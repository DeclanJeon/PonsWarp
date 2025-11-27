/**
 * Direct File Writer Service
 * OPFS 없이 청크를 받으면서 바로 다운로드
 * 
 * 전략:
 * - 송신자가 폴더를 ZIP으로 압축해서 보냄
 * - 수신자는 항상 단일 파일로 받음 (ZIP 또는 원본 파일)
 * - File System Access API (Chrome/Edge) 또는 StreamSaver (Firefox) 사용
 * 
 * 장점:
 * - 브라우저 저장소 quota 제한 없음
 * - 무제한 파일 크기 지원
 * - 메모리 효율적 (청크 단위 처리)
 * - 간단하고 안정적
 */

import streamSaver from 'streamsaver';

// StreamSaver MITM 설정
if (typeof window !== 'undefined') {
  streamSaver.mitm = `${window.location.origin}/mitm.html`;
}

export class DirectFileWriter {
  private manifest: any = null;
  private totalBytesWritten = 0;
  private totalSize = 0;
  private startTime = 0;
  private lastProgressTime = 0;
  private isFinalized = false;
  
  // 파일 Writer
  private writer: WritableStreamDefaultWriter | FileSystemWritableFileStream | null = null;
  private writerMode: 'file-system-access' | 'streamsaver' = 'streamsaver';

  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;

  /**
   * 스토리지 초기화
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();
    this.totalBytesWritten = 0;
    this.isFinalized = false;

    const fileCount = manifest.totalFiles || manifest.files.length;
    console.log('[DirectFileWriter] Initializing for', fileCount, 'files');
    console.log('[DirectFileWriter] Total size:', (manifest.totalSize / (1024 * 1024)).toFixed(2), 'MB');

    // 파일명 결정
    let fileName: string;
    if (fileCount === 1) {
      // 단일 파일: 원본 파일명
      fileName = manifest.files[0].path.split('/').pop()!;
    } else {
      // 여러 파일: ZIP 파일명
      fileName = (manifest.rootName || 'download') + '.zip';
    }

    try {
      await this.initFileWriter(fileName, manifest.totalSize);
      console.log('[DirectFileWriter] ✅ Initialized:', fileName);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new Error('USER_CANCELLED|사용자가 파일 저장을 취소했습니다.');
      }
      throw e;
    }
  }

  /**
   * 파일 Writer 초기화
   */
  private async initFileWriter(fileName: string, fileSize: number): Promise<void> {
    // @ts-ignore
    const hasFileSystemAccess = !!window.showSaveFilePicker;

    if (hasFileSystemAccess) {
      // File System Access API (Chrome/Edge)
      const ext = fileName.split('.').pop() || '';
      const accept: Record<string, string[]> = {};
      
      if (ext === 'zip') {
        accept['application/zip'] = ['.zip'];
      } else {
        accept['application/octet-stream'] = [`.${ext}`];
      }

      // @ts-ignore
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: 'File',
          accept
        }]
      });
      
      this.writer = await handle.createWritable();
      this.writerMode = 'file-system-access';
      console.log(`[DirectFileWriter] File System Access ready: ${fileName}`);
    } else {
      // StreamSaver (Firefox 등)
      const fileStream = streamSaver.createWriteStream(fileName, { size: fileSize });
      this.writer = fileStream.getWriter();
      this.writerMode = 'streamsaver';
      console.log(`[DirectFileWriter] StreamSaver ready: ${fileName}`);
    }
  }

  /**
   * 청크 데이터 쓰기
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    const HEADER_SIZE = 18;
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xFFFF) {
      console.log('[DirectFileWriter] EOS received, finalizing...');
      await this.finalize();
      return;
    }

    const size = view.getUint32(14, true);

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[DirectFileWriter] Corrupt packet');
      return;
    }

    if (!this.writer) {
      console.error('[DirectFileWriter] No writer available');
      return;
    }

    try {
      const data = new Uint8Array(packet, HEADER_SIZE, size);

      if (this.writerMode === 'file-system-access') {
        // File System Access: position 지정 쓰기
        const offset = Number(view.getBigUint64(6, true));
        await (this.writer as FileSystemWritableFileStream).write({
          type: 'write',
          position: offset,
          data: data,
        });
      } else {
        // StreamSaver: 순차 쓰기
        await (this.writer as WritableStreamDefaultWriter).write(data);
      }

      this.totalBytesWritten += size;
      this.reportProgress();

    } catch (error: any) {
      console.error('[DirectFileWriter] Write error:', error);
      this.onErrorCallback?.(`Write failed: ${error.message}`);
    }
  }

  /**
   * 진행률 보고
   */
  private reportProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressTime < 100) return;

    const elapsed = (now - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;
    
    // 🚀 [핵심 수정] 진행률을 100%로 제한 (ZIP 오버헤드로 인해 초과할 수 있음)
    const rawProgress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
    const progress = Math.min(100, rawProgress);

    this.onProgressCallback?.({
      progress,
      speed,
      bytesTransferred: this.totalBytesWritten,
      totalBytes: this.totalSize,
    });

    this.lastProgressTime = now;
  }

  /**
   * 전송 완료
   */
  private async finalize(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;

    if (this.writer) {
      try {
        if (this.writerMode === 'file-system-access') {
          const fsWriter = this.writer as FileSystemWritableFileStream;
          // @ts-ignore - locked 속성 체크
          if (!fsWriter.locked) {
            await fsWriter.close();
          }
        } else {
          const streamWriter = this.writer as WritableStreamDefaultWriter;
          // 스트림이 닫히지 않은 경우에만 닫기
          try {
            await streamWriter.close();
          } catch (closeErr: any) {
            // 이미 닫힌 경우 무시
            if (!closeErr.message?.includes('close') && !closeErr.message?.includes('closed')) {
              throw closeErr;
            }
          }
        }
        console.log('[DirectFileWriter] ✅ File completed:', this.totalBytesWritten, 'bytes');
      } catch (e: any) {
        // 이미 닫힌 스트림 에러는 무시
        if (!e.message?.includes('close') && !e.message?.includes('closed')) {
          console.error('[DirectFileWriter] Error closing file:', e);
        } else {
          console.log('[DirectFileWriter] ✅ File completed (stream already closed):', this.totalBytesWritten, 'bytes');
        }
      }
    }

    this.writer = null;
    this.onCompleteCallback?.(this.totalBytesWritten);
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

    if (this.writer) {
      try {
        if (this.writerMode === 'file-system-access') {
          await (this.writer as FileSystemWritableFileStream).abort();
        } else {
          await (this.writer as WritableStreamDefaultWriter).abort();
        }
      } catch (e) {
        // Ignore
      }
    }

    this.writer = null;
  }
}
