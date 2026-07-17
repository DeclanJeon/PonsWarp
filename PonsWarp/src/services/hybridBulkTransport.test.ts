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
    expect(() => parseHybridFramedObject(truncated)).toThrow(
      /Invalid hybrid frame/
    );
  });
});

describe('hybridBulkTransport arming', () => {
  const base = {
    compileEnabled: true,
    remoteCaps: { hybridHttp: true, version: 1 as const },
    totalBytes: 20 * 1024 * 1024,
    cloudApiConfigured: true,
  };

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
  });

  it('keeps healthy LAN host/srflx on WebRTC-direct (no hybrid)', () => {
    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'host',
        rttMs: 12,
        observedMBps: 12,
      })
    ).toMatchObject({ armed: false, reason: 'direct-path:host' });

    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'srflx',
        rttMs: 30,
      })
    ).toMatchObject({ armed: false, reason: 'direct-path:srflx' });
  });

  it('arms on TURN relay paths', () => {
    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'relay',
      })
    ).toMatchObject({ armed: true, reason: 'path-relay' });
  });

  it('arms elevated-RTT host (CGNAT/VPN overlay) and slow direct', () => {
    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'host',
        rttMs: 240,
      }).armed
    ).toBe(true);

    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'host',
        rttMs: 20,
        observedMBps: 1.5,
        triggerMBps: 4,
      }).armed
    ).toBe(true);
  });

  it('does not arm unknown path unless slow signals present', () => {
    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'unknown',
      })
    ).toMatchObject({ armed: false, reason: 'path-unknown-not-slow' });

    expect(
      shouldArmHybrid({
        ...base,
        pathKind: 'unknown',
        rttMs: 300,
      }).armed
    ).toBe(true);
  });
});
