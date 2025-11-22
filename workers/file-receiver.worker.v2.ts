/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

interface FileHandleWrapper {
  handle: FileSystemSyncAccessHandle;
  written: number;
}

(() => {
  class FastReceiverWorker {
    private opfsRoot: FileSystemDirectoryHandle | null = null;
    private fileHandles: Map<number, FileHandleWrapper> = new Map();
    private totalBytesWritten = 0;
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
      console.log('[Receiver Worker] Initializing storage for manifest:', manifest);
      try {
        this.opfsRoot = await navigator.storage.getDirectory();
        const transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });
        console.log('[Receiver Worker] Transfer directory created:', manifest.transferId);

        for (const file of manifest.files) {
          console.log('[Receiver Worker] Processing file:', file.path, 'ID:', file.id);
          // 폴더 생성 로직 생략 (기존과 동일)
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
          
          ah.truncate(file.size); // 중요: 미리 공간 할당
          this.fileHandles.set(file.id, { handle: ah, written: 0 });
          console.log('[Receiver Worker] File handle created for:', file.path);
        }
        
        this.totalSize = manifest.totalSize;
        console.log('[Receiver Worker] Storage initialization complete. Total size:', this.totalSize);
        
        // 🚨 [추가] 모든 파일 핸들 생성 완료 후 "준비 완료" 신호 발송
        self.postMessage({ type: 'storage-ready' });
      } catch (error) {
        console.error('[Receiver Worker] Storage initialization failed:', error);
        self.postMessage({ type: 'error', payload: 'Storage init failed: ' + error.message });
      }
    }

    private async processChunk(packet: ArrayBuffer) {
      // 1. 최소 헤더 크기 체크
      if (packet.byteLength < this.HEADER_SIZE) {
        console.warn('[Receiver Worker] Chunk too small:', packet.byteLength, 'Expected at least:', this.HEADER_SIZE);
        return;
      }

      const view = new DataView(packet);
      const fileId = view.getUint16(0, true);
      
      // 2. EOS 체크
      if (fileId === 0xFFFF) {
        console.log('[Receiver Worker] EOS packet received, finalizing transfer');
        await this.finalize();
        return;
      }

      const offsetBigInt = view.getBigUint64(6, true);
      const size = view.getUint32(14, true);

      console.log('[Receiver Worker] Processing chunk - FileID:', fileId, 'Offset:', Number(offsetBigInt), 'Size:', size);

      const wrapper = this.fileHandles.get(fileId);
      if (wrapper) {
        try {
          // 🚀 [최적화] Zero-Copy: slice() 대신 subarray() 사용
          // packet은 Transferable로 넘어왔으므로 여기서 소유권을 가짐
          // Uint8Array 뷰만 생성하여 메모리 복사 없이 전달
          const dataView = new Uint8Array(packet, this.HEADER_SIZE, size);
          
          // OPFS SyncHandle은 ArrayBufferView를 받아 즉시 씀
          wrapper.handle.write(dataView, { at: Number(offsetBigInt) });
          
          wrapper.written += size;
          this.totalBytesWritten += size;
          
          console.log('[Receiver Worker] Chunk written successfully. Total written:', this.totalBytesWritten, '/', this.totalSize);
          
          // 🚀 [삭제됨] ACK 전송 로직 제거 (가장 큰 병목 해결)
          
        } catch (writeError) {
          console.error('[Receiver Worker] Write error:', writeError);
        }
      } else {
        console.warn('[Receiver Worker] No file handle found for file ID:', fileId, 'Available IDs:', Array.from(this.fileHandles.keys()));
      }
      
      // 진행률 보고 (쓰로틀링: 200ms)
      const now = Date.now();
      if (now - this.lastReportTime > 200) {
        const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
        console.log('[Receiver Worker] Progress:', progress.toFixed(2) + '%');
        self.postMessage({ type: 'progress', payload: { progress } });
        this.lastReportTime = now;
      }
    }

    private async finalize() {
      let actualSize = 0;
      for (const w of this.fileHandles.values()) {
        w.handle.flush();
        w.handle.close();
        actualSize += w.written;
      }
      self.postMessage({ type: 'complete', payload: { actualSize } });
    }
  }
  new FastReceiverWorker();
})();