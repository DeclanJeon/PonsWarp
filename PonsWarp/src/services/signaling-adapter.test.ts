import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  private closeListeners: Array<() => void> = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({
          type: 'Connected',
          payload: { socket_id: 'socket-1' },
        }),
      });
    }, 0);
  }

  send(message: string) {
    this.sent.push(message);
    const parsed = JSON.parse(message) as { type: string; payload: { room_id?: string } };
    if (parsed.type === 'RequestTurnConfig') {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'TurnConfig',
            payload: {
              success: true,
              data: {
                ice_servers: [{ urls: ['stun:stun.l.google.com:19302'] }],
                ttl: 600,
                timestamp: 1,
                room_id: parsed.payload.room_id,
              },
            },
          }),
        });
      }, 0);
    }
  }
  addEventListener(event: string, listener: () => void) {
    if (event === 'close') this.closeListeners.push(listener);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
    this.closeListeners.splice(0).forEach(listener => listener());
  }
}

describe('RustSignalingAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('uses the configured Rust signaling URL when connect is called through the service interface without arguments', async () => {
    const { rustSignalingAdapter } = await import('./signaling-adapter');

    const connected = rustSignalingAdapter.connect();
    await vi.runAllTimersAsync();
    await connected;

    expect(MockWebSocket.instances[0]?.url).toBe('ws://localhost:5502/ws');
  });

  it('connects before sending TURN config requests so sender initialization cannot hang before joining a room', async () => {
    const { rustSignalingAdapter } = await import('./signaling-adapter');

    const responsePromise = rustSignalingAdapter.requestTurnConfig('ABC123');
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.success).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(JSON.parse(MockWebSocket.instances[0].sent[0])).toEqual({
      type: 'RequestTurnConfig',
      payload: { room_id: 'ABC123' },
    });
  });

  it('opens a fresh socket when an online sender requests reconnect', async () => {
    const { rustSignalingAdapter } = await import('./signaling-adapter');
    const initialConnection = rustSignalingAdapter.connect();
    await vi.runAllTimersAsync();
    await initialConnection;

    const reconnection = rustSignalingAdapter.reconnect();
    await vi.runAllTimersAsync();
    await reconnection;

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
    expect(MockWebSocket.instances[1].url).toBe('ws://localhost:5502/ws');
  });
});
