/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 [Phase 2] 파이프라인 병렬화 + 이중 버퍼링 + 청크 풀링
// ============================================================================

const CHUNK_SIZE = 128 * 1024; // 128KB (브라우저 한계)
const BUFFER_SIZE = 4 * 1024 * 1024; // 4MB per buffer
const POOL_SIZE = 64; // 청크 풀 크기
const PREFETCH_BATCH = 8; // 한 번에 프리페치할 청크 수

// ============================================================================
// 청크 풀링 - 메모리 재사용으로 GC 압박 감소
// ============================================================================
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

// ============================================================================
// 이중 버퍼링 - 전송과 프리페치 완전 분리
// ============================================================================
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

// ============================================================================
// Worker 상태
// ============================================================================
interface WorkerState {
  files: File[];
  manifest: any;
  currentFileIndex: number;
  currentFileOffset: number;
  chunkSequence: number;
  totalBytesSent: number;
  startTime: number;
  isInitialized: boolean;
  isCompleted: boolean;
}

const state: WorkerState = {
  files: [],
  manifest: null,
  currentFileIndex: 0,
  currentFileOffset: 0,
  chunkSequence: 0,
  totalBytesSent: 0,
  startTime: 0,
  isInitialized: false,
  isCompleted: false
};

const chunkPool = new ChunkPool(CHUNK_SIZE, POOL_SIZE);
const doubleBuffer = new DoubleBuffer(BUFFER_SIZE);
let isTransferActive = false;
let prefetchPromise: Promise<void> | null = null;

// ============================================================================
// 메시지 핸들러
// ============================================================================
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
  }
};

function initWorker(payload: { files: File[]; manifest: any }) {
  state.files = payload.files;
  state.manifest = payload.manifest;
  state.currentFileIndex = 0;
  state.currentFileOffset = 0;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = true;
  state.isCompleted = false;

  chunkPool.clear();
  doubleBuffer.clear();
  isTransferActive = true;
  prefetchPromise = null;

  console.log('[Worker] Initialized:', {
    fileCount: state.files.length,
    totalSize: state.manifest.totalSize
  });

  // 🚀 [파이프라인 병렬화] 비동기로 프리페치 시작 (블로킹 없음)
  triggerPrefetch();
}

function resetWorker() {
  isTransferActive = false;
  state.files = [];
  state.manifest = null;
  state.currentFileIndex = 0;
  state.currentFileOffset = 0;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = false;
  state.isCompleted = false;

  chunkPool.clear();
  doubleBuffer.clear();
  prefetchPromise = null;
}

// ============================================================================
// 🚀 [파이프라인 병렬화] 프리페치 트리거 - 비동기 실행
// ============================================================================
function triggerPrefetch() {
  // 이미 프리페치 중이거나 완료된 경우 스킵
  if (prefetchPromise || state.isCompleted || !isTransferActive) return;

  // 비활성 버퍼가 가득 찼으면 스킵
  if (!doubleBuffer.canPrefetch()) return;

  // 🚀 [핵심] 프리페치를 Promise로 실행하고 즉시 반환 (블로킹 없음)
  prefetchPromise = prefetchBatch().finally(() => {
    prefetchPromise = null;
    // 프리페치 완료 후 추가 프리페치 필요하면 재트리거
    if (isTransferActive && !state.isCompleted && doubleBuffer.canPrefetch()) {
      triggerPrefetch();
    }
  });
}

// 🚀 [파이프라인 병렬화] 배치 단위 프리페치
async function prefetchBatch(): Promise<void> {
  for (let i = 0; i < PREFETCH_BATCH && isTransferActive && !state.isCompleted; i++) {
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
  if (state.currentFileIndex >= state.files.length) {
    state.isCompleted = true;
    return null;
  }

  const file = state.files[state.currentFileIndex];

  if (state.currentFileOffset >= file.size) {
    state.currentFileIndex++;
    state.currentFileOffset = 0;

    if (state.currentFileIndex >= state.files.length) {
      state.isCompleted = true;
      return null;
    }

    return createNextChunk();
  }

  const start = state.currentFileOffset;
  const end = Math.min(start + CHUNK_SIZE, file.size);

  try {
    const blob = file.slice(start, end);
    const buffer = await blob.arrayBuffer();
    const dataSize = buffer.byteLength;

    // 청크 풀에서 버퍼 획득
    const packet = chunkPool.acquire();
    const view = new DataView(packet.buffer);

    // 헤더 작성
    view.setUint16(0, state.currentFileIndex, true);
    view.setUint32(2, state.chunkSequence++, true);
    view.setBigUint64(6, BigInt(start), true);
    view.setUint32(14, dataSize, true);

    // 데이터 복사
    packet.set(new Uint8Array(buffer), 18);

    // 오프셋 업데이트
    state.currentFileOffset = end;
    state.totalBytesSent += dataSize;

    // 실제 크기만큼 새 ArrayBuffer로 반환
    const result = new ArrayBuffer(18 + dataSize);
    new Uint8Array(result).set(packet.subarray(0, 18 + dataSize));
    
    // 풀에 버퍼 반환
    chunkPool.release(packet);

    return result;
  } catch (error) {
    console.error('[Worker] Chunk creation failed:', error);
    return null;
  }
}

// ============================================================================
// 🚀 [파이프라인 병렬화] 배치 처리 - 동기적으로 버퍼에서 가져오기
// ============================================================================
function processBatch(requestedCount: number) {
  if (state.startTime === 0) {
    state.startTime = Date.now();
  }

  // 활성 버퍼가 비었으면 스왑 시도
  if (doubleBuffer.getActiveSize() === 0) {
    doubleBuffer.swap();
  }

  // 활성 버퍼에서 청크 가져오기 (동기)
  const chunks = doubleBuffer.takeFromActive(requestedCount);

  // 진행률 계산
  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
  const progress =
    state.manifest.totalSize > 0
      ? Math.min(100, (state.totalBytesSent / state.manifest.totalSize) * 100)
      : 0;

  // 배치 전송
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

  // 완료 체크
  if (state.isCompleted && doubleBuffer.isEmpty()) {
    self.postMessage({ type: 'complete' });
    return;
  }

  // 🚀 [파이프라인 병렬화] 프리페치 트리거 (비동기)
  triggerPrefetch();

  // 버퍼가 비었고 아직 완료 안됐으면 fallback으로 즉시 생성
  if (chunks.length === 0 && !state.isCompleted) {
    createAndSendImmediate(requestedCount);
  }
}

// Fallback: 버퍼가 비었을 때 즉시 생성하여 전송
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

  // 완료 체크
  if (state.isCompleted && doubleBuffer.isEmpty()) {
    self.postMessage({ type: 'complete' });
  }
}

// 워커 준비 완료 신호
self.postMessage({ type: 'ready' });
