import { describe, expect, it } from 'vitest';
import { HEADER_SIZE, SPEED_TRANSFER } from '../utils/constants';
import { createPlainDataPacketFast } from '../utils/plainPacket';
import { isPlainSpeedCompatiblePacket, readPlainPacketMeta } from './SpeedReceiver';
import { sendSpeedFirehose } from './SpeedSender';

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

describe('sendSpeedFirehose', () => {
  it('sends full payload via hooks with recycled packets', async () => {
    const total = 64 * 1024;
    const bytes = new Uint8Array(total);
    bytes.fill(7);

    // Minimal File-like object with reliable slice/arrayBuffer for unit tests.
    const fileLike = {
      name: 'chunk.bin',
      size: total,
      type: 'application/octet-stream',
      slice(start = 0, end = total) {
        const s = Math.max(0, start);
        const e = Math.min(total, end ?? total);
        const part = bytes.subarray(s, e);
        return {
          arrayBuffer: async () => part.slice().buffer,
          size: part.byteLength,
        };
      },
    } as unknown as File;

    const sent: ArrayBuffer[] = [];
    const result = await sendSpeedFirehose({
      files: [fileLike],
      manifest: { totalSize: total },
      chunkSize: 16 * 1024,
      highWater: 8 * 1024 * 1024,
      hooks: {
        getBufferedAmount: () => 0,
        sendPacket: packet => {
          sent.push(packet);
          return 1;
        },
      },
    });
    expect(result.bytesSent).toBe(total);
    expect(result.packets).toBe(4);
    expect(sent).toHaveLength(4);
    expect(sent[0].byteLength).toBe(HEADER_SIZE + 16 * 1024);
    expect(isPlainSpeedCompatiblePacket(sent[0])).toBe(true);
  });
});
