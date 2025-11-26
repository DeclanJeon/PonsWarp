/**
 * OPFS File Writer Service
 * Origin Private File System을 사용하여 수신하면서 바로 디스크에 쓰기
 * 완료 후 StreamSaver로 한 번만 다운로드
 *
 * 🚀 장점:
 * - 메모리 부담 없음 (수신 즉시 OPFS에 쓰기)
 * - 2GB+ 파일 지원
 * - 모든 브라우저 지원 (Chrome, Firefox, Safari, Edge)
 */

import streamSaver from 'streamsaver';

interface FileWriteHandle {
  writable: FileSystemWritableFileStream;
  written: number;
  size: number;
}

export class OPFSFileWriter {
  private files: Map<number, FileWriteHandle> = new Map();
  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private transferDir: FileSystemDirectoryHandle | null = null;
  private totalBytesWritten = 0;
  private totalSize = 0;
  private manifest: any = null;
  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private isFinalized = false;
  private startTime = 0;
  private lastProgressTime = 0;
  private currentSpeed = 0;

  /**
   * OPFS 스토리지 초기화 - 실제로 OPFS에 파일 핸들 생성
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();

    try {
      // OPFS 지원 확인
      if (!navigator.storage?.getDirectory) {
        throw new Error('OPFS not supported in this browser');
      }

      // Storage persistence 요청
      if (navigator.storage?.persist) {
        await navigator.storage.persist();
      }

      // 할당량 확인
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const available = (estimate.quota || 0) - (estimate.usage || 0);

        if (manifest.totalSize > available) {
          await this.cleanupOldTransfers();

          const newEstimate = await navigator.storage.estimate();
          const newAvailable = (newEstimate.quota || 0) - (newEstimate.usage || 0);

          if (manifest.totalSize > newAvailable) {
            const requiredMB = (manifest.totalSize / (1024 * 1024)).toFixed(2);
            const availableMB = (newAvailable / (1024 * 1024)).toFixed(2);
            throw new Error(`Insufficient storage: need ${requiredMB}MB, available ${availableMB}MB`);
          }
        }
      }

      this.opfsRoot = await navigator.storage.getDirectory();
      this.transferDir = await this.opfsRoot.getDirectoryHandle(manifest.transferId, { create: true });

      console.log('[OPFSFileWriter] Initializing for', manifest.totalFiles, 'files');

      // 각 파일에 대한 writable stream 생성
      for (const file of manifest.files) {
        const pathParts = file.path.split('/');
        const fileName = pathParts.pop()!;
        let currentDir = this.transferDir;

        // 폴더 구조 생성
        for (const part of pathParts) {
          if (part) {
            currentDir = await currentDir.getDirectoryHandle(part, { create: true });
          }
        }

        // 파일 핸들 생성
        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();

        this.files.set(file.id, {
          writable,
          written: 0,
          size: file.size,
        });

        console.log(`[OPFSFileWriter] File handle created: ${file.path}`);
      }

      console.log('[OPFSFileWriter] ✅ Storage initialized');
    } catch (error: any) {
      console.error('[OPFSFileWriter] ❌ Init failed:', error);
      throw new Error(`Storage initialization failed: ${error.message}`);
    }
  }

  /**
   * 청크 데이터를 OPFS에 직접 쓰기
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    const HEADER_SIZE = 18;
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xFFFF) {
      console.log('[OPFSFileWriter] EOS received, finalizing...');
      await this.finalize();
      return;
    }

    const offsetBigInt = view.getBigUint64(6, true);
    const size = view.getUint32(14, true);

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[OPFSFileWriter] Corrupt packet');
      return;
    }

    const handle = this.files.get(fileId);
    if (!handle) {
      console.error('[OPFSFileWriter] No file handle for fileId:', fileId);
      return;
    }

    try {
      const writePosition = Number(offsetBigInt);
      const data = packet.slice(HEADER_SIZE, HEADER_SIZE + size);

      // OPFS에 쓰기 (position 지정)
      await handle.writable.write({
        type: 'write',
        position: writePosition,
        data: data,
      });

      handle.written += size;
      this.totalBytesWritten += size;

      // 진행률 콜백 (100ms 간격)
      const now = Date.now();
      if (now - this.lastProgressTime > 100) {
        const elapsed = (now - this.startTime) / 1000;
        this.currentSpeed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;

        if (this.onProgressCallback) {
          const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
          this.onProgressCallback({
            progress,
            speed: this.currentSpeed,
            bytesTransferred: this.totalBytesWritten,
            totalBytes: this.totalSize,
          });
        }

        this.lastProgressTime = now;
      }
    } catch (error: any) {
      console.error('[OPFSFileWriter] Write error:', error);
    }
  }

  /**
   * 전송 완료 - 파일 닫고 다운로드 시작
   */
  private async finalize(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;

    let actualSize = 0;

    // 모든 writable stream 닫기
    for (const handle of this.files.values()) {
      try {
        await handle.writable.close();
        actualSize += handle.written;
      } catch (e: any) {
        if (!e.message?.includes('closed')) {
          console.error('[OPFSFileWriter] Error closing handle:', e);
        }
      }
    }

    console.log('[OPFSFileWriter] Files closed. Total written:', actualSize);
    console.log('[OPFSFileWriter] Starting download from OPFS...');

    try {
      // OPFS에서 파일 다운로드
      await this.downloadFromOPFS();

      // OPFS 정리
      await this.cleanupTransferDir();

      if (this.onCompleteCallback) {
        this.onCompleteCallback(actualSize);
      }
    } catch (error: any) {
      console.error('[OPFSFileWriter] Download failed:', error);
      if (this.onErrorCallback) {
        this.onErrorCallback(`Download failed: ${error.message}`);
      }
    }
  }

  /**
   * OPFS에서 파일 다운로드 (StreamSaver 사용)
   */
  private async downloadFromOPFS(): Promise<void> {
    if (!this.transferDir || !this.manifest) return;

    const files = this.manifest.files;

    // 단일 파일
    if (files.length === 1) {
      await this.downloadSingleFile(files[0]);
      return;
    }

    // 다중 파일 - ZIP 스트리밍
    await this.downloadAsZipStream();
  }

  /**
   * 단일 파일 다운로드
   */
  private async downloadSingleFile(fileInfo: any): Promise<void> {
    if (!this.transferDir) return;

    const pathParts = fileInfo.path.split('/');
    const fileName = pathParts.pop()!;
    let currentDir = this.transferDir;

    for (const part of pathParts) {
      if (part) {
        currentDir = await currentDir.getDirectoryHandle(part);
      }
    }

    const fileHandle = await currentDir.getFileHandle(fileName);
    const file = await fileHandle.getFile();

    console.log('[OPFSFileWriter] Downloading single file:', fileName, 'size:', file.size);

    // StreamSaver로 다운로드
    const fileStream = streamSaver.createWriteStream(fileName, {
      size: file.size,
    });

    const readableStream = file.stream();
    await readableStream.pipeTo(fileStream);

    console.log('[OPFSFileWriter] Single file downloaded:', fileName);
  }

  /**
   * 다중 파일 ZIP 스트리밍 다운로드
   */
  private async downloadAsZipStream(): Promise<void> {
    console.log('[OPFSFileWriter] Creating streaming ZIP...');

    const { Zip, ZipPassThrough } = await import('fflate');

    const zipName = this.manifest?.rootName ? `${this.manifest.rootName}.zip` : 'download.zip';

    const fileStream = streamSaver.createWriteStream(zipName);
    const writer = fileStream.getWriter();

    return new Promise((resolve, reject) => {
      const zipStream = new Zip((err, data, final) => {
        if (err) {
          writer.abort();
          reject(err);
          return;
        }

        if (data) {
          writer.write(data).catch(reject);
        }

        if (final) {
          writer.close().then(resolve).catch(reject);
        }
      });

      this.addFilesToZipFromOPFS(zipStream)
        .then(() => zipStream.end())
        .catch((err) => {
          writer.abort();
          reject(err);
        });
    });
  }

  /**
   * OPFS 파일들을 ZIP 스트림에 추가
   */
  private async addFilesToZipFromOPFS(zipStream: any): Promise<void> {
    if (!this.transferDir) return;

    const { ZipPassThrough } = await import('fflate');

    for (const fileInfo of this.manifest.files) {
      const pathParts = fileInfo.path.split('/');
      const fileName = pathParts.pop()!;
      let currentDir = this.transferDir;

      for (const part of pathParts) {
        if (part) {
          currentDir = await currentDir.getDirectoryHandle(part);
        }
      }

      const fileHandle = await currentDir.getFileHandle(fileName);
      const file = await fileHandle.getFile();

      console.log('[OPFSFileWriter] Adding to ZIP:', fileInfo.path, 'size:', file.size);

      const fileEntry = new ZipPassThrough(fileInfo.path);
      zipStream.add(fileEntry);

      // 파일을 청크 단위로 읽어서 ZIP에 추가
      const reader = file.stream().getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          fileEntry.push(new Uint8Array(0), true);
          break;
        }

        fileEntry.push(value, false);
      }
    }
  }

  /**
   * 전송 디렉토리 정리
   */
  private async cleanupTransferDir(): Promise<void> {
    if (!this.opfsRoot || !this.manifest) return;

    try {
      await this.opfsRoot.removeEntry(this.manifest.transferId, { recursive: true });
      console.log('[OPFSFileWriter] Transfer directory cleaned up');
    } catch (e) {
      console.warn('[OPFSFileWriter] Cleanup failed:', e);
    }
  }

  /**
   * 오래된 전송 정리
   */
  private async cleanupOldTransfers(): Promise<number> {
    if (!this.opfsRoot) {
      this.opfsRoot = await navigator.storage.getDirectory();
    }

    let deletedCount = 0;

    try {
      // @ts-ignore
      for await (const [name, handle] of this.opfsRoot.entries()) {
        if (handle.kind === 'directory') {
          try {
            await this.opfsRoot.removeEntry(name, { recursive: true });
            deletedCount++;
          } catch (e) {
            // Skip
          }
        }
      }
    } catch (e) {
      console.warn('[OPFSFileWriter] Cleanup iteration failed:', e);
    }

    console.log('[OPFSFileWriter] Cleaned up', deletedCount, 'old transfers');
    return deletedCount;
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

    // 열린 writable stream 닫기
    for (const handle of this.files.values()) {
      try {
        await handle.writable.abort();
      } catch (e) {
        // Ignore
      }
    }

    this.files.clear();

    // OPFS 정리
    try {
      await this.cleanupTransferDir();
    } catch (e) {
      // Ignore
    }
  }
}
