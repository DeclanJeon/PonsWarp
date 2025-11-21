/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

interface FileHandleWrapper {
  handle: FileSystemSyncAccessHandle;
  written: number;
}

(() => {
  class ReceiverWorker {
    private opfsRoot: FileSystemDirectoryHandle | null = null;
    private fileHandles: Map<number, FileHandleWrapper> = new Map();
    private totalBytesWritten = 0;
    private totalSize = 0;
    private manifest: any = null;
    private lastReportTime = 0;

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
    }

    private async handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;
      if (type === 'init-manifest') await this.initStorage(payload);
      else if (type === 'chunk') await this.processChunk(payload);
    }

    private async initStorage(manifest: any) {
      this.manifest = manifest;
      this.totalSize = manifest.totalSize;
      this.opfsRoot = await navigator.storage.getDirectory();
      
      // 폴더 생성 (transferId 기준)
      const dir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });

      for (const file of manifest.files) {
        // 파일 생성 및 핸들 확보
        // (간소화를 위해 폴더 구조 평탄화 혹은 파일명만 사용)
        const fh = await dir.getFileHandle(file.name, { create: true });
        const ah = await fh.createSyncAccessHandle();
        
        // 성능을 위해 파일 크기 미리 할당 (Truncate)
        ah.truncate(file.size);
        
        this.fileHandles.set(file.id, { handle: ah, written: 0 });
      }
    }

    private async processChunk(packet: ArrayBuffer) {
      // 🚨 [추가] 최소 헤더 크기 검증 (10 bytes)
      if (packet.byteLength < 10) {
        console.warn('[ReceiverWorker] Packet too small, ignoring:', packet.byteLength);
        return;
      }

      const view = new DataView(packet);
      
      // 🚀 헤더 파싱 (Sender와 동일해야 함)
      // [FileIndex: 2] [Seq: 4] [DataLen: 4]
      const fileId = view.getUint16(0, true);

      // EOS (End of Stream) 체크
      if (fileId === 0xFFFF) {
        this.finalize();
        return;
      }

      const seq = view.getUint32(2, true);
      const size = view.getUint32(6, true);

      // 🚨 [추가] 데이터 무결성 검증
      // 실제 패킷 크기가 헤더(10) + 데이터크기(size)와 일치하는지 확인
      if (packet.byteLength < 10 + size) {
        console.error(`[ReceiverWorker] Corrupted packet detected. Expected ${10 + size}, got ${packet.byteLength}. Dropping.`);
        return;
      }
      
      // 헤더(10바이트) 이후의 데이터만 추출
      const data = new Uint8Array(packet, 10, size);
      const wrapper = this.fileHandles.get(fileId);

      if (wrapper) {
        // OPFS에 동기적으로 쓰기 (매우 빠름)
        wrapper.handle.write(data, { at: wrapper.written });
        wrapper.written += size;
        this.totalBytesWritten += size;

        // 🚀 [핵심] ACK 전송 (Main Thread -> Network)
        // Sender가 RTT를 계산하고 윈도우를 조절할 수 있게 시퀀스 번호를 돌려줌
        self.postMessage({ 
          type: 'ack', 
          payload: { chunkIndex: seq } 
        });
      }
      
      // UI 업데이트용 진행률 보고 (너무 자주 보내지 않음)
      const now = Date.now();
      if (now - this.lastReportTime > 100) {
        const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
        self.postMessage({ type: 'progress', payload: { progress } });
        this.lastReportTime = now;
      }
    }

    private finalize() {
      // 모든 핸들 플러시 및 닫기
      for (const w of this.fileHandles.values()) {
        w.handle.flush();
        w.handle.close();
      }
      // 완료 신호
      self.postMessage({ 
        type: 'complete', 
        payload: { actualSize: this.totalBytesWritten } 
      });
    }
  }
  new ReceiverWorker();
})();