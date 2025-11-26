/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 [Phase 1] 최적화된 Receiver Worker
// - 불필요한 ACK 제거 (WebRTC ordered channel이 신뢰성 보장)
// - 디버그 로그 간소화
// - 진행률 보고 빈도 최적화
// ============================================================================

interface FileHandleWrapper {
  handle: FileSystemSyncAccessHandle;
  written: number;
}

const HEADER_SIZE = 18;
const PROGRESS_REPORT_INTERVAL = 200; // 200ms마다 진행률 보고

class ReceiverWorker {
  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private fileHandles: Map<number, FileHandleWrapper> = new Map();
  private totalBytesWritten = 0;
  private totalSize = 0;
  private manifest: any = null;
  private lastReportTime = 0;
  private chunksProcessed = 0;

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
      case 'cleanup-storage':
        await this.cleanupAllTransfers();
        break;
    }
  }

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

            if (now - oldestTime > maxAgeMs) {
              await root.removeEntry(entry.name, { recursive: true });
              deletedCount++;
            }
          } catch (error) {
            // Skip problematic directories
          }
        }
      }
      return deletedCount;
    } catch (error) {
      return 0;
    }
  }

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
          } catch (error) {
            // Skip
          }
        }
      }

      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const availableMB = (((estimate.quota || 0) - (estimate.usage || 0)) / (1024 * 1024)).toFixed(2);
        self.postMessage({ 
          type: 'cleanup-complete', 
          payload: { deletedCount, availableMB } 
        });
      }
    } catch (error) {
      self.postMessage({ type: 'error', payload: 'Storage cleanup failed' });
    }
  }

  private async initStorage(manifest: any) {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.totalBytesWritten = 0;
    this.chunksProcessed = 0;
    
    try {
      // Storage persistence 요청
      if (navigator.storage?.persist) {
        await navigator.storage.persist();
      }
      
      // 할당량 확인
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const available = (estimate.quota || 0) - (estimate.usage || 0);
        const requiredMB = (manifest.totalSize / (1024 * 1024)).toFixed(2);
        const availableMB = (available / (1024 * 1024)).toFixed(2);
        
        if (manifest.totalSize > available) {
          // 자동 정리 시도
          const deletedCount = await this.cleanupOldTransfers(24);
          
          if (deletedCount > 0) {
            const newEstimate = await navigator.storage.estimate();
            const newAvailable = (newEstimate.quota || 0) - (newEstimate.usage || 0);
            
            if (manifest.totalSize > newAvailable) {
              throw new Error(`STORAGE_FULL|${requiredMB}|${(newAvailable / (1024 * 1024)).toFixed(2)}`);
            }
          } else {
            throw new Error(`STORAGE_FULL|${requiredMB}|${availableMB}`);
          }
        }
      }
      
      this.opfsRoot = await navigator.storage.getDirectory();
      const transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });

      for (const file of manifest.files) {
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
        this.fileHandles.set(file.id, { handle: ah, written: 0 });
      }
      
      console.log('[Receiver] Storage ready for', manifest.totalFiles, 'files');
      self.postMessage({ type: 'storage-ready' });
      
    } catch (error: any) {
      console.error('[Receiver] Init failed:', error);
      self.postMessage({ type: 'error', payload: error.message || 'Storage initialization failed' });
    }
  }

  private async processChunk(packet: ArrayBuffer) {
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);
    
    // EOS 체크
    if (fileId === 0xFFFF) {
      await this.finalize();
      return;
    }

    const offsetBigInt = view.getBigUint64(6, true);
    const size = view.getUint32(14, true);

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[Receiver] Corrupt packet');
      return;
    }

    const wrapper = this.fileHandles.get(fileId);
    if (!wrapper) return;

    try {
      // 🚀 [Phase 1] 최적화된 데이터 추출 - Uint8Array 뷰 사용
      const dataView = new Uint8Array(packet, HEADER_SIZE, size);
      const writePosition = Number(offsetBigInt);

      // OPFS 쓰기
      wrapper.handle.write(dataView, { at: writePosition });
      
      wrapper.written += size;
      this.totalBytesWritten += size;
      this.chunksProcessed++;

      // 🚀 [Phase 1] ACK 제거 - WebRTC ordered channel이 신뢰성 보장
      // 불필요한 postMessage 오버헤드 제거
      
    } catch (writeError) {
      console.error('[Receiver] Write error:', writeError);
    }
    
    // 🚀 [Phase 1] 진행률 보고 빈도 최적화 (200ms)
    const now = Date.now();
    if (now - this.lastReportTime > PROGRESS_REPORT_INTERVAL) {
      const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
      self.postMessage({ 
        type: 'progress', 
        payload: { 
          progress,
          bytesWritten: this.totalBytesWritten,
          chunksProcessed: this.chunksProcessed
        } 
      });
      this.lastReportTime = now;
    }
  }

  private async finalize() {
    let actualSize = 0;
    
    // 모든 핸들 플러시 및 닫기
    for (const w of this.fileHandles.values()) {
      try {
        w.handle.flush();
        w.handle.close();
        actualSize += w.written;
      } catch (e) {
        console.error('[Receiver] Error closing handle:', e);
      }
    }

    console.log('[Receiver] Transfer complete. Total:', actualSize, 'bytes');
    
    // 메모리 정리
    this.fileHandles.clear();
    this.opfsRoot = null;
    this.manifest = null;
    
    self.postMessage({
      type: 'complete',
      payload: { actualSize }
    });
  }
}

new ReceiverWorker();
