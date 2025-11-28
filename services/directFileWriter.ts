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
 * 
 * 🚀 [개선] ReorderingBuffer 통합
 * - Multi-Channel 전송 시 패킷 순서 보장
 * - StreamSaver 모드에서 파일 손상 방지
 */

import streamSaver from 'streamsaver';
import { ReorderingBuffer } from './reorderingBuffer';
import { logInfo, logError, logWarn } from '../utils/logger';

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
  
  // 🚀 [추가] 재정렬 버퍼 (StreamSaver 모드용)
  private reorderingBuffer: ReorderingBuffer | null = null;

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
      logInfo('[DirectFileWriter]', `✅ Initialized: ${fileName}`);
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
      // FileSystem 모드에서는 OS 레벨에서 Random Access Write가 가능하므로
      // 애플리케이션 레벨의 ReorderingBuffer가 필요 없음
      this.reorderingBuffer = null;
      logInfo('[DirectFileWriter]', `File System Access ready: ${fileName} (Random Access Enabled)`);
    } else {
      // StreamSaver (Firefox 등)
      const fileStream = streamSaver.createWriteStream(fileName, { size: fileSize });
      this.writer = fileStream.getWriter();
      this.writerMode = 'streamsaver';
      // StreamSaver는 순서가 틀리면 파일이 깨지므로 버퍼 필수
      this.reorderingBuffer = new ReorderingBuffer(0);
      logInfo('[DirectFileWriter]', `StreamSaver ready: ${fileName} (Sequential Write Only - Buffer Active)`);
    }
  }

  /**
   * 청크 데이터 쓰기
   * 🚀 [개선] ReorderingBuffer를 통한 순서 보장
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    const HEADER_SIZE = 18;
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xFFFF) {
      logInfo('[DirectFileWriter]', 'EOS received, finalizing...');
      await this.finalize();
      return;
    }

    const size = view.getUint32(14, true);
    // Offset 추출
    const offset = Number(view.getBigUint64(6, true));

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      logError('[DirectFileWriter]', 'Corrupt packet');
      return;
    }

    if (!this.writer) {
      logError('[DirectFileWriter]', 'No writer available');
      return;
    }

    try {
      const data = new Uint8Array(packet, HEADER_SIZE, size);

      if (this.writerMode === 'file-system-access') {
        // [Case A] File System Access: Random Access 가능
        // 버퍼 없이 즉시 해당 위치에 씀 (가장 빠름)
        await (this.writer as FileSystemWritableFileStream).write({
          type: 'write',
          position: offset,
          data: data,
        });
        
        // 주의: totalBytesWritten 계산이 비순차적일 수 있으나,
        // 진행률 표시를 위해 대략적으로 누적
        this.totalBytesWritten += size;
        this.reportProgress();
      } else {
        // [Case B] StreamSaver: 순차 쓰기 필수
        if (!this.reorderingBuffer) {
          throw new Error('Buffer not initialized for StreamSaver');
        }

        // 버퍼에 넣고 순서가 맞는 청크들만 돌려받음
        const chunksToWrite = this.reorderingBuffer.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), offset);

        // 반환된 순서대로 쓰기 수행
        for (const chunk of chunksToWrite) {
          await (this.writer as WritableStreamDefaultWriter).write(new Uint8Array(chunk));
          this.totalBytesWritten += chunk.byteLength;
        }

        // 진행률 업데이트 (실제 기록된 바이트 기준)
        if (chunksToWrite.length > 0) {
          this.reportProgress();
        }
      }

    } catch (error: any) {
      logError('[DirectFileWriter]', 'Write error:', error);
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
   * 🚀 [개선] ReorderingBuffer 정리 및 데이터 손실 경고
   */
  private async finalize(): Promise<void> {
    console.log('[DirectFileWriter] 🏁 finalize() called, isFinalized:', this.isFinalized);
    if (this.isFinalized) {
      console.log('[DirectFileWriter] ⚠️ Already finalized, skipping');
      return;
    }
    this.isFinalized = true;

    // 버퍼 정리 및 데이터 손실 체크
    if (this.reorderingBuffer) {
      const stats = this.reorderingBuffer.getStatus();
      if (stats.bufferedCount > 0) {
        logError('[DirectFileWriter]', `Finalizing with ${stats.bufferedCount} chunks still in buffer (Potential Data Loss)`);
      }
      this.reorderingBuffer.clear();
      this.reorderingBuffer = null;
    }

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
        logInfo('[DirectFileWriter]', `✅ File completed: ${this.totalBytesWritten} bytes`);
      } catch (e: any) {
        // 이미 닫힌 스트림 에러는 무시
        if (!e.message?.includes('close') && !e.message?.includes('closed')) {
          logError('[DirectFileWriter]', 'Error closing file:', e);
        } else {
          logInfo('[DirectFileWriter]', `✅ File completed (stream already closed): ${this.totalBytesWritten} bytes`);
        }
      }
    }

    this.writer = null;
    
    console.log('[DirectFileWriter] 📞 Calling onCompleteCallback, exists:', !!this.onCompleteCallback);
    if (this.onCompleteCallback) {
      console.log('[DirectFileWriter] ✅ Executing onCompleteCallback with bytes:', this.totalBytesWritten);
      this.onCompleteCallback(this.totalBytesWritten);
      console.log('[DirectFileWriter] ✅ onCompleteCallback executed');
    } else {
      console.warn('[DirectFileWriter] ⚠️ No onCompleteCallback registered!');
    }
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
   * 🚀 [개선] ReorderingBuffer 정리 추가
   */
  public async cleanup(): Promise<void> {
    this.isFinalized = true;

    // 버퍼 정리
    if (this.reorderingBuffer) {
      this.reorderingBuffer.clear();
      this.reorderingBuffer = null;
    }

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
