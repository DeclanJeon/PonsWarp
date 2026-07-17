import { describe, expect, it } from 'vitest';
import { BulkEncryptProducer } from './bulkEncryptProducer';

describe('BulkEncryptProducer', () => {
  it('exposes worker support detection', () => {
    expect(typeof BulkEncryptProducer.isSupported()).toBe('boolean');
  });

  it('produces encrypted packets off the main thread when Worker is available', async () => {
    if (!BulkEncryptProducer.isSupported()) {
      return;
    }

    const payload = new Uint8Array(64 * 1024).map((_, i) => i & 0xff);
    const file = new File([payload], 'bench.bin', {
      type: 'application/octet-stream',
    });
    const sessionKey = crypto.getRandomValues(new Uint8Array(32));
    const randomPrefix = crypto.getRandomValues(new Uint8Array(8));

    const producer = new BulkEncryptProducer();
    try {
      await producer.start({
        files: [file],
        totalSize: file.size,
        startOffset: 0,
        startSequence: 0,
        startFileIndex: 0,
        startFileOffset: 0,
        chunkSize: 16 * 1024,
        prepareAheadBytes: 2 * 1024 * 1024,
        encryptionEnabled: true,
        sessionKey,
        randomPrefix,
        startNonce: 0,
      });

      const first = await producer.next();
      expect(first).not.toBeNull();
      if (!first) return;

      const bytes = new Uint8Array(first.packet);
      expect(bytes[0]).toBe(0x02);
      expect(bytes[1]).toBe(0x01);
      expect(first.payloadSize).toBe(16 * 1024);
      expect(first.offset).toBe(0);
      expect(first.sequence).toBe(0);
      // encrypted packet: 38 header + ciphertext+tag
      expect(first.packet.byteLength).toBeGreaterThan(38 + first.payloadSize);

      producer.credit(first.packet.byteLength);

      let count = 1;
      for (;;) {
        const next = await producer.next();
        if (!next) break;
        producer.credit(next.packet.byteLength);
        count++;
      }
      expect(count).toBe(4);
      expect(producer.getNextNonce()).toBe(4);
    } finally {
      producer.close();
    }
  }, 20_000);

  it('produces plain packets when encryption is disabled', async () => {
    if (!BulkEncryptProducer.isSupported()) {
      return;
    }

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([payload], 'plain.bin');
    const producer = new BulkEncryptProducer();
    try {
      await producer.start({
        files: [file],
        totalSize: file.size,
        startOffset: 0,
        startSequence: 3,
        startFileIndex: 0,
        startFileOffset: 0,
        chunkSize: 1024,
        encryptionEnabled: false,
        startNonce: 0,
      });
      const packet = await producer.next();
      expect(packet).not.toBeNull();
      if (!packet) return;
      const view = new DataView(packet.packet);
      expect(view.getUint16(0, true)).toBe(0);
      expect(view.getUint32(2, true)).toBe(3);
      expect(Number(view.getBigUint64(6, true))).toBe(0);
      expect(view.getUint32(14, true)).toBe(5);
      expect(view.getUint32(18, true)).toBe(0);
      expect([...new Uint8Array(packet.packet, 22)]).toEqual([1, 2, 3, 4, 5]);
      expect(await producer.next()).toBeNull();
    } finally {
      producer.close();
    }
  }, 20_000);
});
