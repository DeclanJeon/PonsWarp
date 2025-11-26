/**
 * Browser-Compatible File Writer Service
 * 브라우저 기본 다운로드 API를 사용한 파일 저장
 * 모든 브라우저에서 작동 (Chrome, Firefox, Safari, Edge)
 * 
 * 🚀 2GB+ 파일 지원: 스트리밍 ZIP 생성
 */

import streamSaver from 'streamsaver';

// 2GB 제한 (브라우저 Blob 한계)
const BLOB_SIZE_LIMIT = 2 * 1024 * 1024 * 1024 - 1; // 2GB - 1 byte

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
   * 🚀 2GB 이상 파일은 스트리밍 방식 사용
   */
  private async downloadAsZip(): Promise<number> {
    console.log('[BrowserFileWriter] Creating ZIP archive...');
    
    // 총 크기 계산
    let totalSize = 0;
    for (const fileData of this.files.values()) {
      totalSize += fileData.totalReceived;
    }
    
    console.log('[BrowserFileWriter] Total size:', totalSize, 'bytes');
    
    // 2GB 이상이면 스트리밍 방식 사용
    if (totalSize > BLOB_SIZE_LIMIT) {
      console.log('[BrowserFileWriter] Using streaming ZIP (size > 2GB)');
      return this.downloadAsZipStreaming();
    }
    
    // 2GB 미만이면 기존 방식 사용
    return this.downloadAsZipInMemory();
  }

  /**
   * 🚀 스트리밍 ZIP 다운로드 (2GB+ 지원)
   * StreamSaver + fflate 스트리밍 조합
   */
  private async downloadAsZipStreaming(): Promise<number> {
    console.log('[BrowserFileWriter] Starting streaming ZIP download...');
    
    const { Zip, ZipPassThrough } = await import('fflate');
    
    const zipName = this.manifest?.rootName 
      ? `${this.manifest.rootName}.zip` 
      : 'download.zip';
    
    // StreamSaver로 쓰기 스트림 생성
    const fileStream = streamSaver.createWriteStream(zipName);
    const writer = fileStream.getWriter();
    
    let totalWritten = 0;
    
    return new Promise((resolve, reject) => {
      // fflate 스트리밍 ZIP 생성
      const zipStream = new Zip((err, data, final) => {
        if (err) {
          writer.abort();
          reject(err);
          return;
        }
        
        if (data) {
          writer.write(data).catch(reject);
          totalWritten += data.length;
        }
        
        if (final) {
          writer.close().then(() => {
            console.log('[BrowserFileWriter] Streaming ZIP complete:', totalWritten, 'bytes');
            resolve(totalWritten);
          }).catch(reject);
        }
      });
      
      // 각 파일을 스트리밍으로 ZIP에 추가
      this.addFilesToZipStream(zipStream).then(() => {
        zipStream.end();
      }).catch((err) => {
        writer.abort();
        reject(err);
      });
    });
  }

  /**
   * ZIP 스트림에 파일들 추가
   */
  private async addFilesToZipStream(zipStream: any): Promise<void> {
    const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB 청크 단위로 처리
    
    for (const fileData of this.files.values()) {
      console.log('[BrowserFileWriter] Adding to ZIP stream:', fileData.path);
      
      // ZipPassThrough: 압축 없이 스트리밍 (대용량 파일에 적합)
      const { ZipPassThrough } = await import('fflate');
      const fileEntry = new ZipPassThrough(fileData.path);
      zipStream.add(fileEntry);
      
      // 청크들을 오프셋 순서대로 정렬
      const sortedOffsets = Array.from(fileData.chunks.keys()).sort((a, b) => a - b);
      
      // 청크 단위로 스트리밍
      for (const offset of sortedOffsets) {
        const chunk = fileData.chunks.get(offset)!;
        fileEntry.push(new Uint8Array(chunk), false);
        
        // 메모리 해제를 위해 처리된 청크 삭제
        fileData.chunks.delete(offset);
        
        // 이벤트 루프 양보 (UI 블로킹 방지)
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      
      // 파일 완료
      fileEntry.push(new Uint8Array(0), true);
    }
  }

  /**
   * 메모리 내 ZIP 생성 (2GB 미만용)
   */
  private async downloadAsZipInMemory(): Promise<number> {
    console.log('[BrowserFileWriter] Using in-memory ZIP...');
    
    const { zip } = await import('fflate');
    
    const zipFiles: Record<string, Uint8Array> = {};
    let totalSize = 0;
    
    // 각 파일을 ZIP에 추가
    for (const fileData of this.files.values()) {
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
        
        // ZIP 다운로드 - ArrayBuffer로 변환하여 타입 호환성 확보
        const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/zip' });
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
