import { describe, expect, it } from 'vitest';
import { createTransferState, reduceTransferState } from './state';
import type { TransferEvent } from './events';

const apply = (role: 'sender' | 'receiver', events: TransferEvent[]) =>
  events.reduce(reduceTransferState, createTransferState({ role, totalBytes: 100 }));

describe('transfer core reducer', () => {
  it('tracks sender transport bytes and completes normally', () => {
    const state = apply('sender', [
      { type: 'connect', role: 'sender' },
      { type: 'ready', role: 'sender' },
      { type: 'progress', role: 'sender', bytes: 40, totalBytes: 100, chunkId: 1 },
      { type: 'progress', role: 'sender', bytes: 100, totalBytes: 100, chunkId: 2 },
      { type: 'complete', role: 'sender' },
    ]);
    expect(state.status).toBe('completed');
    expect(state.transportBytes).toBe(100);
    expect(state.persistedBytes).toBe(0);
  });

  it('tracks receiver persisted bytes, not transport bytes', () => {
    const state = apply('receiver', [
      { type: 'join', role: 'receiver' },
      { type: 'ready', role: 'receiver' },
      { type: 'progress', role: 'receiver', bytes: 50, totalBytes: 100, chunkId: 'a' },
      { type: 'complete', role: 'receiver' },
    ]);
    expect(state.status).toBe('completed');
    expect(state.persistedBytes).toBe(50);
    expect(state.transportBytes).toBe(0);
  });

  it('ignores duplicate chunks and all late terminal/error events', () => {
    const initial = createTransferState({ role: 'receiver', totalBytes: 100 });
    const progressed = reduceTransferState(initial, {
      type: 'progress', role: 'receiver', bytes: 25, totalBytes: 100, chunkId: 'one',
    });
    const duplicate = reduceTransferState(progressed, {
      type: 'progress', role: 'receiver', bytes: 50, totalBytes: 100, chunkId: 'one',
    });
    expect(duplicate.persistedBytes).toBe(25);
    const done = reduceTransferState(duplicate, { type: 'complete', role: 'receiver' });
    expect(reduceTransferState(done, { type: 'error', role: 'receiver', error: 'late' })).toBe(done);
    expect(reduceTransferState(done, { type: 'cancel', role: 'receiver' })).toBe(done);
  });

  it('preserves progress through reconnect and resumes deterministically', () => {
    let state = createTransferState({ role: 'sender', totalBytes: 100 });
    state = reduceTransferState(state, { type: 'progress', role: 'sender', bytes: 30, totalBytes: 100 });
    state = reduceTransferState(state, { type: 'reconnect', role: 'sender' });
    state = reduceTransferState(state, { type: 'resume', role: 'sender', bytes: 20 });
    expect(state.status).toBe('transferring');
    expect(state.bytes).toBe(30);
  });
});
