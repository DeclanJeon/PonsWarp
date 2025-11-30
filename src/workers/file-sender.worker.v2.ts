/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { Zip, ZipPassThrough, AsyncZipDeflate } from 'fflate';

// 🔐 암호화 관련 상수 및 함수 (워커 환경용)
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;

// 워커 환경에서 암호화 유틸리티
class WorkerEncryptionService {
  /**
   * Base64 문자열에서 CryptoKey 객체 복원
   */
  public static async importKey(base64Key: string): Promise<CryptoKey> {
    const raw = this.base64ToArrayBuffer(base64Key);
    return await self.crypto.subtle.importKey(
      'raw',
      raw,
      ALGORITHM,
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 청크 암호화 (IV는 청크 시퀀스 번호 기반으로 생성하여 오버헤드 제거)
   */
  public static async encryptChunk(
    key: CryptoKey,
    data: ArrayBuffer,
    chunkIndex: number
  ): Promise<ArrayBuffer> {
    const iv = this.generateIV(chunkIndex);
    return await self.crypto.subtle.encrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      data
    );
  }

  // 청크 인덱스를 12byte IV로 변환 (Deterministic IV)
  private static generateIV(counter: number): Uint8Array {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    // 마지막 4바이트에 청크 인덱스 기록 (40억 개 청크까지 지원)
    view.setUint32(8, counter, false); // Big-Endian
    return iv;
  }

  private static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = self.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// 🚀 [신규] 파일 확장자 기반 압축 필요 여부 판단
function isCompressibleFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase();
  // 이미 압축된 포맷들은 CPU 낭비를 막기 위해 압축하지 않음
  const nonCompressibleExts = new Set([
    'zip', 'rar', '7z', 'gz', 'tar', // 아카이브
    'jpg', 'jpeg', 'png', 'gif', 'webp', // 이미지
    'mp4', 'mkv', 'avi', 'mov', 'webm', // 비디오
    'mp3', 'wav', 'ogg', 'flac', // 오디오
    'pdf', 'docx', 'xlsx', 'pptx' // 문서 (이미 압축됨)
  ]);
  return !ext || !nonCompressibleExts.has(ext);
}

// 🚀 [신규] 전송 내역 버퍼 (재전송용)
class HistoryBuffer {
  private history: Map<number, Uint8Array> = new Map(); // Offset -> Data
  private offsets: number[] = []; // 순서 추적용 (LRU)
  private currentSize = 0;
  private readonly MAX_SIZE = 128 * 1024 * 1024; // 128MB 히스토리 (약 1초 분량)

  public add(offset: number, data: Uint8Array) {
    // 이미 있으면 무시
    if (this.history.has(offset)) return;

    this.history.set(offset, data);
    this.offsets.push(offset);
    this.currentSize += data.byteLength;

    // 용량 관리 (오래된 것부터 삭제)
    while (this.currentSize > this.MAX_SIZE && this.offsets.length > 0) {
      const oldOffset = this.offsets.shift()!;
      const oldData = this.history.get(oldOffset);
      if (oldData) {
        this.currentSize -= oldData.byteLength;
        this.history.delete(oldOffset);
      }
    }
  }

  public get(offset: number): Uint8Array | undefined {
    return this.history.get(offset);
  }

  public clear() {
    this.history.clear();
    this.offsets = [];
    this.currentSize = 0;
  }
}

const historyBuffer = new HistoryBuffer();

// 🚀 [신규] 긴급 재전송 큐
const priorityQueue: ArrayBuffer[] = [];

// WASM 모듈 로딩 제거 (fflate 사용)

// ============================================================================
// 🚀 Sender Worker V3 (fflate Powered)
// - Core: fflate ZIP streaming
// - Features: Real ZIP format, Backpressure, Memory efficient
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
  // 🔐 암호화 키 추가
  encryptionKey: CryptoKey | null;
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
  encryptionKey: null,
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
    // 🚀 [신규] NACK 처리
    case 'resend-request':
      handleResendRequest(payload.offset);
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

async function initWorker(payload: { files: File[]; manifest: any; encryptionKeyStr?: string }) {
  resetWorker();
  
  state.files = payload.files;
  state.manifest = payload.manifest;
  state.currentFileOffset = 0;
  state.totalBytesSent = 0;
  state.chunkSequence = 0;
  
  state.startTime = 0;
  state.isInitialized = true;
  state.isCompleted = false;

  isTransferActive = true;
  prefetchPromise = null;
  zipBuffer = null;
  
  const fileCount = state.files.length;
  console.log('[Worker] Initializing for', fileCount, 'files');

  // 🔐 암호화 키 로드
  if (payload.encryptionKeyStr) {
    try {
      state.encryptionKey = await WorkerEncryptionService.importKey(payload.encryptionKeyStr);
      console.log('[Worker] 🔐 Encryption Enabled (AES-GCM)');
    } catch (e) {
      console.error('[Worker] Failed to import encryption key:', e);
    }
  }

  if (fileCount === 1) {
    state.mode = 'single';
    // Single 모드에서는 currentFileOffset이 이미 설정되었으므로 createSingleFileChunk에서 반영됨
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
 * 🚀 [Core] fflate 기반 실제 ZIP 스트리밍
 */
async function initZipStream() {
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

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
      console.log('[Worker] ZIP stream finalized (fflate)');
      zipFinalized = true;
      if (resolveDataAvailable) {
        resolveDataAvailable();
        resolveDataAvailable = null;
      }
    }
  });

  // 파일 처리 루프 (fflate 사용 + 스마트 압축)
  const processFilesAsync = async () => {
    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;
        
        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest && state.manifest.files && state.manifest.files[i]) {
          filePath = state.manifest.files[i].path;
        }
        
        // 🚀 [스마트 압축] 파일 타입에 따라 스트림 방식 결정
        // ZipPassThrough: 비압축 (Store) - 미디어 파일용
        // AsyncZipDeflate: 압축 (Deflate) - 텍스트/코드용 (fflate 지원 필요, 없으면 PassThrough)
        const compressible = isCompressibleFile(filePath);
        
        // 참고: AsyncZipDeflate가 import 되지 않는 환경이라면 ZipPassThrough(level 0) 사용
        // 여기서는 구조적으로 분기 처리함
        let fileStream: any;
        
        if (compressible) {
             // 텍스트 등은 압축 시도 (level 6)
             // 만약 AsyncZipDeflate를 사용할 수 없다면 ZipPassThrough 사용
             try {
                 // @ts-ignore
                 fileStream = new AsyncZipDeflate(filePath, { level: 6 });
             } catch (e) {
                 fileStream = new ZipPassThrough(filePath); // Fallback
             }
        } else {
             // 미디어 파일은 압축 없이 저장 (속도 최적화)
             fileStream = new ZipPassThrough(filePath);
        }

        zip.add(fileStream);
        
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
            if (done) {
              fileStream.push(new Uint8Array(0), true); // 파일 종료
              break;
            }
            
            zipSourceBytesRead += value.length;
            fileStream.push(value, false);
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
      zip.terminate();
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
  historyBuffer.clear();
  priorityQueue.length = 0;
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
    // 파일 읽기 시작
    const blob = file.slice(start, end);
    const buffer = await blob.arrayBuffer();
    
    if (buffer.byteLength === 0) return null;
    
    return await createPacket(new Uint8Array(buffer), buffer.byteLength);
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
    const packet = await createPacket(chunkData, chunkData.length);
    // 🚨 빈 패킷 필터링
    return packet.byteLength > 0 ? packet : null;
  }

  while (true) {
    try {
      const { done, value } = await state.zipReader.read();

      if (done) {
        if (zipBuffer && zipBuffer.length > 0) {
          const chunkData = zipBuffer;
          zipBuffer = null;
          const packet = await createPacket(chunkData, chunkData.length);
          // 🚨 빈 패킷 필터링
          if (packet.byteLength > 0) {
            return packet;
          }
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
          const packet = await createPacket(chunkData, chunkData.length);
          // 🚨 빈 패킷 필터링
          return packet.byteLength > 0 ? packet : null;
        }
      }
    } catch (e) {
      console.error('[Worker] ZIP chunk error:', e);
      state.isCompleted = true;
      return null;
    }
  }
}

async function createPacket(data: Uint8Array, dataSize: number): Promise<ArrayBuffer> {
  // 🚨 ZIP 모드에서는 크기 제한 체크 안 함 (압축 후 크기가 다름)
  if (state.mode === 'single' && state.manifest && state.manifest.totalSize > 0) {
    if (state.totalBytesSent >= state.manifest.totalSize) {
      console.warn('[Worker] Already sent totalSize, stopping:', state.totalBytesSent, '>=', state.manifest.totalSize);
      return new ArrayBuffer(0);
    }
    if (state.totalBytesSent + dataSize > state.manifest.totalSize) {
      const remaining = state.manifest.totalSize - state.totalBytesSent;
      if (remaining <= 0) return new ArrayBuffer(0);
      console.warn('[Worker] Truncating last chunk:', dataSize, '->', remaining);
      data = data.subarray(0, remaining);
      dataSize = remaining;
    }
  }

  // 🔐 [보안] 암호화 활성화
  // 기존: if (false && state.encryptionKey)
  if (state.encryptionKey) {
    try {
      // 청크 인덱스를 IV 카운터로 사용 (Deterministic IV)
      const encryptedData = await WorkerEncryptionService.encryptChunk(
        state.encryptionKey,
        data.buffer.slice(data.byteOffset, data.byteOffset + dataSize) as ArrayBuffer,
        state.chunkSequence
      );
      
      // 암호화된 데이터로 교체 (AES-GCM Tag 16bytes 추가됨)
      data = new Uint8Array(encryptedData);
      dataSize = encryptedData.byteLength;
    } catch (e) {
      console.error('[Worker] Encryption failed:', e);
      throw e; // 치명적 오류: 암호화 실패 시 전송 중단
    }
  }

  const packet = chunkPool.acquire();
  
  // 패킷 크기가 풀 사이즈보다 커졌을 경우 (암호화 태그 때문) 예외 처리 필요하지만,
  // 현재 풀 사이즈(CHUNK_SIZE + 18)에 여유가 없으면 새로 할당해야 함.
  // 간단히 처리:
  const requiredSize = 18 + dataSize;
  let targetPacket = packet;
  if (packet.byteLength < requiredSize) {
      targetPacket = new Uint8Array(requiredSize); // 풀 대신 새 버퍼 사용 (드문 케이스)
  }

  const view = new DataView(targetPacket.buffer);

  // Header: FileIndex(2) + ChunkIndex(4) + Offset(8) + Length(4)
  view.setUint16(0, 0, true);
  view.setUint32(2, state.chunkSequence++, true);
  view.setBigUint64(6, BigInt(state.totalBytesSent), true);
  view.setUint32(14, dataSize, true); // 암호화된 크기 기록

  targetPacket.set(data, 18);
  state.totalBytesSent += dataSize; // 암호화된 크기만큼 증가 (실제 전송량)

  const result = new ArrayBuffer(requiredSize);
  new Uint8Array(result).set(targetPacket.subarray(0, requiredSize));
  
  if (packet === targetPacket) chunkPool.release(packet);

  return result;
}

function processBatch(requestedCount: number) {
  if (!state.isInitialized) return;

  if (state.startTime === 0) state.startTime = Date.now();
  if (doubleBuffer.getActiveSize() === 0) doubleBuffer.swap();

  // 🚀 1. 우선순위 큐(재전송) 먼저 확인
  const chunks: ArrayBuffer[] = [];
  
  while (priorityQueue.length > 0 && chunks.length < requestedCount) {
      chunks.push(priorityQueue.shift()!);
  }

  // 🚀 2. 부족하면 일반 데이터 가져오기
  const remainingCount = requestedCount - chunks.length;
  if (remainingCount > 0) {
      const newChunks = doubleBuffer.takeFromActive(remainingCount);
      
      // 🚀 3. 새로 보낼 청크를 히스토리에 저장
      for (const chunk of newChunks) {
          const view = new DataView(chunk);
          // Header: FileId(2) + ChunkSeq(4) + Offset(8)...
          const offset = Number(view.getBigUint64(6, true));
          
          // ChunkPool은 재사용되므로 복사본을 저장해야 함
          // (전송 시 Transferable로 소유권이 넘어가면 원본이 사라질 수 있음)
          const copy = new Uint8Array(chunk).slice(0);
          historyBuffer.add(offset, copy);
          
          chunks.push(chunk);
      }
  }
  
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
          bytesTransferred: state.mode === 'zip' ? zipSourceBytesRead : state.totalBytesSent,
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

// 🚀 NACK 요청 처리
function handleResendRequest(missingOffset: number) {
    console.log('[Worker] 🚨 Resend requested for offset:', missingOffset);
    
    // 1. 히스토리 버퍼에서 찾기 (Offset은 헤더 제외 순수 데이터 시작점)
    // 주의: 패킷 헤더의 offset 필드와 매칭되어야 함.
    // 여기서는 단순화를 위해 HistoryBuffer가 완성된 패킷(헤더 포함)을 저장한다고 가정하거나,
    // 아니면 청크 시퀀스로 찾는 것이 더 정확할 수 있음.
    // 현재 구조상 'totalBytesSent'가 Offset 역할을 하므로, 이를 기준으로 찾음.
    
    // * 개선: HistoryBuffer 키를 'Offset'으로 사용.
    const packet = historyBuffer.get(missingOffset);
    
    if (packet) {
        console.log('[Worker] ✅ Found in history, queuing for resend.');
        // 우선순위 큐에 추가 (다음 배치 처리 시 최우선 전송)
        // ArrayBuffer 복사본을 만들어야 안전함 (Transferable로 날아갈 수 있으므로)
        const packetCopy = new Uint8Array(packet).buffer;
        priorityQueue.push(packetCopy);
    } else {
        console.warn('[Worker] ⚠️ Packet expired from history buffer. Cannot resend offset:', missingOffset);
        // 심각한 경우: 여기서 파일 읽기를 다시 시도하거나, 에러 처리
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
          bytesTransferred: state.mode === 'zip' ? zipSourceBytesRead : state.totalBytesSent,
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
