/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 [Phase 1] 프리페치 버퍼 기반 고성능 Sender Worker
// ============================================================================

const CHUNK_SIZE = 128 * 1024; // 128KB (브라우저 한계)
const PREFETCH_BUFFER_MAX = 8 * 1024 * 1024; // 8MB
const PREFETCH_LOW_THRESHOLD = 2 * 1024 * 1024; // 2MB

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

// 🚀 [Phase 1] 프리페치 버퍼
interface PrefetchBuffer {
  chunks: ArrayBuffer[];
  totalSize: number;
  isPrefetching: boolean;
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

const prefetchBuffer: PrefetchBuffer = {
  chunks: [],
  totalSize: 0,
  isPrefetching: false
};

let isTransferActive = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'init':
      initWorker(payload);
      break;

    case 'process-batch':
      await processBatchFromPrefetch(payload.count);
      break;

    case 'reset':
      resetWorker();
      break;
  }
};

function initWorker(payload: { files: File[], manifest: any }) {
  state.files = payload.files;
  state.manifest = payload.manifest;
  state.currentFileIndex = 0;
  state.currentFileOffset = 0;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = true;
  state.isCompleted = false;
  
  // 프리페치 버퍼 초기화
  prefetchBuffer.chunks = [];
  prefetchBuffer.totalSize = 0;
  prefetchBuffer.isPrefetching = false;
  isTransferActive = true;

  console.log('[Worker] Initialized:', {
    fileCount: state.files.length,
    totalSize: state.manifest.totalSize
  });

  // 🚀 [Phase 1] 즉시 프리페치 시작
  startPrefetching();
}

function resetWorker() {
  state.files = [];
  state.manifest = null;
  state.currentFileIndex = 0;
  state.currentFileOffset = 0;
  state.chunkSequence = 0;
  state.totalBytesSent = 0;
  state.startTime = 0;
  state.isInitialized = false;
  state.isCompleted = false;
  
  prefetchBuffer.chunks = [];
  prefetchBuffer.totalSize = 0;
  prefetchBuffer.isPrefetching = false;
  isTransferActive = false;
}

// ============================================================================
// 🚀 [Phase 1] 프리페치 로직 - 백그라운드에서 청크 미리 읽기
// ============================================================================

async function startPrefetching() {
  if (prefetchBuffer.isPrefetching || state.isCompleted) return;
  
  prefetchBuffer.isPrefetching = true;
  
  while (isTransferActive && !state.isCompleted) {
    // 버퍼가 가득 찼으면 대기
    if (prefetchBuffer.totalSize >= PREFETCH_BUFFER_MAX) {
      await sleep(5);
      continue;
    }
    
    // 청크 생성
    const chunk = await createNextChunk();
    if (chunk) {
      prefetchBuffer.chunks.push(chunk);
      prefetchBuffer.totalSize += chunk.byteLength;
    } else {
      // 더 이상 읽을 데이터 없음
      break;
    }
  }
  
  prefetchBuffer.isPrefetching = false;
}

async function createNextChunk(): Promise<ArrayBuffer | null> {
  // 모든 파일 처리 완료 체크
  if (state.currentFileIndex >= state.files.length) {
    state.isCompleted = true;
    return null;
  }

  const file = state.files[state.currentFileIndex];
  
  // 현재 파일 끝 도달
  if (state.currentFileOffset >= file.size) {
    state.currentFileIndex++;
    state.currentFileOffset = 0;
    
    if (state.currentFileIndex >= state.files.length) {
      state.isCompleted = true;
      return null;
    }
    
    return createNextChunk(); // 다음 파일로 재귀
  }

  const start = state.currentFileOffset;
  const end = Math.min(start + CHUNK_SIZE, file.size);
  
  try {
    const blob = file.slice(start, end);
    const buffer = await blob.arrayBuffer();
    
    // 패킷 생성 (18B 헤더 + 데이터)
    const packet = new Uint8Array(18 + buffer.byteLength);
    const view = new DataView(packet.buffer);
    
    view.setUint16(0, state.currentFileIndex, true);
    view.setUint32(2, state.chunkSequence++, true);
    view.setBigUint64(6, BigInt(start), true);
    view.setUint32(14, buffer.byteLength, true);
    
    packet.set(new Uint8Array(buffer), 18);
    
    // 오프셋 업데이트
    state.currentFileOffset = end;
    state.totalBytesSent += buffer.byteLength;
    
    return packet.buffer as ArrayBuffer;
  } catch (error) {
    console.error('[Worker] Chunk creation failed:', error);
    return null;
  }
}

// ============================================================================
// 🚀 [Phase 1] 배치 처리 - 프리페치 버퍼에서 즉시 반환
// ============================================================================

async function processBatchFromPrefetch(requestedCount: number) {
  if (state.startTime === 0) {
    state.startTime = Date.now();
  }

  const chunks: ArrayBuffer[] = [];
  let bytesInBatch = 0;

  // 프리페치 버퍼에서 청크 가져오기
  for (let i = 0; i < requestedCount; i++) {
    if (prefetchBuffer.chunks.length === 0) {
      // 버퍼가 비었으면 즉시 생성 (fallback)
      if (!state.isCompleted) {
        const chunk = await createNextChunk();
        if (chunk) {
          chunks.push(chunk);
          bytesInBatch += chunk.byteLength;
        }
      }
      break;
    }
    
    const chunk = prefetchBuffer.chunks.shift()!;
    prefetchBuffer.totalSize -= chunk.byteLength;
    chunks.push(chunk);
    bytesInBatch += chunk.byteLength;
  }

  // 진행률 계산
  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
  const progress = state.manifest.totalSize > 0 
    ? (state.totalBytesSent / state.manifest.totalSize) * 100 
    : 0;

  // 배치 전송
  if (chunks.length > 0) {
    self.postMessage({
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
    }, chunks); // Transferable
  }

  // 완료 체크
  if (state.isCompleted && prefetchBuffer.chunks.length === 0) {
    self.postMessage({ type: 'complete' });
    return;
  }

  // 🚀 [Phase 1] 버퍼가 낮으면 프리페치 재시작
  if (prefetchBuffer.totalSize < PREFETCH_LOW_THRESHOLD && !prefetchBuffer.isPrefetching) {
    startPrefetching();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 워커 준비 완료 신호
self.postMessage({ type: 'ready' });
