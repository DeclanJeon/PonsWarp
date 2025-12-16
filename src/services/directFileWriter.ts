/**
 * Direct File Writer Service
 * 브라우저별 최적화된 파일 저장 전략 구현
 *
 * 전략:
 * - Firefox: File System Access API 우선 → Blob 폴백(500MB↓) → OPFS 폴백(10GB↓) → StreamSaver 최후
 *   (StreamSaver의 차단 페이지 문제 회피)
 * - 기타 브라우저: StreamSaver 우선 → File System Access API 폴백 → Blob/OPFS 폴백
 *   (사용자 개입 없는 다운로드 선호)
 *
 * ⚠️ 현실적인 제약사항:
 * - OPFS: Firefox 기본 10GB 제한 (Persistent Storage 승인 시 더 큰 용량 가능)
 * - Blob: 메모리 제한으로 500MB 이하 권장
 * - StreamSaver: Firefox에서 차단될 수 있음
 *
 * 💡 대용량 파일(10GB+) 권장사항:
 * - Firefox 사용자에게 Chrome/Edge 사용 권장
 * - 또는 File System Access API 사용 유도 (사용자가 저장 위치 선택)
 *
 * 🚀 [개선] ReorderingBuffer 통합으로 순차적 데이터 쓰기 보장
 * 🚀 [Firefox 최적화] Blob 기반 폴백 추가 (메모리 제약 있지만 호환성 최고)
 * 🚀 [대용량 파일] OPFS 폴백 추가 (Storage Quota 체크 포함)
 */

import streamSaver from 'streamsaver';
import { WasmReorderingBuffer } from './wasmReorderingBuffer';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { HEADER_SIZE } from '../utils/constants';

// StreamSaver MITM 설정 (필수)
if (typeof window !== 'undefined') {
  const originUrl = `${window.location.origin}/mitm.html`;
  const fallbackUrl = `${window.location.origin}/public/mitm.html`;

  // 기본 MITM URL 설정
  streamSaver.mitm = originUrl || fallbackUrl;

  // 🚀 [진단] MITM URL 설정 확인 및 폴백 로직
  // MITM URL 설정 확인 (디버깅용)
  logDebug('[DirectFileWriter]', `Initial MITM URL: ${streamSaver.mitm}`);
}

// 🚀 [Flow Control] 메모리 보호를 위한 워터마크 설정
// 32MB 이상 쌓이면 PAUSE 요청, 16MB 이하로 떨어지면 RESUME 요청
const WRITE_BUFFER_HIGH_MARK = 32 * 1024 * 1024;
const WRITE_BUFFER_LOW_MARK = 16 * 1024 * 1024;

export class DirectFileWriter {
  private manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string }>;
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  } = {
    totalSize: 0,
  };
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
  private writerMode:
    | 'file-system-access'
    | 'streamsaver'
    | 'blob-fallback'
    | 'opfs-fallback' = 'streamsaver';

  // 🚀 [Blob 폴백용] 메모리 버퍼 (작은 파일용)
  private blobChunks: Uint8Array[] = [];

  // 🚀 [OPFS 폴백용] 대용량 파일 임시 저장
  private opfsFileHandle: FileSystemFileHandle | null = null;
  private opfsWriter: FileSystemWritableFileStream | null = null;

  // 🚀 [추가] 재정렬 버퍼 (WASM 기반 고성능 버퍼)
  private reorderingBuffer: WasmReorderingBuffer | null = null;

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

  private onProgressCallback:
    | ((data: {
        progress: number;
        speed: number;
        bytesTransferred: number;
        totalBytes: number;
      }) => void)
    | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  // 🚀 [추가] 흐름 제어 콜백
  private onFlowControlCallback: ((action: 'PAUSE' | 'RESUME') => void) | null =
    null;

  /**
   * 스토리지 초기화
   */
  public async initStorage(manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string }>;
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  }): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();
    this.totalBytesWritten = 0;
    this.isFinalized = false;
    this.writeBuffer = [];
    this.currentBatchSize = 0;
    this.pendingBytesInBuffer = 0;
    this.isPaused = false;
    this.blobChunks = [];

    const fileCount = manifest.totalFiles || manifest.files?.length || 0;
    logInfo('[DirectFileWriter]', `Initializing for ${fileCount} files`);
    logInfo(
      '[DirectFileWriter]',
      `Total size: ${((manifest.totalSize as number) / (1024 * 1024)).toFixed(2)} MB`
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
      logInfo(
        '[DirectFileWriter]',
        `✅ Initialized with mode: ${this.writerMode}`
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('USER_CANCELLED|사용자가 파일 저장을 취소했습니다.');
      }
      logError('[DirectFileWriter]', 'Storage initialization failed:', error);
      throw error;
    }
  }

  /**
   * 🚀 [수정됨] 저장 전략: Native FSA 우선 (모든 브라우저) -> StreamSaver/OPFS 폴백
   * Chrome에서의 실패 원인인 "StreamSaver 대기 중 제스처 만료"를 방지합니다.
   */
  private async initStrategy(
    fileName: string,
    fileSize: number
  ): Promise<void> {
    logInfo(
      '[DirectFileWriter]',
      `🔍 Starting initialization for: ${fileName}`
    );

    // FSA 지원 여부 확인
    // @ts-expect-error
    const hasFileSystemAccess = !!window.showSaveFilePicker;

    // 1. File System Access API (Native) 최우선 시도
    // Chrome, Edge, Opera, Desktop Brave 등 최신 브라우저에서 가장 안정적
    if (hasFileSystemAccess) {
      try {
        logInfo(
          '[DirectFileWriter]',
          'Attempting File System Access API (Native)...'
        );
        await this.initFileSystemAccess(fileName);
        logInfo(
          '[DirectFileWriter]',
          '✅ File System Access API initialization successful'
        );
        return;
      } catch (fsaError: any) {
        // 사용자가 취소한 경우, 다른 방법으로 넘어가면 안 됨 (사용자 의도 무시)
        if (fsaError.name === 'AbortError') {
          logWarn('[DirectFileWriter]', 'User cancelled file picker.');
          throw fsaError;
        }
        // 보안 오류나 기타 오류인 경우에만 폴백 시도
        logWarn('[DirectFileWriter]', 'FSA failed, falling back...', fsaError);
      }
    }

    // 2. Blob Fallback (작은 파일용, 500MB 미만)
    // 메모리 안정성이 확보된 작은 파일은 가장 호환성 좋은 Blob 방식 사용
    const isSmallFile = fileSize < 500 * 1024 * 1024;
    if (isSmallFile) {
      try {
        logInfo(
          '[DirectFileWriter]',
          'Attempting Blob fallback (Small file)...'
        );
        await this.initBlobFallback(fileName);
        return;
      } catch (e) {
        logWarn('[DirectFileWriter]', 'Blob fallback failed', e);
      }
    }

    // 3. StreamSaver 시도 (FSA 미지원 브라우저 또는 대용량 파일)
    // 모바일 브라우저나 구형 브라우저용
    try {
      logInfo('[DirectFileWriter]', 'Attempting StreamSaver...');
      await this.initStreamSaver(fileName, fileSize);
      return;
    } catch (ssError) {
      logWarn('[DirectFileWriter]', 'StreamSaver failed', ssError);
    }

    // 4. OPFS Fallback (최후의 수단, 대용량 지원)
    try {
      logInfo('[DirectFileWriter]', 'Attempting OPFS fallback...');
      await this.initOPFSFallback(fileName);
      return;
    } catch (opfsError) {
      logError('[DirectFileWriter]', 'OPFS failed', opfsError);
    }

    throw new Error(
      '모든 파일 저장 방식이 실패했습니다. (Chrome/Edge 사용 권장)'
    );
  }

  /**
   * StreamSaver 초기화 로직 (분리됨)
   */
  private async initStreamSaver(
    fileName: string,
    fileSize: number
  ): Promise<void> {
    logDebug(
      '[DirectFileWriter]',
      `🚀 Initializing StreamSaver with fileName: ${fileName}`
    );

    const isZip = fileName.endsWith('.zip');
    // ZIP이거나 사이즈 추정 모드일 경우 size를 지정하지 않아 브라우저가 크기 오류를 내지 않게 함
    const streamConfig =
      isZip || this.manifest?.isSizeEstimated ? {} : { size: fileSize };

    logDebug(
      '[DirectFileWriter]',
      `StreamSaver config: ${JSON.stringify(streamConfig)}`
    );
    logDebug('[DirectFileWriter]', `MITM URL: ${streamSaver.mitm}`);
    logDebug('[DirectFileWriter]', `Is ZIP file: ${isZip}`);
    logDebug(
      '[DirectFileWriter]',
      `Is size estimated: ${this.manifest?.isSizeEstimated}`
    );

    try {
      // StreamSaver.createWriteStream 호출 전 추가 확인
      logDebug(
        '[DirectFileWriter]',
        'Calling streamSaver.createWriteStream...'
      );

      const fileStream = streamSaver.createWriteStream(fileName, streamConfig);
      logDebug(
        '[DirectFileWriter]',
        'StreamSaver.createWriteStream succeeded, getting writer...'
      );

      this.writer = fileStream.getWriter();
      this.writerMode = 'streamsaver';

      // 순차 데이터 보장 (WASM 기반 고성능 버퍼)
      this.reorderingBuffer = new WasmReorderingBuffer();
      await this.reorderingBuffer.initialize(0);
      logInfo('[DirectFileWriter]', `✅ StreamSaver ready: ${fileName}`);

      // Writer 상태 확인
      logDebug(
        '[DirectFileWriter]',
        `Writer ready state: ${this.writer.ready}`
      );
    } catch (error: unknown) {
      logError(
        '[DirectFileWriter]',
        '❌ StreamSaver initialization failed:',
        error
      );
      if (error instanceof Error) {
        logDebug('[DirectFileWriter]', `Error type: ${error.constructor.name}`);
        logDebug('[DirectFileWriter]', `Error message: ${error.message}`);
        logDebug('[DirectFileWriter]', `Error stack: ${error.stack}`);
      }

      // StreamSaver 특정 오류 분석
      if (error instanceof Error && error.message.includes('Service Worker')) {
        logError(
          '[DirectFileWriter]',
          '🔍 Service Worker related error detected'
        );
      } else if (error instanceof Error && error.message.includes('MITM')) {
        logError(
          '[DirectFileWriter]',
          '🔍 MITM (Man-in-the-Middle) related error detected'
        );
      } else if (error instanceof Error && error.message.includes('secure')) {
        logError('[DirectFileWriter]', '🔍 Security context error detected');
      }

      throw error;
    }
  }

  /**
   * 🚀 [신규] Blob 기반 다운로드 폴백 초기화
   * 메모리에 모든 데이터를 모았다가 마지막에 한 번에 다운로드
   * 장점: 모든 브라우저 호환, Service Worker 불필요
   * 단점: 메모리 제약 (500MB 이하 권장)
   */
  private async initBlobFallback(fileName: string): Promise<void> {
    logDebug(
      '[DirectFileWriter]',
      `💾 Initializing Blob fallback with fileName: ${fileName}`
    );

    this.writerMode = 'blob-fallback';
    this.blobChunks = [];

    // Blob 모드에서도 순차 데이터 보장 (WASM 기반 고성능 버퍼)
    this.reorderingBuffer = new WasmReorderingBuffer();
    await this.reorderingBuffer.initialize(0);

    // 파일명 저장 (finalize에서 사용)
    this.manifest.downloadFileName = fileName;

    logInfo(
      '[DirectFileWriter]',
      `✅ Blob fallback ready: ${fileName} (memory-based download)`
    );
  }

  /**
   * 🚀 [신규] OPFS 기반 다운로드 폴백 초기화
   * 브라우저의 Origin Private File System에 임시 저장 후 수동 다운로드
   *
   * ⚠️ 용량 제한:
   * - Firefox: 기본 10GB, Persistent Storage 승인 시 디스크의 50%까지
   * - Chrome: 디스크 여유 공간의 60%까지
   *
   * 장점: 메모리 제약 없음, Service Worker 불필요
   * 단점: 브라우저 Storage Quota 제한, 전송 완료 후 수동 다운로드
   */
  private async initOPFSFallback(fileName: string): Promise<void> {
    logDebug(
      '[DirectFileWriter]',
      `🗄️ Initializing OPFS fallback with fileName: ${fileName}`
    );

    // OPFS 지원 여부 확인
    if (!navigator.storage || !navigator.storage.getDirectory) {
      throw new Error(
        'OPFS (Origin Private File System) not supported in this browser'
      );
    }

    try {
      // Storage Quota 확인
      if (navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        const available = (estimate.quota || 0) - (estimate.usage || 0);
        const requiredSize = this.totalSize || this.manifest?.totalSize || 0;

        logDebug(
          '[DirectFileWriter]',
          `Storage quota - Available: ${formatBytes(available)}, Required: ${formatBytes(requiredSize)}`
        );

        if (requiredSize > available) {
          logWarn(
            '[DirectFileWriter]',
            `⚠️ Insufficient storage quota. Available: ${formatBytes(available)}, Required: ${formatBytes(requiredSize)}`
          );

          // Persistent Storage 요청 시도
          if (navigator.storage.persist) {
            const isPersisted = await navigator.storage.persist();
            if (isPersisted) {
              logInfo(
                '[DirectFileWriter]',
                '✅ Persistent storage granted, retrying quota check...'
              );
              const newEstimate = await navigator.storage.estimate();
              const newAvailable =
                (newEstimate.quota || 0) - (newEstimate.usage || 0);

              if (requiredSize > newAvailable) {
                throw new Error(
                  `Insufficient storage quota even after persistence. Available: ${formatBytes(newAvailable)}, Required: ${formatBytes(requiredSize)}`
                );
              }
            } else {
              throw new Error(
                `Insufficient storage quota. Available: ${formatBytes(available)}, Required: ${formatBytes(requiredSize)}`
              );
            }
          } else {
            throw new Error(
              `Insufficient storage quota. Available: ${formatBytes(available)}, Required: ${formatBytes(requiredSize)}`
            );
          }
        }
      }

      // OPFS 루트 디렉토리 접근
      const opfsRoot = await navigator.storage.getDirectory();

      // 임시 파일 생성
      this.opfsFileHandle = await opfsRoot.getFileHandle(fileName, {
        create: true,
      });
      this.opfsWriter = await this.opfsFileHandle.createWritable();

      this.writerMode = 'opfs-fallback';

      // 순차 데이터 보장 (WASM 기반 고성능 버퍼)
      this.reorderingBuffer = new WasmReorderingBuffer();
      await this.reorderingBuffer.initialize(0);

      // 파일명 저장 (finalize에서 사용)
      this.manifest.downloadFileName = fileName;

      logInfo(
        '[DirectFileWriter]',
        `✅ OPFS fallback ready: ${fileName} (temporary storage, manual download required)`
      );
    } catch (error: unknown) {
      logError('[DirectFileWriter]', 'OPFS initialization failed:', error);
      throw error;
    }
  }

  /**
   * File System Access API 초기화 로직 (분리됨)
   */
  private async initFileSystemAccess(fileName: string): Promise<void> {
    logDebug(
      '[DirectFileWriter]',
      `📁 Initializing File System Access API with fileName: ${fileName}`
    );

    const ext = fileName.split('.').pop() || '';
    const accept: Record<string, string[]> = {};

    if (ext === 'zip') {
      accept['application/zip'] = ['.zip'];
    } else {
      accept['application/octet-stream'] = [`.${ext}`];
    }

    const pickerOptions = {
      suggestedName: fileName,
      types: [{ description: 'File', accept }],
    };

    logDebug(
      '[DirectFileWriter]',
      `File picker options: ${JSON.stringify(pickerOptions)}`
    );
    logDebug('[DirectFileWriter]', `File extension: ${ext}`);

    try {
      logDebug('[DirectFileWriter]', 'Calling window.showSaveFilePicker...');

      // @ts-expect-error - showSaveFilePicker may not be available in all browsers
      const handle = await window.showSaveFilePicker(pickerOptions);
      logDebug(
        '[DirectFileWriter]',
        'File picker succeeded, creating writable stream...'
      );

      this.writer = await handle.createWritable();
      this.writerMode = 'file-system-access';

      // 순차 데이터 보장 (WASM 기반 고성능 버퍼)
      this.reorderingBuffer = new WasmReorderingBuffer();
      await this.reorderingBuffer.initialize(0);
      logInfo('[DirectFileWriter]', `✅ File System Access ready: ${fileName}`);

      // Writer 상태 확인
      logDebug('[DirectFileWriter]', `Writer created successfully`);
    } catch (error: unknown) {
      logError(
        '[DirectFileWriter]',
        '❌ File System Access API initialization failed:',
        error
      );
      if (error instanceof Error) {
        logDebug('[DirectFileWriter]', `Error type: ${error.constructor.name}`);
        logDebug('[DirectFileWriter]', `Error name: ${error.name}`);
        logDebug('[DirectFileWriter]', `Error message: ${error.message}`);
        logDebug('[DirectFileWriter]', `Error stack: ${error.stack}`);
      }

      // File System Access API 특정 오류 분석
      if (error instanceof Error && error.name === 'AbortError') {
        logWarn('[DirectFileWriter]', '🔍 User cancelled the file save dialog');
      } else if (error instanceof Error && error.name === 'SecurityError') {
        logError(
          '[DirectFileWriter]',
          '🔍 File System Access API blocked due to security restrictions'
        );
      } else if (error instanceof Error && error.name === 'NotAllowedError') {
        logError(
          '[DirectFileWriter]',
          '🔍 File System Access API permission denied'
        );
      } else if (error instanceof Error && error.name === 'TypeError') {
        logError(
          '[DirectFileWriter]',
          '🔍 File System Access API not available or incorrect usage'
        );
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
        } catch (error: unknown) {
          logError('[DirectFileWriter]', 'Write queue error:', error);
          if (error instanceof Error) {
            this.onErrorCallback?.(`Write failed: ${error.message}`);
          } else {
            this.onErrorCallback?.('Write failed: Unknown error');
          }
          throw error; // 에러 전파하여 체인 중단
        }
      })
      .catch(() => {
        // 이미 처리된 에러는 무시하되, 체인은 유지
        logWarn('[DirectFileWriter]', 'Recovering from write error');
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

    // Writer 체크 (모드별로 다른 writer 사용)
    const hasWriter =
      this.writerMode === 'opfs-fallback'
        ? !!this.opfsWriter
        : this.writerMode === 'blob-fallback'
          ? true // Blob 모드는 메모리에만 적재
          : !!this.writer;

    if (!hasWriter || !this.reorderingBuffer) {
      logError(
        '[DirectFileWriter]',
        `No writer available (mode: ${this.writerMode}, writer: ${!!this.writer}, opfsWriter: ${!!this.opfsWriter}, reorderingBuffer: ${!!this.reorderingBuffer})`
      );

      // 디버깅을 위한 상세 정보
      if (!this.reorderingBuffer) {
        logError(
          '[DirectFileWriter]',
          'ReorderingBuffer is null - initialization may have failed'
        );
      }
      if (!hasWriter) {
        logError(
          '[DirectFileWriter]',
          `Writer is null for mode ${this.writerMode} - initialization may have failed`
        );
      }

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

    // 2. 모드별 쓰기 처리
    if (this.writerMode === 'blob-fallback') {
      // Blob 모드: 메모리에 계속 적재 (finalize에서 한 번에 다운로드)
      this.blobChunks.push(mergedBuffer);
    } else if (this.writerMode === 'opfs-fallback') {
      // OPFS 모드: 디스크에 직접 쓰기
      if (this.opfsWriter) {
        await this.opfsWriter.write({
          type: 'write',
          position: this.totalBytesWritten,
          data: mergedBuffer,
        });
      }
    } else if (this.writerMode === 'file-system-access') {
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
   * 🚀 [Blob 모드] 메모리에 모인 데이터를 Blob으로 다운로드
   */
  private async finalize(): Promise<void> {
    logInfo(
      '[DirectFileWriter]',
      `🏁 finalize() called, isFinalized: ${this.isFinalized}`
    );
    if (this.isFinalized) {
      logInfo('[DirectFileWriter]', '⚠️ Already finalized, skipping');
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

    // 🚀 [Blob 모드] 메모리에 모인 데이터를 Blob으로 다운로드
    if (this.writerMode === 'blob-fallback') {
      try {
        logInfo(
          '[DirectFileWriter]',
          `Creating Blob from ${this.blobChunks.length} chunks...`
        );

        const blob = new Blob(this.blobChunks as BlobPart[], {
          type: 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = this.manifest.downloadFileName || 'download';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // 정리
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);

        this.blobChunks = []; // 메모리 해제
        logInfo(
          '[DirectFileWriter]',
          `✅ Blob download triggered: ${this.totalBytesWritten} bytes`
        );
      } catch (error: unknown) {
        logError('[DirectFileWriter]', 'Blob download failed:', error);
        throw error;
      }
    }
    // 🚀 [OPFS 모드] OPFS에 저장된 파일을 사용자가 다운로드할 수 있도록 안내
    else if (this.writerMode === 'opfs-fallback') {
      try {
        if (this.opfsWriter) {
          await this.opfsWriter.close();
          this.opfsWriter = null;
        }

        logInfo(
          '[DirectFileWriter]',
          `✅ File saved to OPFS: ${this.totalBytesWritten} bytes`
        );
        logInfo(
          '[DirectFileWriter]',
          '⬇️ Transfer complete! Triggering automatic download...'
        );

        // OPFS에서 파일 읽어서 다운로드 트리거
        if (this.opfsFileHandle) {
          const file = await this.opfsFileHandle.getFile();
          const url = URL.createObjectURL(file);

          const a = document.createElement('a');
          a.href = url;
          a.download = this.manifest.downloadFileName || 'download';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();

          // 정리
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 100);

          logInfo(
            '[DirectFileWriter]',
            '✅ OPFS download triggered successfully'
          );
        }
      } catch (error: unknown) {
        logError('[DirectFileWriter]', 'OPFS download failed:', error);
        throw error;
      }
    } else if (this.writer) {
      try {
        if (this.writerMode === 'file-system-access') {
          const fsWriter = this.writer as FileSystemWritableFileStream;
          // 🚨 [핵심 수정] 파일 크기 Truncate
          // ZIP 사이즈 불일치 문제 해결을 위한 Truncate
          // locked 속성 체크
          if (!(fsWriter as unknown as { locked: boolean }).locked) {
            await fsWriter.truncate(this.totalBytesWritten);
            await fsWriter.close();
          }
        } else {
          const streamWriter = this.writer as WritableStreamDefaultWriter;
          await streamWriter.close();
        }
        logInfo(
          '[DirectFileWriter]',
          `✅ File saved (${this.writerMode}): ${this.totalBytesWritten} bytes`
        );
      } catch (error: unknown) {
        // 이미 닫힌 스트림 에러는 무시
        if (
          error instanceof Error &&
          !error.message?.includes('close') &&
          !error.message?.includes('closed')
        ) {
          logError('[DirectFileWriter]', 'Error closing file:', error);
        }
      }
    }

    this.writer = null;
    this.onCompleteCallback?.(this.totalBytesWritten);
  }

  /**
   * 콜백 등록
   */
  public onProgress(
    callback: (data: {
      progress: number;
      speed: number;
      bytesTransferred: number;
      totalBytes: number;
    }) => void
  ): void {
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
   * 🚀 [Blob 모드] 메모리 해제
   * 🚀 [OPFS 모드] OPFS 파일 정리
   */
  public async cleanup(): Promise<void> {
    this.isFinalized = true;
    this.writeBuffer = []; // 메모리 해제
    this.blobChunks = []; // Blob 청크 메모리 해제
    this.isPaused = false;

    // 버퍼 정리
    if (this.reorderingBuffer) {
      this.reorderingBuffer.clear();
      this.reorderingBuffer = null;
    }

    // OPFS Writer 정리
    if (this.opfsWriter) {
      try {
        await this.opfsWriter.abort();
      } catch {
        // Ignore
      }
      this.opfsWriter = null;
    }

    // OPFS 파일 삭제 (선택적)
    if (this.opfsFileHandle && this.writerMode === 'opfs-fallback') {
      try {
        const opfsRoot = await navigator.storage.getDirectory();
        await opfsRoot.removeEntry(this.opfsFileHandle.name);
        logInfo('[DirectFileWriter]', 'OPFS temporary file cleaned up');
      } catch {
        // Ignore - 파일이 이미 삭제되었거나 접근 불가
      }
      this.opfsFileHandle = null;
    }

    if (this.writer) {
      try {
        await this.writer.abort();
      } catch {
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
