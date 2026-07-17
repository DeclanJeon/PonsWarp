/// <reference lib="webworker" />
/**
 * Bulk AES-GCM decrypt off the main thread.
 * Input: encrypted partition packets (0x02 0x01 ...)
 * Output: plain header packets (22-byte HEADER + plaintext) for DirectFileWriter.
 */
declare const self: DedicatedWorkerGlobalScope;

const HEADER_SIZE = 22;
const ENCRYPTED_HEADER_SIZE = 38;
const AUTH_TAG_SIZE = 16;

type InMsg =
  | { type: 'init'; payload: { sessionKey: ArrayBuffer } }
  | { type: 'decrypt'; payload: { id: number; packet: ArrayBuffer } }
  | { type: 'close' };

let cryptoKey: CryptoKey | null = null;

async function importKey(sessionKey: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    sessionKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
}

function isEncrypted(packet: ArrayBuffer): boolean {
  if (packet.byteLength < 2) return false;
  const b = new Uint8Array(packet);
  return b[0] === 0x02 && b[1] === 0x01;
}

async function decryptToPlain(packet: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isEncrypted(packet)) {
    // Already plain — transfer copy to detach safely.
    return packet.slice(0);
  }
  if (!cryptoKey) {
    throw new Error('Decrypt worker has no session key');
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

  const bytes = new Uint8Array(packet);
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

  const normalized = new ArrayBuffer(HEADER_SIZE + decrypted.byteLength);
  const nv = new DataView(normalized);
  const nb = new Uint8Array(normalized);
  nv.setUint16(0, 0, true);
  nv.setUint32(2, 0, true);
  nv.setBigUint64(6, offset, true);
  nv.setUint32(14, decrypted.byteLength, true);
  nv.setUint32(18, 0, true);
  nb.set(new Uint8Array(decrypted), HEADER_SIZE);
  return normalized;
}

self.onmessage = (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  void (async () => {
    try {
      if (msg.type === 'init') {
        cryptoKey = await importKey(msg.payload.sessionKey);
        self.postMessage({ type: 'ready' });
        return;
      }
      if (msg.type === 'close') {
        cryptoKey = null;
        self.close();
        return;
      }
      if (msg.type === 'decrypt') {
        const { id, packet } = msg.payload;
        const out = await decryptToPlain(packet);
        self.postMessage({ type: 'decrypted', id, packet: out }, [out]);
        return;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const id =
        msg && typeof msg === 'object' && 'payload' in msg
          ? // @ts-expect-error id optional
            msg.payload?.id
          : undefined;
      self.postMessage({ type: 'error', id, message });
    }
  })();
};

