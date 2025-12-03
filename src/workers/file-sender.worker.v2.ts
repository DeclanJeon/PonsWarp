/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 Sender Worker V3 (Native Browser APIs)
// - ZIP: Native CompressionStream (Deflate)
// - Features: Zero-copy streaming, Aggregation, Backpressure
// - Checksum: CRC32 for data integrity verification
// ============================================================================

const CHUNK_SIZE_MIN = 16 * 1024;
const CHUNK_SIZE_MAX = 64 * 1024;
let CHUNK_SIZE = CHUNK_SIZE_MAX;

const BUFFER_SIZE = 8 * 1024 * 1024; // 8MB sender 버퍼
const POOL_SIZE = 128; // 풀 사이즈
const PREFETCH_BATCH = 16;

// ZIP 백프레셔 임계값
const ZIP_QUEUE_HIGH_WATER_MARK = 32 * 1024 * 1024;
const ZIP_QUEUE_LOW_WATER_MARK = 8 * 1024 * 1024;

interface AdaptiveConfig {
  chunkSize: number;
  prefetchBatch: number;
  enableAdaptive: boolean;
}

class ChunkPool {
  private pool: Uint8Array[] = [];
  private readonly chunkSize: number;
  private readonly maxPoolSize: number;

  constructor(chunkSize: number, maxPoolSize: number) {
    this.chunkSize = chunkSize + 22; // 헤더 크기 18 -> 22로 변경
    this.maxPoolSize = maxPoolSize;
  }

  acquire(): Uint8Array {
    return this.pool.pop() || new Uint8Array(this.chunkSize);
  }

  release(buffer: Uint8Array) {
    if (this.pool.length < this.maxPoolSize) {
      this.pool.push(buffer);
    }
  }

  clear() {
    this.pool = [];
  }
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
    const activeSize = this.getActiveSize();
    const inactiveSize = this.getInactiveSize();

    if (activeSize === 0 && inactiveSize > 0) {
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
  chunkSequence: number;
  totalBytesSent: number;
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
  chunkSequence: 0,
  totalBytesSent: 0,
  startTime: 0,
  isInitialized: false,
  isCompleted: false,
};

const adaptiveConfig: AdaptiveConfig = {
  chunkSize: CHUNK_SIZE_MAX,
  prefetchBatch: PREFETCH_BATCH,
  enableAdaptive: true,
};

const chunkPool = new ChunkPool(CHUNK_SIZE_MAX, POOL_SIZE);
const doubleBuffer = new DoubleBuffer(BUFFER_SIZE);
let isTransferActive = false;
let prefetchPromise: Promise<void> | null = null;

// 백프레셔 상태 변수
let isZipPaused = false;
let resolveZipResume: (() => void) | null = null;
let currentZipQueueSize = 0;

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
  }
};

function updateAdaptiveConfig(config: Partial<AdaptiveConfig>) {
  if (config.chunkSize !== undefined) {
    adaptiveConfig.chunkSize = Math.max(
      CHUNK_SIZE_MIN,
      Math.min(CHUNK_SIZE_MAX, config.chunkSize)
    );
    CHUNK_SIZE = adaptiveConfig.chunkSize;
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

  state.files = payload.files;
  state.manifest = payload.manifest;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = true;
  state.isCompleted = false;
  state.currentFileOffset = 0;

  isTransferActive = true;
  prefetchPromise = null;
  zipBuffer = null;

  const fileCount = state.files.length;
  console.log('[Worker] Initializing for', fileCount, 'files');

  if (fileCount === 1) {
    state.mode = 'single';
  } else {
    state.mode = 'zip';
    try {
      await initZipStream();
      await prefetchBatch();
    } catch (error: any) {
      console.error('[Worker] ZIP init failed:', error);
      self.postMessage({ type: 'error', payload: { message: error.message } });
      return;
    }
  }

  triggerPrefetch();
  self.postMessage({ type: 'init-complete' });
}

// ZIP 소스 읽기 진행률
let zipSourceBytesRead = 0;

/**
 * 🚀 [Core] Native Browser ZIP Streaming (fflate)
 * CompressionStream은 개별 파일만 압축 가능하므로 fflate 사용
 */
async function initZipStream() {
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

  // fflate 동적 import
  const { Zip } = await import('fflate');

  const zipDataQueue: Uint8Array[] = [];
  let resolveDataAvailable: (() => void) | null = null;
  let zipFinalized = false;
  let hasError = false;

  // 헬퍼: 압축 데이터를 큐에 넣고 알림
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

  // fflate Zip 인스턴스 생성
  const zip = new Zip((err, data, final) => {
    if (err) {
      console.error('[Worker] ZIP error:', err);
      hasError = true;
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
      return;
    }

    if (data && data.length > 0) {
      pushToQueue(data);
    }

    if (final) {
      zipFinalized = true;
      console.log('[Worker] ZIP stream finalized (fflate)');
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
    }
  });

  // 파일 처리 루프
  const processFilesAsync = async () => {
    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;

        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest && state.manifest.files && state.manifest.files[i]) {
          filePath = state.manifest.files[i].path;
        }

        // fflate ZipDeflate 스트림 생성
        const { ZipDeflate } = await import('fflate');
        const fileStream = new ZipDeflate(filePath, { level: 6 });
        zip.add(fileStream);

        const reader = file.stream().getReader();
        try {
          while (true) {
            // Backpressure 체크
            if (currentZipQueueSize > ZIP_QUEUE_HIGH_WATER_MARK) {
              isZipPaused = true;
              await new Promise<void>(resolve => {
                resolveZipResume = resolve;
              });
              isZipPaused = false;
            }

            const { done, value } = await reader.read();
            if (done) {
              fileStream.push(new Uint8Array(0), true); // 파일 종료
              break;
            }

            zipSourceBytesRead += value.length;
            fileStream.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      // 모든 파일 처리 후 ZIP 종료
      if (isTransferActive) {
        zip.end();
      }
    } catch (e) {
      console.error('[Worker] Fatal ZIP error:', e);
      hasError = true;
    }
  };

  // ReadableStream 생성 (Consumer용)
  state.zipStream = new ReadableStream({
    async pull(controller) {
      const consumeAndCheckResume = (chunk: Uint8Array) => {
        currentZipQueueSize -= chunk.length;
        controller.enqueue(chunk);

        if (isZipPaused && currentZipQueueSize < ZIP_QUEUE_LOW_WATER_MARK) {
          if (resolveZipResume) {
            resolveZipResume();
            resolveZipResume = null;
          }
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
        controller.error(new Error('ZIP failed'));
        return;
      }

      await new Promise<void>(resolve => {
        resolveDataAvailable = resolve;
      });

      if (zipDataQueue.length > 0) {
        consumeAndCheckResume(zipDataQueue.shift()!);
      } else if (zipFinalized) controller.close();
      else if (hasError) controller.error(new Error('ZIP failed'));
    },
  });

  state.zipReader = state.zipStream.getReader();
  processFilesAsync();

  // 초기 데이터 대기 (Fast Start)
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
  if (state.zipReader) {
    state.zipReader.cancel();
    state.zipReader = null;
  }

  // Clean up single file reader
  if (singleFileReader) {
    try {
      singleFileReader.cancel();
    } catch (e) {}
    singleFileReader = null;
  }
  singleFileBuffer = null;

  if (resolveZipResume) {
    resolveZipResume();
    resolveZipResume = null;
  }
  isZipPaused = false;
  currentZipQueueSize = 0;

  state.isInitialized = false;
  state.isCompleted = false;
  state.files = [];

  chunkPool.clear();
  doubleBuffer.clear();
  zipBuffer = null;
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
  if (state.mode === 'single') return createSingleFileChunk();
  return createZipChunk();
}

// Single file stream reader (singleton)
let singleFileReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let singleFileBuffer: Uint8Array | null = null;

async function createSingleFileChunk(): Promise<ArrayBuffer | null> {
  if (state.files.length === 0) return null;
  const file = state.files[0];

  // Initialize stream reader on first call
  if (!singleFileReader && state.currentFileOffset === 0) {
    singleFileReader = file.stream().getReader();
  }

  if (state.currentFileOffset >= file.size) {
    state.isCompleted = true;
    if (singleFileReader) {
      try {
        await singleFileReader.cancel();
      } catch (e) {}
      singleFileReader = null;
    }
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive
    ? adaptiveConfig.chunkSize
    : CHUNK_SIZE_MAX;

  try {
    // Accumulate data until we have enough for a chunk
    while (true) {
      const bufferSize = singleFileBuffer ? singleFileBuffer.length : 0;

      // If we have enough data, create packet
      if (
        bufferSize >= currentChunkSize ||
        state.currentFileOffset + bufferSize >= file.size
      ) {
        const dataToSend = singleFileBuffer!.slice(0, currentChunkSize);
        const remaining = singleFileBuffer!.slice(currentChunkSize);
        singleFileBuffer = remaining.length > 0 ? remaining : null;

        state.currentFileOffset += dataToSend.length;
        return createPacket(dataToSend, dataToSend.length);
      }

      // Read more data from stream
      if (!singleFileReader) {
        state.isCompleted = true;
        return null;
      }

      const { done, value } = await singleFileReader.read();

      if (done) {
        // Stream ended, send remaining buffer
        if (singleFileBuffer && singleFileBuffer.length > 0) {
          const dataToSend = singleFileBuffer;
          singleFileBuffer = null;
          state.currentFileOffset += dataToSend.length;

          singleFileReader = null;
          return createPacket(dataToSend, dataToSend.length);
        }

        state.isCompleted = true;
        singleFileReader = null;
        return null;
      }

      // Append to buffer
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
    console.error('[Worker] Single chunk error:', e);
    if (singleFileReader) {
      try {
        await singleFileReader.cancel();
      } catch (err) {}
      singleFileReader = null;
    }
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
    : CHUNK_SIZE_MAX;

  if (zipBuffer && zipBuffer.length >= targetChunkSize) {
    const chunkData = zipBuffer.slice(0, targetChunkSize);
    const remaining = zipBuffer.slice(targetChunkSize);
    zipBuffer = remaining.length > 0 ? remaining : null;
    return createPacket(chunkData, chunkData.length);
  }

  while (true) {
    try {
      const { done, value } = await state.zipReader.read();

      if (done) {
        if (zipBuffer && zipBuffer.length > 0) {
          const chunkData = zipBuffer;
          zipBuffer = null;
          return createPacket(chunkData, chunkData.length);
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
          return createPacket(chunkData, chunkData.length);
        }
      }
    } catch (e) {
      console.error('[Worker] ZIP chunk error:', e);
      state.isCompleted = true;
      return null;
    }
  }
}

// CRC32 Checksum 계산 함수
function calculateCRC32(data: Uint8Array): number {
  const CRC_TABLE = new Int32Array(256);

  // CRC 테이블 초기화 (한 번만 실행)
  if (CRC_TABLE[0] === 0) {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c;
    }
  }

  let crc = -1; // 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0; // 부호 없는 정수로 변환
}

function createPacket(data: Uint8Array, dataSize: number): ArrayBuffer {
  // Single File 모드 크기 제한 체크
  if (state.mode === 'single' && state.manifest) {
    if (state.totalBytesSent >= state.manifest.totalSize)
      return new ArrayBuffer(0);
    if (state.totalBytesSent + dataSize > state.manifest.totalSize) {
      const remaining = state.manifest.totalSize - state.totalBytesSent;
      if (remaining <= 0) return new ArrayBuffer(0);
      data = data.subarray(0, remaining);
      dataSize = remaining;
    }
  }

  const packet = chunkPool.acquire();
  const view = new DataView(packet.buffer);

  // 1. Checksum 계산 (Payload 부분만)
  const checksum = calculateCRC32(data);

  // 2. Header 작성 (총 22 Bytes)
  // [0-1] FileIndex (2)
  view.setUint16(0, 0, true);
  // [2-5] ChunkIndex (4)
  view.setUint32(2, state.chunkSequence++, true);
  // [6-13] Offset (8)
  view.setBigUint64(6, BigInt(state.totalBytesSent), true);
  // [14-17] Length (4)
  view.setUint32(14, dataSize, true);
  // [18-21] Checksum (4) - 🚀 신규 추가
  view.setUint32(18, checksum, true);

  // 3. Data 복사 (헤더 뒤부터)
  packet.set(data, 22); // 18 -> 22로 변경
  state.totalBytesSent += dataSize;

  // 4. 최종 패킷 생성 (헤더 + 데이터)
  const result = new ArrayBuffer(22 + dataSize); // 18 -> 22로 변경
  new Uint8Array(result).set(packet.subarray(0, 22 + dataSize)); // 18 -> 22로 변경
  chunkPool.release(packet);

  return result;
}

function processBatch(requestedCount: number) {
  if (!state.isInitialized) return;

  if (state.startTime === 0) state.startTime = Date.now();
  if (doubleBuffer.getActiveSize() === 0) doubleBuffer.swap();

  const chunks = doubleBuffer.takeFromActive(requestedCount);

  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
  let progress = 0;
  const totalSize = state.manifest?.totalSize || 0;

  if (state.mode === 'zip') {
    // ZIP 모드는 소스 읽기 기준으로 진행률 추정 (압축률 변동성 보정)
    progress =
      totalSize > 0 ? Math.min(100, (zipSourceBytesRead / totalSize) * 100) : 0;
  } else {
    progress =
      totalSize > 0
        ? Math.min(100, (state.totalBytesSent / totalSize) * 100)
        : 0;
  }

  if (chunks.length > 0) {
    self.postMessage(
      {
        type: 'chunk-batch',
        payload: {
          chunks,
          progressData: {
            bytesTransferred: state.totalBytesSent,
            totalBytes: totalSize,
            speed,
            progress,
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
    const totalSize = state.manifest?.totalSize || 0;
    let progress = 0;
    if (state.mode === 'zip')
      progress =
        totalSize > 0
          ? Math.min(100, (zipSourceBytesRead / totalSize) * 100)
          : 0;
    else
      progress =
        totalSize > 0
          ? Math.min(100, (state.totalBytesSent / totalSize) * 100)
          : 0;

    self.postMessage(
      {
        type: 'chunk-batch',
        payload: {
          chunks,
          progressData: {
            bytesTransferred: state.totalBytesSent,
            totalBytes: totalSize,
            speed: 0,
            progress,
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

self.postMessage({ type: 'ready' });
