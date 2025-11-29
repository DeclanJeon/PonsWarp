/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { Zip, ZipPassThrough } from 'fflate';

// ============================================================================
// 🚀 Sender Worker V2 (Final Optimized)
// - Race Condition 방지: init 완료 전 요청 무시
// - Packet Flooding 방지: 64KB 이상 모아서 전송 (Aggregation)
// - Memory Protection: ZIP Backpressure 구현 (High/Low Water Mark)
// ============================================================================

const CHUNK_SIZE_MIN = 16 * 1024;
const CHUNK_SIZE_MAX = 64 * 1024;
let CHUNK_SIZE = CHUNK_SIZE_MAX;

const BUFFER_SIZE = 8 * 1024 * 1024; // 8MB sender 버퍼
const POOL_SIZE = 128; // 풀 사이즈
const PREFETCH_BATCH = 16; // 한 번에 프리페치하는 양

// 🚀 [추가] ZIP 백프레셔 임계값
const ZIP_QUEUE_HIGH_WATER_MARK = 32 * 1024 * 1024; // 32MB 초과 시 읽기 중단
const ZIP_QUEUE_LOW_WATER_MARK = 8 * 1024 * 1024;   // 8MB 미만 시 읽기 재개

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

// 🚀 [추가] 백프레셔 상태 변수
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
  // 상태 초기화
  resetWorker();
  
  state.files = payload.files;
  state.manifest = payload.manifest;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = true; // 플래그 설정
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
      // ZIP 모드 초기 프리패치 (데이터 준비)
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

async function initZipStream() {
  // 상태 초기화
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

  const zip = new Zip();
  let zipFinalized = false;
  let hasError = false;
  const zipDataQueue: Uint8Array[] = [];
  let resolveDataAvailable: (() => void) | null = null;
  
  zip.ondata = (err, data, final) => {
    if (err) {
      console.error('[Worker] ZIP error:', err);
      hasError = true;
      return;
    }
    if (data && data.length > 0) {
      zipDataQueue.push(data);
      currentZipQueueSize += data.length; // 큐 크기 증가
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
    }
    if (final) {
      console.log('[Worker] ZIP stream finalized');
      zipFinalized = true;
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
    }
  };
  
  // 🚀 [백프레셔 적용] 파일 처리 루프
  const processFilesAsync = async () => {
    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;
        
        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest && state.manifest.files && state.manifest.files[i]) {
            filePath = state.manifest.files[i].path;
        }
        
        const entry = new ZipPassThrough(filePath);
        zip.add(entry);
        
        const reader = file.stream().getReader();
        try {
          while (true) {
            // 🚨 High Water Mark 초과 시 파일 읽기 일시 중지
            if (currentZipQueueSize > ZIP_QUEUE_HIGH_WATER_MARK) {
              isZipPaused = true;
              await new Promise<void>(resolve => { resolveZipResume = resolve; });
              isZipPaused = false;
            }

            const { done, value } = await reader.read();
            if (done) break;
            zipSourceBytesRead += value.length;
            entry.push(value, false);
          }
          entry.push(new Uint8Array(0), true);
        } catch (e) {
          console.error('[Worker] File read error:', filePath, e);
          try { entry.push(new Uint8Array(0), true); } catch(err) {}
        } finally {
          reader.releaseLock();
        }
      }
      zip.end();
    } catch (e) {
      console.error('[Worker] Fatal ZIP error:', e);
      hasError = true;
    }
  };
  
  state.zipStream = new ReadableStream({
    async pull(controller) {
      // 큐에서 데이터 소비 시 크기 감소 및 Resume 체크 함수
      const consumeAndCheckResume = (chunk: Uint8Array) => {
        currentZipQueueSize -= chunk.length;
        controller.enqueue(chunk);
        
        // 🚨 Low Water Mark 도달 시 읽기 재개
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
  console.log('[Worker] ✅ ZIP stream reader created with Backpressure');
  processFilesAsync();
  
  // 🚀 [성능 최적화] 초기 대기 로직 개선 - 50ms -> 1ms로 단축
  // 데이터가 준비될 때까지 기다리되, 반응 속도 극대화
  const waitStart = Date.now();
  while (zipDataQueue.length === 0 && !zipFinalized && !hasError && (Date.now() - waitStart) < 2000) {
    // 1ms 대기는 이벤트 루프를 한 텀 쉬게 하여 CPU 독점을 막으면서도 빠르게 실행
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  console.log('[Worker] ✅ ZIP stream ready, initial queue size:', zipDataQueue.length);
}

function resetWorker() {
  isTransferActive = false;
  if (state.zipReader) {
    state.zipReader.cancel();
    state.zipReader = null;
  }

  // 백프레셔 초기화
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
  if (state.files.length === 0) return null; // 방어 코드
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
    const packet = createPacket(new Uint8Array(buffer), buffer.byteLength);
    state.currentFileOffset = end;
    return packet;
  } catch (e) {
    console.error('[Worker] Single chunk error:', e);
    return null;
  }
}

// 🚀 [핵심] ZIP 청크 병합 (Aggregation)
let zipBuffer: Uint8Array | null = null;

async function createZipChunk(): Promise<ArrayBuffer | null> {
  if (!state.zipReader) {
    state.isCompleted = true;
    return null;
  }

  const targetChunkSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.chunkSize : CHUNK_SIZE_MAX;

  // 1. 버퍼에 데이터가 충분하면 바로 반환
  if (zipBuffer && zipBuffer.length >= targetChunkSize) {
    const chunkData = zipBuffer.slice(0, targetChunkSize);
    const remaining = zipBuffer.slice(targetChunkSize);
    zipBuffer = remaining.length > 0 ? remaining : null;
    return createPacket(chunkData, chunkData.length);
  }

  // 2. 버퍼가 부족하면 스트림에서 읽어서 채움 (Aggregation)
  while (true) {
    try {
      const { done, value } = await state.zipReader.read();

      if (done) {
        // 스트림 끝: 남은 버퍼 털어내기
        if (zipBuffer && zipBuffer.length > 0) {
          const chunkData = zipBuffer;
          zipBuffer = null;
          return createPacket(chunkData, chunkData.length);
        }
        state.isCompleted = true;
        return null;
      }

      if (value && value.length > 0) {
        // 데이터 병합
        if (zipBuffer) {
          const newBuffer = new Uint8Array(zipBuffer.length + value.length);
          newBuffer.set(zipBuffer);
          newBuffer.set(value, zipBuffer.length);
          zipBuffer = newBuffer;
        } else {
          zipBuffer = value;
        }

        // 목표 크기 도달 확인
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
  const packet = chunkPool.acquire();
  const view = new DataView(packet.buffer);

  // Header: FileIndex(2) + ChunkIndex(4) + Offset(8) + Length(4)
  view.setUint16(0, 0, true);
  view.setUint32(2, state.chunkSequence++, true);
  view.setBigUint64(6, BigInt(state.totalBytesSent), true);
  view.setUint32(14, dataSize, true);

  packet.set(data, 18);
  state.totalBytesSent += dataSize;

  // Transferable 복사본 생성
  const result = new ArrayBuffer(18 + dataSize);
  new Uint8Array(result).set(packet.subarray(0, 18 + dataSize));
  chunkPool.release(packet);

  return result;
}

function processBatch(requestedCount: number) {
  // 🚨 [FIX] 초기화되지 않았으면 처리하지 않음 (Race Condition 방지)
  if (!state.isInitialized) {
    console.warn('[Worker] Ignored process-batch request: Worker not initialized');
    return;
  }

  if (state.startTime === 0) state.startTime = Date.now();
  if (doubleBuffer.getActiveSize() === 0) doubleBuffer.swap();

  const chunks = doubleBuffer.takeFromActive(requestedCount);
  
  // 진행률 계산
  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
  let progress = 0;
  const totalSize = state.manifest?.totalSize || 0;
  
  if (state.mode === 'zip') {
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
  // 🚨 [FIX] 초기화 체크
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
