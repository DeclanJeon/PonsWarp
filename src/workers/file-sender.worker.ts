/// <reference lib="webworker" />
import { debugLog } from '../utils/logger';
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 Sender Worker V5 (Zero-Copy Packet Pool + E2E Encryption + ZIP64)
// - Zero-Copy: WASM 메모리 직접 접근으로 GC 오버헤드 최소화
// - CRC32 & Packet Encoding: Rust/WASM (pons-core-wasm)
// - E2E Encryption: AES-256-GCM (pons-core-wasm)
// - ZIP64: Rust/WASM (pons-core-wasm) - 4GB+ 파일 지원
// - Features: Zero-copy streaming, Aggregation, Backpressure
// ============================================================================

import init, {
  PacketEncoder,
  CryptoSession,
  Zip64Stream,
  ZeroCopyPacketPool,
} from 'pons-core-wasm';
import { TransferManifest } from '../types/types';
import {
  BATCH_SIZE_INITIAL,
  BATCH_SIZE_MAX,
  BATCH_SIZE_MIN,
  CHUNK_SIZE_INITIAL,
  CHUNK_SIZE_MAX,
  CHUNK_SIZE_MIN,
  PREFETCH_BUFFER_SIZE,
} from '../utils/constants';

const ZIP_QUEUE_HIGH_WATER_MARK = 32 * 1024 * 1024;
const ZIP_QUEUE_LOW_WATER_MARK = 8 * 1024 * 1024;

interface AdaptiveConfig {
  chunkSize: number;
  prefetchBatch: number;
  enableAdaptive: boolean;
}

class DoubleBuffer {
  private bufferA: ArrayBuffer[] = [];
  private bufferB: ArrayBuffer[] = [];
  private sizeA = 0;
  private sizeB = 0;
  private activeBuffer: 'A' | 'B' = 'A';
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  getActiveSize(): number {
    return this.activeBuffer === 'A' ? this.sizeA : this.sizeB;
  }

  getInactiveSize(): number {
    return this.activeBuffer === 'A' ? this.sizeB : this.sizeA;
  }

  canPrefetch(): boolean {
    return this.getInactiveSize() < this.maxSize;
  }

  addToInactive(chunk: ArrayBuffer) {
    if (this.activeBuffer === 'A') {
      this.bufferB.push(chunk);
      this.sizeB += chunk.byteLength;
    } else {
      this.bufferA.push(chunk);
      this.sizeA += chunk.byteLength;
    }
  }

  takeFromActive(count: number): ArrayBuffer[] {
    const chunks: ArrayBuffer[] = [];
    const activeChunks =
      this.activeBuffer === 'A' ? this.bufferA : this.bufferB;

    for (let i = 0; i < count && activeChunks.length > 0; i++) {
      const chunk = activeChunks.shift()!;
      if (this.activeBuffer === 'A') {
        this.sizeA -= chunk.byteLength;
      } else {
        this.sizeB -= chunk.byteLength;
      }
      chunks.push(chunk);
    }
    return chunks;
  }

  swap(): boolean {
    if (this.getActiveSize() === 0 && this.getInactiveSize() > 0) {
      this.activeBuffer = this.activeBuffer === 'A' ? 'B' : 'A';
      return true;
    }
    return false;
  }

  isEmpty(): boolean {
    return this.sizeA === 0 && this.sizeB === 0;
  }

  clear() {
    this.bufferA = [];
    this.bufferB = [];
    this.sizeA = 0;
    this.sizeB = 0;
    this.activeBuffer = 'A';
  }
}

interface WorkerState {
  files: File[];
  manifest: TransferManifest | null;
  mode: 'single' | 'multi-raw' | 'zip';
  currentFileOffset: number;
  currentFileIndex: number;
  zipStream: ReadableStream<Uint8Array> | null;
  zipReader: ReadableStreamDefaultReader<Uint8Array> | null;
  startTime: number;
  isInitialized: boolean;
  isCompleted: boolean;
}

const state: WorkerState = {
  files: [],
  manifest: null,
  mode: 'single',
  currentFileOffset: 0,
  currentFileIndex: 0,
  zipStream: null,
  zipReader: null,
  startTime: 0,
  isInitialized: false,
  isCompleted: false,
};

const adaptiveConfig: AdaptiveConfig = {
  chunkSize: CHUNK_SIZE_INITIAL,
  prefetchBatch: BATCH_SIZE_INITIAL,
  enableAdaptive: true,
};

const doubleBuffer = new DoubleBuffer(PREFETCH_BUFFER_SIZE);
let isTransferActive = false;
let prefetchPromise: Promise<void> | null = null;

let isZipPaused = false;
let resolveZipResume: (() => void) | null = null;
let currentZipQueueSize = 0;

// 🦀 WASM ZIP64 Stream
let zip64Stream: Zip64Stream | null = null;

// 🦀 WASM PacketEncoder (레거시 fallback)
let packetEncoder: PacketEncoder | null = null;
let wasmReady = false;

// 🚀 Zero-Copy Packet Pool
let zeroCopyPool: ZeroCopyPacketPool | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let zeroCopyEnabled = false;

// 🔐 E2E Encryption
let cryptoSession: CryptoSession | null = null;
let encryptionEnabled = false;
let pendingEncryptionKey: {
  sessionKey: Uint8Array;
  randomPrefix: Uint8Array;
} | null = null;

// WASM 초기화
async function initWasm() {
  try {
    const wasmInstance = await init();

    // Zero-Copy Pool 초기화 (64 슬롯)
    zeroCopyPool = new ZeroCopyPacketPool();

    // WASM 메모리 참조 획득
    wasmMemory = wasmInstance.memory;
    zeroCopyEnabled = true;

    // 레거시 PacketEncoder도 초기화 (fallback용)
    packetEncoder = new PacketEncoder();
    wasmReady = true;

    debugLog('[Sender Worker] WASM initialized with Zero-Copy Pool');
  } catch (e) {
    console.error('[Sender Worker] WASM init failed:', e);
    wasmReady = false;
    zeroCopyEnabled = false;
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'init':
      initWorker(payload);
      break;
    case 'process-batch':
      processBatch(payload.count);
      break;
    case 'resume-single-file':
      resumeSingleFile(payload.offset);
      break;
    case 'reset':
      resetWorker();
      break;
    case 'update-config':
      updateAdaptiveConfig(payload);
      break;
    case 'update-adaptive-config':
      updateAdaptiveConfig(payload);
      break;
    case 'set-encryption-key':
      setEncryptionKey(payload);
      break;
  }
};

/**
 * 🔐 암호화 키 설정
 */
function setEncryptionKey(payload: {
  sessionKey: Uint8Array;
  randomPrefix: Uint8Array;
}) {
  try {
    if (!wasmReady) {
      pendingEncryptionKey = {
        sessionKey: payload.sessionKey,
        randomPrefix: payload.randomPrefix,
      };
      return;
    }

    cryptoSession = new CryptoSession(payload.sessionKey, payload.randomPrefix);
    encryptionEnabled = true;
    pendingEncryptionKey = null;
    debugLog('[Sender Worker] 🔐 E2E encryption enabled');
    self.postMessage({ type: 'encryption-ready' });
  } catch (e) {
    console.error('[Sender Worker] Encryption setup failed:', e);
    self.postMessage({ type: 'encryption-error', payload: e.message });
  }
}

function updateAdaptiveConfig(config: Partial<AdaptiveConfig>) {
  if (config.chunkSize !== undefined) {
    adaptiveConfig.chunkSize = Math.max(
      CHUNK_SIZE_MIN,
      Math.min(CHUNK_SIZE_MAX, config.chunkSize)
    );
  }
  if (config.prefetchBatch !== undefined) {
    adaptiveConfig.prefetchBatch = Math.max(
      BATCH_SIZE_MIN,
      Math.min(BATCH_SIZE_MAX, config.prefetchBatch)
    );
  }
  if (config.enableAdaptive !== undefined) {
    adaptiveConfig.enableAdaptive = config.enableAdaptive;
  }
}

async function initWorker(payload: {
  files: File[];
  manifest: TransferManifest;
}) {
  resetWorker();

  if (!wasmReady) {
    await initWasm();
  }

  if (pendingEncryptionKey) {
    setEncryptionKey(pendingEncryptionKey);
  }

  if (packetEncoder) {
    packetEncoder.reset();
  }

  state.files = payload.files;
  state.manifest = payload.manifest;
  state.startTime = 0;
  state.isInitialized = true;
  state.isCompleted = false;
  state.currentFileOffset = 0;
  state.currentFileIndex = 0;

  isTransferActive = true;
  prefetchPromise = null;
  zipBuffer = null;

  const fileCount = state.files.length;
  debugLog(
    '[Sender Worker] Initializing for',
    fileCount,
    'files (WASM:',
    wasmReady,
    ', Encrypted:',
    encryptionEnabled,
    ')'
  );

  if (fileCount === 1) {
    state.mode = 'single';
  } else {
    state.mode = 'multi-raw';
  }

  triggerPrefetch();
  self.postMessage({ type: 'init-complete' });
}

async function resumeSingleFile(offset: number) {
  if (!state.isInitialized) {
    self.postMessage({
      type: 'error',
      payload: {
        message: 'Resume is only available for initialized transfers',
      },
    });
    return;
  }

  const totalSize = state.manifest?.totalSize ?? state.files[0]?.size ?? 0;
  const safeOffset = Math.max(0, Math.min(offset, totalSize));

  try {
    await singleFileReader?.cancel();
  } catch {
    // Ignore reader cancellation during resume.
  }

  doubleBuffer.clear();
  singleFileBuffer = null;
  prefetchPromise = null;
  state.currentFileOffset = safeOffset;
  state.isCompleted = safeOffset >= totalSize;
  isTransferActive = true;

  if (state.files.length === 1) {
    const file = state.files[0];
    state.mode = 'single';
    state.currentFileIndex = 0;
    singleFileReader =
      safeOffset < file.size
        ? file.slice(safeOffset).stream().getReader()
        : null;
  } else {
    state.mode = 'multi-raw';
    seekMultiFileOffset(safeOffset);
  }

  if (zeroCopyPool) {
    zeroCopyPool.set_total_bytes(BigInt(safeOffset));
  } else {
    self.postMessage({
      type: 'error',
      payload: { message: 'Resume requires the zero-copy packet encoder' },
    });
    return;
  }

  fallbackTotalBytes = safeOffset;
  fallbackSequence = Math.floor(safeOffset / CHUNK_SIZE_INITIAL);

  triggerPrefetch();
  self.postMessage({ type: 'resume-ready', payload: { offset: safeOffset } });
}

let zipSourceBytesRead = 0;

// Reserved for the legacy ZIP streaming mode. Multi-file sends currently use
// raw manifest chunks so offset resume can stay deterministic.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function initZipStream() {
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

  // 🦀 WASM ZIP64 스트림 초기화 (4GB+ 파일 지원)
  // ⚡ STORE 모드 (압축 없음) - 전송 속도 최적화
  zip64Stream = new Zip64Stream(0); // 0 = STORE (압축 없음)

  const zipDataQueue: Uint8Array[] = [];
  let resolveDataAvailable: (() => void) | null = null;
  let zipFinalized = false;
  let hasError = false;

  const pushToQueue = (data: Uint8Array) => {
    if (data.length > 0) {
      zipDataQueue.push(data);
      currentZipQueueSize += data.length;
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
    }
  };

  const processFilesAsync = async () => {
    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;

        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest?.files?.[i]) {
          filePath = state.manifest.files[i].path;
        }

        // 🦀 파일 시작 (Local File Header 생성)
        const header = zip64Stream!.begin_file(filePath, BigInt(file.size));
        pushToQueue(header);

        const reader = file.stream().getReader();
        try {
          for (;;) {
            // 백프레셔 체크
            if (currentZipQueueSize > ZIP_QUEUE_HIGH_WATER_MARK) {
              isZipPaused = true;
              await new Promise<void>(resolve => {
                resolveZipResume = resolve;
              });
              isZipPaused = false;
            }

            const { done, value } = await reader.read();
            if (done) break;

            zipSourceBytesRead += value.length;

            // 🦀 WASM 패키징 (압축 없음)
            const processed = zip64Stream!.process_chunk(value);
            if (processed.length > 0) {
              pushToQueue(processed);
            }
          }
        } finally {
          reader.releaseLock();
        }

        // 🦀 파일 종료 (Data Descriptor 생성)
        const descriptor = zip64Stream!.end_file();
        if (descriptor.length > 0) {
          pushToQueue(descriptor);
        }
      }

      // 🦀 ZIP 아카이브 종료 (Central Directory + EOCD64)
      if (isTransferActive && zip64Stream) {
        const footer = zip64Stream.finalize();
        pushToQueue(footer);
        zipFinalized = true;
        resolveDataAvailable?.();
        resolveDataAvailable = null;
      }
    } catch (e) {
      console.error('[Sender Worker] Fatal ZIP64 error:', e);
      hasError = true;
      resolveDataAvailable?.();
      resolveDataAvailable = null;
    }
  };

  state.zipStream = new ReadableStream({
    async pull(controller) {
      const consumeAndCheckResume = (chunk: Uint8Array) => {
        currentZipQueueSize -= chunk.length;
        controller.enqueue(chunk);
        if (isZipPaused && currentZipQueueSize < ZIP_QUEUE_LOW_WATER_MARK) {
          resolveZipResume?.();
          resolveZipResume = null;
        }
      };

      if (zipDataQueue.length > 0) {
        consumeAndCheckResume(zipDataQueue.shift()!);
        return;
      }
      if (zipFinalized) {
        controller.close();
        return;
      }
      if (hasError) {
        controller.error(new Error('ZIP64 failed'));
        return;
      }

      await new Promise<void>(resolve => {
        resolveDataAvailable = resolve;
      });

      if (zipDataQueue.length > 0) consumeAndCheckResume(zipDataQueue.shift()!);
      else if (zipFinalized) controller.close();
      else if (hasError) controller.error(new Error('ZIP64 failed'));
    },
  });

  state.zipReader = state.zipStream.getReader();
  processFilesAsync();

  const waitStart = Date.now();
  while (
    zipDataQueue.length === 0 &&
    !zipFinalized &&
    !hasError &&
    Date.now() - waitStart < 2000
  ) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function resetWorker() {
  isTransferActive = false;
  state.zipReader?.cancel();
  state.zipReader = null;

  if (singleFileReader) {
    try {
      singleFileReader.cancel();
    } catch {
      // Ignore reader cancellation during reset.
    }
    singleFileReader = null;
  }
  singleFileBuffer = null;

  resolveZipResume?.();
  resolveZipResume = null;
  isZipPaused = false;
  currentZipQueueSize = 0;

  state.isInitialized = false;
  state.isCompleted = false;
  state.files = [];
  state.currentFileIndex = 0;
  state.currentFileOffset = 0;

  doubleBuffer.clear();
  zipBuffer = null;

  packetEncoder?.reset();
  cryptoSession?.reset();
  zeroCopyPool?.reset();
  zip64Stream?.reset();
  zip64Stream = null;
}

function triggerPrefetch() {
  if (prefetchPromise || state.isCompleted || !isTransferActive) return;
  if (!doubleBuffer.canPrefetch()) return;

  prefetchPromise = prefetchBatch().finally(() => {
    prefetchPromise = null;
    if (isTransferActive && !state.isCompleted && doubleBuffer.canPrefetch()) {
      triggerPrefetch();
    }
  });
}

async function prefetchBatch(): Promise<void> {
  const batchSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.prefetchBatch
    : BATCH_SIZE_INITIAL;
  for (
    let i = 0;
    i < batchSize && isTransferActive && !state.isCompleted;
    i++
  ) {
    if (!doubleBuffer.canPrefetch()) break;
    const chunk = await createNextChunk();
    if (chunk) doubleBuffer.addToInactive(chunk);
    else break;
  }
}

async function createNextChunk(): Promise<ArrayBuffer | null> {
  if (state.mode === 'single') return createSingleFileChunk();
  if (state.mode === 'multi-raw') return createMultiFileChunk();
  return createZipChunk();
}

let singleFileReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let singleFileBuffer: Uint8Array | null = null;

function seekMultiFileOffset(globalOffset: number): void {
  let remaining = globalOffset;
  state.currentFileIndex = 0;

  while (
    state.currentFileIndex < state.files.length &&
    remaining >= state.files[state.currentFileIndex].size
  ) {
    remaining -= state.files[state.currentFileIndex].size;
    state.currentFileIndex++;
  }

  if (state.currentFileIndex >= state.files.length) {
    singleFileReader = null;
    state.isCompleted = true;
    return;
  }

  const file = state.files[state.currentFileIndex];
  singleFileReader = file.slice(remaining).stream().getReader();
}

async function createSingleFileChunk(): Promise<ArrayBuffer | null> {
  if (state.files.length === 0) return null;
  const file = state.files[0];

  if (!singleFileReader && state.currentFileOffset === 0) {
    singleFileReader = file.stream().getReader();
  }

  if (state.currentFileOffset >= file.size) {
    state.isCompleted = true;
    try {
      await singleFileReader?.cancel();
    } catch {
      // Ignore reader cancellation after completion.
    }
    singleFileReader = null;
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.chunkSize
    : CHUNK_SIZE_INITIAL;

  try {
    for (;;) {
      const bufferSize = singleFileBuffer?.length ?? 0;

      if (
        bufferSize >= currentChunkSize ||
        state.currentFileOffset + bufferSize >= file.size
      ) {
        const dataToSend = singleFileBuffer!.slice(0, currentChunkSize);
        const remaining = singleFileBuffer!.slice(currentChunkSize);
        singleFileBuffer = remaining.length > 0 ? remaining : null;
        state.currentFileOffset += dataToSend.length;
        return createPacket(dataToSend);
      }

      if (!singleFileReader) {
        state.isCompleted = true;
        return null;
      }

      const { done, value } = await singleFileReader.read();

      if (done) {
        if (singleFileBuffer && singleFileBuffer.length > 0) {
          const dataToSend = singleFileBuffer;
          singleFileBuffer = null;
          state.currentFileOffset += dataToSend.length;
          singleFileReader = null;
          return createPacket(dataToSend);
        }
        state.isCompleted = true;
        singleFileReader = null;
        return null;
      }

      if (singleFileBuffer) {
        const newBuffer = new Uint8Array(
          singleFileBuffer.length + value.length
        );
        newBuffer.set(singleFileBuffer);
        newBuffer.set(value, singleFileBuffer.length);
        singleFileBuffer = newBuffer;
      } else {
        singleFileBuffer = value;
      }
    }
  } catch (e) {
    console.error('[Sender Worker] Single chunk error:', e);
    try {
      await singleFileReader?.cancel();
    } catch {
      // Ignore reader cancellation after a read error.
    }
    singleFileReader = null;
    singleFileBuffer = null;
    return null;
  }
}

function getCurrentFileStartOffset(): number {
  let offset = 0;
  for (let i = 0; i < state.currentFileIndex; i++) {
    offset += state.files[i].size;
  }
  return offset;
}

async function createMultiFileChunk(): Promise<ArrayBuffer | null> {
  if (state.currentFileIndex >= state.files.length) {
    state.isCompleted = true;
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.chunkSize
    : CHUNK_SIZE_INITIAL;

  try {
    for (;;) {
      const file = state.files[state.currentFileIndex];
      const fileStartOffset = getCurrentFileStartOffset();
      const localOffset = state.currentFileOffset - fileStartOffset;

      if (localOffset >= file.size) {
        try {
          await singleFileReader?.cancel();
        } catch {
          // Ignore reader cancellation when advancing files.
        }
        singleFileReader = null;
        singleFileBuffer = null;
        state.currentFileIndex++;

        if (state.currentFileIndex >= state.files.length) {
          state.isCompleted = true;
          return null;
        }

        singleFileReader = state.files[state.currentFileIndex]
          .stream()
          .getReader();
        continue;
      }

      if (!singleFileReader) {
        singleFileReader = file.slice(localOffset).stream().getReader();
      }

      const bufferSize = singleFileBuffer?.length ?? 0;
      const remainingInFile = file.size - localOffset;
      if (bufferSize >= currentChunkSize || bufferSize >= remainingInFile) {
        const take = Math.min(currentChunkSize, remainingInFile);
        const dataToSend = singleFileBuffer!.slice(0, take);
        const remaining = singleFileBuffer!.slice(take);
        singleFileBuffer = remaining.length > 0 ? remaining : null;
        state.currentFileOffset += dataToSend.length;
        return createPacket(dataToSend);
      }

      const { done, value } = await singleFileReader.read();
      if (done) {
        if (singleFileBuffer && singleFileBuffer.length > 0) {
          const take = Math.min(singleFileBuffer.length, remainingInFile);
          const dataToSend = singleFileBuffer.slice(0, take);
          const remaining = singleFileBuffer.slice(take);
          singleFileBuffer = remaining.length > 0 ? remaining : null;
          state.currentFileOffset += dataToSend.length;
          return createPacket(dataToSend);
        }

        state.currentFileOffset = fileStartOffset + file.size;
        continue;
      }

      if (singleFileBuffer) {
        const newBuffer = new Uint8Array(
          singleFileBuffer.length + value.length
        );
        newBuffer.set(singleFileBuffer);
        newBuffer.set(value, singleFileBuffer.length);
        singleFileBuffer = newBuffer;
      } else {
        singleFileBuffer = value;
      }
    }
  } catch (e) {
    console.error('[Sender Worker] Multi-file chunk error:', e);
    try {
      await singleFileReader?.cancel();
    } catch {
      // Ignore reader cancellation after a read error.
    }
    singleFileReader = null;
    singleFileBuffer = null;
    return null;
  }
}

let zipBuffer: Uint8Array | null = null;

async function createZipChunk(): Promise<ArrayBuffer | null> {
  if (!state.zipReader) {
    state.isCompleted = true;
    return null;
  }

  const targetChunkSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.chunkSize
    : CHUNK_SIZE_INITIAL;

  if (zipBuffer && zipBuffer.length >= targetChunkSize) {
    const chunkData = zipBuffer.slice(0, targetChunkSize);
    const remaining = zipBuffer.slice(targetChunkSize);
    zipBuffer = remaining.length > 0 ? remaining : null;
    return createPacket(chunkData);
  }

  for (;;) {
    try {
      const { done, value } = await state.zipReader.read();

      if (done) {
        if (zipBuffer && zipBuffer.length > 0) {
          const chunkData = zipBuffer;
          zipBuffer = null;
          return createPacket(chunkData);
        }
        state.isCompleted = true;
        return null;
      }

      if (value && value.length > 0) {
        if (zipBuffer) {
          const newBuffer = new Uint8Array(zipBuffer.length + value.length);
          newBuffer.set(zipBuffer);
          newBuffer.set(value, zipBuffer.length);
          zipBuffer = newBuffer;
        } else {
          zipBuffer = value;
        }

        if (zipBuffer.length >= targetChunkSize) {
          const chunkData = zipBuffer.slice(0, targetChunkSize);
          const remaining = zipBuffer.slice(targetChunkSize);
          zipBuffer = remaining.length > 0 ? remaining : null;
          return createPacket(chunkData);
        }
      }
    } catch (e) {
      console.error('[Sender Worker] ZIP chunk error:', e);
      state.isCompleted = true;
      return null;
    }
  }
}

/**
 * 🚀 Zero-Copy 패킷 생성
 * WASM 메모리에 직접 쓰기하여 GC 오버헤드 최소화
 */
function createPacketZeroCopy(data: Uint8Array): ArrayBuffer {
  if (!zeroCopyPool || !wasmMemory) {
    return createPacketLegacy(data);
  }

  // 슬롯 획득: [slot_id, data_ptr, max_size]
  const slotInfo = zeroCopyPool.acquire_slot();
  if (slotInfo[0] < 0) {
    // 풀 가득 참 - 레거시 방식으로 fallback
    console.warn('[Sender Worker] Zero-Copy pool exhausted, using legacy');
    return createPacketLegacy(data);
  }

  const slotId = slotInfo[0];
  const dataPtr = slotInfo[1];
  const maxSize = slotInfo[2];

  // 데이터 크기 검증
  if (data.length > maxSize) {
    zeroCopyPool.release_slot(slotId);
    console.warn('[Sender Worker] Data too large for slot, using legacy');
    return createPacketLegacy(data);
  }

  // 🚀 Zero-Copy: WASM 메모리에 직접 쓰기
  const wasmBuffer = new Uint8Array(wasmMemory.buffer, dataPtr, data.length);
  wasmBuffer.set(data);

  // 암호화 모드
  let packetLen: number;
  if (encryptionEnabled && cryptoSession) {
    packetLen = zeroCopyPool.commit_encrypted_slot(
      slotId,
      data.length,
      cryptoSession
    );
  } else {
    packetLen = zeroCopyPool.commit_slot(slotId, data.length);
  }

  if (packetLen === 0) {
    zeroCopyPool.release_slot(slotId);
    return createPacketLegacy(data);
  }

  // 패킷 뷰 획득: [ptr, len]
  const view = zeroCopyPool.get_packet_view(slotId);
  const packetPtr = view[0];
  const packetLength = view[1];

  // 🚀 Zero-Copy 전송: WASM 메모리에서 직접 ArrayBuffer 생성
  // WebRTC는 ArrayBuffer를 전송 후 detach하므로 복사 필요
  const packet = new ArrayBuffer(packetLength);
  const packetView = new Uint8Array(packet);
  const sourceView = new Uint8Array(wasmMemory.buffer, packetPtr, packetLength);
  packetView.set(sourceView);

  // 슬롯 반환 (재사용 가능)
  zeroCopyPool.release_slot(slotId);

  return packet;
}

/**
 * 🦀 레거시 WASM 기반 패킷 생성 (암호화 지원)
 */
function createPacketLegacy(data: Uint8Array): ArrayBuffer {
  // 🔐 암호화 모드
  if (encryptionEnabled && cryptoSession) {
    const packet = cryptoSession.encrypt_chunk(data);
    const result = new ArrayBuffer(packet.byteLength);
    new Uint8Array(result).set(packet);
    return result;
  }

  // 🦀 비암호화 WASM PacketEncoder
  if (wasmReady && packetEncoder) {
    const packet = packetEncoder.encode(data);
    const result = new ArrayBuffer(packet.byteLength);
    new Uint8Array(result).set(packet);
    return result;
  }

  // Fallback: TypeScript 구현
  return createPacketFallback(data);
}

/**
 * 🦀 WASM 기반 패킷 생성 (암호화 지원)
 */
function createPacket(data: Uint8Array): ArrayBuffer {
  // 원본 파일 바이트 전송 모드 크기 제한 체크
  if (state.mode !== 'zip' && state.manifest) {
    const totalBytesSent = getTotalBytesSent();
    if (totalBytesSent >= BigInt(state.manifest.totalSize)) {
      return new ArrayBuffer(0);
    }
    const remaining = BigInt(state.manifest.totalSize) - totalBytesSent;
    if (BigInt(data.length) > remaining) {
      data = data.subarray(0, Number(remaining));
    }
  }

  // 🚀 Zero-Copy 모드 우선 사용
  if (zeroCopyEnabled && zeroCopyPool && wasmMemory) {
    return createPacketZeroCopy(data);
  }

  // 레거시 모드
  return createPacketLegacy(data);
}

/**
 * 전송된 총 바이트 수 조회
 */
function getTotalBytesSent(): bigint {
  if (zeroCopyEnabled && zeroCopyPool) {
    return BigInt(zeroCopyPool.total_bytes);
  }
  if (encryptionEnabled && cryptoSession) {
    return cryptoSession.total_bytes_encrypted;
  }
  if (wasmReady && packetEncoder) {
    return packetEncoder.total_bytes_sent;
  }
  return BigInt(fallbackTotalBytes);
}

// Fallback CRC32
function calculateCRC32Fallback(data: Uint8Array): number {
  const CRC_TABLE = new Int32Array(256);
  if (CRC_TABLE[0] === 0) {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

let fallbackSequence = 0;
let fallbackTotalBytes = 0;

function createPacketFallback(data: Uint8Array): ArrayBuffer {
  const dataSize = data.length;
  const checksum = calculateCRC32Fallback(data);

  const packet = new ArrayBuffer(22 + dataSize);
  const view = new DataView(packet);
  const arr = new Uint8Array(packet);

  view.setUint16(0, 0, true);
  view.setUint32(2, fallbackSequence++, true);
  view.setBigUint64(6, BigInt(fallbackTotalBytes), true);
  view.setUint32(14, dataSize, true);
  view.setUint32(18, checksum, true);
  arr.set(data, 22);

  fallbackTotalBytes += dataSize;
  return packet;
}

async function processBatch(requestedCount: number) {
  if (!state.isInitialized) return;

  if (state.startTime === 0) state.startTime = Date.now();

  if (doubleBuffer.getActiveSize() === 0 && prefetchPromise) {
    await prefetchPromise;
  }

  if (doubleBuffer.getActiveSize() === 0) doubleBuffer.swap();

  const chunks = doubleBuffer.takeFromActive(requestedCount);

  const totalBytesSent = Number(getTotalBytesSent());

  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? totalBytesSent / elapsed : 0;
  const totalSize = state.manifest?.totalSize || 0;

  let progress = 0;
  if (state.mode === 'zip') {
    progress =
      totalSize > 0 ? Math.min(100, (zipSourceBytesRead / totalSize) * 100) : 0;
  } else {
    progress =
      totalSize > 0 ? Math.min(100, (totalBytesSent / totalSize) * 100) : 0;
  }

  if (chunks.length > 0) {
    self.postMessage(
      {
        type: 'chunk-batch',
        payload: {
          chunks,
          progressData: {
            bytesTransferred: totalBytesSent,
            totalBytes: totalSize,
            speed,
            progress,
            encrypted: encryptionEnabled,
          },
        },
      },
      chunks
    );
  }

  if (
    state.isCompleted &&
    doubleBuffer.isEmpty() &&
    (!zipBuffer || zipBuffer.length === 0)
  ) {
    self.postMessage({ type: 'complete' });
    return;
  }

  triggerPrefetch();

  if (chunks.length === 0 && !state.isCompleted) {
    createAndSendImmediate(requestedCount);
  }
}

async function createAndSendImmediate(count: number) {
  if (!state.isInitialized) return;

  const chunks: ArrayBuffer[] = [];
  for (let i = 0; i < count && !state.isCompleted; i++) {
    const chunk = await createNextChunk();
    if (chunk) chunks.push(chunk);
    else break;
  }

  if (chunks.length > 0) {
    const totalBytesSent = Number(getTotalBytesSent());
    const totalSize = state.manifest?.totalSize || 0;

    let progress = 0;
    if (state.mode === 'zip') {
      progress =
        totalSize > 0
          ? Math.min(100, (zipSourceBytesRead / totalSize) * 100)
          : 0;
    } else {
      progress =
        totalSize > 0 ? Math.min(100, (totalBytesSent / totalSize) * 100) : 0;
    }

    self.postMessage(
      {
        type: 'chunk-batch',
        payload: {
          chunks,
          progressData: {
            bytesTransferred: totalBytesSent,
            totalBytes: totalSize,
            speed: 0,
            progress,
            encrypted: encryptionEnabled,
          },
        },
      },
      chunks
    );
  }

  if (
    state.isCompleted &&
    doubleBuffer.isEmpty() &&
    (!zipBuffer || zipBuffer.length === 0)
  ) {
    self.postMessage({ type: 'complete' });
  }
}

// 🚀 Worker 시작
initWasm()
  .then(() => {
    self.postMessage({ type: 'ready' });
  })
  .catch(() => {
    console.warn('[Sender Worker] WASM failed, using fallback');
    self.postMessage({ type: 'ready' });
  });
