import { describe, expect, it, vi } from 'vitest';
import type { ISignalingService } from './signaling-factory';
import type { SinglePeerConnection } from './singlePeerConnection';
import { ReceiverService } from './webRTCService';

describe('ReceiverService signaling', () => {
  it('replays ICE candidates received while TURN config is loading', async () => {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    let resolveTurnConfig!: (value: unknown) => void;
    const turnConfig = new Promise(resolve => {
      resolveTurnConfig = resolve;
    });

    const signaling = {
      connect: vi.fn(async () => undefined),
      joinRoom: vi.fn(async () => undefined),
      leaveRoom: vi.fn(),
      sendOffer: vi.fn(),
      sendAnswer: vi.fn(),
      sendCandidate: vi.fn(),
      requestTurnConfig: vi.fn(() => turnConfig),
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      off: vi.fn(),
      getSocketId: vi.fn(() => 'receiver-id'),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
    } as unknown as ISignalingService;

    const signals: unknown[] = [];
    const peerHandlers = new Map<string, Array<(data: unknown) => void>>();
    const peer = {
      id: 'sender-id',
      connected: false,
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        peerHandlers.set(event, [...(peerHandlers.get(event) ?? []), handler]);
      }),
      signal: vi.fn((data: unknown) => signals.push(data)),
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
    } as unknown as SinglePeerConnection;

    const service = new ReceiverService({
      signaling,
      peerFactory: () => peer,
    });
    await service.initReceiver('ABC123');

    const offer = { type: 'offer', sdp: 'offer-sdp' };
    const candidate = {
      type: 'candidate',
      candidate: { candidate: 'candidate:relay' },
    };
    handlers
      .get('offer')
      ?.forEach(handler => handler({ from: 'sender-id', offer }));
    handlers
      .get('ice-candidate')
      ?.forEach(handler => handler({ from: 'sender-id', candidate }));

    expect(signals).toEqual([]);

    resolveTurnConfig({
      success: true,
      data: {
        iceServers: [],
        turnServerStatus: { primary: {}, fallback: [] },
        ttl: 600,
        timestamp: 0,
        roomId: 'ABC123',
      },
    });

    await vi.waitFor(() => expect(signals).toEqual([offer, candidate]));
    const metadata = vi.fn();
    service.on('metadata', metadata);
    const manifest = { rootName: 'fixture.txt', totalFiles: 1, totalSize: 49 };
    const controlFrame = new TextEncoder().encode(
      JSON.stringify({ type: 'MANIFEST', manifest })
    ).buffer as ArrayBuffer;
    peerHandlers.get('data')?.forEach(handler => handler(controlFrame));

    await vi.waitFor(() => expect(metadata).toHaveBeenCalledWith(manifest));
    const errors = vi.fn();
    service.on('error', errors);
    (service as unknown as { completionEmitted: boolean }).completionEmitted =
      true;
    peerHandlers
      .get('error')
      ?.forEach(handler => handler(new Error('late peer failure')));
    peerHandlers.get('close')?.forEach(handler => handler(undefined));

    expect(errors).not.toHaveBeenCalled();
    service.cleanup();
  });
});
