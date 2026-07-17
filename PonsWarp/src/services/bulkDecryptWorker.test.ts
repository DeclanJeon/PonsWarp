import { describe, expect, it } from 'vitest';
import { BulkDecryptWorker } from './bulkDecryptWorker';

const HEADER_SIZE = 22;
const ENCRYPTED_HEADER_SIZE = 38;

async function makeEncryptedPacket(
  key: CryptoKey,
  randomPrefix: Uint8Array,
  nonceCounter: number,
  offset: number,
  payload: Uint8Array
): Promise<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(0, nonceCounter, true);
  nonce.set(randomPrefix.subarray(0, 8), 4);
  const ciphertextWithTag = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    payload
  );
  const packet = new ArrayBuffer(ENCRYPTED_HEADER_SIZE + ciphertextWithTag.byteLength);
  const bytes = new Uint8Array(packet);
  const view = new DataView(packet);
  bytes[0] = 0x02;
  bytes[1] = 0x01;
  view.setUint16(2, 0, true);
  view.setUint32(4, 1, true);
  view.setBigUint64(8, BigInt(offset), true);
  view.setUint32(16, payload.byteLength, true);
  bytes.set(nonce, 20);
  bytes.set(new Uint8Array(ciphertextWithTag), ENCRYPTED_HEADER_SIZE);
  return packet;
}

describe('BulkDecryptWorker', () => {
  it('decrypts encrypted partition packets off main thread', async () => {
    if (typeof Worker === 'undefined') return;
    const sessionKey = crypto.getRandomValues(new Uint8Array(32));
    const randomPrefix = crypto.getRandomValues(new Uint8Array(8));
    const key = await crypto.subtle.importKey(
      'raw',
      sessionKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    const payload = new TextEncoder().encode('pons-decrypt-worker-ok');
    const packet = await makeEncryptedPacket(key, randomPrefix, 7, 4096, payload);

    const worker = new BulkDecryptWorker();
    await worker.start(sessionKey);
    const plain = await worker.decrypt(packet);
    const view = new DataView(plain);
    expect(plain.byteLength).toBe(HEADER_SIZE + payload.byteLength);
    expect(Number(view.getBigUint64(6, true))).toBe(4096);
    expect(view.getUint32(14, true)).toBe(payload.byteLength);
    expect(new TextDecoder().decode(new Uint8Array(plain, HEADER_SIZE))).toBe(
      'pons-decrypt-worker-ok'
    );
    worker.close();
  });
});
