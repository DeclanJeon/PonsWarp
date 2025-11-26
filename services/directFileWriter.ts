/**
 * Direct File Writer Service
 * File System Access API를 사용하여 메인 스레드에서 직접 파일 쓰기
 * OPFS 할당량 제한 없이 디스크 여유 공간만큼 파일 저장 가능
 */

interface FileWriterHandle {
  writable: FileSystemWritableFileStream;
  written: number;
  size: number;
}

export class DirectFileWriter {
  private fileHandles: Map<number, FileWriterHandle> = new Map();
  private rootDirHandle: FileSystemDirectoryHandle | null = null;
  private totalBytesWritten = 0;
  private totalSize = 0;
  private manifest: any = null;
  private onProgressCallback: ((progress: number) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  
  // 🚀 [Phase 1] 속도 계산용 상태
  private startTime = 0;
  private lastProgressTime = 0;
  private lastBytesWritten = 0;
  private currentSpeed = 0;
  
  // 🚀 [버그 수정] 중복 finalize 방지
  private isFinalized = false;
  
  // 🚀 [버그 수정] EOS 수신 후 대기 처리
  private eosReceived = false;
  private pendingWrites = 0;

  /**
   * 사용자에게 저장 위치 선택 요청 및 파일 핸들 생성
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;

    try {
      // 🚨 [핵심] File System Access API 지원 확인
      if (!('showDirectoryPicker' in window)) {
        throw new Error('UNSUPPORTED_BROWSER');
      }

      console.log('[DirectFileWriter] Requesting directory picker...');
      
      // 사용자에게 저장 디렉토리 선택 요청
      this.rootDirHandle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'downloads',
      });

      console.log('[DirectFileWriter] Directory selected:', this.rootDirHandle.name);

      // 각 파일에 대한 writable stream 생성
      for (const file of manifest.files) {
        const pathParts = file.path.split('/');
        const fileName = pathParts.pop()!;
        let currentDir = this.rootDirHandle;

        // 폴더 구조 생성
        for (const part of pathParts) {
          if (part) {
            currentDir = await currentDir.getDirectoryHandle(part, { create: true });
          }
        }

        // 파일 핸들 생성
        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();

        this.fileHandles.set(file.id, {
          writable,
          written: 0,
          size: file.size,
        });

        console.log(`[DirectFileWriter] File handle created: ${file.path} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);
      }

      console.log('[DirectFileWriter] ✅ Storage initialized for', manifest.totalFiles, 'files');
    } catch (error: any) {
      console.error('[DirectFileWriter] ❌ Init failed:', error);
      
      if (error.name === 'AbortError') {
        throw new Error('User cancelled directory selection');
      }
      
      throw new Error(`Storage initialization failed: ${error.message}`);
    }
  }

  /**
   * 청크 데이터 쓰기
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    const HEADER_SIZE = 18;

    // 🚀 [버그 수정] 이미 완료된 경우 무시
    if (this.isFinalized) {
      return;
    }

    // 1. 최소 헤더 크기 체크
    if (packet.byteLength < HEADER_SIZE) {
      return;
    }

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // 2. EOS(End of Stream) 체크
    if (fileId === 0xFFFF) {
      console.log('[DirectFileWriter] EOS received. Bytes written:', this.totalBytesWritten, '/', this.totalSize);
      this.eosReceived = true;
      
      // 🚀 [버그 수정] 모든 데이터를 받았는지 확인 후 finalize
      await this.checkAndFinalize();
      return;
    }

    const offsetBigInt = view.getBigUint64(6, true);
    const size = view.getUint32(14, true);

    // 3. 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error(`[DirectFileWriter] ❌ Corrupt packet. Expected: ${HEADER_SIZE + size}, Got: ${packet.byteLength}`);
      return;
    }

    const handle = this.fileHandles.get(fileId);
    if (!handle) {
      console.error('[DirectFileWriter] ❌ No file handle for fileId:', fileId);
      return;
    }

    // 🚀 [버그 수정] 진행 중인 쓰기 작업 추적
    this.pendingWrites++;

    try {
      // 🚀 [Phase 1] 시작 시간 기록
      if (this.startTime === 0) {
        this.startTime = performance.now();
        this.lastProgressTime = this.startTime;
      }
      
      const writePosition = Number(offsetBigInt);
      const data = packet.slice(HEADER_SIZE, HEADER_SIZE + size);
      
      // 🚀 [버그 수정] write()에 position 옵션을 명시적으로 지정
      // seek() + write() 대신 write({ type: 'write', position, data }) 사용
      await handle.writable.write({
        type: 'write',
        position: writePosition,
        data: data
      });

      handle.written += size;
      this.totalBytesWritten += size;
      
      // 🚀 [UX 개선] 속도 계산 및 진행률 콜백 (100ms 간격)
      const now = performance.now();
      const timeSinceLastUpdate = now - this.lastProgressTime;
      
      if (timeSinceLastUpdate > 100) {
        const elapsed = timeSinceLastUpdate / 1000; // seconds
        const bytesInInterval = this.totalBytesWritten - this.lastBytesWritten;
        
        // 이동 평균으로 속도 계산 (더 부드러운 표시)
        const instantSpeed = bytesInInterval / elapsed;
        this.currentSpeed = this.currentSpeed === 0 
          ? instantSpeed 
          : this.currentSpeed * 0.7 + instantSpeed * 0.3;
        
        this.lastProgressTime = now;
        this.lastBytesWritten = this.totalBytesWritten;
        
        // 진행률 콜백 호출 (속도 정보 포함)
        if (this.onProgressCallback) {
          // 🚀 [UX 개선] 진행률을 0-100 범위로 제한
          const progress = Math.min(100, (this.totalBytesWritten / this.totalSize) * 100);
          (this.onProgressCallback as any)({
            progress,
            speed: this.currentSpeed,
            bytesTransferred: this.totalBytesWritten,
            totalBytes: this.totalSize
          });
        }
      }

    } catch (writeError: any) {
      if (writeError.message?.includes('closing') || writeError.message?.includes('closed')) {
        console.warn('[DirectFileWriter] Stream already closing, ignoring write');
      } else {
        console.error('[DirectFileWriter] Write error:', writeError);
      }
    } finally {
      this.pendingWrites--;
      
      // 🚀 [버그 수정] EOS를 받았고 모든 쓰기가 완료되면 finalize
      if (this.eosReceived) {
        await this.checkAndFinalize();
      }
    }
  }
  
  /**
   * 🚀 [버그 수정] 모든 데이터 수신 확인 후 finalize
   */
  private async checkAndFinalize(): Promise<void> {
    // 아직 쓰기 작업이 진행 중이면 대기
    if (this.pendingWrites > 0) {
      return;
    }
    
    // 모든 데이터를 받았는지 확인 (95% 이상이면 완료로 간주 - 헤더 오버헤드 고려)
    const completionRatio = this.totalBytesWritten / this.totalSize;
    if (completionRatio >= 0.95 || this.totalBytesWritten >= this.totalSize) {
      await this.finalize();
    } else {
      console.log('[DirectFileWriter] Waiting for more data...', 
        `${this.totalBytesWritten}/${this.totalSize} (${(completionRatio * 100).toFixed(1)}%)`);
    }
  }

  /**
   * 전송 완료 처리
   */
  private async finalize(): Promise<void> {
    // 🚀 [버그 수정] 중복 finalize 방지
    if (this.isFinalized) {
      console.warn('[DirectFileWriter] Already finalized, skipping');
      return;
    }
    this.isFinalized = true;
    
    let actualSize = 0;

    // 모든 파일 핸들 닫기
    for (const handle of this.fileHandles.values()) {
      try {
        await handle.writable.close();
        actualSize += handle.written;
      } catch (e: any) {
        // 이미 닫힌 스트림은 무시
        if (!e.message?.includes('closed') && !e.message?.includes('closing')) {
          console.error('[DirectFileWriter] Error closing handle:', e);
        }
      }
    }

    console.log('[DirectFileWriter] ✅ Transfer finalized. Total written:', actualSize);

    if (this.onCompleteCallback) {
      this.onCompleteCallback(actualSize);
    }
  }

  /**
   * 콜백 등록
   */
  public onProgress(callback: (progress: number) => void): void {
    this.onProgressCallback = callback;
  }

  public onComplete(callback: (actualSize: number) => void): void {
    this.onCompleteCallback = callback;
  }

  public onError(callback: (error: string) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * 정리
   */
  public async cleanup(): Promise<void> {
    for (const handle of this.fileHandles.values()) {
      try {
        await handle.writable.abort();
      } catch (e) {
        // Ignore
      }
    }

    this.fileHandles.clear();
    this.rootDirHandle = null;
    this.isFinalized = false;
    this.eosReceived = false;
    this.pendingWrites = 0;
    this.startTime = 0;
    this.lastProgressTime = 0;
    this.lastBytesWritten = 0;
    this.currentSpeed = 0;
    this.totalBytesWritten = 0;
  }
}
