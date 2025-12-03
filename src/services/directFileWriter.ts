/**
 * Direct File Writer Service
 * StreamSaver 우선 적용 및 File System Access API 폴백(Fallback) 구현
 *
 * 전략:
 * 1. StreamSaver.js 시도 (사용자 개입 없는 다운로드, 백그라운드 스트리밍)
 * 2. 실패 시 File System Access API 시도 (저장 위치 지정 다이얼로그)
 * 3. 모두 실패 시 에러 처리
 *
 * 🚀 [개선] ReorderingBuffer 통합으로 순차적 데이터 쓰기 보장
 */

import streamSaver from 'streamsaver';
import { ReorderingBuffer } from './reorderingBuffer';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { HEADER_SIZE } from '../utils/constants';

// StreamSaver MITM 설정 (필수)
if (typeof window !== 'undefined') {

  const originUrl = `${window.location.origin}/mitm.html`;
  const fallbackUrl = `${window.location.origin}/public/mitm.html`;

  // 기본 MITM URL 설정
  streamSaver.mitm = originUrl || fallbackUrl;
  
  // 🚀 [진단] MITM URL 설정 확인 및 폴백 로직
  console.log('[DirectFileWriter] Initial MITM URL:', streamSaver.mitm);
}

// 🚀 [Flow Control] 메모리 보호를 위한 워터마크 설정
// 32MB 이상 쌓이면 PAUSE 요청, 16MB 이하로 떨어지면 RESUME 요청
const WRITE_BUFFER_HIGH_MARK = 32 * 1024 * 1024;
const WRITE_BUFFER_LOW_MARK = 16 * 1024 * 1024;

export class DirectFileWriter {
  private manifest: any = null;
  private totalBytesWritten = 0;
  private totalSize = 0;
  private startTime = 0;
  private lastProgressTime = 0;
  private isFinalized = false;

  // 파일 Writer
  private writer:
    | WritableStreamDefaultWriter
    | FileSystemWritableFileStream
    | null = null;
  private writerMode: 'file-system-access' | 'streamsaver' = 'streamsaver';

  // 🚀 [추가] 재정렬 버퍼 (StreamSaver 모드용)
  private reorderingBuffer: ReorderingBuffer | null = null;

  // 🚀 [추가] 쓰기 작업을 순차적으로 처리하기 위한 Promise 체인
  private writeQueue: Promise<void> = Promise.resolve();

  // 🚀 [속도 개선] 배치 버퍼 설정 (메모리에 모았다가 한 번에 쓰기)
  private writeBuffer: Uint8Array[] = [];
  private currentBatchSize = 0;
  // 🚀 [최적화] 디스크 I/O 배치 크기 상향
  // 송신 측의 HIGH_WATER_MARK(12MB)에 맞춰 효율적인 쓰기 수행 (Context Switch 최소화)
  private readonly BATCH_THRESHOLD = 8 * 1024 * 1024; // 8MB

  // 🚀 [핵심] 버퍼에 적재된 바이트 수 추적 (디스크 쓰기 전 데이터 포함)
  private pendingBytesInBuffer = 0;

  // 🚀 버퍼 추적 및 흐름 제어 변수
  private isPaused = false;

  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  // 🚀 [추가] 흐름 제어 콜백
  private onFlowControlCallback: ((action: 'PAUSE' | 'RESUME') => void) | null =
    null;

  /**
   * 스토리지 초기화
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();
    this.totalBytesWritten = 0;
    this.isFinalized = false;
    this.writeBuffer = [];
    this.currentBatchSize = 0;
    this.pendingBytesInBuffer = 0;
    this.isPaused = false;

    const fileCount = manifest.totalFiles || manifest.files.length;
    console.log('[DirectFileWriter] Initializing for', fileCount, 'files');
    console.log(
      '[DirectFileWriter] Total size:',
      (manifest.totalSize / (1024 * 1024)).toFixed(2),
      'MB'
    );

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
      // 🚀 핵심 변경: StreamSaver 우선, FSA 폴백 로직 적용
      await this.initStrategy(fileName, manifest.totalSize);
      logInfo('[DirectFileWriter]', `✅ Initialized with mode: ${this.writerMode}`);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new Error('USER_CANCELLED|사용자가 파일 저장을 취소했습니다.');
      }
      throw e;
    }
  }

  /**
   * 🚀 [핵심 변경] 저장 전략 선택 및 초기화 (StreamSaver -> FSA)
   */
  private async initStrategy(fileName: string, fileSize: number): Promise<void> {
    logInfo('[DirectFileWriter]', `🔍 Starting initialization for file: ${fileName}, size: ${fileSize} bytes`);
    
    // 1. StreamSaver 우선 시도
    try {
      logInfo('[DirectFileWriter]', 'Attempting StreamSaver initialization...');
      
      // StreamSaver 지원 여부 확인 (Service Worker 등)
      logDebug('[DirectFileWriter]', `StreamSaver supported: ${streamSaver.supported}`);
      logDebug('[DirectFileWriter]', `Service Worker registered: ${!!navigator.serviceWorker}`);
      logDebug('[DirectFileWriter]', `User agent: ${navigator.userAgent}`);
      logDebug('[DirectFileWriter]', `HTTPS context: ${location.protocol === 'https:'}`);
      logDebug('[DirectFileWriter]', `MITM URL: ${streamSaver.mitm}`);
      
      // 🚀 [진단] Service Worker 상태 상세 확인
      if (navigator.serviceWorker) {
        try {
          const registration = await navigator.serviceWorker.ready;
          logDebug('[DirectFileWriter]', `Service Worker active: ${!!registration.active}`);
          logDebug('[DirectFileWriter]', `Service Worker scope: ${registration.scope}`);
        } catch (swError) {
          logError('[DirectFileWriter]', 'Service Worker registration check failed:', swError);
        }
      }
      
      // 🚀 [진단] MITM 파일 접근 가능성 확인
      try {
        const mitmResponse = await fetch(streamSaver.mitm, { method: 'HEAD' });
        logDebug('[DirectFileWriter]', `MITM file accessible: ${mitmResponse.ok}`);
        logDebug('[DirectFileWriter]', `MITM status: ${mitmResponse.status}`);
      } catch (mitmError) {
        logError('[DirectFileWriter]', 'MITM file check failed:', mitmError);
      }
      
      // StreamSaver가 실패할 수 있는 다양한 원인 확인
      if (!streamSaver.supported) {
        throw new Error('StreamSaver not supported in this browser environment');
      }

      // Service Worker 등록 확인
      if (!navigator.serviceWorker) {
        throw new Error('Service Worker not available - required for StreamSaver');
      }

      // HTTPS 확인
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        throw new Error('StreamSaver requires HTTPS context (except localhost)');
      }

      await this.initStreamSaver(fileName, fileSize);
      logInfo('[DirectFileWriter]', '✅ StreamSaver initialization successful');
      return; // 성공 시 리턴
    } catch (ssError) {
      logWarn('[DirectFileWriter]', 'StreamSaver failed, attempting fallback to File System Access API...', ssError);
      logDebug('[DirectFileWriter]', `StreamSaver error details: ${ssError.message}`);
      logDebug('[DirectFileWriter]', `StreamSaver error stack: ${ssError.stack}`);
      
      // StreamSaver 실패 원인 분석 로그
      if (ssError.message.includes('Service Worker')) {
        logWarn('[DirectFileWriter]', '⚠️ StreamSaver failed due to Service Worker issues');
      } else if (ssError.message.includes('HTTPS')) {
        logWarn('[DirectFileWriter]', '⚠️ StreamSaver failed due to security context issues');
      } else if (ssError.message.includes('not supported')) {
        logWarn('[DirectFileWriter]', '⚠️ StreamSaver failed due to browser compatibility');
      } else {
        logWarn('[DirectFileWriter]', '⚠️ StreamSaver failed due to unknown reasons');
      }
    }

    // 2. File System Access API (FSA) 폴백 시도
    // @ts-ignore
    const hasFileSystemAccess = !!window.showSaveFilePicker;
    logDebug('[DirectFileWriter]', `File System Access API available: ${hasFileSystemAccess}`);
    
    if (hasFileSystemAccess) {
      try {
        await this.initFileSystemAccess(fileName);
        logInfo('[DirectFileWriter]', '✅ File System Access API initialization successful');
        return; // 성공 시 리턴
      } catch (fsaError) {
        logError('[DirectFileWriter]', 'File System Access API failed:', fsaError);
        logDebug('[DirectFileWriter]', `FSA error details: ${fsaError.message}`);
        logDebug('[DirectFileWriter]', `FSA error stack: ${fsaError.stack}`);
        
        // FSA 실패 원인 분석 로그
        if (fsaError.name === 'AbortError') {
          logWarn('[DirectFileWriter]', '⚠️ User cancelled the file save dialog');
        } else if (fsaError.name === 'SecurityError') {
          logWarn('[DirectFileWriter]', '⚠️ File System Access API blocked due to security restrictions');
        } else {
          logWarn('[DirectFileWriter]', '⚠️ File System Access API failed due to unknown reasons');
        }
        
        throw fsaError; // 여기서 실패하면 더 이상 방법이 없음
      }
    }

    throw new Error('No supported file saving method available (StreamSaver and FSA failed).');
  }

  /**
   * StreamSaver 초기화 로직 (분리됨)
   */
  private async initStreamSaver(fileName: string, fileSize: number): Promise<void> {
    logDebug('[DirectFileWriter]', `🚀 Initializing StreamSaver with fileName: ${fileName}`);
    
    const isZip = fileName.endsWith('.zip');
    // ZIP이거나 사이즈 추정 모드일 경우 size를 지정하지 않아 브라우저가 크기 오류를 내지 않게 함
    const streamConfig = (isZip || this.manifest?.isSizeEstimated) ? {} : { size: fileSize };
    
    logDebug('[DirectFileWriter]', `StreamSaver config: ${JSON.stringify(streamConfig)}`);
    logDebug('[DirectFileWriter]', `MITM URL: ${streamSaver.mitm}`);
    logDebug('[DirectFileWriter]', `Is ZIP file: ${isZip}`);
    logDebug('[DirectFileWriter]', `Is size estimated: ${this.manifest?.isSizeEstimated}`);
    
    try {
      // StreamSaver.createWriteStream 호출 전 추가 확인
      logDebug('[DirectFileWriter]', 'Calling streamSaver.createWriteStream...');
      
      const fileStream = streamSaver.createWriteStream(fileName, streamConfig);
      logDebug('[DirectFileWriter]', 'StreamSaver.createWriteStream succeeded, getting writer...');
      
      this.writer = fileStream.getWriter();
      this.writerMode = 'streamsaver';
      
      // 순차 데이터 보장
      this.reorderingBuffer = new ReorderingBuffer(0);
      logInfo('[DirectFileWriter]', `✅ StreamSaver ready: ${fileName}`);
      
      // Writer 상태 확인
      logDebug('[DirectFileWriter]', `Writer ready state: ${this.writer.ready}`);
      
    } catch (error) {
      logError('[DirectFileWriter]', '❌ StreamSaver initialization failed:', error);
      logDebug('[DirectFileWriter]', `Error type: ${error.constructor.name}`);
      logDebug('[DirectFileWriter]', `Error message: ${error.message}`);
      logDebug('[DirectFileWriter]', `Error stack: ${error.stack}`);
      
      // StreamSaver 특정 오류 분석
      if (error.message.includes('Service Worker')) {
        logError('[DirectFileWriter]', '🔍 Service Worker related error detected');
      } else if (error.message.includes('MITM')) {
        logError('[DirectFileWriter]', '🔍 MITM (Man-in-the-Middle) related error detected');
      } else if (error.message.includes('secure')) {
        logError('[DirectFileWriter]', '🔍 Security context error detected');
      }
      
      throw error;
    }
  }

  /**
   * File System Access API 초기화 로직 (분리됨)
   */
  private async initFileSystemAccess(fileName: string): Promise<void> {
    logDebug('[DirectFileWriter]', `📁 Initializing File System Access API with fileName: ${fileName}`);
    
    const ext = fileName.split('.').pop() || '';
    const accept: Record<string, string[]> = {};

    if (ext === 'zip') {
      accept['application/zip'] = ['.zip'];
    } else {
      accept['application/octet-stream'] = [`.${ext}`];
    }

    const pickerOptions = {
      suggestedName: fileName,
      types: [{ description: 'File', accept }]
    };
    
    logDebug('[DirectFileWriter]', `File picker options: ${JSON.stringify(pickerOptions)}`);
    logDebug('[DirectFileWriter]', `File extension: ${ext}`);

    try {
      logDebug('[DirectFileWriter]', 'Calling window.showSaveFilePicker...');
      
      // @ts-ignore
      const handle = await window.showSaveFilePicker(pickerOptions);
      logDebug('[DirectFileWriter]', 'File picker succeeded, creating writable stream...');
      
      this.writer = await handle.createWritable();
      this.writerMode = 'file-system-access';
      
      // 순차 데이터 보장 (Batch Merge를 위해 필수)
      this.reorderingBuffer = new ReorderingBuffer(0);
      logInfo('[DirectFileWriter]', `✅ File System Access ready: ${fileName}`);
      
      // Writer 상태 확인
      logDebug('[DirectFileWriter]', `Writer created successfully`);
      
    } catch (error) {
      logError('[DirectFileWriter]', '❌ File System Access API initialization failed:', error);
      logDebug('[DirectFileWriter]', `Error type: ${error.constructor.name}`);
      logDebug('[DirectFileWriter]', `Error name: ${error.name}`);
      logDebug('[DirectFileWriter]', `Error message: ${error.message}`);
      logDebug('[DirectFileWriter]', `Error stack: ${error.stack}`);
      
      // File System Access API 특정 오류 분석
      if (error.name === 'AbortError') {
        logWarn('[DirectFileWriter]', '🔍 User cancelled the file save dialog');
      } else if (error.name === 'SecurityError') {
        logError('[DirectFileWriter]', '🔍 File System Access API blocked due to security restrictions');
      } else if (error.name === 'NotAllowedError') {
        logError('[DirectFileWriter]', '🔍 File System Access API permission denied');
      } else if (error.name === 'TypeError') {
        logError('[DirectFileWriter]', '🔍 File System Access API not available or incorrect usage');
      }
      
      throw error;
    }
  }

  /**
   * 청크 데이터 쓰기 (수정됨)
   * 🚀 비동기 큐를 사용하여 쓰기 작업의 순차적 실행 보장
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    // 큐에 새로운 작업을 추가 (이전 작업이 끝나야 실행됨)
    this.writeQueue = this.writeQueue
      .then(async () => {
        try {
          await this.processChunkInternal(packet);
        } catch (error: any) {
          logError('[DirectFileWriter]', 'Write queue error:', error);
          this.onErrorCallback?.(`Write failed: ${error.message}`);
          throw error; // 에러 전파하여 체인 중단
        }
      })
      .catch(err => {
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

    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xffff) {
      logInfo('[DirectFileWriter]', 'EOS received signal.');
      await this.flushBuffer(); // 남은 데이터 모두 쓰기
      await this.finalize();
      return;
    }

    const size = view.getUint32(14, true);
    const offset = Number(view.getBigUint64(6, true));

    // 🚀 [FIX] ZIP 모드(isSizeEstimated)일 경우 Overflow 체크 완화
    const totalReceived = this.totalBytesWritten + this.pendingBytesInBuffer;
    
    // Manifest가 있고, 크기 추정 모드(ZIP 등)가 아닐 때만 엄격하게 체크
    const isSizeStrict = this.manifest && !this.manifest.isSizeEstimated;

    // ZIP 모드(다중 파일)일 때는 totalSize를 초과해도 데이터를 받아야 함 (Central Directory 등 오버헤드 때문)
    if (isSizeStrict && this.totalSize > 0 && totalReceived >= this.totalSize) {
      logWarn(
        '[DirectFileWriter]',
        `Ignoring chunk: already reached totalSize (${this.totalSize})`
      );
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

    const data = new Uint8Array(packet, HEADER_SIZE, size);

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

    // 🚀 [Flow Control] High Water Mark 체크
    this.checkBackpressure();

    // 3. 임계값(8MB) 넘으면 디스크에 쓰기 (Flushing)
    if (this.currentBatchSize >= this.BATCH_THRESHOLD) {
      await this.flushBuffer();
    }
  }

  /**
   * 🚀 [핵심] 메모리에 모아둔 데이터를 한 번에 디스크로 전송
   */
  private async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) return;

    // 1. 큰 버퍼 하나로 병합
    const mergedBuffer = new Uint8Array(this.currentBatchSize);
    let offset = 0;
    for (const chunk of this.writeBuffer) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // 2. 디스크 쓰기
    if (this.writerMode === 'file-system-access') {
      const fsWriter = this.writer as FileSystemWritableFileStream;
      await fsWriter.write({
        type: 'write',
        position: this.totalBytesWritten, // 순차적으로 쓰므로 누적 오프셋 사용
        data: mergedBuffer,
      });
    } else {
      const streamWriter = this.writer as WritableStreamDefaultWriter;
      await streamWriter.ready;
      await streamWriter.write(mergedBuffer);
    }

    // 3. 상태 업데이트 및 초기화
    this.totalBytesWritten += this.currentBatchSize;
    this.pendingBytesInBuffer -= this.currentBatchSize; // 버퍼에서 디스크로 이동했으므로 감소
    this.writeBuffer = [];
    this.currentBatchSize = 0;

    // 🚀 [Flow Control] Low Water Mark 체크 (Resume)
    this.checkBackpressure();

    this.reportProgress();
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
    const rawProgress =
      this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
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
   * 🚀 [개선] ReorderingBuffer 정리 및 파일 크기 Truncate
   */
  private async finalize(): Promise<void> {
    console.log(
      '[DirectFileWriter] 🏁 finalize() called, isFinalized:',
      this.isFinalized
    );
    if (this.isFinalized) {
      console.log('[DirectFileWriter] ⚠️ Already finalized, skipping');
      return;
    }
    this.isFinalized = true;

    // 버퍼에 남은 잔여 데이터 강제 플러시
    await this.flushBuffer();

    // 버퍼 정리 및 데이터 손실 체크
    if (this.reorderingBuffer) {
      const stats = this.reorderingBuffer.getStatus();
      if (stats.bufferedCount > 0) {
        logError(
          '[DirectFileWriter]',
          `Finalizing with ${stats.bufferedCount} chunks still in buffer (Potential Data Loss)`
        );
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
        logInfo('[DirectFileWriter]', `✅ File saved (${this.writerMode}): ${this.totalBytesWritten} bytes`);
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

  // 🚀 [추가] 콜백 등록 메서드
  public onFlowControl(callback: (action: 'PAUSE' | 'RESUME') => void): void {
    this.onFlowControlCallback = callback;
  }

  /**
   * 🚀 [Flow Control] 버퍼 상태에 따른 PAUSE/RESUME 이벤트 발생
   */
  private checkBackpressure() {
    if (!this.isPaused && this.pendingBytesInBuffer >= WRITE_BUFFER_HIGH_MARK) {
      this.isPaused = true;
      logWarn(
        '[DirectFileWriter]',
        `High memory usage (${formatBytes(this.pendingBytesInBuffer)}). Pausing sender.`
      );
      this.onFlowControlCallback?.('PAUSE');
    } else if (
      this.isPaused &&
      this.pendingBytesInBuffer <= WRITE_BUFFER_LOW_MARK
    ) {
      this.isPaused = false;
      logInfo(
        '[DirectFileWriter]',
        `Memory drained (${formatBytes(this.pendingBytesInBuffer)}). Resuming sender.`
      );
      this.onFlowControlCallback?.('RESUME');
    }
  }

  /**
   * 정리
   * 🚀 [개선] ReorderingBuffer 정리 추가
   */
  public async cleanup(): Promise<void> {
    this.isFinalized = true;
    this.writeBuffer = []; // 메모리 해제
    this.isPaused = false;

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

// 헬퍼 함수
function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
