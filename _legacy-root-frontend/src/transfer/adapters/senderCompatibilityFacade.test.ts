import { describe, expect, it, vi } from 'vitest';
import type { TransferEvent } from '../events';
import { SenderCompatibilityFacade } from './senderCompatibilityFacade';

describe('SenderCompatibilityFacade', () => {
  it('preserves sender transport progress and event order', () => {
    const listeners = new Map<string, (event: TransferEvent) => void>();
    const source = {
      on: (name: string, handler: (event: TransferEvent) => void) =>
        listeners.set(name, handler),
      off: (name: string) => listeners.delete(name),
    };
    const emit = vi.fn();
    const facade = new SenderCompatibilityFacade(source, { emit }).attach();
    const events: TransferEvent[] = [
      { type: 'connected', role: 'sender' },
      { type: 'ready', role: 'sender' },
      { type: 'progress', role: 'sender', bytes: 7, totalBytes: 100 },
      { type: 'complete', role: 'sender' },
    ];

    events.forEach(event => listeners.get(event.type)?.(event));

    expect(emit.mock.calls.map(([name]) => name)).toEqual([
      'peer-connected',
      'peer-ready',
      'progress',
      'complete',
    ]);
    expect(emit.mock.calls[2][1]).toBe(events[2]);
    facade.detach();
    expect(listeners.size).toBe(0);
  });
});
