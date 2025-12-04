/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 Sender Worker V3 (WASM Core + E2E Encryption)
// - CRC32 & Packet Encoding: Rust/WASM (pons-core-wasm)
// - E2E Encryption: AES-256-GCM (pons-core-wasm)
// - ZIP: fflate (streaming)
// - Features: Zero-copy streaming, Aggregation, Backpressure
// ============================================================================

import init, {
  PacketEncoder,
  CryptoSession,
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

// 🦀 WASM PacketEncoder
let packetEncoder: PacketEncoder | null = null;
let wasmReady = false;

// 🔐 E2E Encryption
let cryptoSession: CryptoSession | null = null;
let encryptionEnabled = false;

// WASM 초기화
async function initWasm() {
  try {
    await init();
    packetEncoder = new PacketEncoder();
    wasmReady = true;
    console.log('[Sender Worker] WASM initialized');
  } catch (e) {
    console.error('[Sender Worker] WASM init failed:', e);
    wasmReady = false;
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
function setEncryptionKey(payload: { sessionKey: Uint8Array; randomPrefix: Uint8Array }) {
  try {
    if (!wasmReady) {
      console.error('[Sender Worker] WASM not ready for encryption');
      self.postMessage({ type: 'encryption-error', payload: 'WASM not initialized' });
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
    adaptiveConfig.chunkSize = Math.max(CHUNK_SIZE_MIN, Math.min(CHUNK_SIZE_MAX, config.chunkSize));
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
  console.log('[Sender Worker] Initializing for', fileCount, 'files (WASM:', wasmReady, ', Encrypted:', encryptionEnabled, ')');

  if (fileCount === 1) {
    state.mode = 'single';
  } else {
    state.mode = 'zip';
    try {
      await initZipStream();
      await prefetchBatch();
    } catch (error: any) {
      console.error('[Sender Worker] ZIP init failed:', error);
      self.postMessage({ type: 'error', payload: { message: error.message } });
      return;
    }
  }

  triggerPrefetch();
  self.postMessage({ type: 'init-complete' });
}

let zipSourceBytesRead = 0;

async function initZipStream() {
  zipSourceBytesRead = 0;
  currentZipQueueSize = 0;
  isZipPaused = false;
  resolveZipResume = null;

  const { Zip } = await import('fflate');

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

  const zip = new Zip((err, data, final) => {
    if (err) {
      console.error('[Sender Worker] ZIP error:', err);
      hasError = true;
      resolveDataAvailable?.();
      resolveDataAvailable = null;
      return;
    }
    if (data && data.length > 0) pushToQueue(data);
    if (final) {
      zipFinalized = true;
      resolveDataAvailable?.();
      resolveDataAvailable = null;
    }
  });

  const processFilesAsync = async () => {
    try {
      for (let i = 0; i < state.files.length; i++) {
        if (!isTransferActive) break;

        const file = state.files[i];
        let filePath = file.name;
        if (state.manifest?.files?.[i]) {
          filePath = state.manifest.files[i].path;
        }

        const { ZipDeflate } = await import('fflate');
        const fileStream = new ZipDeflate(filePath, { level: 6 });
        zip.add(fileStream);

        const reader = file.stream().getReader();
        try {
          while (true) {
            if (currentZipQueueSize > ZIP_QUEUE_HIGH_WATER_MARK) {
              isZipPaused = true;
              await new Promise<void>(resolve => { resolveZipResume = resolve; });
              isZipPaused = false;
            }

            const { done, value } = await reader.read();
            if (done) {
              fileStream.push(new Uint8Array(0), true);
              break;
            }
            zipSourceBytesRead += value.length;
            fileStream.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (isTransferActive) zip.end();
    } catch (e) {
      console.error('[Sender Worker] Fatal ZIP error:', e);
      hasError = true;
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
      if (zipFinalized) { controller.close(); return; }
      if (hasError) { controller.error(new Error('ZIP failed')); return; }

      await new Promise<void>(resolve => { resolveDataAvailable = resolve; });

      if (zipDataQueue.length > 0) consumeAndCheckResume(zipDataQueue.shift()!);
      else if (zipFinalized) controller.close();
      else if (hasError) controller.error(new Error('ZIP failed'));
    },
  });

  state.zipReader = state.zipStream.getReader();
  processFilesAsync();

  const waitStart = Date.now();
  while (zipDataQueue.length === 0 && !zipFinalized && !hasError && Date.now() - waitStart < 2000) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function resetWorker() {
  isTransferActive = false;
  state.zipReader?.cancel();
  state.zipReader = null;

  if (singleFileReader) {
    try { singleFileReader.cancel(); } catch {}
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
    try { await singleFileReader?.cancel(); } catch {}
    singleFileReader = null;
    return null;
  }

  const currentChunkSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.chunkSize : CHUNK_SIZE_MAX;

  try {
    while (true) {
      const bufferSize = singleFileBuffer?.length ?? 0;

      if (bufferSize >= currentChunkSize || state.currentFileOffset + bufferSize >= file.size) {
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
        const newBuffer = new Uint8Array(singleFileBuffer.length + value.length);
        newBuffer.set(singleFileBuffer);
        newBuffer.set(value, singleFileBuffer.length);
        singleFileBuffer = newBuffer;
      } else {
        singleFileBuffer = value;
      }
    }
  } catch (e) {
    console.error('[Sender Worker] Single chunk error:', e);
    try { await singleFileReader?.cancel(); } catch {}
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

  const targetChunkSize = adaptiveConfig.enableAdaptive ? adaptiveConfig.chunkSize : CHUNK_SIZE_MAX;

  if (zipBuffer && zipBuffer.length >= targetChunkSize) {
    const chunkData = zipBuffer.slice(0, targetChunkSize);
    const remaining = zipBuffer.slice(targetChunkSize);
    zipBuffer = remaining.length > 0 ? remaining : null;
    return createPacket(chunkData);
  }

  while (true) {
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
 * 🦀 WASM 기반 패킷 생성 (암호화 지원)
 */
function createPacket(data: Uint8Array): ArrayBuffer {
  // Single File 모드 크기 제한 체크
  if (state.mode === 'single' && state.manifest) {
    const totalBytesSent = encryptionEnabled && cryptoSession
      ? cryptoSession.total_bytes_encrypted
      : (packetEncoder?.total_bytes_sent ?? 0n);
    if (totalBytesSent >= BigInt(state.manifest.totalSize)) {
      return new ArrayBuffer(0);
    }
    const remaining = BigInt(state.manifest.totalSize) - totalBytesSent;
    if (BigInt(data.length) > remaining) {
      data = data.subarray(0, Number(remaining));
    }
  }

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
  
  const totalBytesSent = encryptionEnabled && cryptoSession
    ? Number(cryptoSession.total_bytes_encrypted)
    : (wasmReady && packetEncoder ? Number(packetEncoder.total_bytes_sent) : fallbackTotalBytes);

  const elapsed = (Date.now() - state.startTime) / 1000;
  const speed = elapsed > 0 ? totalBytesSent / elapsed : 0;
  const totalSize = state.manifest?.totalSize || 0;

  let progress = 0;
  if (state.mode === 'zip') {
    progress = totalSize > 0 ? Math.min(100, (zipSourceBytesRead / totalSize) * 100) : 0;
  } else {
    progress = totalSize > 0 ? Math.min(100, (totalBytesSent / totalSize) * 100) : 0;
  }

  if (chunks.length > 0) {
    self.postMessage({
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
    const totalBytesSent = encryptionEnabled && cryptoSession
      ? Number(cryptoSession.total_bytes_encrypted)
      : (wasmReady && packetEncoder ? Number(packetEncoder.total_bytes_sent) : fallbackTotalBytes);
    const totalSize = state.manifest?.totalSize || 0;
    
    let progress = 0;
    if (state.mode === 'zip') {
      progress = totalSize > 0 ? Math.min(100, (zipSourceBytesRead / totalSize) * 100) : 0;
    } else {
      progress = totalSize > 0 ? Math.min(100, (totalBytesSent / totalSize) * 100) : 0;
    }

    self.postMessage({
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
    }, chunks);
  }

  if (state.isCompleted && doubleBuffer.isEmpty() && (!zipBuffer || zipBuffer.length === 0)) {
    self.postMessage({ type: 'complete' });
  }
}

// 🚀 Worker 시작
initWasm().then(() => {
  self.postMessage({ type: 'ready' });
}).catch(() => {
  console.warn('[Sender Worker] WASM failed, using fallback');
  self.postMessage({ type: 'ready' });
});
