/**
 * Browser-Compatible File Writer Service
 * 브라우저 기본 다운로드 API를 사용한 파일 저장
 * 모든 브라우저에서 작동 (Chrome, Firefox, Safari, Edge)
 */

interface FileData {
  id: number;
  name: string;
  path: string;
  size: number;
  chunks: Map<number, ArrayBuffer>;
  nextExpectedOffset: number;
  totalReceived: number;
}

export class BrowserFileWriter {
  private files: Map<number, FileData> = new Map();
  private totalBytesWritten = 0;
  private totalSize = 0;
  private manifest: any = null;
  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private isFinalized = false;
  private startTime = 0;

  /**
   * 파일 메타데이터 초기화
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();

    try {
      console.log('[BrowserFileWriter] Initializing for', manifest.totalFiles, 'files');

      // 각 파일에 대한 메모리 버퍼 준비
      for (const file of manifest.files) {
        this.files.set(file.id, {
          id: file.id,
          name: file.name,
          path: file.path,
          size: file.size,
          chunks: new Map(),
          nextExpectedOffset: 0,
          totalReceived: 0,
        });

        console.log(`[BrowserFileWriter] File registered: ${file.path} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);
      }

      console.log('[BrowserFileWriter] ✅ Storage initialized');
    } catch (error: any) {
      console.error('[BrowserFileWriter] ❌ Init failed:', error);
      throw new Error(`Storage initialization failed: ${error.message}`);
    }
  }

  /**
   * 청크 데이터 수신 및 버퍼링
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    const HEADER_SIZE = 18;
    
    if (this.isFinalized) {
      return;
    }
    
    if (packet.byteLength < HEADER_SIZE) {
      console.warn('[BrowserFileWriter] Packet too small:', packet.byteLength);
      return;
    }
    
    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);
    
    // EOS(End of Stream) 체크
    if (fileId === 0xFFFF) {
      console.log('[BrowserFileWriter] EOS received, finalizing...');
      await this.finalize();
      return;
    }

    const seq = view.getUint32(2, true);
    const offsetBigInt = view.getBigUint64(6, true);
    const size = view.getUint32(14, true);
    const offset = Number(offsetBigInt);

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error(`[BrowserFileWriter] ❌ Corrupt packet. Expected: ${HEADER_SIZE + size}, Got: ${packet.byteLength}`);
      return;
    }

    const fileData = this.files.get(fileId);
    if (!fileData) {
      console.error('[BrowserFileWriter] ❌ No file data for fileId:', fileId);
      return;
    }

    try {
      // 헤더 제거하고 데이터만 추출
      const data = packet.slice(HEADER_SIZE, HEADER_SIZE + size);

      // 청크를 오프셋 순서대로 저장
      fileData.chunks.set(offset, data);
      fileData.totalReceived += size;
      this.totalBytesWritten += size;

      // 진행률 보고 (속도 계산 포함)
      if (this.onProgressCallback) {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;
        const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
        
        this.onProgressCallback({
          progress,
          speed,
          bytesTransferred: this.totalBytesWritten,
          totalBytes: this.totalSize
        });
      }
    } catch (error: any) {
      console.error('[BrowserFileWriter] ❌ Write error:', error);
      
      if (this.onErrorCallback) {
        this.onErrorCallback(`Write failed: ${error.message}`);
      }
    }
  }

  /**
   * 전송 완료 처리 - 브라우저 다운로드 트리거
   */
  private async finalize(): Promise<void> {
    if (this.isFinalized) {
      console.warn('[BrowserFileWriter] Already finalized, skipping');
      return;
    }
    
    console.log('[BrowserFileWriter] Starting finalization...');
    this.isFinalized = true;
    
    // 짧은 지연을 주어 in-flight 청크들이 도착할 시간 확보
    await new Promise(resolve => setTimeout(resolve, 100));
    
    let actualSize = 0;
    
    try {
      // 단일 파일인 경우
      if (this.files.size === 1) {
        const fileData = Array.from(this.files.values())[0];
        await this.downloadSingleFile(fileData);
        actualSize = fileData.totalReceived;
      } 
      // 여러 파일인 경우 - ZIP으로 압축
      else {
        actualSize = await this.downloadAsZip();
      }
      
      console.log('[BrowserFileWriter] ✅ Transfer finalized. Total written:', actualSize);
      
      if (this.onCompleteCallback) {
        this.onCompleteCallback(actualSize);
      }
    } catch (error: any) {
      console.error('[BrowserFileWriter] ❌ Finalization error:', error);
      if (this.onErrorCallback) {
        this.onErrorCallback(`Download failed: ${error.message}`);
      }
    }
  }

  /**
   * 단일 파일 다운로드
   */
  private async downloadSingleFile(fileData: FileData): Promise<void> {
    console.log('[BrowserFileWriter] Downloading single file:', fileData.name);
    
    // 청크들을 오프셋 순서대로 정렬하여 병합
    const sortedOffsets = Array.from(fileData.chunks.keys()).sort((a, b) => a - b);
    const chunks: ArrayBuffer[] = [];
    
    for (const offset of sortedOffsets) {
      chunks.push(fileData.chunks.get(offset)!);
    }
    
    // Blob 생성
    const blob = new Blob(chunks);
    
    // 다운로드 트리거
    this.triggerDownload(blob, fileData.name);
  }

  /**
   * 여러 파일을 ZIP으로 압축하여 다운로드
   */
  private async downloadAsZip(): Promise<number> {
    console.log('[BrowserFileWriter] Creating ZIP archive...');
    
    // fflate 동적 import
    const { zip } = await import('fflate');
    
    const zipFiles: Record<string, Uint8Array> = {};
    let totalSize = 0;
    
    // 각 파일을 ZIP에 추가
    for (const fileData of this.files.values()) {
      // 청크들을 오프셋 순서대로 정렬하여 병합
      const sortedOffsets = Array.from(fileData.chunks.keys()).sort((a, b) => a - b);
      const chunks: Uint8Array[] = [];
      
      for (const offset of sortedOffsets) {
        chunks.push(new Uint8Array(fileData.chunks.get(offset)!));
      }
      
      // 모든 청크를 하나의 Uint8Array로 병합
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(totalLength);
      let position = 0;
      
      for (const chunk of chunks) {
        merged.set(chunk, position);
        position += chunk.length;
      }
      
      zipFiles[fileData.path] = merged;
      totalSize += merged.length;
    }
    
    // ZIP 생성 (비동기)
    return new Promise((resolve, reject) => {
      zip(zipFiles, { level: 0 }, (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        
        console.log('[BrowserFileWriter] ZIP created, size:', data.length);
        
        // ZIP 다운로드
        const blob = new Blob([data], { type: 'application/zip' });
        const zipName = this.manifest?.rootName 
          ? `${this.manifest.rootName}.zip` 
          : 'download.zip';
        
        this.triggerDownload(blob, zipName);
        resolve(totalSize);
      });
    });
  }

  /**
   * 브라우저 다운로드 트리거 (모든 브라우저 호환)
   */
  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    
    document.body.appendChild(a);
    a.click();
    
    // 정리
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    
    console.log('[BrowserFileWriter] Download triggered:', filename);
  }

  /**
   * 콜백 등록
   */
  public onProgress(callback: (data: any) => void): void {
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
    this.isFinalized = true;
    
    // 메모리 정리
    for (const fileData of this.files.values()) {
      fileData.chunks.clear();
    }
    
    this.files.clear();
  }
}
