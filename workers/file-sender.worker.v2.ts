/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// 🚀 [Pull-Based] 상태 관리 인터페이스
interface WorkerState {
  files: File[];
  manifest: any;
  currentFileIndex: number;
  currentFileOffset: number;
  chunkSequence: number;
  totalBytesSent: number;
  startTime: number;
  chunkSize: number;
  isInitialized: boolean;
  isCompleted: boolean;
}

// 🚀 [Dynamic Chunk Sizing] 네트워크 상태 추적
interface NetworkMetrics {
  rtt: number; // Round Trip Time
  throughput: number; // bytes per second
  bufferDrainRate: number; // 버퍼 비워지는 속도
  lastAdjustmentTime: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
}

// 🚀 [State Machine] 상태 정의
enum WorkerStateType {
  IDLE = 'IDLE',
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  PROCESSING_BATCH = 'PROCESSING_BATCH',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR',
  COMPLETED = 'COMPLETED'
}

// 🚀 [State Machine] 상태 전이 규칙
const stateTransitions: Record<WorkerStateType, WorkerStateType[]> = {
  [WorkerStateType.IDLE]: [WorkerStateType.INITIALIZING],
  [WorkerStateType.INITIALIZING]: [WorkerStateType.READY, WorkerStateType.ERROR],
  [WorkerStateType.READY]: [WorkerStateType.PROCESSING_BATCH, WorkerStateType.PAUSED, WorkerStateType.ERROR],
  [WorkerStateType.PROCESSING_BATCH]: [WorkerStateType.READY, WorkerStateType.PAUSED, WorkerStateType.ERROR, WorkerStateType.COMPLETED],
  [WorkerStateType.PAUSED]: [WorkerStateType.READY, WorkerStateType.ERROR],
  [WorkerStateType.ERROR]: [WorkerStateType.IDLE, WorkerStateType.INITIALIZING],
  [WorkerStateType.COMPLETED]: [WorkerStateType.IDLE, WorkerStateType.INITIALIZING]
};

const state: WorkerState = {
  files: [],
  manifest: null,
  currentFileIndex: 0,
  currentFileOffset: 0,
  chunkSequence: 0,
  totalBytesSent: 0,
  startTime: 0,
  chunkSize: 32 * 1024, // 32KB (시작 크기)
  isInitialized: false,
  isCompleted: false
};

// 🚀 [Dynamic Chunk Sizing] 네트워크 메트릭 초기화
const networkMetrics: NetworkMetrics = {
  rtt: 100, // 100ms 초기값
  throughput: 1024 * 1024, // 1MB/s 초기값
  bufferDrainRate: 1024 * 1024, // 1MB/s 초기값
  lastAdjustmentTime: 0,
  consecutiveSuccesses: 0,
  consecutiveFailures: 0
};

let currentState: WorkerStateType = WorkerStateType.IDLE;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  console.log('[DEBUG Worker] Message received:', {
    type,
    payload: payload ? 'has payload' : 'no payload',
    currentState,
    currentChunkSize: state.chunkSize
  });

  switch (type) {
    case 'init':
      // 🚀 [State Machine] 초기화
      if (!transitionState(currentState, WorkerStateType.INITIALIZING)) {
        console.log('[DEBUG Worker] Invalid transition from', currentState, 'to INITIALIZING');
        return;
      }
      
      try {
        state.files = payload.files;
        state.manifest = payload.manifest;
        state.currentFileIndex = 0;
        state.currentFileOffset = 0;
        state.chunkSequence = 0;
        state.totalBytesSent = 0;
        state.startTime = 0;
        state.isInitialized = true;
        state.isCompleted = false;
        
        // 🚀 [Dynamic Chunk Sizing] 초기화
        networkMetrics.lastAdjustmentTime = Date.now();
        networkMetrics.consecutiveSuccesses = 0;
        networkMetrics.consecutiveFailures = 0;
        
        transitionState(currentState, WorkerStateType.READY);
        
        console.log('[DEBUG Worker] Initialized:', {
          fileCount: state.files.length,
          totalSize: state.manifest.totalSize,
          chunkSize: state.chunkSize,
          state: currentState
        });
      } catch (error) {
        console.error('[DEBUG Worker] Initialization failed:', error);
        transitionState(currentState, WorkerStateType.ERROR);
      }
      break;

    case 'process-batch': // 🚀 [Pull-Based] 배치 처리 요청
      if (!transitionState(currentState, WorkerStateType.PROCESSING_BATCH)) {
        console.log('[DEBUG Worker] Cannot process batch, invalid state:', currentState);
        return;
      }
      
      try {
        console.log('[DEBUG Worker] Processing batch request:', {
          count: payload.count,
          currentChunkSize: state.chunkSize
        });
        await processBatch(payload.count);
        transitionState(WorkerStateType.PROCESSING_BATCH, WorkerStateType.READY);
      } catch (error) {
        console.error('[DEBUG Worker] Batch processing failed:', error);
        transitionState(WorkerStateType.PROCESSING_BATCH, WorkerStateType.ERROR);
      }
      break;

    case 'network-feedback': // 🚀 [Dynamic Chunk Sizing] 네트워크 피드백
      if (payload && (currentState === WorkerStateType.READY || currentState === WorkerStateType.PROCESSING_BATCH)) {
        updateNetworkMetrics(payload);
        adjustChunkSize();
      } else {
        console.log('[DEBUG Worker] Ignoring network feedback, invalid state:', currentState);
      }
      break;

    case 'reset': // 🚀 [State Machine] 상태 리셋
      if (!transitionState(currentState, WorkerStateType.IDLE)) {
        console.log('[DEBUG Worker] Cannot reset, invalid state:', currentState);
        return;
      }
      
      // 상태 초기화
      state.files = [];
      state.manifest = null;
      state.currentFileIndex = 0;
      state.currentFileOffset = 0;
      state.chunkSequence = 0;
      state.totalBytesSent = 0;
      state.startTime = 0;
      state.isInitialized = false;
      state.isCompleted = false;
      state.chunkSize = 32 * 1024; // 기본값으로 리셋
      
      console.log('[DEBUG Worker] State reset to IDLE');
      break;

    case 'start':
      // 🚀 [Pull-Based] 더 이상 사용되지 않음 (process-batch로 대체)
      console.log('[DEBUG Worker] Legacy start command ignored, use process-batch instead');
      break;

    case 'resume': // 🚀 [Legacy] 하위 호환성
      console.log('[DEBUG Worker] Legacy resume command ignored');
      break;

    case 'pause': // 🚀 [Legacy] 하위 호환성
      console.log('[DEBUG Worker] Legacy pause command ignored');
      break;
  }
};

// 🚀 [State Machine] 상태 전이 함수
function transitionState(from: WorkerStateType, to: WorkerStateType): boolean {
  if (!stateTransitions[from] || !stateTransitions[from].includes(to)) {
    console.log('[DEBUG Worker] ❌ Invalid state transition:', {
      from,
      to,
      allowedTransitions: stateTransitions[from]
    });
    return false;
  }
  
  console.log('[DEBUG Worker] ✅ State transition:', {
    from,
    to,
    timestamp: Date.now()
  });
  
  currentState = to;
  return true;
}

// 🚀 [Pull-Based] 배치 처리 함수 - 메인 스레드의 요청에 따라 청크 생성
async function processBatch(requestedCount: number) {
  if (currentState !== WorkerStateType.PROCESSING_BATCH) {
    console.log('[DEBUG Worker] Cannot process batch, invalid state:', {
      currentState,
      isCompleted: state.isCompleted
    });
    return;
  }

  // 🚀 [속도 계산] 첫 배치 처리 시 시작 시간 기록
  if (state.startTime === 0) {
    state.startTime = Date.now();
    console.log('[DEBUG Worker] Transfer started, recording start time');
  }

  const batchStartTime = performance.now();
  const chunks: ArrayBuffer[] = [];
  let actualProcessed = 0;

  console.log('[DEBUG Worker] Starting batch processing:', {
    requestedCount,
    currentFileIndex: state.currentFileIndex,
    currentOffset: state.currentFileOffset
  });

  // 요청된 수만큼 청크 생성
  for (let i = 0; i < requestedCount; i++) {
    if (state.currentFileIndex >= state.files.length) {
      console.log('[DEBUG Worker] All files processed');
      state.isCompleted = true;
      currentState = WorkerStateType.COMPLETED;
      break;
    }

    const file = state.files[state.currentFileIndex];
    const start = state.currentFileOffset;
    
    // 파일 끝 도달 시 다음 파일로
    if (start >= file.size) {
      console.log('[DEBUG Worker] File completed, moving to next file:', {
        fileIndex: state.currentFileIndex,
        fileName: file.name,
        fileSize: file.size
      });
      
      state.currentFileIndex++;
      state.currentFileOffset = 0;
      
      // 다음 파일이 없으면 완료
      if (state.currentFileIndex >= state.files.length) {
        console.log('[DEBUG Worker] All files completed');
        state.isCompleted = true;
        currentState = WorkerStateType.COMPLETED;
        break;
      }
      
      // 다음 파일의 청크 처리 계속
      i--; // 현재 인덱스 다시 시도
      continue;
    }

    // 🚀 [Zero-Copy 지향] 청크 생성
    const chunk = await createChunk(state.currentFileIndex, start);
    if (chunk) {
      chunks.push(chunk);
      actualProcessed++;
      
      // 오프셋 업데이트
      state.currentFileOffset += chunk.byteLength - 18; // 헤더 제외
      
      // 🚀 [Dynamic Chunk Sizing] 네트워크 성공 카운트
      networkMetrics.consecutiveSuccesses++;
      networkMetrics.consecutiveFailures = 0;
    } else {
      console.error('[DEBUG Worker] Failed to create chunk');
      networkMetrics.consecutiveFailures++;
      networkMetrics.consecutiveSuccesses = 0;
      break;
    }
  }

  // 진행률 계산
  const elapsed = state.startTime > 0 ? (Date.now() - state.startTime) / 1000 : 0;
  const speed = elapsed > 0 ? state.totalBytesSent / elapsed : 0;
  const progressData = {
    bytesTransferred: state.totalBytesSent,
    totalBytes: state.manifest.totalSize,
    speed,
    progress: state.manifest.totalSize > 0 ? (state.totalBytesSent / state.manifest.totalSize) * 100 : 0
  };

  const batchEndTime = performance.now();

  console.log('[DEBUG Worker] Batch processing completed:', {
    requestedCount,
    actualProcessed,
    batchTimeMs: (batchEndTime - batchStartTime).toFixed(2),
    totalBytesSent: state.totalBytesSent,
    progress: progressData.progress.toFixed(2) + '%'
  });

  // 🚀 [Pull-Based] 배치를 메인 스레드로 전송
  if (chunks.length > 0) {
    self.postMessage({
      type: 'chunk-batch',
      payload: {
        chunks,
        progressData
      }
    }, chunks); // Transferable 객체로 전송
  }

  // 전송 완료 처리
  if (state.isCompleted) {
    console.log('[DEBUG Worker] Transfer completed, sending complete message');
    self.postMessage({ type: 'complete' });
    transitionState(WorkerStateType.PROCESSING_BATCH, WorkerStateType.COMPLETED);
  }
}

// 🚀 [Zero-Copy] 청크 생성 함수 - 메모리 복사 최소화
async function createChunk(fileIndex: number, offset: number): Promise<ArrayBuffer | null> {
  let buffer: ArrayBuffer | null = null;
  let packet: Uint8Array | null = null;
  let sourceData: Uint8Array | null = null;
  
  try {
    const file = state.files[fileIndex];
    const end = Math.min(offset + state.chunkSize, file.size);
    const blob = file.slice(offset, end);
    
    // 🚨 [진단] 메모리 사용량 추적
    const beforeRead = performance.now();
    buffer = await blob.arrayBuffer(); // 파일 읽기
    const afterRead = performance.now();
    
    console.log('[DEBUG Worker] Chunk read:', {
      fileIndex,
      offset,
      end,
      chunkSize: buffer.byteLength,
      readTimeMs: (afterRead - beforeRead).toFixed(2)
    });

    // 🚀 [Zero-Copy 개선] 패킷 생성 - 단일 버퍼 할당으로 복사 횟수 감소
    const beforePacket = performance.now();
    
    // 18 bytes header + data - 단일 버퍼 할당
    packet = new Uint8Array(18 + buffer.byteLength);
    const view = new DataView(packet.buffer);

    // Header 작성
    view.setUint16(0, fileIndex, true);
    view.setUint32(2, state.chunkSequence++, true);
    view.setBigUint64(6, BigInt(offset), true);
    view.setUint32(14, buffer.byteLength, true);

    // 🚀 [Zero-Copy] 데이터 복사 최적화 - 단일 복사 연산
    sourceData = new Uint8Array(buffer);
    packet.set(sourceData, 18);
    
    const afterPacket = performance.now();
    
    console.log('[DEBUG Worker] Optimized packet created:', {
      packetSize: packet.byteLength,
      headerSize: 18,
      dataSize: buffer.byteLength,
      creationTimeMs: (afterPacket - beforePacket).toFixed(2),
      chunkSequence: state.chunkSequence - 1,
      copyOperations: 'single-copy-optimized'
    });

    // 진행률 업데이트
    state.totalBytesSent += buffer.byteLength;

    // 🚀 [메모리 최적화] 결과 반환 전 불필요한 참조 정리
    const result = packet.buffer.slice(0) as ArrayBuffer; // 명시적 ArrayBuffer 변환
    
    // 명시적 메모리 해제 (GC 힌트)
    sourceData = null;
    buffer = null;
    packet = null;
    
    // 가비지 컬렉션 제안 (주기적으로)
    if (state.chunkSequence % 100 === 0) {
      if (globalThis.gc) {
        globalThis.gc();
        console.log('[DEBUG Worker] GC suggested (every 100 chunks)');
      }
    }

    return result;
  } catch (error) {
    console.error('[DEBUG Worker] Error creating chunk:', error);
    
    // 🚀 [메모리 최적화] 에러 발생 시 메모리 정리
    sourceData = null;
    buffer = null;
    packet = null;
    
    return null;
  }
}

// 🚀 [Zero-Copy] 최적화된 청크 생성 함수 - Transferable Objects 활용
async function createChunkOptimized(fileIndex: number, offset: number): Promise<{header: ArrayBuffer, data: ArrayBuffer} | null> {
  let buffer: ArrayBuffer | null = null;
  let headerBuffer: ArrayBuffer | null = null;
  
  try {
    const file = state.files[fileIndex];
    const end = Math.min(offset + state.chunkSize, file.size);
    const blob = file.slice(offset, end);
    
    // 🚨 [진단] 메모리 사용량 추적
    const beforeRead = performance.now();
    buffer = await blob.arrayBuffer(); // 파일 읽기
    const afterRead = performance.now();
    
    console.log('[DEBUG Worker] Optimized chunk read:', {
      fileIndex,
      offset,
      end,
      chunkSize: buffer.byteLength,
      readTimeMs: (afterRead - beforeRead).toFixed(2)
    });

    // 🚀 [Zero-Copy] 헤더와 데이터를 완전히 분리
    const beforeHeader = performance.now();
    
    // 헤더 생성 (18 bytes) - 별도 버퍼
    headerBuffer = new ArrayBuffer(18);
    const headerView = new DataView(headerBuffer);
    
    // Header 작성
    headerView.setUint16(0, fileIndex, true);
    headerView.setUint32(2, state.chunkSequence++, true);
    headerView.setBigUint64(6, BigInt(offset), true);
    headerView.setUint32(14, buffer.byteLength, true);
    
    const afterHeader = performance.now();
    
    console.log('[DEBUG Worker] Optimized header created:', {
      headerSize: 18,
      dataSize: buffer.byteLength,
      headerTimeMs: (afterHeader - beforeHeader).toFixed(2),
      chunkSequence: state.chunkSequence - 1,
      copyOperations: 'none (zero-copy)'
    });

    // 진행률 업데이트
    state.totalBytesSent += buffer.byteLength;

    const result = {
      header: headerBuffer,
      data: buffer // 원본 데이터 버퍼를 그대로 사용 (복사 없음)
    };
    
    // 🚀 [메모리 최적화] 불필요한 참조 정리
    headerBuffer = null;
    buffer = null;
    
    return result;
  } catch (error) {
    console.error('[DEBUG Worker] Error creating optimized chunk:', error);
    
    // 🚀 [메모리 최적화] 에러 발생 시 메모리 정리
    headerBuffer = null;
    buffer = null;
    
    return null;
  }
}

// 🚀 [메모리 최적화] 명시적 메모리 정리 함수
function forceMemoryCleanup() {
  // 대용량 객체 참조 정리
  if (state.files.length > 0) {
    console.log('[DEBUG Worker] Force memory cleanup:', {
      filesCount: state.files.length,
      totalBytesSent: state.totalBytesSent,
      chunkSequence: state.chunkSequence
    });
  }
  
  // 가비지 컬렉션 강제 실행 (개발 환경에서만)
  if (globalThis.gc) {
    globalThis.gc();
    console.log('[DEBUG Worker] Forced garbage collection');
  }
}

// 🚀 [Dynamic Chunk Sizing] 네트워크 메트릭 업데이트 함수
function updateNetworkMetrics(feedback: any) {
  if (feedback.rtt) {
    networkMetrics.rtt = feedback.rtt;
  }
  
  if (feedback.throughput) {
    networkMetrics.throughput = feedback.throughput;
  }
  
  if (feedback.bufferDrainRate) {
    networkMetrics.bufferDrainRate = feedback.bufferDrainRate;
  }
  
  console.log('[DEBUG Worker] Network metrics updated:', {
    rtt: networkMetrics.rtt,
    throughput: networkMetrics.throughput,
    bufferDrainRate: networkMetrics.bufferDrainRate,
    consecutiveSuccesses: networkMetrics.consecutiveSuccesses,
    consecutiveFailures: networkMetrics.consecutiveFailures
  });
}

// 🚀 [Dynamic Chunk Sizing] AIMD 알고리즘 기반 청크 크기 조절
function adjustChunkSize() {
  const now = Date.now();
  const timeSinceLastAdjustment = now - networkMetrics.lastAdjustmentTime;
  
  // 최소 조절 간격 (1초)
  if (timeSinceLastAdjustment < 1000) {
    return;
  }
  
  const oldChunkSize = state.chunkSize;
  const MIN_CHUNK = 16 * 1024;  // 16KB
  const MAX_CHUNK = 256 * 1024; // 256KB
  
  // 🚀 [AIMD] Additive Increase / Multiplicative Decrease
  if (networkMetrics.consecutiveFailures > 2) {
    // 실패가 연속되면 청크 크기 감소 (Multiplicative Decrease)
    state.chunkSize = Math.max(MIN_CHUNK, Math.floor(state.chunkSize * 0.75));
    
    console.log('[DEBUG Worker] Chunk size decreased (MD):', {
      oldSize: oldChunkSize,
      newSize: state.chunkSize,
      reason: 'consecutive failures',
      failures: networkMetrics.consecutiveFailures
    });
    
    networkMetrics.consecutiveFailures = 0;
    networkMetrics.consecutiveSuccesses = 0;
  } else if (networkMetrics.consecutiveSuccesses > 5) {
    // 성공이 연속되면 청크 크기 증가 (Additive Increase)
    state.chunkSize = Math.min(MAX_CHUNK, state.chunkSize + 16 * 1024); // 16KB씩 증가
    
    console.log('[DEBUG Worker] Chunk size increased (AI):', {
      oldSize: oldChunkSize,
      newSize: state.chunkSize,
      reason: 'consecutive successes',
      successes: networkMetrics.consecutiveSuccesses
    });
    
    networkMetrics.consecutiveSuccesses = 0;
  }
  
  // 🚀 [RTT 기반 조절] RTT가 높으면 작은 청크 사용
  if (networkMetrics.rtt > 200) { // 200ms 이상
    const rttAdjustedSize = Math.max(MIN_CHUNK, Math.floor(64 * 1024 * (200 / networkMetrics.rtt)));
    if (rttAdjustedSize < state.chunkSize) {
      state.chunkSize = rttAdjustedSize;
      
      console.log('[DEBUG Worker] Chunk size adjusted for RTT:', {
        oldSize: oldChunkSize,
        newSize: state.chunkSize,
        rtt: networkMetrics.rtt,
        reason: 'high RTT adjustment'
      });
    }
  }
  
  // 🚀 [처리량 기반 조절] 처리량이 낮으면 작은 청크 사용
  if (networkMetrics.throughput < 512 * 1024) { // 512KB/s 미만
    const throughputAdjustedSize = Math.max(MIN_CHUNK, Math.floor(32 * 1024 * (networkMetrics.throughput / (512 * 1024))));
    if (throughputAdjustedSize < state.chunkSize) {
      state.chunkSize = throughputAdjustedSize;
      
      console.log('[DEBUG Worker] Chunk size adjusted for throughput:', {
        oldSize: oldChunkSize,
        newSize: state.chunkSize,
        throughput: networkMetrics.throughput,
        reason: 'low throughput adjustment'
      });
    }
  }
  
  networkMetrics.lastAdjustmentTime = now;
}

// 워커 로드 시 준비 신호
self.postMessage({ type: 'ready' });