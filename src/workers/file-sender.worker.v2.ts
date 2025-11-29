/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// 🚀 [Step 4] WASM 모듈 import
// 🚀 [Step 4] WASM 모듈 import
// 동적 import를 사용하여 워커 환경에서의 모듈 로딩 문제 해결
let initWasm: any;
let ZipEngineClass: any;
let init_wasm: any;

async function loadWasmModule() {
  try {
    const wasmModule = await import('../wasm-pkg/ponswarp_wasm.js') as any;
    initWasm = wasmModule.default;
    ZipEngineClass = wasmModule.ZipEngine;
    init_wasm = wasmModule.init_wasm;
    console.log('[Worker] WASM module loaded successfully');
  } catch (error) {
    console.error('[Worker] Failed to load WASM module:', error);
    throw error;
  }
}

// ============================================================================
// 🚀 Sender Worker V3 (WASM Powered)
// - Core: Rust-based ZipEngine (No fflate)
// - Features: Zero-copy flushing, Aggregation, Backpressure
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

// --- ChunkPool & DoubleBuffer (기존 로직 유지) ---
class ChunkPool {
  private pool: Uint8Array[] = [];
  private readonly chunkSize: number;
  private readonly maxPoolSize: number;

  constructor(chunkSize: number, maxPoolSize: number) {
    this.chunkSize = chunkSize + 18;
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
    const activeChunks = this.activeBuffer === 'A' ? this.bufferA : this.bufferB;

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
  // 🚀 WASM 엔진 추가
  zipEngine: any | null;
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
  zipEngine: null
};

const adaptiveConfig: AdaptiveConfig = {
  chunkSize: CHUNK_SIZE_MAX,
  prefetchBatch: PREFETCH_BATCH,
  enableAdaptive: true
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
    adaptiveConfig.chunkSize = Math.max(CHUNK_SIZE_MIN, Math.min(CHUNK_SIZE_MAX, config.chunkSize));
    CHUNK_SIZE = adaptiveConfig.chunkSize;
  }
  if (config.prefetchBatch !== undefined) {
    adaptiveConfig.prefetchBatch = Math.max(4, Math.min(32, config.prefetchBatch));
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

  // 🚀 WASM 초기화
  try {
    await loadWasmModule();
    await initWasm();
    init_wasm();
    console.log('[Worker] WASM module loaded');
  } catch (e) {
    console.error('[Worker] WASM load failed:', e);
    self.postMessage({ type: 'error', payload: { message: 'WASM load failed' } });
    return;
  }

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
 * 🚀 [Core] Rust ZipEngine 기반 스트리밍
 */
async function initZipStream() {
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

  // WASM 엔진 생성
  state.zipEngine = new ZipEngineClass();
  
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

  // 파일 처리 루프 (Rust Engine 사용)
  const processFilesAsync = async () => {
    if (!state.zipEngine) return;

    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;
        
        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest && state.manifest.files && state.manifest.files[i]) {
            filePath = state.manifest.files[i].path;
        }
        
        // 1. Rust에 새 파일 시작 알림
        state.zipEngine.start_file(filePath);
        
        const reader = file.stream().getReader();
        try {
          while (true) {
            // Backpressure 체크
            if (currentZipQueueSize > ZIP_QUEUE_HIGH_WATER_MARK) {
              isZipPaused = true;
              await new Promise<void>(resolve => { resolveZipResume = resolve; });
              isZipPaused = false;
            }

            const { done, value } = await reader.read();
            if (done) break;
            
            zipSourceBytesRead += value.length;
            
            // 2. Rust에 데이터 주입
            state.zipEngine.write_data(value);
            
            // 3. 압축된 데이터 회수 (Streaming Flush)
            const compressedChunk = state.zipEngine.flush();
            pushToQueue(compressedChunk);
          }
        } finally {
          reader.releaseLock();
        }
      }
      
      // 4. 모든 파일 처리 후 마무리 (Central Directory)
      if (isTransferActive && state.zipEngine) {
        const finalChunk = state.zipEngine.finish();
        pushToQueue(finalChunk);
        
        console.log('[Worker] ZIP stream finalized (WASM)');
        zipFinalized = true;
        
        // 엔진 메모리 해제
        state.zipEngine.free();
        state.zipEngine = null;
        
        if (resolveDataAvailable) {
          resolveDataAvailable();
          resolveDataAvailable = null;
        }
      }
    } catch (e) {
      console.error('[Worker] Fatal ZIP error:', e);
      hasError = true;
      if (state.zipEngine) {
        state.zipEngine.free();
        state.zipEngine = null;
      }
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
      
      await new Promise<void>((resolve) => {
        resolveDataAvailable = resolve;
      });
      
      if (zipDataQueue.length > 0) {
        consumeAndCheckResume(zipDataQueue.shift()!);
      }
      else if (zipFinalized) controller.close();
      else if (hasError) controller.error(new Error('ZIP failed'));
    }
  });
  
  state.zipReader = state.zipStream.getReader();
  processFilesAsync();
  
  // 초기 데이터 대기 (Fast Start)
  const waitStart = Date.now();
  while (zipDataQueue.length === 0 && !zipFinalized && !hasError && (Date.now() - waitStart) < 2000) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function resetWorker() {
  isTransferActive = false;
  if (state.zipReader) {
    state.zipReader.cancel();
    state.zipReader = null;
  }
  
  // 🚀 WASM 엔진 메모리 정리
  if (state.zipEngine) {
    try {
        state.zipEngine.free();
    } catch(e) {}
    state.zipEngine = null;
  }

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
  const batchSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.prefetchBatch : PREFETCH_BATCH;
  for (let i = 0; i < batchSize && isTransferActive && !state.isCompleted; i++) {
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

async function createSingleFileChunk(): Promise<ArrayBuffer | null> {
  if (state.files.length === 0) return null;
  const file = state.files[0];
  
  if (state.currentFileOffset >= file.size) {
    state.isCompleted = true;
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.chunkSize : CHUNK_SIZE_MAX;
  const start = state.currentFileOffset;
  const end = Math.min(start + currentChunkSize, file.size);

  state.currentFileOffset = end;

  try {
    const blob = file.slice(start, end);
    const buffer = await blob.arrayBuffer();
    
    if (buffer.byteLength === 0) return null;
    
    return createPacket(new Uint8Array(buffer), buffer.byteLength);
  } catch (e) {
    console.error('[Worker] Single chunk error:', e);
    return null;
  }
}

let zipBuffer: Uint8Array | null = null;

async function createZipChunk(): Promise<ArrayBuffer | null> {
  if (!state.zipReader) {
    state.isCompleted = true;
    return null;
  }

  const targetChunkSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.chunkSize : CHUNK_SIZE_MAX;

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

function createPacket(data: Uint8Array, dataSize: number): ArrayBuffer {
  // Single File 모드 크기 제한 체크
  if (state.mode === 'single' && state.manifest) {
    if (state.totalBytesSent >= state.manifest.totalSize) return new ArrayBuffer(0);
    if (state.totalBytesSent + dataSize > state.manifest.totalSize) {
      const remaining = state.manifest.totalSize - state.totalBytesSent;
      if (remaining <= 0) return new ArrayBuffer(0);
      data = data.subarray(0, remaining);
      dataSize = remaining;
    }
  }

  const packet = chunkPool.acquire();
  const view = new DataView(packet.buffer);

  // Header: FileIndex(2) + ChunkIndex(4) + Offset(8) + Length(4)
  view.setUint16(0, 0, true);
  view.setUint32(2, state.chunkSequence++, true);
  view.setBigUint64(6, BigInt(state.totalBytesSent), true);
  view.setUint32(14, dataSize, true);

  packet.set(data, 18);
  state.totalBytesSent += dataSize;

  const result = new ArrayBuffer(18 + dataSize);
  new Uint8Array(result).set(packet.subarray(0, 18 + dataSize));
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
    progress = totalSize > 0 ? Math.min(100, (zipSourceBytesRead / totalSize) * 100) : 0;
  } else {
    progress = totalSize > 0 ? Math.min(100, (state.totalBytesSent / totalSize) * 100) : 0;
  }

  if (chunks.length > 0) {
    self.postMessage({
      type: 'chunk-batch',
      payload: {
        chunks,
        progressData: {
          bytesTransferred: state.totalBytesSent,
          totalBytes: totalSize,
          speed,
          progress
        }
      }
    }, chunks);
  }

  if (state.isCompleted && doubleBuffer.isEmpty() && (!zipBuffer || zipBuffer.length === 0)) {
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
    if (state.mode === 'zip') progress = totalSize > 0 ? Math.min(100, (zipSourceBytesRead / totalSize) * 100) : 0;
    else progress = totalSize > 0 ? Math.min(100, (state.totalBytesSent / totalSize) * 100) : 0;

    self.postMessage({
      type: 'chunk-batch',
      payload: {
        chunks,
        progressData: {
          bytesTransferred: state.totalBytesSent,
          totalBytes: totalSize,
          speed: 0, 
          progress
        }
      }
    }, chunks);
  }

  if (state.isCompleted && doubleBuffer.isEmpty() && (!zipBuffer || zipBuffer.length === 0)) {
    self.postMessage({ type: 'complete' });
  }
}

self.postMessage({ type: 'ready' });
