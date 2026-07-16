import { describe, expect, it } from 'vitest';
import { SPEED_TRANSFER } from '../utils/constants';
import { createPlainDataPacketFast } from '../utils/plainPacket';
import { isPlainSpeedCompatiblePacket, readPlainPacketMeta } from './SpeedReceiver';

describe('speed path packet compatibility', () => {
  it('keeps speed transfer enabled by default', () => {
    expect(SPEED_TRANSFER).toBe(true);
  });

  it('plain fast packets are speed-compatible and sequential-readable', () => {
    const payload = new Uint8Array([9, 8, 7, 6]);
    const packet = createPlainDataPacketFast({
      payload,
      sequence: 3,
      offset: 4096,
    });
    expect(isPlainSpeedCompatiblePacket(packet)).toBe(true);
    const meta = readPlainPacketMeta(packet);
    expect(meta).toEqual({
      sequence: 3,
      offset: 4096,
      payloadLength: 4,
      isEos: false,
    });
  });
});
