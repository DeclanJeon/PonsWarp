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
    
    // 🚨 [추가] EOF 재시도 관련 변수
    private eofRetryCount: number = 0;
    private eofReceived: boolean = false;
    
    // 🚨 [추가] 청크 시퀀스 추적
    private chunkSequence: number = 0;
    
    // 🚀 [최적화] 쓰기 버퍼링
    private writeBuffer: Map<number, Uint8Array[]> = new Map(); // FileID -> Chunks
    private bufferSize: Map<number, number> = new Map();        // FileID -> TotalBytesInBuffer
    private readonly MAX_BUFFER_SIZE = 1024 * 1024; // 1MB 버퍼 (파일당)

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
          // 🚨 [수정] 여기서 바로 handleEOF를 호출하여 EOF 처리
          this.handleEOF();
          return;
      }

      const payloadSize = view.getUint32(2, true);
      
      // 헤더(6 bytes) 제외
      const data = new Uint8Array(packet, 6, payloadSize);

      const wrapper = this.fileHandles.get(fileIndex);
      
      if (wrapper) {
        // 🚨 [수정] 데이터 쓰기 전에 유효성 검증
        if (data.byteLength === 0) {
          console.warn('[Worker] Received empty chunk, skipping');
          return;
        }

        // 🚨 [추가] 청크 시퀀스 번호 추적 (선택적)
        if (!this.chunkSequence) {
          this.chunkSequence = 0;
        }
        this.chunkSequence++;

        // 🚀 [최적화] 버퍼에 추가
        this.addToBuffer(fileIndex, data);
      } else {
        console.warn(`[Worker] No file handle found for index ${fileIndex}`);
      }
    }

    // 🚀 [최적화] 버퍼에 데이터 추가
    private addToBuffer(fileId: number, data: Uint8Array) {
      const currentBuffer = this.writeBuffer.get(fileId) || [];
      const currentSize = this.bufferSize.get(fileId) || 0;
      
      // 데이터 복사하여 저장 (packet은 메인스레드에서 해제될 수 있으므로)
      // 성능을 위해 여기서는 Uint8Array.slice() 사용
      currentBuffer.push(data.slice());
      
      const newSize = currentSize + data.byteLength;
      this.writeBuffer.set(fileId, currentBuffer);
      this.bufferSize.set(fileId, newSize);

      // 버퍼가 꽉 찼으면 플러시
      if (newSize >= this.MAX_BUFFER_SIZE) {
        this.flushBuffer(fileId);
      }
      
      // 진행률 보고 (I/O와 별개로 계산)
      this.totalBytesWritten += data.byteLength;
      this.checkProgress();
    }

    // 🚀 [최적화] 버퍼 플러시
    private flushBuffer(fileId: number) {
      const wrapper = this.fileHandles.get(fileId);
      const chunks = this.writeBuffer.get(fileId);
      if (!wrapper || !chunks || chunks.length === 0) return;

      // 여러 청크를 하나의 큰 버퍼로 병합
      const totalBytes = this.bufferSize.get(fileId) || 0;
      const mergedBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        mergedBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // OPFS에 한 번에 쓰기
      try {
        wrapper.handle.write(mergedBuffer, { at: wrapper.written });
        wrapper.written += totalBytes;
        console.log(`[Worker] Flushed ${totalBytes} bytes to file ${fileId}`);
      } catch (e) {
        console.error('Write failed', e);
      }

      // 버퍼 초기화
      this.writeBuffer.set(fileId, []);
      this.bufferSize.set(fileId, 0);
    }

    // 🚀 [최적화] 모든 버퍼 강제 플러시 (새로 추가할 메서드)
    private flushAllBuffers() {
      for (const [fileId, buffer] of this.writeBuffer) {
        if (buffer && buffer.length > 0) {
          this.flushBuffer(fileId);
        }
      }
    }

    // � [수정] 강화된 EOF 처리: 데이터 무결성 검증 및 재시도 메커니즘
    private handleEOF() {
        // 1. 검증 전에 메모리에 있는 모든 데이터를 디스크로 쓴다.
        this.flushAllBuffers();

        console.log(`[Worker] EOF Check: ${this.totalBytesWritten} / ${this.totalSize}`);
        
        // 🚨 [핵심 수정] 데이터가 부족할 경우 즉시 에러 처리하지 않고 재시도 기회 부여
        if (this.totalSize > 0 && this.totalBytesWritten < this.totalSize) {
            const missing = this.totalSize - this.totalBytesWritten;
            
            // 재시도 카운터 초기화 확인
            if (!this.eofRetryCount) {
                this.eofRetryCount = 0;
            }
            
            this.eofRetryCount++;
            
            // 🚨 [수정] 재시도 횟수 및 간격 증가 (10회 -> 20회, 1000ms -> 500ms)
            // 3.5GB 같은 대용량 파일은 디스크 쓰기 지연 등으로 인해 싱크가 늦을 수 있음
            if (this.eofRetryCount <= 20) { // 횟수 좀 더 넉넉하게 20회로 증가
                console.warn(`[Worker] EOF retry ${this.eofRetryCount}/20: Missing ${missing} bytes, waiting...`);
                
                // 지연 후 다시 체크 (0.5초 간격으로 감소)
                setTimeout(() => {
                    this.handleEOF();
                }, 500);
                return;
            }
            
            // 재시도 실패 시 에러 처리
            const msg = `CRITICAL: Data corruption detected. Missing ${missing} bytes after ${this.eofRetryCount} retries.`;
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

       // 1. 정확히 다 받았더라도 여기서 바로 finalize() 호출하지 않음
       // EOF 패킷을 기다려야 함 (데이터 무결성 보장)
       // if (this.totalBytesWritten >= this.totalSize) {
       //   this.finalize();
       //   return;
       // }

       // 2. 진행률 보고 (Throttling: 0.1초에 한 번만 보냄)
       // 너무 자주 보내면 메인 스레드가 UI 그리느라 멈춤
       if (now - this.lastReportTime > this.REPORT_INTERVAL) {
         // totalSize가 0인 경우를 방지
         const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
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
      // manifest가 null인 경우를 대비한 안전한 처리
      if (this.manifest) {
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
      } else {
        // manifest가 없는 경우 기본 완료 메시지
        self.postMessage({
          type: 'complete',
          payload: {
            actualSize: this.totalBytesWritten
          }
        });
      }
      
      // 초기화
      this.isInitialized = false;
      this.fileHandles.clear();
      // console.log('[Worker] All done');
    }
  }

  new ReceiverWorker();
})();