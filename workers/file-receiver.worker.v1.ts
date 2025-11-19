/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

interface FileHandleWrapper {
  handle: FileSystemSyncAccessHandle;
  path: string;
  size: number;
  written: number;
}

(() => {
  class ReceiverWorker {
    private manifest: any = null;
    private opfsRoot: FileSystemDirectoryHandle | null = null;
    private fileHandles: Map<number, FileHandleWrapper> = new Map();
    private isInitialized = false;
    
    // 🚀 성능 최적화 변수
    private totalBytesWritten = 0;
    private totalSize = 0;
    private lastReportTime = 0;
    private readonly REPORT_INTERVAL = 100; // 100ms마다 한 번만 보고 (UI 부하 방지)

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
    }

    private async handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;

      switch (type) {
        case 'init-manifest':
          await this.initStorage(payload);
          break;
        case 'chunk':
          await this.processChunk(payload);
          break;
        // 🚨 추가: EOF 처리
        case 'eof':
          this.handleEOF();
          break;
      }
    }

    private async initStorage(manifest: any) {
      try {
        this.manifest = manifest;
        this.totalSize = manifest.totalSize;
        this.totalBytesWritten = 0;
        this.opfsRoot = await navigator.storage.getDirectory();
        
        const transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });

        for (const file of manifest.files) {
          const parts = file.path.split('/');
          const fileName = parts.pop()!;
          let currentDir = transferDir;
          
          for (const part of parts) {
            currentDir = await currentDir.getDirectoryHandle(part, { create: true });
          }

          const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
          const accessHandle = await fileHandle.createSyncAccessHandle();
          
          accessHandle.truncate(file.size);

          this.fileHandles.set(file.id, {
            handle: accessHandle,
            path: file.path,
            size: file.size,
            written: 0
          });
        }

        this.isInitialized = true;
        // console.log('[Worker] Storage ready'); // 로그 최소화

      } catch (e) {
        self.postMessage({ type: 'error', payload: { error: 'Storage Init Failed: ' + e } });
      }
    }

    private async processChunk(packet: ArrayBuffer) {
      if (!this.isInitialized) return;

      const view = new DataView(packet);
      const fileIndex = view.getUint16(0, true); // 파일 ID 읽기

      // 🚨 [핵심 수정] 매직 넘버 65535(0xFFFF)가 오면 "진짜 끝"으로 간주
      if (fileIndex === 0xFFFF) {
          console.log('[Worker] Binary EOS (End of Stream) packet received.');
          this.handleEOF();
          return;
      }

      const payloadSize = view.getUint32(2, true);
      
      // 헤더(6 bytes) 제외
      const data = new Uint8Array(packet, 6, payloadSize);

      const wrapper = this.fileHandles.get(fileIndex);
      
      if (wrapper) {
        // 1. 파일 쓰기 (동기식이라 빠름)
        wrapper.handle.write(data, { at: wrapper.written });
        wrapper.written += data.byteLength;
        this.totalBytesWritten += data.byteLength;

        // 2. 완료 체크 및 진행률 보고
        this.checkProgress();
      }
    }

    // 🚨 [수정] 바이트가 모자라면 절대 완료 처리하지 않음
    private handleEOF() {
        console.log(`[Worker] EOF Check: ${this.totalBytesWritten} / ${this.totalSize}`);
        
        // 🚨 [수정] 바이트가 모자라면 절대 완료 처리하지 않음
        if (this.totalBytesWritten < this.totalSize) {
            const missing = this.totalSize - this.totalBytesWritten;
            const msg = `CRITICAL: Data corruption detected. Missing ${missing} bytes.`;
            console.error(msg);
            
            // 메인 스레드에 에러 전파
            self.postMessage({
                type: 'error',
                payload: { error: msg }
            });
            return; // 여기서 함수 종료 (finalize 호출 안 함)
        }
        
        console.log('✅ Integrity Check Passed.');
        this.finalize();
    }

    private checkProgress() {
       const now = Date.now();

       // 1. 정확히 다 받았으면 즉시 완료
       if (this.totalBytesWritten >= this.totalSize) {
         this.finalize();
         return;
       }

       // 2. 진행률 보고 (Throttling: 0.1초에 한 번만 보냄)
       // 너무 자주 보내면 메인 스레드가 UI 그리느라 멈춤
       if (now - this.lastReportTime > this.REPORT_INTERVAL) {
         const progress = (this.totalBytesWritten / this.totalSize) * 100;
         self.postMessage({ type: 'progress', payload: { progress } });
         this.lastReportTime = now;
       }
    }

    private isFinalized = false; // 중복 실행 방지 플래그

    private finalize() {
      if (this.isFinalized) return;
      this.isFinalized = true;

      // 1. 모든 핸들 닫기 (메모리 누수 방지)
      for (const wrapper of this.fileHandles.values()) {
        try {
            wrapper.handle.flush();
            wrapper.handle.close();
        } catch(e) {
            console.warn('Close error', e);
        }
      }
      
      // 2. 100% 강제 전송
      self.postMessage({ type: 'progress', payload: { progress: 100 } });

      // 3. 완료 신호
      self.postMessage({
        type: 'complete',
        payload: {
          manifest: this.manifest,
          transferId: this.manifest.transferId,
          rootName: this.manifest.rootName,
          // 🚨 [추가] 실제로 저장된 바이트 수 전달
          actualSize: this.totalBytesWritten
        }
      });
      
      // 초기화
      this.isInitialized = false;
      this.fileHandles.clear();
      // console.log('[Worker] All done');
    }
  }

  new ReceiverWorker();
})();