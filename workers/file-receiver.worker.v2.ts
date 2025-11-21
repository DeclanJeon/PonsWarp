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
    
    // 헤더 크기: FileId(2) + Seq(4) + Offset(8) + Size(4) = 18
    private readonly HEADER_SIZE = 18;
    
    // 🚀 [Phase 1] OPFS 배치 쓰기 및 메모리 버퍼 풀
    private chunkBuffer: Map<number, { data: Uint8Array; position: number }> = new Map();
    private flushCounter = 0;
    private readonly BATCH_FLUSH_SIZE = 5; // 5개 청크마다 flush

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
      
      try {
        this.opfsRoot = await navigator.storage.getDirectory();
        
        const transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });

        for (const file of manifest.files) {
          // 폴더 구조 처리
          const pathParts = file.path.split('/');
          const fileName = pathParts.pop()!;
          let currentDir = transferDir;
          
          for (const part of pathParts) {
            if (part) {
              currentDir = await currentDir.getDirectoryHandle(part, { create: true });
            }
          }
          
          const fh = await currentDir.getFileHandle(fileName, { create: true });
          const ah = await fh.createSyncAccessHandle();
          
          // 파일 크기 미리 할당 (매우 중요: 성능 및 단편화 방지)
          ah.truncate(file.size);
          this.fileHandles.set(file.id, { handle: ah, written: 0 });
        }
        
        // console.log('[ReceiverWorker] Storage initialized for', manifest.totalFiles, 'files');
      } catch (error) {
        console.error('[ReceiverWorker] Init failed:', error);
        self.postMessage({ type: 'error', payload: 'Storage initialization failed' });
      }
    }

    private async processChunk(packet: ArrayBuffer) {
      // 1. 최소 헤더 크기 체크
      if (packet.byteLength < this.HEADER_SIZE) {
        // console.warn('[ReceiverWorker] ⚠️ Packet too small:', packet.byteLength);
        return;
      }

      const view = new DataView(packet);
      const fileId = view.getUint16(0, true);
      
      // 2. EOS(End of Stream) 체크
      if (fileId === 0xFFFF) {
        // console.log('[ReceiverWorker] ✅ EOS packet received');
        await this.finalize();
        return;
      }

      const seq = view.getUint32(2, true);
      const offsetBigInt = view.getBigUint64(6, true);
      const size = view.getUint32(14, true); // 데이터 길이

      // 🚨 [진단] 헤더 정보 로깅
      // console.log('[ReceiverWorker] Chunk received:', {
      //   fileId,
      //   seq,
      //   offset: offsetBigInt.toString(),
      //   dataSize: size,
      //   packetSize: packet.byteLength,
      //   expectedSize: this.HEADER_SIZE + size
      // });

      // 3. 패킷 무결성 검증
      if (packet.byteLength !== this.HEADER_SIZE + size) {
        // console.error(`[ReceiverWorker] ❌ Corrupt packet detected. Header says ${size}, actual is ${packet.byteLength - this.HEADER_SIZE}`);
        return;
      }

      const wrapper = this.fileHandles.get(fileId);
      if (!wrapper) {
        // console.error('[ReceiverWorker] ❌ No file handle for fileId:', fileId);
        // console.log('[ReceiverWorker] Available fileIds:', Array.from(this.fileHandles.keys()));
        return;
      }

      if (wrapper) {
        try {
          // 🚨 [진단] slice 전 데이터 확인
          const originalData = new Uint8Array(packet);
          // console.log('[ReceiverWorker] Original packet data (first 20 bytes):',
          //   Array.from(originalData.slice(0, Math.min(20, packet.byteLength))));
          
          // 🚨 [핵심 수정] .slice()를 사용하여 헤더를 완전히 제거한 새로운 버퍼 생성
          const dataCopy = packet.slice(this.HEADER_SIZE, this.HEADER_SIZE + size);
          const dataView = new Uint8Array(dataCopy);
          
          // 🚨 [진단] slice 후 데이터 확인
          // console.log('[ReceiverWorker] Sliced data (first 20 bytes):',
          //   Array.from(dataView.slice(0, Math.min(20, dataView.byteLength))));
          
          const writePosition = Number(offsetBigInt);

          // 🚨 [진단] 쓰기 작업 정보
          // console.log('[ReceiverWorker] Writing:', {
          //   position: writePosition,
          //   size: dataView.byteLength,
          //   totalWritten: wrapper.written
          // });

          // 🚀 [Phase 1] 청크를 버퍼에 저장
          this.chunkBuffer.set(seq, {
            data: dataView,
            position: writePosition
          });
          
          this.flushCounter++;
          
          // 배치 쓰기: 5개 청크마다 플러시
          if (this.flushCounter >= this.BATCH_FLUSH_SIZE) {
            this.flushBuffer(wrapper);
            this.flushCounter = 0;
          }
          
          wrapper.written += size;
          this.totalBytesWritten += size;

          // ACK 전송
          self.postMessage({ type: 'ack', payload: { seq: seq } });
        } catch (writeError) {
          // console.error('[ReceiverWorker] ❌ Write error:', writeError);
        }
      }
      
      // 진행률 보고 (빈도 조절: 100ms)
      const now = Date.now();
      if (now - this.lastReportTime > 100) {
        const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
        self.postMessage({ type: 'progress', payload: { progress } });
        this.lastReportTime = now;
      }
    }

    private flushBuffer(wrapper: FileHandleWrapper) {
      // 🚀 [Phase 1] 버퍼에 저장된 청크들을 일괄 쓰기
      for (const [seq, chunk] of this.chunkBuffer) {
        try {
          wrapper.handle.write(chunk.data, { at: chunk.position });
        } catch (e) {
          // 쓰기 오류 무시하고 계속 진행
        }
      }
      
      // 버퍼 비우기
      this.chunkBuffer.clear();
    }

    private async finalize() {
      let actualSize = 0;
      
      // 🚀 [Phase 1] 남은 버퍼 플러시
      for (const w of this.fileHandles.values()) {
        try {
          // 남은 청크 플러시
          this.flushBuffer(w);
          
          // 최종 플러시 및 닫기
          w.handle.flush();
          w.handle.close();
          actualSize += w.written;
        } catch (e) {
            // console.error('[ReceiverWorker] Error closing handle:', e);
        }
      }

      // console.log('[ReceiverWorker] Transfer finalized. Total written:', actualSize);
      self.postMessage({
        type: 'complete',
        payload: { actualSize: actualSize }
      });
    }
  }
  new ReceiverWorker();
})();