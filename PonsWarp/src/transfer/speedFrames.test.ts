import { describe, expect, it } from 'vitest';
import {
  decodeSpeedFrame,
  encodeSpeedFrame,
  isSpeedFrame,
  SPEED_FRAME_MAGIC,
} from './speedFrames';
import { SPEED_TRANSFER, DEFAULT_APP_AES } from '../utils/constants';

describe('speedFrames', () => {
  it('round-trips payload frames with file index', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const packet = encodeSpeedFrame({
      seq: 9,
      offset: 1024,
      payload,
      fileIndex: 2,
    });
    expect(isSpeedFrame(packet)).toBe(true);
    expect(new Uint8Array(packet)[0]).toBe(SPEED_FRAME_MAGIC);
    const decoded = decodeSpeedFrame(packet);
    expect(decoded).not.toBeNull();
    expect(decoded!.seq).toBe(9);
    expect(decoded!.offset).toBe(1024);
    expect(decoded!.fileIndex).toBe(2);
    expect(Array.from(decoded!.payload)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded!.eos).toBe(false);
  });

  it('encodes EOS frames', () => {
    const packet = encodeSpeedFrame({
      seq: 1,
      offset: 20 * 1024 * 1024,
      payload: new Uint8Array(0),
      eos: true,
    });
    const decoded = decodeSpeedFrame(packet);
    expect(decoded?.eos).toBe(true);
    expect(decoded?.payload.byteLength).toBe(0);
  });

  it('defaults speed transfer with app AES off', () => {
    expect(SPEED_TRANSFER).toBe(true);
    expect(DEFAULT_APP_AES).toBe(false);
  });
});
