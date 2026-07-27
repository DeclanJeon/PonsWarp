import { describe, expect, it, vi } from 'vitest';
import { createReceiverUseCase, createSenderUseCase, createCloudDropUseCase } from './useCases';

function ports() {
  let onMessage: (value: unknown) => void = () => undefined;
  const peer = {
    connect: async () => undefined,
    send: async () => undefined,
    onMessage: (handler: (value: unknown) => void) => { onMessage = handler; return () => undefined; },
  };
  return {
    peer: { create: async () => peer },
    signaling: { connect: async () => undefined, join: async () => undefined, send: async () => undefined, onMessage: () => () => undefined },
    emit: (value: unknown) => onMessage(value),
  };
}

describe('transfer application use cases', () => {
  it('runs a sender trace and ignores duplicate chunks', async () => {
    const fake = ports();
    const sender = createSenderUseCase(fake, 10);
    await sender.connect();
    await sender.sendChunk('chunk', 10, 1);
    await sender.sendChunk('duplicate', 10, 1);
    await sender.complete();
    expect(sender.events.map(event => event.type)).toEqual(['connect', 'connected', 'ready', 'progress', 'duplicate-chunk', 'complete']);
    expect(sender.state.bytes).toBe(10);
  });

  it('persists each receiver chunk once', async () => {
    const fake = ports();
    const writes: unknown[] = [];
    const receiver = createReceiverUseCase({ ...fake, writer: { write: async chunk => { writes.push(chunk); } } }, 4);
    await receiver.join('room');
    fake.emit({ type: 'chunk', data: 'data', bytes: 4, totalBytes: 4, chunkId: 'a' });
    fake.emit({ type: 'chunk', data: 'again', bytes: 4, totalBytes: 4, chunkId: 'a' });
    await Promise.resolve();
    expect(writes).toEqual(['data']);
  });

  it('tears down peer and signaling on automatic timeout', async () => {
    let timeoutCallback: (() => void) | undefined;
    const close = vi.fn(async () => undefined);
    const leave = vi.fn(async () => undefined);
    const sender = createSenderUseCase({
      peer: {
        create: async () => ({
          connect: async () => undefined,
          close,
          send: async () => undefined,
          onMessage: () => () => undefined,
        }),
      },
      signaling: {
        connect: async () => undefined,
        join: async () => undefined,
        leave,
        send: async () => undefined,
        onMessage: () => () => undefined,
      },
      clock: {
        now: () => 1,
        setTimeout: callback => {
          timeoutCallback = callback;
          return 1;
        },
        clearTimeout: () => undefined,
      },
    }, 10, 100);

    await sender.connect();
    timeoutCallback?.();
    await vi.waitFor(() => {
      expect(sender.state.terminalReason).toBe('timeout');
      expect(close).toHaveBeenCalledOnce();
      expect(leave).toHaveBeenCalledOnce();
    });
  });

  it('delegates cloud drop lifecycle exactly once', async () => {
    const calls: string[] = [];
    const drop = createCloudDropUseCase({
      create: async input => { calls.push(`create:${String(input)}`); return 'id'; },
      upload: async id => { calls.push(`upload:${id}`); return undefined; },
      complete: async id => { calls.push(`complete:${id}`); return undefined; },
      cancel: async () => undefined,
    });
    const id = await drop.create('manifest');
    await drop.upload(String(id), 'data');
    await drop.complete(String(id));
    expect(calls).toEqual(['create:manifest', 'upload:id', 'complete:id']);
  });
});
