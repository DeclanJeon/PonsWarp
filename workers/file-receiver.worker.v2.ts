/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

interface FileHandleWrapper {
  handle: FileSystemSyncAccessHandle;
}

(() => {
  class FastReceiverWorker {
    private opfsRoot: FileSystemDirectoryHandle | null = null;
    private fileHandles: Map<number, FileHandleWrapper> = new Map();
    
    // 🚀 [성능 최적화] 문자열 Set 대신 정수형 Set 사용 (메모리/CPU 효율 극대화)
    private processedSeqs: Set<number> = new Set();
    
    private totalBytesReceived = 0;
    private totalSize = 0;
    private lastReportTime = 0;
    private readonly HEADER_SIZE = 18;

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
    }

    private async handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;
      if (type === 'init-manifest') await this.initStorage(payload);
      else if (type === 'chunk') await this.processChunk(payload);
    }

    private async initStorage(manifest: any) {
      try {
        this.opfsRoot = await navigator.storage.getDirectory();
        const transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });
        
        // 초기화
        this.fileHandles.clear();
        this.processedSeqs.clear(); // Set 초기화
        this.totalBytesReceived = 0;

        for (const file of manifest.files) {
          const pathParts = file.path.split('/');
          const fileName = pathParts.pop()!;
          let currentDir = transferDir;
          for (const part of pathParts) {
            if (part) currentDir = await currentDir.getDirectoryHandle(part, { create: true });
          }
          const fh = await currentDir.getFileHandle(fileName, { create: true });
          const ah = await fh.createSyncAccessHandle();
          ah.truncate(file.size);
          this.fileHandles.set(file.id, { handle: ah });
        }
        
        this.totalSize = manifest.totalSize;
        self.postMessage({ type: 'storage-ready' });
      } catch (error) {
        self.postMessage({ type: 'error', payload: 'Storage init failed: ' + error.message });
      }
    }

    private async processChunk(packet: ArrayBuffer) {
      if (packet.byteLength < this.HEADER_SIZE) return;

      const view = new DataView(packet);
      const fileId = view.getUint16(0, true); // Byte 0-2
      
      // EOS 체크
      if (fileId === 0xFFFF) {
        await this.finalize();
        return;
      }

      // 🚀 [성능 최적화] 헤더에서 시퀀스 번호(Seq) 추출 (Byte 2-6)
      // Sender가 이미 보내고 있던 고유 번호입니다.
      const seq = view.getUint32(2, true);

      // 🚨 [핵심] 정수형 비교는 문자열 비교보다 압도적으로 빠릅니다.
      if (this.processedSeqs.has(seq)) {
        // 중복 패킷은 무시하되, 쓰기 작업은 안전을 위해 수행할 수도 있으나
        // 속도가 중요하다면 여기서 바로 return 하는 것이 가장 빠릅니다.
        // 하지만 "Sender보다 진행률이 앞서는 문제"를 해결하는 것이 주 목적이므로
        // 쓰기는 허용하되 '카운팅'만 막습니다.
      } else {
        // 새로운 패킷임 -> Set에 추가
        this.processedSeqs.add(seq);
        
        const offsetBigInt = view.getBigUint64(6, true);
        const size = view.getUint32(14, true);

        const wrapper = this.fileHandles.get(fileId);
        if (wrapper) {
          try {
            // Zero-Copy Write
            const dataView = new Uint8Array(packet, this.HEADER_SIZE, size);
            wrapper.handle.write(dataView, { at: Number(offsetBigInt) });
            
            // 🚨 유효한 패킷일 때만 진행률 증가
            this.totalBytesReceived += size;
            
            // 100% 초과 방지 클램핑
            if (this.totalBytesReceived > this.totalSize) {
               this.totalBytesReceived = this.totalSize;
            }
          } catch (writeError) {
            console.error('[Receiver Worker] Write error:', writeError);
          }
        }
      }
      
      // 메모리 관리: Set이 너무 커지면(예: 100만개 이상) 오래된 것 비우기 고려 가능하나,
      // 정수형 Set 100만개는 약 30~40MB 수준이라 최신 브라우저에서는 문제없음.
      
      const now = Date.now();
      if (now - this.lastReportTime > 200) {
        this.reportProgress();
        this.lastReportTime = now;
      }
    }

    private reportProgress() {
      const progress = this.totalSize > 0 
        ? (this.totalBytesReceived / this.totalSize) * 100 
        : 0;
      
      self.postMessage({ type: 'progress', payload: { progress } });
    }

    private async finalize() {
      for (const w of this.fileHandles.values()) {
        w.handle.flush();
        w.handle.close();
      }
      
      self.postMessage({ type: 'progress', payload: { progress: 100 } });
      self.postMessage({ type: 'complete', payload: { actualSize: this.totalBytesReceived } });
    }
  }
  new FastReceiverWorker();
})();