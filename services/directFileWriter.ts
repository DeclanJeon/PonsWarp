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

    // 1. 최소 헤더 크기 체크
    if (packet.byteLength < HEADER_SIZE) {
      return;
    }

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // 2. EOS(End of Stream) 체크
    if (fileId === 0xFFFF) {
      await this.finalize();
      return;
    }

    const seq = view.getUint32(2, true);
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

    try {
      // 🚨 [최적화] slice 대신 subarray 사용 가능 여부 확인
      // ArrayBuffer의 slice는 복사를 수행하므로, DataView나 TypedArray로 처리
      // 여기서는 명확성을 위해 slice 사용하되, offset을 정확히 seek
      
      const writePosition = Number(offsetBigInt);
      
      // 순서가 뒤섞여 왔을 때를 대비해 seek를 반드시 수행
      await handle.writable.seek(writePosition);
      
      const data = packet.slice(HEADER_SIZE, HEADER_SIZE + size);
      await handle.writable.write(data);

      handle.written += size;
      this.totalBytesWritten += size;
      
      // 진행률 콜백 호출
      if (this.onProgressCallback) {
        const progress = (this.totalBytesWritten / this.totalSize) * 100;
        this.onProgressCallback(progress);
      }

    } catch (writeError: any) {
       console.error('[DirectFileWriter] Write error:', writeError);
    }
  }

  /**
   * 전송 완료 처리
   */
  private async finalize(): Promise<void> {
    let actualSize = 0;

    // 모든 파일 핸들 닫기
    for (const handle of this.fileHandles.values()) {
      try {
        await handle.writable.close();
        actualSize += handle.written;
      } catch (e) {
        console.error('[DirectFileWriter] Error closing handle:', e);
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
  }
}
