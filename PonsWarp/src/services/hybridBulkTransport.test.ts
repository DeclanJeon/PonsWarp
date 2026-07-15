import { describe, expect, it } from 'vitest';
import {
  frameHybridPackets,
  parseHybridFramedObject,
  shouldArmHybrid,
} from './hybridBulkTransport';

describe('hybridBulkTransport framing', () => {
  it('round-trips length-delimited packets', () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    const b = new Uint8Array([9, 8, 7, 6]).buffer;
    const framed = frameHybridPackets([a, b]);
    const copy = framed.slice().buffer;
    const parsed = parseHybridFramedObject(copy);
    expect(parsed).toHaveLength(2);
    expect(new Uint8Array(parsed[0])).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(parsed[1])).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  it('rejects truncated frames', () => {
    const framed = frameHybridPackets([new Uint8Array([1, 2, 3, 4]).buffer]);
    const truncated = framed.slice(0, 6).buffer;
    expect(() => parseHybridFramedObject(truncated)).toThrow(/Invalid hybrid frame/);
  });
});

describe('hybridBulkTransport arming', () => {
  it('requires compile flag, cloud, remote caps, and min size', () => {
    expect(
      shouldArmHybrid({
        compileEnabled: false,
        remoteCaps: { hybridHttp: true, version: 1 },
        totalBytes: 20 * 1024 * 1024,
        cloudApiConfigured: true,
      }).armed
    ).toBe(false);

    expect(
      shouldArmHybrid({
        compileEnabled: true,
        remoteCaps: { hybridHttp: false, version: 1 },
        totalBytes: 20 * 1024 * 1024,
        cloudApiConfigured: true,
      }).reason
    ).toBe('remote-caps-missing');

    expect(
      shouldArmHybrid({
        compileEnabled: true,
        remoteCaps: { hybridHttp: true, version: 1 },
        totalBytes: 1024,
        cloudApiConfigured: true,
        minBytes: 8 * 1024 * 1024,
      }).armed
    ).toBe(false);

    expect(
      shouldArmHybrid({
        compileEnabled: true,
        remoteCaps: { hybridHttp: true, version: 1 },
        totalBytes: 20 * 1024 * 1024,
        cloudApiConfigured: true,
      })
    ).toEqual({ armed: true, reason: 'ok' });
  });
});
