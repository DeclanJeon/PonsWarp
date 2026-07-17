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
import initPonsCore, { CryptoSession, Zip64Stream } from 'pons-core-wasm';
import { WasmReorderingBuffer } from './wasmReorderingBuffer';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { BulkDecryptWorker } from './bulkDecryptWorker';
import { HEADER_SIZE } from '../utils/constants';
import { calculateReceiverBufferedProgress } from '../utils/transferProgress';
import { TransferSpeedMeter } from '../utils/transferEstimate';
import {
  shouldUseBlobFallbackBeforeStreaming,
  isHeadlessBrowser,
  isAutomationDownloadMode,
} from '../utils/downloadStrategy';

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
const WRITE_BUFFER_HIGH_MARK = 48 * 1024 * 1024;
const WRITE_BUFFER_LOW_MARK = 16 * 1024 * 1024;
const ENCRYPTED_HEADER_SIZE = 38;
const AUTH_TAG_SIZE = 16;
const MAX_RESUME_ATTEMPTS = 3;

import type { EvidenceFsaHandleContext } from './lanEvidenceAdapter';
export class DirectFileWriter {
  private evidenceFsaHandleContext: EvidenceFsaHandleContext | null = null;

  public setEvidenceFsaHandleContext(
    context: EvidenceFsaHandleContext | null
  ): void {
    this.evidenceFsaHandleContext = context;
  }

  public getWriterMode(): string {
    return this.writerMode;
  }
  private manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string; size: number }>;
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  } = {
    totalSize: 0,
  };
  private totalBytesWritten = 0;
  private outputBytesWritten = 0;
  private totalSize = 0;
  private startTime = 0;
  private lastProgressTime = 0;
  private speedMeter = new TransferSpeedMeter();
  private isFinalized = false;

  // 파일 Writer
  private writer:
    WritableStreamDefaultWriter | FileSystemWritableFileStream | null = null;
  private writerMode:
    'file-system-access' | 'streamsaver' | 'blob-fallback' | 'opfs-fallback' =
    'streamsaver';

  // 🚀 [Blob 폴백용] 메모리 버퍼 (작은 파일용)
  private blobChunks: Uint8Array[] = [];

  // 🚀 [OPFS 폴백용] 대용량 파일 임시 저장
  private opfsFileHandle: FileSystemFileHandle | null = null;
  private opfsWriter: FileSystemWritableFileStream | null = null;

  // 🚀 [추가] 재정렬 버퍼 (WASM 기반 고성능 버퍼)
  private reorderingBuffer: WasmReorderingBuffer | null = null;
  /** Next expected payload offset for ordered bulk fast path (1:1). */
  private contiguousOffset = 0;
  /** When true, skip WASM reordering for sequential host bulk. */
  private orderedBulkFastPath = true;

  // 🚀 [추가] 쓰기 작업을 순차적으로 처리하기 위한 Promise 체인
  private writeQueue: Promise<void> = Promise.resolve();

  // 🚀 [속도 개선] 배치 버퍼 설정 (메모리에 모았다가 한 번에 쓰기)
  private writeBuffer: Uint8Array[] = [];
  private currentBatchSize = 0;
  // 🚀 [최적화] 디스크 I/O 배치 크기 상향
  // 송신 측의 HIGH_WATER_MARK(12MB)에 맞춰 효율적인 쓰기 수행 (Context Switch 최소화)
  private readonly BATCH_THRESHOLD = 4 * 1024 * 1024; // 4MB batches reduce write syscall churn

  // 🚀 [핵심] 버퍼에 적재된 바이트 수 추적 (디스크 쓰기 전 데이터 포함)
  private pendingBytesInBuffer = 0;
  private queuedAcceptedBytesInBuffer = 0;

  // 🚀 버퍼 추적 및 흐름 제어 변수
  private isPaused = false;
  private sessionKey: Uint8Array | null = null;
  private bulkDecryptWorker: BulkDecryptWorker | null = null;
  private bulkDecryptArmPromise: Promise<void> | null = null;
  private decryptInFlight = 0;
  private static readonly MAX_DECRYPT_IN_FLIGHT = 48;
  private decryptWaiters: Array<() => void> = [];
  private randomPrefix: Uint8Array | null = null;
  private cryptoSession: CryptoSession | null = null;
  private decryptCryptoKey: CryptoKey | null = null;
  private writeFailure: Error | null = null;
  private resumeAttempts = 0;
  private awaitingResume = false;
  private receiverZipStream: Zip64Stream | null = null;
  private receiverZipFileIndex = 0;
  private receiverZipFileBytesWritten = 0;
  private receiverZipFinalized = false;

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
  private onResumeRequestCallback:
    ((offset: number, reason: string) => void) | null = null;

  /**
   * 스토리지 초기화
   */
  public async initStorage(manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string; size: number }>;
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  }): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();
    this.speedMeter.reset(0, this.startTime);
    this.totalBytesWritten = 0;
    this.outputBytesWritten = 0;
    this.isFinalized = false;
    this.writeBuffer = [];
    this.currentBatchSize = 0;
    this.pendingBytesInBuffer = 0;
    this.queuedAcceptedBytesInBuffer = 0;
    this.isPaused = false;
    this.resumeAttempts = 0;
    this.awaitingResume = false;
    this.writeFailure = null;
    this.blobChunks = [];
    this.receiverZipStream = null;
    this.receiverZipFileIndex = 0;
    this.receiverZipFileBytesWritten = 0;
    this.receiverZipFinalized = false;

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
      this.contiguousOffset = 0;
      this.orderedBulkFastPath = true;
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

  public setEncryptionKey(
    sessionKey: Uint8Array,
    randomPrefix: Uint8Array
  ): void {
    this.sessionKey = new Uint8Array(sessionKey);
    this.randomPrefix = new Uint8Array(randomPrefix);
    this.cryptoSession = null;
    this.decryptCryptoKey = null;
    // Prefer off-main-thread decrypt for bulk throughput.
    this.bulkDecryptArmPromise = this.armBulkDecryptWorker();
    logInfo('[DirectFileWriter]', '🔐 Encryption key configured');
  }

  private async acquireDecryptSlot(): Promise<void> {
    if (this.decryptInFlight < DirectFileWriter.MAX_DECRYPT_IN_FLIGHT) {
      this.decryptInFlight++;
      return;
    }
    await new Promise<void>(resolve => {
      this.decryptWaiters.push(() => {
        this.decryptInFlight++;
        resolve();
      });
    });
  }

  private releaseDecryptSlot(): void {
    this.decryptInFlight = Math.max(0, this.decryptInFlight - 1);
    const next = this.decryptWaiters.shift();
    if (next) next();
  }

  private async armBulkDecryptWorker(): Promise<void> {
    if (!this.sessionKey || !BulkDecryptWorker.isSupported()) return;
    try {
      this.bulkDecryptWorker?.close();
      const worker = new BulkDecryptWorker();
      await worker.start(this.sessionKey);
      this.bulkDecryptWorker = worker;
      logInfo('[DirectFileWriter]', '🔐 Bulk decrypt worker armed');
    } catch (error) {
      this.bulkDecryptWorker = null;
      logWarn(
        '[DirectFileWriter]',
        'Bulk decrypt worker unavailable; using main-thread decrypt',
        error
      );
    }
  }

  /**
   * 🚀 [핵심 변경] 저장 전략 선택 및 초기화 (Firefox: FSA 우선, 기타: StreamSaver 우선)
   */
  private async initStrategy(
    fileName: string,
    fileSize: number
  ): Promise<void> {
    logInfo(
      '[DirectFileWriter]',
      `🔍 Starting initialization for file: ${fileName}, size: ${fileSize} bytes`
    );

    // Firefox 감지
    if (this.evidenceFsaHandleContext) {
      if (
        !this.evidenceFsaHandleContext.verified ||
        Date.now() >= this.evidenceFsaHandleContext.expiresAtMs
      ) {
        throw new Error(
          'Evidence FSA handle is missing, expired, or unverified'
        );
      }
      await this.initEvidenceFileSystemAccess(fileName);
      return;
    }
    // Firefox 감지
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
    logDebug('[DirectFileWriter]', `Browser detected - Firefox: ${isFirefox}`);

    // @ts-expect-error - showSaveFilePicker may not be available in all browsers
    const hasFileSystemAccess = !!window.showSaveFilePicker;
    logDebug(
      '[DirectFileWriter]',
      `File System Access API available: ${hasFileSystemAccess}`
    );

    // 🚀 [Firefox 최적화] Firefox는 Service Worker 없는 방법 우선
    // StreamSaver는 Service Worker + iframe을 사용하여 Firefox의 Enhanced Tracking Protection에 차단됨
    if (isFirefox) {
      logInfo(
        '[DirectFileWriter]',
        '🦊 Firefox detected - avoiding StreamSaver (Service Worker blocked by Enhanced Tracking Protection)'
      );

      // 1. File System Access API 우선 시도 (Firefox, 자동화 제외)
      if (hasFileSystemAccess && !isHeadlessBrowser() && !isAutomationDownloadMode()) {
        try {
          await this.initFileSystemAccess(fileName);
          logInfo(
            '[DirectFileWriter]',
            '✅ File System Access API initialization successful'
          );
          return;
        } catch (fsaError: unknown) {
          // FSA 실패 원인 분석 로그
          if (fsaError instanceof Error && fsaError.name === 'AbortError') {
            logWarn(
              '[DirectFileWriter]',
              '⚠️ User cancelled the file save dialog'
            );
            throw fsaError;
          } else if (
            fsaError instanceof Error &&
            fsaError.name === 'SecurityError'
          ) {
            logWarn(
              '[DirectFileWriter]',
              '⚠️ File System Access API blocked due to security restrictions'
            );
          } else {
            logWarn(
              '[DirectFileWriter]',
              '⚠️ File System Access API failed due to unknown reasons'
            );
          }

          logWarn(
            '[DirectFileWriter]',
            'File System Access API failed, attempting automatic fallback...',
            fsaError
          );
          if (fsaError instanceof Error) {
            logDebug(
              '[DirectFileWriter]',
              `FSA error details: ${fsaError.message}`
            );
          }
        }
      } else {
        logWarn(
          '[DirectFileWriter]',
          '⚠️ File System Access API not available in this Firefox version'
        );
      }

      // 2. Blob 다운로드 폴백 시도 (Firefox - 500MB 이하만)
      const isSmallFile = shouldUseBlobFallbackBeforeStreaming(fileSize);
      if (isSmallFile) {
        try {
          logInfo(
            '[DirectFileWriter]',
            'Attempting Blob-based download as fallback...'
          );
          await this.initBlobFallback(fileName);
          logInfo(
            '[DirectFileWriter]',
            '✅ Blob fallback initialization successful'
          );
          return;
        } catch (blobError: unknown) {
          logWarn(
            '[DirectFileWriter]',
            'Blob fallback failed, trying OPFS...',
            blobError
          );
        }
      } else {
        logInfo(
          '[DirectFileWriter]',
          `File too large (${formatBytes(fileSize)}) for Blob fallback, trying OPFS...`
        );
      }

      // 3. OPFS 폴백 시도 (Firefox - 대용량 파일, 단 Storage Quota 제한 있음)
      try {
        logInfo(
          '[DirectFileWriter]',
          'Attempting OPFS (Origin Private File System) as fallback...'
        );
        await this.initOPFSFallback(fileName);
        logInfo(
          '[DirectFileWriter]',
          '✅ OPFS fallback initialization successful'
        );
        logInfo(
          '[DirectFileWriter]',
          '📦 File will be temporarily saved to browser storage, then automatically downloaded when transfer completes.'
        );
        return;
      } catch (opfsError: unknown) {
        logWarn(
          '[DirectFileWriter]',
          'OPFS fallback failed (likely quota exceeded), trying StreamSaver as last resort...',
          opfsError
        );

        // Storage Quota 초과 시 사용자에게 명확한 안내
        if (
          opfsError instanceof Error &&
          opfsError.message &&
          opfsError.message.includes('quota')
        ) {
          logError(
            '[DirectFileWriter]',
            '❌ Browser storage quota exceeded. For large files (10GB+), please use Chrome/Edge or try File System Access API.'
          );
        }
      }

      // 4. StreamSaver 최후 시도 (Firefox - 거의 항상 차단됨)
      try {
        logWarn(
          '[DirectFileWriter]',
          '⚠️ Attempting StreamSaver as last resort (likely to be blocked by Firefox)...'
        );
        await this.initStreamSaver(fileName, fileSize);
        logInfo(
          '[DirectFileWriter]',
          '✅ StreamSaver initialization successful (unexpected!)'
        );
        return;
      } catch (ssError: unknown) {
        logError('[DirectFileWriter]', 'All download methods failed:', ssError);

        // Firefox 사용자에게 명확한 안내
        const errorMsg =
          'Firefox에서 파일 다운로드에 실패했습니다.\n\n' +
          '해결 방법:\n' +
          '1. 파일 저장 위치 선택 다이얼로그가 나타나면 승인해주세요 (File System Access API)\n' +
          '2. 또는 Chrome/Edge 브라우저를 사용해주세요\n' +
          '3. Firefox Enhanced Tracking Protection이 StreamSaver를 차단하고 있습니다';

        throw new Error(errorMsg);
      }
    }

    const isSmallFile = shouldUseBlobFallbackBeforeStreaming(fileSize);

    // 🚀 Headless/자동화 감지: FSA 대화상자 회피
    const skipFsa = isHeadlessBrowser() || isAutomationDownloadMode();

    // Chromium/Edge 계열은 사용자가 MATERIALIZE를 클릭한 제스처 안에서
    // File System Access API를 열 수 있다. 50MB+ 파일을 Blob에 끝까지 모으면
    // 마지막 Blob 생성/다운로드 단계에서 UI가 멈춘 것처럼 보이고 메모리 압박이 커진다.
    // 따라서 FSA가 있으면 실제 디스크 스트리밍 writer를 우선 사용한다.
    // 단, headless/자동화 모드에서는 FSA를 건너뛰고 Blob/OPFS를 사용한다.
    if (hasFileSystemAccess && !skipFsa) {
      try {
        await this.initFileSystemAccess(fileName);
        logInfo(
          '[DirectFileWriter]',
          '✅ File System Access API initialization successful'
        );
        return;
      } catch (fsaError: unknown) {
        logWarn(
          '[DirectFileWriter]',
          'File System Access API failed before streaming fallback:',
          fsaError
        );
        if (fsaError instanceof Error && fsaError.name === 'AbortError') {
          throw fsaError;
        }
      }
    }

    if (isSmallFile) {
      try {
        logInfo(
          '[DirectFileWriter]',
          'Small file detected; using Blob-based download to avoid StreamSaver startup latency...'
        );
        await this.initBlobFallback(fileName);
        logInfo(
          '[DirectFileWriter]',
          '✅ Blob fallback initialization successful'
        );
        return;
      } catch (blobError: unknown) {
        logWarn(
          '[DirectFileWriter]',
          'Blob fallback failed, trying streaming strategies...',
          blobError
        );
      }
    }

    // 🚀 [기타 브라우저] StreamSaver 우선 시도
    try {
      logInfo('[DirectFileWriter]', 'Attempting StreamSaver initialization...');

      // StreamSaver 지원 여부 확인 (Service Worker 등)
      logDebug(
        '[DirectFileWriter]',
        `StreamSaver supported: ${streamSaver.supported}`
      );
      logDebug(
        '[DirectFileWriter]',
        `Service Worker registered: ${!!navigator.serviceWorker}`
      );
      logDebug('[DirectFileWriter]', `User agent: ${navigator.userAgent}`);
      logDebug(
        '[DirectFileWriter]',
        `HTTPS context: ${location.protocol === 'https:'}`
      );
      logDebug('[DirectFileWriter]', `MITM URL: ${streamSaver.mitm}`);

      // 🚀 [진단] Service Worker 상태 상세 확인
      if (navigator.serviceWorker) {
        try {
          const registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
          ]);

          if (registration) {
            logDebug(
              '[DirectFileWriter]',
              `Service Worker active: ${!!registration.active}`
            );
            logDebug(
              '[DirectFileWriter]',
              `Service Worker scope: ${registration.scope}`
            );
          } else {
            logWarn(
              '[DirectFileWriter]',
              'Service Worker not ready yet; continuing with fallback strategy checks'
            );
          }
        } catch (swError: unknown) {
          logError(
            '[DirectFileWriter]',
            'Service Worker registration check failed:',
            swError
          );
        }
      }

      // 🚀 [진단] MITM 파일 접근 가능성 확인
      try {
        const mitmResponse = await fetch(streamSaver.mitm, { method: 'HEAD' });
        logDebug(
          '[DirectFileWriter]',
          `MITM file accessible: ${mitmResponse.ok}`
        );
        logDebug('[DirectFileWriter]', `MITM status: ${mitmResponse.status}`);
      } catch (mitmError: unknown) {
        logError('[DirectFileWriter]', 'MITM file check failed:', mitmError);
      }

      // StreamSaver가 실패할 수 있는 다양한 원인 확인
      if (!streamSaver.supported) {
        throw new Error(
          'StreamSaver not supported in this browser environment'
        );
      }

      // Service Worker 등록 확인
      if (!navigator.serviceWorker) {
        throw new Error(
          'Service Worker not available - required for StreamSaver'
        );
      }

      // HTTPS 확인
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        throw new Error(
          'StreamSaver requires HTTPS context (except localhost)'
        );
      }

      await this.initStreamSaver(fileName, fileSize);
      logInfo('[DirectFileWriter]', '✅ StreamSaver initialization successful');
      return; // 성공 시 리턴
    } catch (ssError: unknown) {
      logWarn(
        '[DirectFileWriter]',
        'StreamSaver failed, attempting fallback to File System Access API...',
        ssError
      );
      if (ssError instanceof Error) {
        logDebug(
          '[DirectFileWriter]',
          `StreamSaver error details: ${ssError.message}`
        );
        logDebug(
          '[DirectFileWriter]',
          `StreamSaver error stack: ${ssError.stack}`
        );
      }

      // StreamSaver 실패 원인 분석 로그
      if (
        ssError instanceof Error &&
        ssError.message.includes('Service Worker')
      ) {
        logWarn(
          '[DirectFileWriter]',
          '⚠️ StreamSaver failed due to Service Worker issues'
        );
      } else if (
        ssError instanceof Error &&
        ssError.message.includes('HTTPS')
      ) {
        logWarn(
          '[DirectFileWriter]',
          '⚠️ StreamSaver failed due to security context issues'
        );
      } else if (
        ssError instanceof Error &&
        ssError.message.includes('not supported')
      ) {
        logWarn(
          '[DirectFileWriter]',
          '⚠️ StreamSaver failed due to browser compatibility'
        );
      } else {
        logWarn(
          '[DirectFileWriter]',
          '⚠️ StreamSaver failed due to unknown reasons'
        );
      }
    }

    // File System Access API (FSA) 폴백 시도 (기타 브라우저)
    if (hasFileSystemAccess) {
      try {
        await this.initFileSystemAccess(fileName);
        logInfo(
          '[DirectFileWriter]',
          '✅ File System Access API initialization successful'
        );
        return; // 성공 시 리턴
      } catch (fsaError: unknown) {
        logWarn(
          '[DirectFileWriter]',
          'File System Access API failed:',
          fsaError
        );
        if (fsaError instanceof Error) {
          logDebug(
            '[DirectFileWriter]',
            `FSA error details: ${fsaError.message}`
          );
        }

        // FSA 실패 원인 분석 로그
        if (fsaError instanceof Error && fsaError.name === 'AbortError') {
          logWarn(
            '[DirectFileWriter]',
            '⚠️ User cancelled the file save dialog'
          );
          throw fsaError; // 사용자 취소는 재시도하지 않음
        } else if (
          fsaError instanceof Error &&
          fsaError.name === 'SecurityError'
        ) {
          logWarn(
            '[DirectFileWriter]',
            '⚠️ File System Access API blocked due to security restrictions'
          );
        } else {
          logWarn(
            '[DirectFileWriter]',
            '⚠️ File System Access API failed due to unknown reasons'
          );
        }
      }
    }

    // 🚀 [최후 폴백] Blob 또는 OPFS 다운로드 시도 (모든 브라우저)
    if (isSmallFile) {
      try {
        logInfo(
          '[DirectFileWriter]',
          'Attempting Blob-based download as last resort...'
        );
        await this.initBlobFallback(fileName);
        logInfo(
          '[DirectFileWriter]',
          '✅ Blob fallback initialization successful'
        );
        return;
      } catch (blobError: unknown) {
        logWarn(
          '[DirectFileWriter]',
          'Blob fallback failed, trying OPFS...',
          blobError
        );
      }
    } else {
      logInfo(
        '[DirectFileWriter]',
        `File too large (${formatBytes(fileSize)}) for Blob fallback, trying OPFS...`
      );
    }

    // OPFS 최후 시도 (대용량 파일)
    try {
      logInfo('[DirectFileWriter]', 'Attempting OPFS as final fallback...');
      await this.initOPFSFallback(fileName);
      logInfo(
        '[DirectFileWriter]',
        '✅ OPFS fallback initialization successful'
      );
      logInfo(
        '[DirectFileWriter]',
        '📦 File will be temporarily saved to browser storage, then automatically downloaded when transfer completes.'
      );
      return;
    } catch (opfsError: unknown) {
      logError('[DirectFileWriter]', 'OPFS fallback also failed:', opfsError);
    }

    throw new Error(
      'No supported file saving method available (all methods failed).'
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
  private async initEvidenceFileSystemAccess(fileName: string): Promise<void> {
    const context = this.evidenceFsaHandleContext;
    if (!context || !context.verified || Date.now() >= context.expiresAtMs) {
      throw new Error('Evidence FSA handle is missing, expired, or unverified');
    }
    this.writer = await context.handle.createWritable();
    context.consume();
    this.writerMode = 'file-system-access';
    this.reorderingBuffer = new WasmReorderingBuffer();
    await this.reorderingBuffer.initialize(0);
    logInfo('[DirectFileWriter]', `Evidence FSA ready: ${fileName}`);
  }

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
    if (this.writeFailure) {
      return Promise.reject(this.writeFailure);
    }

    const queuedPayloadBytes = this.getAcceptedPayloadBytes(packet);
    if (queuedPayloadBytes > 0) {
      this.pendingBytesInBuffer += queuedPayloadBytes;
      this.queuedAcceptedBytesInBuffer += queuedPayloadBytes;
      this.checkBackpressure();
    }

    // 🚀 [성능 핵심] 복호화를 큐 밖에서 먼저 수행 (네트워크 수신과 병렬)
    // Bound concurrent decrypts so worker/main queue cannot explode RAM.
    await this.acquireDecryptSlot();
    let normalizedPacket: ArrayBuffer;
    try {
      normalizedPacket = await this.normalizePacket(packet);
    } catch (error: unknown) {
      this.releaseDecryptSlot();
      const writeError = error instanceof Error ? error : new Error('Decryption failed');
      this.writeFailure = writeError;
      if (queuedPayloadBytes > 0) {
        this.pendingBytesInBuffer = Math.max(
          0,
          this.pendingBytesInBuffer - queuedPayloadBytes
        );
        this.queuedAcceptedBytesInBuffer = Math.max(
          0,
          this.queuedAcceptedBytesInBuffer - queuedPayloadBytes
        );
        this.checkBackpressure();
      }
      this.onErrorCallback?.(`Decrypt failed: ${writeError.message}`);
      throw writeError;
    }
    this.releaseDecryptSlot();

    // 큐에는 이미 복호화된 패킷만 전달 (가벼운 연산)
    const writeTask = this.writeQueue.then(async () => {
      if (this.writeFailure) {
        throw this.writeFailure;
      }

      try {
        await this.processDecodedChunk(normalizedPacket);
      } catch (error: unknown) {
        const writeError =
          error instanceof Error ? error : new Error('Unknown write failure');
        this.writeFailure = writeError;
        logError('[DirectFileWriter]', 'Write queue error:', writeError);
        this.onErrorCallback?.(`Write failed: ${writeError.message}`);
        throw writeError;
      } finally {
        if (queuedPayloadBytes > 0) {
          // Leave pendingBytesInBuffer until flushBuffer/disk write.
          // Only clear the pre-decode admission tracker.
          this.queuedAcceptedBytesInBuffer = Math.max(
            0,
            this.queuedAcceptedBytesInBuffer - queuedPayloadBytes
          );
          if (!this.writeFailure) {
            this.checkBackpressure();
          }
        }
      }
    });

    this.writeQueue = writeTask.catch(() => {
      logWarn('[DirectFileWriter]', 'Write queue halted after write error');
    });

    return writeTask;
  }
  private getAcceptedPayloadBytes(packet: ArrayBuffer): number {
    if (packet.byteLength < HEADER_SIZE) return 0;

    const bytes = new Uint8Array(packet);
    const view = new DataView(packet);

    if (bytes[0] === 0x02 && bytes[1] === 0x01) {
      if (packet.byteLength < ENCRYPTED_HEADER_SIZE + AUTH_TAG_SIZE) return 0;
      const plaintextLength = view.getUint32(16, true);
      if (
        packet.byteLength !==
        ENCRYPTED_HEADER_SIZE + plaintextLength + AUTH_TAG_SIZE
      ) {
        return 0;
      }
      return plaintextLength;
    }

    const fileId = view.getUint16(0, true);
    if (fileId === 0xffff) return 0;

    const payloadLength = view.getUint32(14, true);
    if (packet.byteLength !== HEADER_SIZE + payloadLength) return 0;
    return payloadLength;
  }

  public async waitForIdle(): Promise<void> {
    await this.writeQueue;
    if (this.writeFailure) {
      throw this.writeFailure;
    }
  }

  /**
   * Contiguous payload frontier (reordering next-expected).
   * Used by PARTITION_ACK so multi-lane arrivals cannot ACK past gaps.
   */
  public getContiguousReceivedOffset(): number {
    if (this.orderedBulkFastPath) {
      return this.contiguousOffset;
    }
    if (this.reorderingBuffer) {
      return this.reorderingBuffer.getNextExpectedOffset();
    }
    return this.contiguousOffset || this.totalBytesWritten;
  }

  /**
   * 🚀 [신규] 실제 쓰기 로직을 분리 (내부용)
   */
  /**
   * 🚀 [성능] 이미 복호화된 패킷 처리 (processChunkInternal에서 normalizePacket 분리)
   * writeChunk에서 복호화를 먼저 수행한 후 호출됨.
   */
  private async processDecodedChunk(normalizedPacket: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    if (normalizedPacket.byteLength < HEADER_SIZE) {
      throw new Error('Packet too short');
    }

    const view = new DataView(normalizedPacket);
    const fileId = view.getUint16(0, true);

    if (fileId === 0xffff) {
      logInfo('[DirectFileWriter]', 'EOS received signal.');
      await this.finalize();
      return;
    }

    this.awaitingResume = false;

    const size = view.getUint32(14, true);
    const offset = Number(view.getBigUint64(6, true));

    const totalReceived =
      this.totalBytesWritten +
      this.pendingBytesInBuffer -
      this.queuedAcceptedBytesInBuffer;

    const isSizeStrict = this.manifest && !this.manifest.isSizeEstimated;
    if (isSizeStrict && this.totalSize > 0 && totalReceived >= this.totalSize) {
      return;
    }

    if (normalizedPacket.byteLength !== HEADER_SIZE + size) {
      throw new Error('Corrupt packet');
    }

    const hasWriter =
      this.writerMode === 'opfs-fallback'
        ? !!this.opfsWriter
        : this.writerMode === 'blob-fallback'
          ? true
          : !!this.writer;

    if (!hasWriter) {
      throw new Error(`No writer available (mode: ${this.writerMode})`);
    }

    const data = new Uint8Array(normalizedPacket, HEADER_SIZE, size);

    // 1:1 ordered bulk: skip WASM reordering when stream is contiguous.
    if (this.orderedBulkFastPath && offset === this.contiguousOffset) {
      // Reuse the decrypted payload view (normalized packet is owned).
      // pendingBytes already counted at writeChunk admission — do not double-count.
      this.writeBuffer.push(data);
      this.currentBatchSize += data.byteLength;
      this.contiguousOffset = offset + size;
    } else if (this.reorderingBuffer) {
      // Gap / out-of-order: fall back to reordering buffer.
      this.orderedBulkFastPath = false;
      const chunksToWrite = this.reorderingBuffer.push(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        offset
      );
      for (const chunk of chunksToWrite) {
        this.writeBuffer.push(new Uint8Array(chunk));
        this.currentBatchSize += chunk.byteLength;
      }
      this.contiguousOffset = this.reorderingBuffer.getNextExpectedOffset();
    } else {
      const copy = data.slice();
      this.writeBuffer.push(copy);
      this.currentBatchSize += copy.byteLength;
      this.contiguousOffset = Math.max(this.contiguousOffset, offset + size);
    }

    this.checkBackpressure();
    this.reportProgress();

    if (this.currentBatchSize >= this.BATCH_THRESHOLD) {
      await this.flushBuffer();
    }
  }
  private async processChunkInternal(packet: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    if (packet.byteLength < HEADER_SIZE) {
      throw new Error('Packet too short');
    }

    const normalizedPacket = await this.normalizePacket(packet);
    const view = new DataView(normalizedPacket);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xffff) {
      logInfo('[DirectFileWriter]', 'EOS received signal.');
      await this.finalize();
      return;
    }

    this.awaitingResume = false;

    const size = view.getUint32(14, true);
    const offset = Number(view.getBigUint64(6, true));

    // 🚀 [FIX] ZIP 모드(isSizeEstimated)일 경우 Overflow 체크 완화
    const totalReceived =
      this.totalBytesWritten +
      this.pendingBytesInBuffer -
      this.queuedAcceptedBytesInBuffer;

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
    if (normalizedPacket.byteLength !== HEADER_SIZE + size) {
      throw new Error('Corrupt packet');
    }

    // Writer 체크 (모드별로 다른 writer 사용)
    const hasWriter =
      this.writerMode === 'opfs-fallback'
        ? !!this.opfsWriter
        : this.writerMode === 'blob-fallback'
          ? true // Blob 모드는 메모리에만 적재
          : !!this.writer;

    if (!hasWriter || !this.reorderingBuffer) {
      throw new Error(
        `No writer available (mode: ${this.writerMode}, writer: ${!!this.writer}, opfsWriter: ${!!this.opfsWriter}, reorderingBuffer: ${!!this.reorderingBuffer})`
      );
    }

    const data = new Uint8Array(normalizedPacket, HEADER_SIZE, size);

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

    // Small transfers can stay below BATCH_THRESHOLD until EOS. Report buffered
    // bytes too so the receiver UI does not sit at 0% while data is arriving.
    this.reportProgress();

    // 3. 임계값(8MB) 넘으면 디스크에 쓰기 (Flushing)
    if (this.currentBatchSize >= this.BATCH_THRESHOLD) {
      await this.flushBuffer();
    }
  }

  private async normalizePacket(packet: ArrayBuffer): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(packet);
    if (bytes[0] !== 0x02 || bytes[1] !== 0x01) {
      return packet;
    }

    // Wait for async arm so early bulk packets still hit the worker.
    if (this.bulkDecryptArmPromise) {
      try {
        await this.bulkDecryptArmPromise;
      } catch {
        // arm already logged; fall through to main-thread decrypt
      }
    }
    // Off-main-thread decrypt when worker is armed.
    if (this.bulkDecryptWorker) {
      // Transfer original buffer (zero-copy). On failure, packet is detached
      // so we rethrow — worker is required once armed for encrypted bulk.
      return await this.bulkDecryptWorker.decrypt(packet);
    }

    if (packet.byteLength < ENCRYPTED_HEADER_SIZE + AUTH_TAG_SIZE) {
      throw new Error('Encrypted packet too short');
    }

    const view = new DataView(packet);
    const offset = view.getBigUint64(8, true);
    const plaintextLength = view.getUint32(16, true);

    if (
      packet.byteLength !==
      ENCRYPTED_HEADER_SIZE + plaintextLength + AUTH_TAG_SIZE
    ) {
      throw new Error('Corrupt encrypted packet');
    }

    const decrypted = await this.decryptEncryptedPacket(bytes);
    if (decrypted.byteLength !== plaintextLength) {
      throw new Error('Encrypted packet plaintext length mismatch');
    }

    const normalized = new ArrayBuffer(HEADER_SIZE + decrypted.length);
    const normalizedView = new DataView(normalized);
    const normalizedBytes = new Uint8Array(normalized);

    normalizedView.setUint16(0, 0, true);
    normalizedView.setUint32(2, 0, true);
    normalizedView.setBigUint64(6, offset, true);
    normalizedView.setUint32(14, decrypted.length, true);
    normalizedView.setUint32(18, 0, true);
    normalizedBytes.set(decrypted, HEADER_SIZE);
    return normalized;
  }


  private async decryptEncryptedPacket(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.sessionKey && globalThis.crypto?.subtle) {
      const key = await this.ensureDecryptCryptoKey();
      const iv = bytes.slice(20, 32);
      const ciphertextWithTag = bytes.slice(ENCRYPTED_HEADER_SIZE);

      try {
        const decrypted = await globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv,
            tagLength: 128,
          },
          key,
          ciphertextWithTag
        );
        return new Uint8Array(decrypted);
      } catch (error) {
        throw new Error(
          `Encrypted packet decrypt failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const session = await this.ensureCryptoSession();
    return session.decrypt_chunk(bytes);
  }

  private async ensureDecryptCryptoKey(): Promise<CryptoKey> {
    if (this.decryptCryptoKey) {
      return this.decryptCryptoKey;
    }
    if (!this.sessionKey) {
      throw new Error('Encrypted packet received before crypto session');
    }
    // Prefer a concrete Uint8Array key material. Some jsdom/vitest crypto
    // polyfills reject plain ArrayBuffer even when Node webcrypto accepts it.
    const keyBytes = new Uint8Array(this.sessionKey.byteLength);
    keyBytes.set(this.sessionKey);
    this.decryptCryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    return this.decryptCryptoKey;
  }

  private async ensureCryptoSession(): Promise<CryptoSession> {
    if (this.cryptoSession) {
      return this.cryptoSession;
    }
    if (!this.sessionKey || !this.randomPrefix) {
      throw new Error('Encrypted packet received before crypto session');
    }

    await initPonsCore();
    this.cryptoSession = new CryptoSession(this.sessionKey, this.randomPrefix);
    return this.cryptoSession;
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

    if (this.isReceiverZipMode()) {
      await this.writeZipInput(mergedBuffer);
    } else {
      await this.writeOutputData(mergedBuffer);
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

  private async writeOutputData(data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return;

    if (this.writerMode === 'blob-fallback') {
      // Blob 모드: 메모리에 계속 적재 (finalize에서 한 번에 다운로드)
      this.blobChunks.push(data);
    } else if (this.writerMode === 'opfs-fallback') {
      // OPFS 모드: 디스크에 직접 쓰기
      if (this.opfsWriter) {
        await this.opfsWriter.write({
          type: 'write',
          position: this.outputBytesWritten,
          data: data as BufferSource,
        });
      }
    } else if (this.writerMode === 'file-system-access') {
      const fsWriter = this.writer as FileSystemWritableFileStream;
      await fsWriter.write({
        type: 'write',
        position: this.outputBytesWritten,
        data: data as BufferSource,
      });
    } else {
      const streamWriter = this.writer as WritableStreamDefaultWriter;
      await streamWriter.ready;
      await streamWriter.write(data);
    }

    this.outputBytesWritten += data.byteLength;
  }

  private isReceiverZipMode(): boolean {
    return (
      !!this.manifest.isSizeEstimated && (this.manifest.totalFiles ?? 0) > 1
    );
  }

  private async ensureReceiverZipStream(): Promise<Zip64Stream> {
    if (!this.receiverZipStream) {
      await initPonsCore();
      this.receiverZipStream = new Zip64Stream(0);
    }
    return this.receiverZipStream;
  }

  private async writeZipInput(data: Uint8Array): Promise<void> {
    const zip = await this.ensureReceiverZipStream();
    let cursor = 0;

    while (cursor < data.byteLength) {
      await this.emitPendingZeroByteZipEntries(zip);

      const fileMeta = this.manifest.files?.[this.receiverZipFileIndex];
      if (!fileMeta) {
        throw new Error(
          'Received more source data than the manifest describes'
        );
      }

      if (fileMeta.size === 0) {
        continue;
      }

      if (this.receiverZipFileBytesWritten === 0) {
        await this.writeOutputData(
          zip.begin_file(fileMeta.path, BigInt(fileMeta.size))
        );
      }

      const remainingForFile = fileMeta.size - this.receiverZipFileBytesWritten;
      const take = Math.min(remainingForFile, data.byteLength - cursor);
      const sourceSlice = data.subarray(cursor, cursor + take);
      const zipChunk = zip.process_chunk(sourceSlice);
      await this.writeOutputData(zipChunk);

      cursor += take;
      this.receiverZipFileBytesWritten += take;

      if (this.receiverZipFileBytesWritten === fileMeta.size) {
        await this.writeOutputData(zip.end_file());
        this.receiverZipFileIndex++;
        this.receiverZipFileBytesWritten = 0;
      }
    }
  }

  private async emitPendingZeroByteZipEntries(zip: Zip64Stream): Promise<void> {
    while (this.receiverZipFileIndex < (this.manifest.files?.length ?? 0)) {
      const fileMeta = this.manifest.files?.[this.receiverZipFileIndex];
      if (!fileMeta || fileMeta.size !== 0) return;

      await this.writeOutputData(zip.begin_file(fileMeta.path, 0n));
      await this.writeOutputData(zip.end_file());
      this.receiverZipFileIndex++;
      this.receiverZipFileBytesWritten = 0;
    }
  }

  private async finalizeReceiverZip(): Promise<void> {
    if (!this.isReceiverZipMode() || this.receiverZipFinalized) return;
    if (this.totalBytesWritten !== this.totalSize) return;

    const zip = await this.ensureReceiverZipStream();
    await this.emitPendingZeroByteZipEntries(zip);

    const remainingFile = this.manifest.files?.[this.receiverZipFileIndex];
    if (remainingFile) {
      throw new Error(
        `Missing ZIP source data for ${remainingFile.path}: expected ${remainingFile.size} bytes`
      );
    }

    await this.writeOutputData(zip.finalize());
    this.receiverZipFinalized = true;
  }

  /**
   * 진행률 보고
   */
  private reportProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressTime < 200) return;

    const visibleProgress = calculateReceiverBufferedProgress({
      bytesWritten: this.totalBytesWritten,
      pendingBytes: this.pendingBytesInBuffer,
      totalBytes: this.totalSize,
    });
    const speed = this.speedMeter.update(
      visibleProgress.bytesTransferred,
      now
    );

    this.onProgressCallback?.({
      progress: visibleProgress.progress,
      speed,
      bytesTransferred: visibleProgress.bytesTransferred,
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

    // 버퍼에 남은 잔여 데이터 강제 플러시
    await this.flushBuffer();

    // 버퍼 정리 및 데이터 손실 체크
    if (this.reorderingBuffer) {
      const stats = this.reorderingBuffer.getStatus();
      if (stats.bufferedCount > 0) {
        const isSizeStrict = this.manifest && !this.manifest.isSizeEstimated;
        if (
          isSizeStrict &&
          this.totalSize > 0 &&
          this.totalBytesWritten >= this.totalSize
        ) {
          logWarn(
            '[DirectFileWriter]',
            `Discarding ${stats.bufferedCount} buffered chunk(s) after exact-size completion`
          );
          this.reorderingBuffer.clear();
        } else {
          if (
            this.requestResume(
              stats.nextExpected,
              `${stats.bufferedCount} buffered chunk(s) are waiting for missing data`
            )
          ) {
            return;
          }

          await this.abortIncompleteTransfer(
            `INCOMPLETE_TRANSFER|Transfer incomplete: ${stats.bufferedCount} chunk(s) are still waiting for missing data at offset ${stats.nextExpected}. Received ${formatBytes(this.totalBytesWritten)} of ${formatBytes(this.totalSize)}.`
          );
          return;
        }
      }
    }

    const incompleteError = this.getIncompleteTransferError();
    if (incompleteError) {
      if (
        this.requestResume(
          this.totalBytesWritten,
          `received ${formatBytes(this.totalBytesWritten)} of ${formatBytes(this.totalSize)}`
        )
      ) {
        return;
      }

      await this.abortIncompleteTransfer(incompleteError);
      return;
    }

    this.isFinalized = true;

    if (this.reorderingBuffer) {
      this.reorderingBuffer.clear();
      this.reorderingBuffer = null;
    }

    await this.finalizeReceiverZip();

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
          if ((fsWriter as unknown as { locked: boolean }).locked) {
            throw new Error('File writer is locked and cannot be committed');
          }

          const maybeTruncate = (
            fsWriter as unknown as {
              truncate?: (size: number) => Promise<void>;
            }
          ).truncate;
          if (typeof maybeTruncate === 'function') {
            await maybeTruncate.call(fsWriter, this.outputBytesWritten);
          }
          await fsWriter.close();
        } else {
          const streamWriter = this.writer as WritableStreamDefaultWriter;
          await streamWriter.close();
        }
        logInfo(
          '[DirectFileWriter]',
          `✅ File saved (${this.writerMode}): ${this.totalBytesWritten} bytes`
        );
      } catch (error: unknown) {
        const closeError =
          error instanceof Error
            ? error
            : new Error('Unknown file close failure');
        logError('[DirectFileWriter]', 'Error closing file:', closeError);
        throw closeError;
      }
    }

    this.writer = null;
    this.onCompleteCallback?.(this.totalBytesWritten);
  }

  private getIncompleteTransferError(): string | null {
    const isSizeStrict = this.manifest && !this.manifest.isSizeEstimated;

    if (isSizeStrict && this.totalSize > 0) {
      if (this.totalBytesWritten === this.totalSize) {
        return null;
      }

      return `INCOMPLETE_TRANSFER|Transfer incomplete: received ${formatBytes(this.totalBytesWritten)} of ${formatBytes(this.totalSize)}. The partial file was discarded. Please retry, or use Cloud Drop if the sender cannot stay connected.`;
    }

    if (this.manifest?.isSizeEstimated && this.totalSize > 0) {
      if (this.totalBytesWritten >= this.totalSize) {
        return null;
      }

      return `INCOMPLETE_TRANSFER|Transfer incomplete: received ${formatBytes(this.totalBytesWritten)} but expected at least ${formatBytes(this.totalSize)}. The partial file was discarded. Please retry, or use Cloud Drop if the sender cannot stay connected.`;
    }

    return null;
  }

  private async abortIncompleteTransfer(message: string): Promise<never> {
    logError('[DirectFileWriter]', message);
    await this.cleanup();
    throw new Error(message);
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

  public onResumeRequest(
    callback: (offset: number, reason: string) => void
  ): void {
    this.onResumeRequestCallback = callback;
  }

  public requestResumeFromCurrentOffset(reason: string): boolean {
    return this.requestResume(this.totalBytesWritten, reason);
  }

  private requestResume(offset: number, reason: string): boolean {
    if (!this.canRequestResume()) {
      return false;
    }

    if (this.awaitingResume) {
      return true;
    }

    this.resumeAttempts++;
    this.awaitingResume = true;
    logWarn(
      '[DirectFileWriter]',
      `Requesting resume from offset ${offset} (${this.resumeAttempts}/${MAX_RESUME_ATTEMPTS}): ${reason}`
    );
    this.onResumeRequestCallback?.(offset, reason);
    return true;
  }

  private canRequestResume(): boolean {
    return (
      !!this.onResumeRequestCallback &&
      (this.isReceiverZipMode() ||
        (!this.manifest.isSizeEstimated &&
          (this.manifest.totalFiles ?? this.manifest.files?.length ?? 0) ===
            1)) &&
      this.resumeAttempts < MAX_RESUME_ATTEMPTS
    );
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
    this.bulkDecryptWorker?.close();
    this.bulkDecryptWorker = null;
    this.isFinalized = true;
    this.writeBuffer = []; // 메모리 해제
    this.blobChunks = []; // Blob 청크 메모리 해제
    this.isPaused = false;
    this.awaitingResume = false;
    this.receiverZipStream?.reset();
    this.receiverZipStream = null;
    this.receiverZipFinalized = false;
    if (this.sessionKey) {
      this.sessionKey.fill(0);
    }
    if (this.randomPrefix) {
      this.randomPrefix.fill(0);
    }
    this.sessionKey = null;
    this.randomPrefix = null;
    this.cryptoSession?.reset();
    this.cryptoSession = null;
    this.decryptCryptoKey = null;
    this.writeFailure = null;

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
