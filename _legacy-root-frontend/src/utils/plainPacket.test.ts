import { describe, expect, it } from 'vitest';
import { HEADER_SIZE } from './constants';
import { calculateCRC32, createEosPacket, createPlainDataPacket } from './plainPacket';

describe('plainPacket', () => {
  it('encodes the DirectFileWriter-compatible 22 byte data header', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const packet = createPlainDataPacket({ payload, sequence: 7, offset: 1234 });
    const view = new DataView(packet);
    const bytes = new Uint8Array(packet);

    expect(packet.byteLength).toBe(HEADER_SIZE + payload.byteLength);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint32(2, true)).toBe(7);
    expect(Number(view.getBigUint64(6, true))).toBe(1234);
    expect(view.getUint32(14, true)).toBe(payload.byteLength);
    expect(view.getUint32(18, true)).toBe(calculateCRC32(payload));
    expect([...bytes.slice(HEADER_SIZE)]).toEqual([...payload]);
  });

  it('creates an EOS packet recognized by DirectFileWriter', () => {
    const packet = createEosPacket();
    const view = new DataView(packet);

    expect(packet.byteLength).toBe(HEADER_SIZE);
    expect(view.getUint16(0, true)).toBe(0xffff);
  });

  it('does not start normal binary packets with JSON control marker', () => {
    const packet = createPlainDataPacket({
      payload: new TextEncoder().encode('{"looks":"json"}'),
      sequence: 0,
      offset: 0,
    });

    expect(new Uint8Array(packet)[0]).not.toBe(123);
  });
});
