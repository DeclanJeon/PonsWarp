/// <reference lib="webworker" />
/**
 * Focused bulk encrypt producer for 1:1 partitioned transfer.
 * Keeps AES-GCM E2E off the UI thread; posts transferable ciphertext packets.
 */
declare const self: DedicatedWorkerGlobalScope;

type StartPayload = {
  files: File[];
  fileSizes: number[];
  totalSize: number;
  startOffset: number;
  startSequence: number;
  startFileIndex: number;
  startFileOffset: number;
  chunkSize: number;
  prepareAheadBytes: number;
  encryptionEnabled: boolean;
  sessionKey?: ArrayBuffer;
  randomPrefix?: ArrayBuffer;
  startNonce: number;
};

type PreparedMsg = {
  type: 'prepared';
  sequence: number;
  offset: number;
  payloadSize: number;
  packet: ArrayBuffer;
};

type ControlIn =
  | { type: 'start'; payload: StartPayload }
  | { type: 'credit'; payload: { bytes: number } }
  | { type: 'update-chunk-size'; payload: { chunkSize: number } }
  | { type: 'cancel' };

const READ_BLOCK_SIZE = 8 * 1024 * 1024;

let cancelled = false;
let cryptoKey: CryptoKey | null = null;
let randomPrefix: Uint8Array | null = null;
let encryptionEnabled = false;
let nonceCounter = 0;
let chunkSize = 128 * 1024;
let prepareAheadBytes = 12 * 1024 * 1024;
let queuedBytes = 0;
let creditWaiters: Array<() => void> = [];

function notifyCredit(): void {
  const waiters = creditWaiters;
  creditWaiters = [];
  for (const w of waiters) w();
}

function waitForCredit(needBytes: number): Promise<void> {
  if (queuedBytes + needBytes <= prepareAheadBytes) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const tryResolve = () => {
      if (cancelled || queuedBytes + needBytes <= prepareAheadBytes) {
        resolve();
        return;
      }
      creditWaiters.push(tryResolve);
    };
    creditWaiters.push(tryResolve);
  });
}

async function importKey(sessionKey: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    sessionKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
}

function createPlainPacket(
  payload: Uint8Array,
  sequence: number,
  offset: number
): ArrayBuffer {
  const packet = new ArrayBuffer(22 + payload.byteLength);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  view.setUint16(0, 0, true);
  view.setUint32(2, sequence, true);
  view.setBigUint64(6, BigInt(offset), true);
  view.setUint32(14, payload.byteLength, true);
  view.setUint32(18, 0, true);
  bytes.set(payload, 22);
  return packet;
}

async function createEncryptedPacket(
  payload: Uint8Array,
  sequence: number,
  offset: number
): Promise<ArrayBuffer> {
  if (!cryptoKey || !randomPrefix) {
    throw new Error('Encryption key not configured');
  }
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(0, nonceCounter++, true);
  nonce.set(randomPrefix.subarray(0, 8), 4);

  const ciphertextWithTag = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    cryptoKey,
    payload
  );

  const packet = new ArrayBuffer(38 + ciphertextWithTag.byteLength);
  const packetBytes = new Uint8Array(packet);
  const packetView = new DataView(packet);
  packetBytes[0] = 0x02;
  packetBytes[1] = 0x01;
  packetView.setUint16(2, 0, true);
  packetView.setUint32(4, sequence, true);
  packetView.setBigUint64(8, BigInt(offset), true);
  packetView.setUint32(16, payload.byteLength, true);
  packetBytes.set(nonce, 20);
  packetBytes.set(new Uint8Array(ciphertextWithTag), 38);
  return packet;
}

async function runStart(payload: StartPayload): Promise<void> {
  cancelled = false;
  queuedBytes = 0;
  creditWaiters = [];
  chunkSize = Math.max(16 * 1024, payload.chunkSize | 0);
  prepareAheadBytes = Math.max(1 * 1024 * 1024, payload.prepareAheadBytes | 0);
  encryptionEnabled = payload.encryptionEnabled === true;
  nonceCounter = Math.max(0, payload.startNonce | 0);
  cryptoKey = null;
  randomPrefix = null;

  if (encryptionEnabled) {
    if (!payload.sessionKey || !payload.randomPrefix) {
      throw new Error('Encrypted bulk requires session key');
    }
    cryptoKey = await importKey(payload.sessionKey);
    randomPrefix = new Uint8Array(payload.randomPrefix);
  }

  const files = payload.files;
  const totalSize = payload.totalSize;
  let fileIndex = payload.startFileIndex;
  let fileOffset = payload.startFileOffset;
  let offset = payload.startOffset;
  let sequence = payload.startSequence;

  let readBlockCache: {
    fileIndex: number;
    offset: number;
    data: ArrayBuffer;
  } | null = null;

  const readChunk = async (
    fIdx: number,
    fOff: number,
    size: number
  ): Promise<Uint8Array> => {
    if (
      readBlockCache &&
      readBlockCache.fileIndex === fIdx &&
      fOff >= readBlockCache.offset &&
      fOff + size <= readBlockCache.offset + readBlockCache.data.byteLength
    ) {
      const rel = fOff - readBlockCache.offset;
      return new Uint8Array(readBlockCache.data, rel, size);
    }
    const file = files[fIdx];
    const blockEnd = Math.min(fOff + READ_BLOCK_SIZE, file.size);
    const blockData = await file.slice(fOff, blockEnd).arrayBuffer();
    readBlockCache = { fileIndex: fIdx, offset: fOff, data: blockData };
    return new Uint8Array(blockData, 0, size);
  };

  while (!cancelled && fileIndex < files.length && offset < totalSize) {
    while (
      !cancelled &&
      fileIndex < files.length &&
      fileOffset >= files[fileIndex].size
    ) {
      fileIndex++;
      fileOffset = 0;
    }
    if (fileIndex >= files.length || offset >= totalSize) break;

    const file = files[fileIndex];
    const bytes = Math.min(chunkSize, file.size - fileOffset, totalSize - offset);
    if (bytes <= 0) break;

    // Estimate ciphertext size for credit gating (plain 22+n, enc 38+n+16)
    const estPacket =
      (encryptionEnabled ? 38 + 16 : 22) + bytes;
    await waitForCredit(estPacket);
    if (cancelled) break;

    const payloadBytes = await readChunk(fileIndex, fileOffset, bytes);
    // Copy into standalone buffer for SubtleCrypto / transfer safety.
    const payloadCopy = new Uint8Array(payloadBytes.byteLength);
    payloadCopy.set(payloadBytes);

    const packet = encryptionEnabled
      ? await createEncryptedPacket(payloadCopy, sequence, offset)
      : createPlainPacket(payloadCopy, sequence, offset);

    queuedBytes += packet.byteLength;
    const msg: PreparedMsg = {
      type: 'prepared',
      sequence,
      offset,
      payloadSize: bytes,
      packet,
    };
    self.postMessage(msg, [packet]);

    fileOffset += bytes;
    offset += bytes;
    sequence++;
  }

  if (!cancelled) {
    self.postMessage({ type: 'complete', payload: { nextNonce: nonceCounter } });
  }
}

self.onmessage = (event: MessageEvent<ControlIn>) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'start':
      void runStart(data.payload).catch(error => {
        self.postMessage({
          type: 'error',
          payload: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
      break;
    case 'credit':
      queuedBytes = Math.max(0, queuedBytes - Math.max(0, data.payload.bytes | 0));
      notifyCredit();
      break;
    case 'update-chunk-size':
      chunkSize = Math.max(16 * 1024, data.payload.chunkSize | 0);
      break;
    case 'cancel':
      cancelled = true;
      notifyCredit();
      break;
  }
};

self.postMessage({ type: 'ready' });
