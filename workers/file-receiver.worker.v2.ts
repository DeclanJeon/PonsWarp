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

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
    }

    private async handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;
      if (type === 'init-manifest') await this.initStorage(payload);
      else if (type === 'chunk') await this.processChunk(payload);
      else if (type === 'cleanup-storage') await this.cleanupAllTransfers();
    }
    
    /**
     * 오래된 전송 디렉토리 삭제
     */
    private async cleanupOldTransfers(maxAgeHours: number): Promise<number> {
      try {
        const root = await navigator.storage.getDirectory();
        let deletedCount = 0;
        const now = Date.now();
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // @ts-ignore
        for await (const entry of root.values()) {
          if (entry.kind === 'directory' && entry.name.startsWith('transfer-')) {
            try {
              const dirHandle = await root.getDirectoryHandle(entry.name);
              
              // 디렉토리 내 파일의 수정 시간 확인
              let oldestTime = now;
              // @ts-ignore
              for await (const fileEntry of dirHandle.values()) {
                if (fileEntry.kind === 'file') {
                  const fileHandle = await dirHandle.getFileHandle(fileEntry.name);
                  const file = await fileHandle.getFile();
                  if (file.lastModified < oldestTime) {
                    oldestTime = file.lastModified;
                  }
                }
              }

              // 오래된 디렉토리 삭제
              if (now - oldestTime > maxAgeMs) {
                await root.removeEntry(entry.name, { recursive: true });
                deletedCount++;
                console.log(`[ReceiverWorker] Deleted old transfer: ${entry.name}`);
              }
            } catch (error) {
              console.warn(`[ReceiverWorker] Failed to process directory ${entry.name}:`, error);
            }
          }
        }

        return deletedCount;
      } catch (error) {
        console.error('[ReceiverWorker] Cleanup failed:', error);
        return 0;
      }
    }
    
    /**
     * 모든 전송 디렉토리 삭제 (사용자 요청 시)
     */
    private async cleanupAllTransfers(): Promise<void> {
      try {
        const root = await navigator.storage.getDirectory();
        let deletedCount = 0;

        // @ts-ignore
        for await (const entry of root.values()) {
          if (entry.kind === 'directory' && entry.name.startsWith('transfer-')) {
            try {
              await root.removeEntry(entry.name, { recursive: true });
              deletedCount++;
              console.log(`[ReceiverWorker] Deleted transfer: ${entry.name}`);
            } catch (error) {
              console.warn(`[ReceiverWorker] Failed to delete ${entry.name}:`, error);
            }
          }
        }

        console.log(`[ReceiverWorker] Cleared ${deletedCount} transfer(s)`);
        
        // 정리 완료 후 저장 공간 정보 전송
        if (navigator.storage && navigator.storage.estimate) {
          const estimate = await navigator.storage.estimate();
          const availableMB = (((estimate.quota || 0) - (estimate.usage || 0)) / (1024 * 1024)).toFixed(2);
          self.postMessage({ 
            type: 'cleanup-complete', 
            payload: { deletedCount, availableMB } 
          });
        }
      } catch (error) {
        console.error('[ReceiverWorker] Clear all failed:', error);
        self.postMessage({ type: 'error', payload: 'Storage cleanup failed' });
      }
    }

    private async initStorage(manifest: any) {
      this.manifest = manifest;
      this.totalSize = manifest.totalSize;
      
      try {
        // 🚨 [핵심 수정] Storage API로 persistent 권한 요청
        if (navigator.storage && navigator.storage.persist) {
          const isPersisted = await navigator.storage.persist();
          console.log('[ReceiverWorker] Storage persistence:', isPersisted);
        }
        
        // 현재 할당량 확인
        if (navigator.storage && navigator.storage.estimate) {
          const estimate = await navigator.storage.estimate();
          const quotaMB = ((estimate.quota || 0) / (1024 * 1024)).toFixed(2);
          const usageMB = ((estimate.usage || 0) / (1024 * 1024)).toFixed(2);
          const availableMB = (((estimate.quota || 0) - (estimate.usage || 0)) / (1024 * 1024)).toFixed(2);
          const requiredMB = (manifest.totalSize / (1024 * 1024)).toFixed(2);
          
          console.log(`[ReceiverWorker] Storage: ${usageMB}MB used / ${quotaMB}MB quota (${availableMB}MB available)`);
          console.log(`[ReceiverWorker] Required: ${requiredMB}MB`);
          
          // 🚨 [핵심 수정] 공간 부족 시 자동 정리 시도
          if (manifest.totalSize > (estimate.quota || 0) - (estimate.usage || 0)) {
            console.warn('[ReceiverWorker] Insufficient space. Attempting auto-cleanup...');
            
            // 오래된 전송 디렉토리 자동 삭제
            const deletedCount = await this.cleanupOldTransfers(24); // 24시간 이상 된 것
            
            if (deletedCount > 0) {
              // 정리 후 다시 확인
              const newEstimate = await navigator.storage.estimate();
              const newAvailableMB = (((newEstimate.quota || 0) - (newEstimate.usage || 0)) / (1024 * 1024)).toFixed(2);
              console.log(`[ReceiverWorker] Cleaned up ${deletedCount} old transfer(s). New available: ${newAvailableMB}MB`);
              
              // 여전히 부족하면 에러
              if (manifest.totalSize > (newEstimate.quota || 0) - (newEstimate.usage || 0)) {
                throw new Error(
                  `STORAGE_FULL|${requiredMB}|${newAvailableMB}`
                );
              }
            } else {
              // 정리할 것이 없으면 에러
              throw new Error(
                `STORAGE_FULL|${requiredMB}|${availableMB}`
              );
            }
          }
        }
        
        this.opfsRoot = await navigator.storage.getDirectory();
        const transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });

        for (const file of manifest.files) {
          try {
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
            
            // 🚨 [핵심 수정] truncate() 제거 - 스트리밍 방식으로 쓰기
            // truncate()는 공간을 미리 예약하려고 하는데, 브라우저가 거부할 수 있음
            // 대신 데이터가 도착할 때마다 동적으로 파일 크기 증가
            this.fileHandles.set(file.id, { handle: ah, written: 0 });
            
            console.log(`[ReceiverWorker] File handle created: ${file.path} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);
          } catch (fileError: any) {
            console.error('[ReceiverWorker] ❌ Failed to create file:', file.path, fileError);
            throw fileError;
          }
        }
        
        console.log('[ReceiverWorker] ✅ Storage initialized for', manifest.totalFiles, 'files');
        self.postMessage({ type: 'storage-ready' });
      } catch (error: any) {
        console.error('[ReceiverWorker] ❌ Init failed:', error);
        
        // 에러 메시지를 사용자 친화적으로 변환
        let errorMessage = 'Storage initialization failed';
        if (error.message?.includes('Insufficient storage') ||
            error.message?.includes('quota') ||
            error.name === 'QuotaExceededError') {
          errorMessage = error.message;
        }
        
        self.postMessage({ type: 'error', payload: errorMessage });
      }
    }

    private async processChunk(packet: ArrayBuffer) {
      const processStartTime = performance.now();
      
      // 1. 최소 헤더 크기 체크
      if (packet.byteLength < this.HEADER_SIZE) {
        console.log('[DEBUG Receiver] ⚠️ Packet too small:', packet.byteLength);
        return;
      }

      const view = new DataView(packet);
      const fileId = view.getUint16(0, true);
      
      // 2. EOS(End of Stream) 체크
      if (fileId === 0xFFFF) {
        console.log('[DEBUG Receiver] ✅ EOS packet received');
        await this.finalize();
        return;
      }

      const seq = view.getUint32(2, true);
      const offsetBigInt = view.getBigUint64(6, true);
      const size = view.getUint32(14, true); // 데이터 길이

      // 🚨 [진단] 헤더 정보 로깅
      console.log('[DEBUG Receiver] Chunk received:', {
        fileId,
        seq,
        offset: offsetBigInt.toString(),
        dataSize: size,
        packetSize: packet.byteLength,
        expectedSize: this.HEADER_SIZE + size,
        timestamp: Date.now()
      });

      // 3. 패킷 무결성 검증
      if (packet.byteLength !== this.HEADER_SIZE + size) {
        console.error(`[DEBUG Receiver] ❌ Corrupt packet detected. Header says ${size}, actual is ${packet.byteLength - this.HEADER_SIZE}`);
        return;
      }

      const wrapper = this.fileHandles.get(fileId);
      if (!wrapper) {
        console.error('[DEBUG Receiver] ❌ No file handle for fileId:', fileId);
        console.log('[DEBUG Receiver] Available fileIds:', Array.from(this.fileHandles.keys()));
        return;
      }

      if (wrapper) {
        try {
          // 🚨 [진단] slice 전 데이터 확인
          const originalData = new Uint8Array(packet);
          console.log('[DEBUG Receiver] Original packet data (first 20 bytes):',
            Array.from(originalData.slice(0, Math.min(20, packet.byteLength))));
          
          // 🚨 [진단] 메모리 복사 성능 추적
          const beforeSlice = performance.now();
          
          // 🚨 [핵심 수정] .slice()를 사용하여 헤더를 완전히 제거한 새로운 버퍼 생성
          const dataCopy = packet.slice(this.HEADER_SIZE, this.HEADER_SIZE + size);
          const dataView = new Uint8Array(dataCopy);
          
          const afterSlice = performance.now();
          
          // 🚨 [진단] slice 후 데이터 확인
          console.log('[DEBUG Receiver] Sliced data (first 20 bytes):',
            Array.from(dataView.slice(0, Math.min(20, dataView.byteLength))));
          
          const writePosition = Number(offsetBigInt);

          // 🚨 [진단] 쓰기 작업 정보
          console.log('[DEBUG Receiver] Writing:', {
            position: writePosition,
            size: dataView.byteLength,
            totalWritten: wrapper.written,
            sliceTimeMs: (afterSlice - beforeSlice).toFixed(2)
          });

          // 🚨 [진단] 디스크 쓰기 성능 추적
          const beforeWrite = performance.now();
          
          // OPFS에 쓰기
          wrapper.handle.write(dataView, { at: writePosition });
          
          const afterWrite = performance.now();
          
          wrapper.written += size;
          this.totalBytesWritten += size;

          console.log('[DEBUG Receiver] ✅ Write successful:', {
            writeTimeMs: (afterWrite - beforeWrite).toFixed(2),
            totalWritten: this.totalBytesWritten,
            progress: ((this.totalBytesWritten / this.totalSize) * 100).toFixed(2) + '%'
          });

          // ACK 전송
          const beforeAck = performance.now();
          self.postMessage({ type: 'ack', payload: { seq: seq } });
          const afterAck = performance.now();
          
          console.log('[DEBUG Receiver] ACK sent:', {
            seq,
            ackTimeMs: (afterAck - beforeAck).toFixed(2)
          });
          
        } catch (writeError) {
          console.error('[DEBUG Receiver] ❌ Write error:', writeError);
        }
      }
      
      // 진행률 보고 (빈도 조절: 100ms)
      const now = Date.now();
      if (now - this.lastReportTime > 100) {
        const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
        self.postMessage({ type: 'progress', payload: { progress } });
        this.lastReportTime = now;
      }
      
      const processEndTime = performance.now();
      console.log('[DEBUG Receiver] Chunk processing completed:', {
        totalTimeMs: (processEndTime - processStartTime).toFixed(2),
        packetSize: packet.byteLength
      });
    }

    private async finalize() {
      let actualSize = 0;
      let handles: FileSystemSyncAccessHandle[] = [];
      
      // 모든 핸들 강제 플러시 (디스크 기록 보장) 및 닫기
      for (const w of this.fileHandles.values()) {
        try {
            w.handle.flush();
            handles.push(w.handle); // 나중에 정리하기 위해 참조 보관
            w.handle.close();
            actualSize += w.written;
        } catch (e) {
            console.error('[ReceiverWorker] Error closing handle:', e);
        }
      }

      console.log('[ReceiverWorker] Transfer finalized. Total written:', actualSize);
      
      // 🚀 [메모리 최적화] 완료 후 메모리 정리
      this.fileHandles.clear();
      this.opfsRoot = null;
      this.manifest = null;
      
      // 강제 가비지 컬렉션
      if (globalThis.gc) {
        globalThis.gc();
        console.log('[DEBUG Receiver] Forced GC on finalize');
      }
      
      self.postMessage({
        type: 'complete',
        payload: { actualSize: actualSize }
      });
      
      // 🚀 [메모리 최적화] 핸들 참조 정리
      handles.length = 0; // 배열 비우기
    }
  }
  new ReceiverWorker();
})();