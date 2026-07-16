import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Lightweight unit tests for PeerSession public surface without a real RTC stack.
 * Full browser E2E covers ICE + dual channels.
 */

describe('PeerSession module surface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports PeerSession as SinglePeerConnection facade', async () => {
    const peer = await import('./peerSession');
    const facade = await import('./singlePeerConnection');
    expect(peer.PeerSession).toBeTypeOf('function');
    expect(facade.SinglePeerConnection).toBe(peer.PeerSession);
  });

  it('routes string sends to control and buffers to bulk when channels open', async () => {
    class FakeChannel {
      label: string;
      readyState = 'open';
      binaryType = 'arraybuffer';
      bufferedAmount = 0;
      bufferedAmountLowThreshold = 0;
      sent: Array<string | ArrayBuffer> = [];
      onopen: ((ev?: unknown) => void) | null = null;
      onclose: ((ev?: unknown) => void) | null = null;
      onerror: ((ev?: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onbufferedamountlow: (() => void) | null = null;
      constructor(label: string) {
        this.label = label;
      }
      send(data: string | ArrayBuffer) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 'closed';
      }
    }

    const channels: FakeChannel[] = [];
    const pc = {
      connectionState: 'new',
      signalingState: 'stable',
      localDescription: null as null | { type: string; sdp: string },
      remoteDescription: null as null | { type: string; sdp: string },
      onicecandidate: null as null | ((ev: { candidate: null }) => void),
      onconnectionstatechange: null as null | (() => void),
      ondatachannel: null as null | ((ev: { channel: FakeChannel }) => void),
      createDataChannel: (label: string) => {
        const ch = new FakeChannel(label);
        channels.push(ch);
        return ch as unknown as RTCDataChannel;
      },
      createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
      createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
      setLocalDescription: async (desc: { type: string; sdp: string }) => {
        pc.localDescription = desc;
        pc.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
      },
      setRemoteDescription: async (desc: { type: string; sdp: string }) => {
        pc.remoteDescription = desc;
        pc.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
      },
      addIceCandidate: async () => undefined,
      getStats: async () => ({
        forEach: () => undefined,
        get: () => undefined,
      }),
      close: () => {
        pc.connectionState = 'closed';
      },
    };

    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(function RTCPeerConnection() {
        return pc;
      })
    );

    const { PeerSession } = await import('./peerSession');
    const session = new PeerSession('peer-a', true, { iceServers: [] });

    // Open channels
    for (const ch of channels) {
      ch.onopen?.(undefined);
    }

    expect(session.connected).toBe(true);

    expect(session.send(JSON.stringify({ type: 'PING' }))).toBe(true);
    const control = channels.find(c => c.label === 'control')!;
    expect(control.sent[0]).toBe(JSON.stringify({ type: 'PING' }));

    const payload = new ArrayBuffer(16);
    expect(session.send(payload)).toBe(true);
    const bulk = channels.find(c => c.label === 'bulk-0')!;
    expect(bulk.sent[0]).toBe(payload);

    expect(session.getBufferedAmount()).toBe(0);
    session.destroy();
    expect(session.isDestroyed()).toBe(true);
  });
});
