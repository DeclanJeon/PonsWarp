/**
 * Off-main-thread AES-GCM packet encrypt/decrypt for bulk plane.
 * Keys stay inside the worker after init; only ciphertext crosses the wire.
 */

export type CryptoPlaneInMessage =
  | {
      type: 'init-key';
      requestId: number;
      sessionKey: ArrayBuffer;
      randomPrefix: ArrayBuffer;
    }
  | {
      type: 'encrypt';
      requestId: number;
      payload: ArrayBuffer;
      sequence: number;
      offset: number;
      nonceCounter: number;
    }
  | {
      type: 'decrypt';
      requestId: number;
      packet: ArrayBuffer;
    }
  | { type: 'reset'; requestId: number };

export type CryptoPlaneOutMessage =
  | { type: 'ready'; requestId: number }
  | {
      type: 'encrypt-result';
      requestId: number;
      packet: ArrayBuffer;
    }
  | {
      type: 'decrypt-result';
      requestId: number;
      /** Normalized plain packet (22B header + payload). */
      packet: ArrayBuffer;
    }
  | { type: 'error'; requestId: number; message: string };

const ENCRYPTED_HEADER_SIZE = 38;
const AUTH_TAG_SIZE = 16;
const PLAIN_HEADER_SIZE = 22;

let cryptoKey: CryptoKey | null = null;
let randomPrefix: Uint8Array | null = null;

function post(
  msg: CryptoPlaneOutMessage,
  transfer: Transferable[] = []
): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

async function initKey(
  sessionKey: ArrayBuffer,
  prefix: ArrayBuffer
): Promise<void> {
  cryptoKey = await crypto.subtle.importKey(
    'raw',
    sessionKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  randomPrefix = new Uint8Array(prefix).slice(0, 8);
}

async function encryptPacket(params: {
  payload: ArrayBuffer;
  sequence: number;
  offset: number;
  nonceCounter: number;
}): Promise<ArrayBuffer> {
  if (!cryptoKey || !randomPrefix) {
    throw new Error('Crypto worker not initialized');
  }
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(0, params.nonceCounter, true);
  nonce.set(randomPrefix, 4);

  const ciphertextWithTag = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    cryptoKey,
    params.payload
  );

  const packet = new ArrayBuffer(ENCRYPTED_HEADER_SIZE + ciphertextWithTag.byteLength);
  const packetBytes = new Uint8Array(packet);
  const packetView = new DataView(packet);
  packetBytes[0] = 0x02;
  packetBytes[1] = 0x01;
  packetView.setUint16(2, 0, true);
  packetView.setUint32(4, params.sequence, true);
  packetView.setBigUint64(8, BigInt(params.offset), true);
  packetView.setUint32(16, params.payload.byteLength, true);
  packetBytes.set(nonce, 20);
  packetBytes.set(new Uint8Array(ciphertextWithTag), ENCRYPTED_HEADER_SIZE);
  return packet;
}

async function decryptToPlainPacket(packet: ArrayBuffer): Promise<ArrayBuffer> {
  if (!cryptoKey) {
    throw new Error('Crypto worker not initialized');
  }
  const bytes = new Uint8Array(packet);
  if (bytes[0] !== 0x02 || bytes[1] !== 0x01) {
    // Already plain — return copy so caller can transfer safely.
    return packet.slice(0);
  }
  if (packet.byteLength < ENCRYPTED_HEADER_SIZE + AUTH_TAG_SIZE) {
    throw new Error('Encrypted packet too short');
  }
  const view = new DataView(packet);
  const offset = view.getBigUint64(8, true);
  const plaintextLength = view.getUint32(16, true);
  if (
    packet.byteLength !==
    ENCRYPTED_HEADER_SIZE + plaintextLength + AUTH_TAG_SIZE
  ) {
    throw new Error('Corrupt encrypted packet');
  }

  const iv = bytes.slice(20, 32);
  const ciphertextWithTag = bytes.slice(ENCRYPTED_HEADER_SIZE);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    ciphertextWithTag
  );
  if (decrypted.byteLength !== plaintextLength) {
    throw new Error('Encrypted packet plaintext length mismatch');
  }

  const normalized = new ArrayBuffer(PLAIN_HEADER_SIZE + decrypted.byteLength);
  const normalizedView = new DataView(normalized);
  const normalizedBytes = new Uint8Array(normalized);
  normalizedView.setUint16(0, 0, true);
  normalizedView.setUint32(2, 0, true);
  normalizedView.setBigUint64(6, offset, true);
  normalizedView.setUint32(14, decrypted.byteLength, true);
  normalizedView.setUint32(18, 0, true);
  normalizedBytes.set(new Uint8Array(decrypted), PLAIN_HEADER_SIZE);
  return normalized;
}

(self as DedicatedWorkerGlobalScope).onmessage = (
  event: MessageEvent<CryptoPlaneInMessage>
) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.type) {
        case 'init-key': {
          await initKey(msg.sessionKey, msg.randomPrefix);
          post({ type: 'ready', requestId: msg.requestId });
          return;
        }
        case 'encrypt': {
          const packet = await encryptPacket(msg);
          post(
            { type: 'encrypt-result', requestId: msg.requestId, packet },
            [packet]
          );
          return;
        }
        case 'decrypt': {
          const packet = await decryptToPlainPacket(msg.packet);
          post(
            { type: 'decrypt-result', requestId: msg.requestId, packet },
            [packet]
          );
          return;
        }
        case 'reset': {
          cryptoKey = null;
          if (randomPrefix) randomPrefix.fill(0);
          randomPrefix = null;
          post({ type: 'ready', requestId: msg.requestId });
          return;
        }
        default:
          post({
            type: 'error',
            requestId: (msg as { requestId?: number }).requestId ?? -1,
            message: 'Unknown crypto worker message',
          });
      }
    } catch (error) {
      post({
        type: 'error',
        requestId: msg.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
