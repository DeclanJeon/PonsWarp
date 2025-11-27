/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { Zip, ZipPassThrough } from 'fflate';

// ============================================================================
// 🚀 Sender Worker with ZIP compression for folders
// - 단일 파일: 그대로 전송
// - 여러 파일/폴더: ZIP으로 압축하여 전송
// ============================================================================

const CHUNK_SIZE_MIN = 16 * 1024;
const CHUNK_SIZE_MAX = 128 * 1024;
let CHUNK_SIZE = CHUNK_SIZE_MAX;

const BUFFER_SIZE = 8 * 1024 * 1024;
const POOL_SIZE = 128;
const PREFETCH_BATCH = 16;

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
  
  // Single mode
  currentFileOffset: number;
  
  // ZIP mode
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
  isCompleted: false
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
    console.log('[Worker] Chunk size updated:', CHUNK_SIZE);
  }
  if (config.prefetchBatch !== undefined) {
    adaptiveConfig.prefetchBatch = Math.max(4, Math.min(32, config.prefetchBatch));
  }
  if (config.enableAdaptive !== undefined) {
    adaptiveConfig.enableAdaptive = config.enableAdaptive;
  }
}

async function initWorker(payload: { files: File[]; manifest: any }) {
  state.files = payload.files;
  state.manifest = payload.manifest;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = true;
  state.isCompleted = false;
  state.currentFileOffset = 0;

  chunkPool.clear();
  doubleBuffer.clear();
  isTransferActive = true;
  prefetchPromise = null;

  const fileCount = state.files.length;
  console.log('[Worker] Initializing:', { fileCount, totalSize: state.manifest.totalSize });

  // 🚨 [핵심] 파일 개수에 따라 모드 결정
  if (fileCount === 1) {
    state.mode = 'single';
    console.log('[Worker] Mode: SINGLE file');
  } else {
    state.mode = 'zip';
    console.log('[Worker] Mode: ZIP compression for', fileCount, 'files');
    await initZipStream();
  }

  triggerPrefetch();
}

/**
 * ZIP 스트림 초기화
 */
async function initZipStream() {
  const zip = new Zip();
  
  // ReadableStream 생성
  state.zipStream = new ReadableStream({
    start(controller) {
      zip.ondata = (err, data, final) => {
        if (err) {
          console.error('[Worker] ZIP error:', err);
          controller.error(err);
          return;
        }
        
        if (data && data.length > 0) {
          controller.enqueue(data);
        }
        
        if (final) {
          controller.close();
        }
      };
      
      // 각 파일을 ZIP에 추가
      (async () => {
        for (const file of state.files) {
          const entry = new ZipPassThrough(file.webkitRelativePath || file.name);
          zip.add(entry);
          
          // 파일 데이터를 스트리밍으로 읽어서 ZIP 엔트리에 푸시
          const reader = file.stream().getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              entry.push(value, false);
            }
            entry.push(new Uint8Array(0), true); // 파일 종료
          } catch (e) {
            console.error('[Worker] File read error:', e);
          }
        }
        
        // 모든 파일 추가 완료
        zip.end();
      })();
    }
  });
  
  state.zipReader = state.zipStream.getReader();
  console.log('[Worker] ZIP stream initialized');
}

function resetWorker() {
  isTransferActive = false;
  
  if (state.zipReader) {
    state.zipReader.cancel();
    state.zipReader = null;
  }
  
  state.files = [];
  state.manifest = null;
  state.mode = 'single';
  state.currentFileOffset = 0;
  state.zipStream = null;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = false;
  state.isCompleted = false;

  chunkPool.clear();
  doubleBuffer.clear();
  prefetchPromise = null;
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
    if (chunk) {
      doubleBuffer.addToInactive(chunk);
    } else {
      break;
    }
  }
}

async function createNextChunk(): Promise<ArrayBuffer | null> {
  if (state.mode === 'single') {
    return createSingleFileChunk();
  } else {
    return createZipChunk();
  }
}

/**
 * 단일 파일 청크 생성
 */
async function createSingleFileChunk(): Promise<ArrayBuffer | null> {
  const file = state.files[0];
  
  if (state.currentFileOffset >= file.size) {
    state.isCompleted = true;
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.chunkSize : CHUNK_SIZE_MAX;
  const start = state.currentFileOffset;
  const end = Math.min(start + currentChunkSize, file.size);

  try {
    const blob = file.slice(start, end);
    const buffer = await blob.arrayBuffer();
    const dataSize = buffer.byteLength;

    const packet = chunkPool.acquire();
    const view = new DataView(packet.buffer);

    // 헤더 작성 (fileId = 0)
    view.setUint16(0, 0, true);
    view.setUint32(2, state.chunkSequence++, true);
    view.setBigUint64(6, BigInt(start), true);
    view.setUint32(14, dataSize, true);

    packet.set(new Uint8Array(buffer), 18);
    state.currentFileOffset = end;
    state.totalBytesSent += dataSize;

    const result = new ArrayBuffer(18 + dataSize);
    new Uint8Array(result).set(packet.subarray(0, 18 + dataSize));
    chunkPool.release(packet);

    return result;
  } catch (error) {
    console.error('[Worker] Single file chunk creation failed:', error);
    return null;
  }
}

/**
 * ZIP 청크 생성
 */
async function createZipChunk(): Promise<ArrayBuffer | null> {
  if (!state.zipReader) {
    state.isCompleted = true;
    return null;
  }

  try {
    const { done, value } = await state.zipReader.read();
    
    if (done) {
      state.isCompleted = true;
      return null;
    }

    if (!value || value.length === 0) {
      return createZipChunk(); // 다음 청크 시도
    }

    const dataSize = value.length;
    const packet = chunkPool.acquire();
    const view = new DataView(packet.buffer);

    // 헤더 작성 (fileId = 0, ZIP 파일 하나로 취급)
    view.setUint16(0, 0, true);
    view.setUint32(2, state.chunkSequence++, true);
    view.setBigUint64(6, BigInt(state.totalBytesSent), true);
    view.setUint32(14, dataSize, true);

    packet.set(value, 18);
    state.totalBytesSent += dataSize;

    const result = new ArrayBuffer(18 + dataSize);
    new Uint8Array(result).set(packet.subarray(0, 18 + dataSize));
    chunkPool.release(packet);

    return result;
  } catch (error) {
    console.error('[Worker] ZIP chunk creation failed:', error);
    state.isCompleted = true;
    return null;
  }
}

function processBatch(requestedCount: number) {
  if (state.startTime === 0) {
    state.startTime = Date.now();
  }

  if (doubleBuffer.getActiveSize() === 0) {
    doubleBuffer.swap();
  }

  const chunks = doubleBuffer.takeFromActive(requestedCount);

  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
  const progress =
    state.manifest.totalSize > 0
      ? Math.min(100, (state.totalBytesSent / state.manifest.totalSize) * 100)
      : 0;

  if (chunks.length > 0) {
    self.postMessage(
      {
        type: 'chunk-batch',
        payload: {
          chunks,
          progressData: {
            bytesTransferred: state.totalBytesSent,
            totalBytes: state.manifest.totalSize,
            speed,
            progress
          }
        }
      },
      chunks
    );
  }

  if (state.isCompleted && doubleBuffer.isEmpty()) {
    self.postMessage({ type: 'complete' });
    return;
  }

  triggerPrefetch();

  if (chunks.length === 0 && !state.isCompleted) {
    createAndSendImmediate(requestedCount);
  }
}

async function createAndSendImmediate(count: number) {
  const chunks: ArrayBuffer[] = [];

  for (let i = 0; i < count && !state.isCompleted; i++) {
    const chunk = await createNextChunk();
    if (chunk) {
      chunks.push(chunk);
    } else {
      break;
    }
  }

  if (chunks.length > 0) {
    const elapsed = (Date.now() - state.startTime) / 1000;
    const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
    const progress =
      state.manifest.totalSize > 0
        ? Math.min(100, (state.totalBytesSent / state.manifest.totalSize) * 100)
        : 0;

    self.postMessage(
      {
        type: 'chunk-batch',
        payload: {
          chunks,
          progressData: {
            bytesTransferred: state.totalBytesSent,
            totalBytes: state.manifest.totalSize,
            speed,
            progress
          }
        }
      },
      chunks
    );
  }

  if (state.isCompleted && doubleBuffer.isEmpty()) {
    self.postMessage({ type: 'complete' });
  }
}

self.postMessage({ type: 'ready' });
