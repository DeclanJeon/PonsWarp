/// <reference lib="webworker" />
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

const CHUNK_SIZE_MIN = 16 * 1024;
const CHUNK_SIZE_MAX = 64 * 1024;

const BUFFER_SIZE = 8 * 1024 * 1024;
const PREFETCH_BATCH = 16;

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
  manifest: any;
  mode: 'single' | 'zip';
  currentFileOffset: number;
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
  zipStream: null,
  zipReader: null,
  startTime: 0,
  isInitialized: false,
  isCompleted: false,
};

const adaptiveConfig: AdaptiveConfig = {
  chunkSize: CHUNK_SIZE_MAX,
  prefetchBatch: PREFETCH_BATCH,
  enableAdaptive: true,
};

const doubleBuffer = new DoubleBuffer(BUFFER_SIZE);
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

    console.log('[Sender Worker] WASM initialized with Zero-Copy Pool');
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
    case 'reset':
      resetWorker();
      break;
    case 'update-config':
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
      console.error('[Sender Worker] WASM not ready for encryption');
      self.postMessage({
        type: 'encryption-error',
        payload: 'WASM not initialized',
      });
      return;
    }

    cryptoSession = new CryptoSession(payload.sessionKey, payload.randomPrefix);
    encryptionEnabled = true;
    console.log('[Sender Worker] 🔐 E2E encryption enabled');
    self.postMessage({ type: 'encryption-ready' });
  } catch (e: any) {
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
      4,
      Math.min(32, config.prefetchBatch)
    );
  }
  if (config.enableAdaptive !== undefined) {
    adaptiveConfig.enableAdaptive = config.enableAdaptive;
  }
}

async function initWorker(payload: { files: File[]; manifest: any }) {
  resetWorker();

  if (!wasmReady) {
    await initWasm();
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

  isTransferActive = true;
  prefetchPromise = null;
  zipBuffer = null;

  const fileCount = state.files.length;
  console.log(
    '[Sender Worker] 🚀 [DEBUG] Initializing for',
    fileCount,
    'files (WASM:',
    wasmReady,
    ', Encrypted:',
    encryptionEnabled,
    ')'
  );

  console.log('[Sender Worker] 🚀 [DEBUG] Manifest info:', {
    isFolder: payload.manifest?.isFolder,
    totalFiles: payload.manifest?.totalFiles,
    totalSize: payload.manifest?.totalSize,
    rootName: payload.manifest?.rootName,
    files: payload.manifest?.files?.map(f => ({
      name: f.name,
      path: f.path,
      size: f.size,
    })),
  });

  if (fileCount === 1) {
    state.mode = 'single';
    console.log('[Sender Worker] 🚀 [DEBUG] Mode set to SINGLE (1 file)');
  } else {
    state.mode = 'zip';
    console.log('[Sender Worker] 🚀 [DEBUG] Mode set to ZIP (multiple files)');
    try {
      console.log('[Sender Worker] 🚀 [DEBUG] Initializing ZIP stream...');
      await initZipStream();
      console.log(
        '[Sender Worker] ✅ [DEBUG] ZIP stream initialized successfully'
      );
      console.log('[Sender Worker] 🚀 [DEBUG] Prefetching initial batch...');
      await prefetchBatch();
      console.log('[Sender Worker] ✅ [DEBUG] Initial batch prefetched');
    } catch (error: any) {
      console.error('[Sender Worker] ❌ [DEBUG] ZIP init failed:', error);
      self.postMessage({ type: 'error', payload: { message: error.message } });
      return;
    }
  }

  console.log(
    '[Sender Worker] ✅ [DEBUG] Worker initialization complete, sending init-complete'
  );
  triggerPrefetch();
  self.postMessage({ type: 'init-complete' });
}

let zipSourceBytesRead = 0;

async function initZipStream() {
  console.log('[Sender Worker] 🚀 [DEBUG] initZipStream() called');
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

  // 🦀 WASM ZIP64 스트림 초기화 (4GB+ 파일 지원)
  // ⚡ STORE 모드 (압축 없음) - 전송 속도 최적화
  console.log('[Sender Worker] 🚀 [DEBUG] Creating Zip64Stream...');
  zip64Stream = new Zip64Stream(0); // 0 = STORE (압축 없음)
  console.log('[Sender Worker] ✅ [DEBUG] Zip64Stream created successfully');

  const zipDataQueue: Uint8Array[] = [];
  let resolveDataAvailable: (() => void) | null = null;
  let zipFinalized = false;
  let hasError = false;

  const pushToQueue = (data: Uint8Array) => {
    if (data.length > 0) {
      zipDataQueue.push(data);
      currentZipQueueSize += data.length;
      console.log('[Sender Worker] 📦 [DEBUG] Pushed to ZIP queue:', {
        dataSize: data.length,
        queueSize: currentZipQueueSize,
        queueLength: zipDataQueue.length,
      });
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
    }
  };

  const processFilesAsync = async () => {
    console.log(
      '[Sender Worker] 🚀 [DEBUG] Starting async file processing for',
      state.files.length,
      'files'
    );
    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;

        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest?.files?.[i]) {
          filePath = state.manifest.files[i].path;
        }

        console.log('[Sender Worker] 📁 [DEBUG] Processing file', i, ':', {
          name: file.name,
          path: filePath,
          size: file.size,
        });

        // 🦀 파일 시작 (Local File Header 생성)
        console.log(
          '[Sender Worker] 🚀 [DEBUG] Beginning file in ZIP stream:',
          filePath
        );
        const header = zip64Stream!.begin_file(filePath, BigInt(file.size));
        pushToQueue(header);

        const reader = file.stream().getReader();
        try {
          let chunkCount = 0;
          while (true) {
            // 백프레셔 체크
            if (currentZipQueueSize > ZIP_QUEUE_HIGH_WATER_MARK) {
              console.log(
                '[Sender Worker] ⏸️ [DEBUG] ZIP queue high water mark reached, pausing...'
              );
              isZipPaused = true;
              await new Promise<void>(resolve => {
                resolveZipResume = resolve;
              });
              isZipPaused = false;
              console.log('[Sender Worker] ▶️ [DEBUG] ZIP queue resumed');
            }

            const { done, value } = await reader.read();
            if (done) {
              console.log(
                '[Sender Worker] ✅ [DEBUG] File read complete:',
                filePath,
                'chunks:',
                chunkCount
              );
              break;
            }

            zipSourceBytesRead += value.length;
            chunkCount++;

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
        console.log(
          '[Sender Worker] 🚀 [DEBUG] Ending file in ZIP stream:',
          filePath
        );
        const descriptor = zip64Stream!.end_file();
        if (descriptor.length > 0) {
          pushToQueue(descriptor);
        }
      }

      // 🦀 ZIP 아카이브 종료 (Central Directory + EOCD64)
      if (isTransferActive && zip64Stream) {
        console.log('[Sender Worker] 🚀 [DEBUG] Finalizing ZIP archive...');
        const footer = zip64Stream.finalize();
        pushToQueue(footer);
        zipFinalized = true;
        console.log('[Sender Worker] ✅ [DEBUG] ZIP archive finalized');
        resolveDataAvailable?.();
        resolveDataAvailable = null;
      }
    } catch (e) {
      console.error('[Sender Worker] ❌ [DEBUG] Fatal ZIP64 error:', e);
      hasError = true;
      resolveDataAvailable?.();
      resolveDataAvailable = null;
    }
  };

  state.zipStream = new ReadableStream({
    async pull(controller) {
      console.log(
        '[Sender Worker] 🔄 [DEBUG] ZIP stream pull called, queue size:',
        zipDataQueue.length
      );

      const consumeAndCheckResume = (chunk: Uint8Array) => {
        currentZipQueueSize -= chunk.length;
        console.log('[Sender Worker] 📤 [DEBUG] Consuming from ZIP queue:', {
          chunkSize: chunk.length,
          queueSizeAfter: currentZipQueueSize,
          isPaused: isZipPaused,
        });
        controller.enqueue(chunk);
        if (isZipPaused && currentZipQueueSize < ZIP_QUEUE_LOW_WATER_MARK) {
          console.log('[Sender Worker] ▶️ [DEBUG] Resuming ZIP processing');
          resolveZipResume?.();
          resolveZipResume = null;
        }
      };

      if (zipDataQueue.length > 0) {
        consumeAndCheckResume(zipDataQueue.shift()!);
        return;
      }
      if (zipFinalized) {
        console.log(
          '[Sender Worker] ✅ [DEBUG] ZIP stream finalized, closing controller'
        );
        controller.close();
        return;
      }
      if (hasError) {
        console.log('[Sender Worker] ❌ [DEBUG] ZIP error, closing with error');
        controller.error(new Error('ZIP64 failed'));
        return;
      }

      console.log('[Sender Worker] ⏳ [DEBUG] Waiting for ZIP data...');
      await new Promise<void>(resolve => {
        resolveDataAvailable = resolve;
      });

      if (zipDataQueue.length > 0) consumeAndCheckResume(zipDataQueue.shift()!);
      else if (zipFinalized) {
        console.log(
          '[Sender Worker] ✅ [DEBUG] ZIP finalized during wait, closing'
        );
        controller.close();
      } else if (hasError) {
        console.log(
          '[Sender Worker] ❌ [DEBUG] ZIP error during wait, closing with error'
        );
        controller.error(new Error('ZIP64 failed'));
      }
    },
  });

  state.zipReader = state.zipStream.getReader();

  // 🚀 [핵심 수정] 파일 처리를 비동기적으로 시작하지만, 초기 데이터가 준비될 때까지 대기
  console.log('[Sender Worker] 🚀 [DEBUG] Starting async file processing...');
  processFilesAsync();

  // 🚀 [핵심 수정] 초기 데이터가 준비될 때까지 대기 (최대 5초)
  const waitStart = Date.now();
  console.log('[Sender Worker] ⏳ [DEBUG] Waiting for initial ZIP data...');
  while (
    zipDataQueue.length === 0 &&
    !zipFinalized &&
    !hasError &&
    Date.now() - waitStart < 5000 // 2초에서 5초로 증가
  ) {
    await new Promise(resolve => setTimeout(resolve, 10)); // 1ms에서 10ms로 증가
  }

  console.log('[Sender Worker] 📊 [DEBUG] Initial wait completed:', {
    queueSize: zipDataQueue.length,
    finalized: zipFinalized,
    hasError: hasError,
    waitTime: Date.now() - waitStart,
  });
}

function resetWorker() {
  isTransferActive = false;
  state.zipReader?.cancel();
  state.zipReader = null;

  if (singleFileReader) {
    try {
      singleFileReader.cancel();
    } catch {}
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
    : PREFETCH_BATCH;
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
  return state.mode === 'single' ? createSingleFileChunk() : createZipChunk();
}

let singleFileReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let singleFileBuffer: Uint8Array | null = null;

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
    } catch {}
    singleFileReader = null;
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.chunkSize
    : CHUNK_SIZE_MAX;

  try {
    while (true) {
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
    } catch {}
    singleFileReader = null;
    singleFileBuffer = null;
    return null;
  }
}

let zipBuffer: Uint8Array | null = null;

async function createZipChunk(): Promise<ArrayBuffer | null> {
  console.log('[Sender Worker] 🚀 [DEBUG] createZipChunk() called');

  if (!state.zipReader) {
    console.log(
      '[Sender Worker] ❌ [DEBUG] No ZIP reader available, marking as completed'
    );
    state.isCompleted = true;
    return null;
  }

  const targetChunkSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.chunkSize
    : CHUNK_SIZE_MAX;

  console.log('[Sender Worker] 📊 [DEBUG] Target chunk size:', targetChunkSize);
  console.log(
    '[Sender Worker] 📊 [DEBUG] Current zipBuffer size:',
    zipBuffer?.length || 0
  );

  if (zipBuffer && zipBuffer.length >= targetChunkSize) {
    const chunkData = zipBuffer.slice(0, targetChunkSize);
    const remaining = zipBuffer.slice(targetChunkSize);
    zipBuffer = remaining.length > 0 ? remaining : null;
    console.log(
      '[Sender Worker] 📦 [DEBUG] Created chunk from existing buffer:',
      {
        chunkSize: chunkData.length,
        remainingBufferSize: zipBuffer?.length || 0,
      }
    );
    return createPacket(chunkData);
  }

  console.log('[Sender Worker] 🔄 [DEBUG] Reading from ZIP stream...');
  while (true) {
    try {
      const { done, value } = await state.zipReader.read();

      if (done) {
        console.log('[Sender Worker] ✅ [DEBUG] ZIP stream reading completed');
        if (zipBuffer && zipBuffer.length > 0) {
          const chunkData = zipBuffer;
          zipBuffer = null;
          console.log(
            '[Sender Worker] 📦 [DEBUG] Created final chunk from remaining buffer:',
            {
              chunkSize: chunkData.length,
            }
          );
          return createPacket(chunkData);
        }
        console.log(
          '[Sender Worker] ✅ [DEBUG] ZIP processing completed, marking as completed'
        );
        state.isCompleted = true;
        return null;
      }

      if (value && value.length > 0) {
        console.log('[Sender Worker] 📥 [DEBUG] Read from ZIP stream:', {
          dataSize: value.length,
          currentBufferSize: zipBuffer?.length || 0,
        });

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
          console.log(
            '[Sender Worker] 📦 [DEBUG] Created chunk after reading:',
            {
              chunkSize: chunkData.length,
              remainingBufferSize: zipBuffer?.length || 0,
            }
          );
          return createPacket(chunkData);
        }
      }
    } catch (e) {
      console.error('[Sender Worker] ❌ [DEBUG] ZIP chunk error:', e);
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
  // Single File 모드 크기 제한 체크
  if (state.mode === 'single' && state.manifest) {
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
  if (encryptionEnabled && cryptoSession) {
    return cryptoSession.total_bytes_encrypted;
  }
  if (zeroCopyEnabled && zeroCopyPool) {
    return BigInt(zeroCopyPool.total_bytes);
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

function processBatch(requestedCount: number) {
  if (!state.isInitialized) return;

  if (state.startTime === 0) state.startTime = Date.now();
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
