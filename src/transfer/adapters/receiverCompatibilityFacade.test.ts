import { describe, expect, it } from 'vitest';
import { ReceiverCompatibilityFacade, mapReceiverEvent } from './receiverCompatibilityFacade';

describe('ReceiverCompatibilityFacade', () => {
  it('reports persisted receiver progress using the legacy payload', () => {
    expect(mapReceiverEvent({ type: 'progress', role: 'receiver', bytes: 4, totalBytes: 10 })).toEqual([
      { event: 'progress', data: { progress: 0.4, bytesTransferred: 4, totalBytes: 10 } },
    ]);
  });

  it('emits one terminal completion and ignores later events', () => {
    const events: Array<[string, unknown]> = [];
    const facade = new ReceiverCompatibilityFacade({ emit: (event, data) => events.push([event, data]) });
    facade.handle({ type: 'complete', role: 'receiver' }, 10);
    facade.handle({ type: 'error', role: 'receiver', error: 'late' });
    expect(events).toEqual([['complete', { actualSize: 10 }]]);
  });
});
