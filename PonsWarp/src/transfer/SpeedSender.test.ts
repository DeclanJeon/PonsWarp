import { describe, expect, it } from 'vitest';
import { SPEED_TRANSFER } from '../utils/constants';
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
  it('sends full file via hooks without transport abstraction', async () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes.fill(7);
    // happy-dom File may lack Blob.arrayBuffer; polyfill for this unit test.
    const blob = new Blob([bytes]);
    if (typeof (blob as any).arrayBuffer !== 'function') {
      (Blob.prototype as any).arrayBuffer = async function arrayBuffer() {
        return await new Response(this).arrayBuffer();
      };
    }
    const file = new File([bytes], 'chunk.bin', {
      type: 'application/octet-stream',
    });
    const sent: ArrayBuffer[] = [];
    const result = await sendSpeedFirehose({
      files: [file],
      manifest: { totalSize: file.size },
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
    expect(result.bytesSent).toBe(file.size);
    expect(result.packets).toBe(4);
    expect(sent).toHaveLength(4);
    expect(isPlainSpeedCompatiblePacket(sent[0])).toBe(true);
  });
});
