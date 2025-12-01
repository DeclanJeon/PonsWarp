import streamSaver from 'streamsaver';
import { ReorderingBuffer } from './reorderingBuffer';
import { logInfo, logError, logWarn } from '../utils/logger';
import { bufferPool } from '../utils/bufferPool';
import { EncryptionService } from '../utils/encryption';
import { formatBytes } from '../utils/fileUtils';

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
  
  private writer: WritableStreamDefaultWriter | FileSystemWritableFileStream | null = null;
  private writerMode: 'file-system-access' | 'streamsaver' = 'streamsaver';
  private reorderingBuffer: ReorderingBuffer | null = null;
  private encryptionKey: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeBuffer: Uint8Array[] = [];
  private currentBatchSize = 0;
  private readonly BATCH_THRESHOLD = 8 * 1024 * 1024; // 8MB
  
  // 🚀 [핵심] 버퍼에 적재된 바이트 수 추적 (디스크 쓰기 전 데이터 포함)
  private pendingBytesInBuffer = 0;
  

  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private onNackCallback: ((nack: any) => void) | null = null;

  /**
   * 저장소 초기화
   */
  public async initStorage(manifest: any, encryptionKey?: string): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();
    this.totalBytesWritten = 0;
    this.isFinalized = false;
    this.writeBuffer = [];
    this.currentBatchSize = 0;
    this.pendingBytesInBuffer = 0;
    
    // 🔐 암호화 키 설정
    this.encryptionKey = encryptionKey || null;

    const fileCount = manifest.totalFiles || manifest.files.length;
    console.log('[DirectFileWriter] Initializing for', fileCount, 'files');
    console.log('[DirectFileWriter] Total size:', (manifest.totalSize / (1024 * 1024)).toFixed(2), 'MB');
    if (this.encryptionKey) {
      console.log('[DirectFileWriter] 🔐 Encryption enabled');
    }

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

      let handle: FileSystemFileHandle | undefined;
      
      // @ts-ignore
      handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: 'File',
          accept
        }]
      });

      this.writer = await handle.createWritable();
      this.writerMode = 'file-system-access';
      this.reorderingBuffer = new ReorderingBuffer(this.totalBytesWritten);
      this.reorderingBuffer.onNack((nack) => {
          this.onNackCallback?.(nack);
      });
      
      logInfo('[DirectFileWriter]', `File System Access ready: ${fileName} (Batch Mode ON)`);
    } else {
      const isZip = fileName.endsWith('.zip');
      const streamConfig = isZip ? {} : { size: fileSize };
      const fileStream = streamSaver.createWriteStream(fileName, streamConfig);
      this.writer = fileStream.getWriter();
      this.writerMode = 'streamsaver';
      this.reorderingBuffer = new ReorderingBuffer(this.totalBytesWritten);
      this.reorderingBuffer.onNack((nack) => {
          this.onNackCallback?.(nack);
      });
      
      logInfo('[DirectFileWriter]', `StreamSaver ready: ${fileName} (Batch Mode ON)`);
    }
  }

  /**
   * 청크 데이터 쓰기 (수정됨)
   * 🚀 비동기 큐를 사용하여 쓰기 작업의 순차적 실행 보장
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    // 큐에 새로운 작업을 추가 (이전 작업이 끝나야 실행됨)
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.processChunkInternal(packet);
      } catch (error: any) {
        logError('[DirectFileWriter]', 'Write queue error:', error);
        this.onErrorCallback?.(`Write failed: ${error.message}`);
        throw error; // 에러 전파하여 체인 중단
      }
    }).catch(err => {
      // 이미 처리된 에러는 무시하되, 체인은 유지
      console.warn('[DirectFileWriter] Recovering from write error');
    });

    // 호출자는 큐의 완료를 기다림
    return this.writeQueue;
  }

  /**
   * 🚀 [신규] 실제 쓰기 로직을 분리 (내부용)
   */
  private async processChunkInternal(packet: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    const HEADER_SIZE = 18;
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xFFFF) {
      logInfo('[DirectFileWriter]', 'EOS received signal.');
      await this.flushBuffer(); // 남은 데이터 모두 쓰기
      await this.finalize();
      return;
    }

    const chunkIndex = view.getUint32(2, true); // 🔐 패킷 헤더에서 청크 인덱스 추출
    const size = view.getUint32(14, true);
    const offset = Number(view.getBigUint64(6, true));

    // 🚨 [핵심 수정] 용량 초과 방지 - 버퍼 포함 총 바이트가 totalSize를 초과하면 무시
    const totalReceived = this.totalBytesWritten + this.pendingBytesInBuffer;
    if (this.totalSize > 0 && totalReceived >= this.totalSize) {
      logWarn('[DirectFileWriter]', `Ignoring chunk: already reached totalSize (${this.totalSize})`);
      return;
    }

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      logError('[DirectFileWriter]', 'Corrupt packet');
      return;
    }

    if (!this.writer || !this.reorderingBuffer) {
      logError('[DirectFileWriter]', 'No writer available');
      return;
    }

    let data = new Uint8Array(packet, HEADER_SIZE, size);
    

    // 1. 순서 정렬 (Reordering) - 모든 모드에서 사용
    const chunksToWrite = this.reorderingBuffer.push(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      offset
    );

    // 2. 메모리 버퍼에 적재 (Batching)
    for (const chunk of chunksToWrite) {
      this.writeBuffer.push(new Uint8Array(chunk));
      this.currentBatchSize += chunk.byteLength;
      this.pendingBytesInBuffer += chunk.byteLength; // 버퍼에 적재된 바이트 추적
    }

    // 3. 임계값(8MB) 넘으면 디스크에 쓰기 (Flushing)
    if (this.currentBatchSize >= this.BATCH_THRESHOLD) {
      await this.flushBuffer();
    }
  }

  /**
   * 🚀 [핵심] 메모리에 모아둔 데이터를 한 번에 디스크로 전송 (메모리 풀링 적용)
   */
  private async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) return;

    // 1. 풀에서 거대 버퍼 대여 (Slab Allocation)
    // 정확히 currentBatchSize 크기를 요청하거나,
    // 성능을 위해 표준 사이즈(예: 8MB, 16MB)로 올림(Rounding)할 수도 있음
    // 여기서는 정확한 크기로 요청 (BufferPool이 알아서 처리하거나 할당함)
    const mergedBuffer = bufferPool.acquire(this.currentBatchSize);
    
    // 2. 데이터 병합 (Merge)
    let offset = 0;
    for (const chunk of this.writeBuffer) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      // 3. 디스크 쓰기
      if (this.writerMode === 'file-system-access') {
        const fsWriter = this.writer as FileSystemWritableFileStream;
        // 🚀 타입 호환을 위해 Uint8Array를 그대로 전달
        // @ts-ignore - FileSystem API 타입 정의와 실제 구현 간의 불일치 우회
        await fsWriter.write({
          type: 'write',
          position: this.totalBytesWritten, // 순차적으로 쓰므로 누적 오프셋 사용
          data: mergedBuffer, // 🚀 Uint8Array 직접 전달
        });
      } else {
        const streamWriter = this.writer as WritableStreamDefaultWriter;
        await streamWriter.ready;
        await streamWriter.write(mergedBuffer); // 🚀 Uint8Array 직접 전달
      }
    } catch (e) {
      logError('[DirectFileWriter]', 'Write failed', e);
      throw e;
    } finally {
      // 4. 🚀 [핵심] 사용 완료한 버퍼 반납 (재사용)
      // StreamSaver 등에서 버퍼를 계속 잡고 있을 수 있으므로,
      // 확실히 쓰기가 끝난 시점에 반납해야 함
      // FileSystemAccess API의 write는 await시 완료를 보장함
      bufferPool.release(mergedBuffer);
    }

    // 5. 상태 업데이트 및 초기화
    this.totalBytesWritten += this.currentBatchSize;
    this.pendingBytesInBuffer -= this.currentBatchSize; // 버퍼에서 디스크로 이동했으므로 감소
    this.writeBuffer = []; // 참조 해제 (작은 청크들은 GC 대상이 됨)
    this.currentBatchSize = 0;
    
    
    this.reportProgress();
  }

  /**
   * 🚀 [핵심 요구사항] 진행률/속도가 실제 데이터 전송과 정확히 일치해야 함
   * 
   * - progress: 실제 수신된 바이트 / 전체 바이트 * 100
   * - speed: 실제 수신된 바이트 / 경과 시간
   * - bytesTransferred: 실제 수신된 바이트 (totalBytesWritten)
   */
  private reportProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressTime < 100) return;

    const elapsed = (now - this.startTime) / 1000;
    
    // 🚀 [정확성] 실제 수신된 바이트 기반 속도 계산
    const speed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;
    
    // 🚀 [정확성] 실제 수신된 바이트 기반 진행률 계산 (100% 초과 방지)
    const rawProgress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
    const progress = Math.min(100, rawProgress);

    this.onProgressCallback?.({
      progress,
      speed,
      bytesTransferred: this.totalBytesWritten,
      totalBytesSent: this.totalBytesWritten, // 호환성
      totalBytes: this.totalSize,
    });

    this.lastProgressTime = now;
  }

  /**
   * 전송 완료
   * 🚀 [개선] ReorderingBuffer 정리 및 파일 크기 Truncate
   */
  private async finalize(): Promise<void> {
    console.log('[DirectFileWriter] 🏁 finalize() called, isFinalized:', this.isFinalized);
    if (this.isFinalized) {
      console.log('[DirectFileWriter] ⚠️ Already finalized, skipping');
      return;
    }
    this.isFinalized = true;

    // 버퍼에 남은 잔여 데이터 강제 플러시
    await this.flushBuffer();

    // 🚨 ReorderingBuffer에 남은 청크 강제 배출 (순서 무시)
    if (this.reorderingBuffer) {
      const stats = this.reorderingBuffer.getStatus();
      if (stats.bufferedCount > 0) {
        logWarn('[DirectFileWriter]', `Finalizing with ${stats.bufferedCount} chunks still in buffer - forcing flush`);
        
        // 남은 청크를 강제로 배출
        const remainingChunks = this.reorderingBuffer.forceFlushAll();
        
        // 배출된 청크를 버퍼에 추가
        for (const chunk of remainingChunks) {
          this.writeBuffer.push(new Uint8Array(chunk));
          this.currentBatchSize += chunk.byteLength;
        }
        
        // 최종 플러시
        if (this.writeBuffer.length > 0) {
          await this.flushBuffer();
        }
      }
      this.reorderingBuffer.clear();
      this.reorderingBuffer = null;
    }

    if (this.writer) {
      try {
        if (this.writerMode === 'file-system-access') {
          const fsWriter = this.writer as FileSystemWritableFileStream;
          // 🚨 [핵심 수정] 파일 크기 Truncate
          // ZIP 사이즈 불일치 문제 해결을 위한 Truncate
          // @ts-ignore - locked 속성 체크
          if (!fsWriter.locked) {
            await fsWriter.truncate(this.totalBytesWritten);
            await fsWriter.close();
          }
        } else {
          const streamWriter = this.writer as WritableStreamDefaultWriter;
          await streamWriter.close();
        }
        logInfo('[DirectFileWriter]', `✅ File saved: ${this.totalBytesWritten} bytes`);
      } catch (e: any) {
        // 이미 닫힌 스트림 에러는 무시
        if (!e.message?.includes('close') && !e.message?.includes('closed')) {
          logError('[DirectFileWriter]', 'Error closing file:', e);
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
   * 🚀 NACK 콜백 등록 메서드
   */
  public onNack(callback: (nack: any) => void) {
      this.onNackCallback = callback;
  }

  /**
   * 암호화 키 설정
   */
  public setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  }

  /**
   * 정리
   * 🚀 [개선] ReorderingBuffer 정리 추가
   */
  public async cleanup(): Promise<void> {
    this.isFinalized = true;
    this.writeBuffer = []; // 메모리 해제
    this.encryptionKey = null; // 🔐 암호화 키 정리

    // 버퍼 정리
    if (this.reorderingBuffer) {
      this.reorderingBuffer.clear();
      this.reorderingBuffer = null;
    }

    if (this.writer) {
      try {
        await this.writer.abort();
      } catch (e) {
        // Ignore
      }
    }

    this.writer = null;
  }
}
