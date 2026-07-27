import { describe, expect, it } from 'vitest';
import {
  calculateProgressPercent,
  calculateReceiverBufferedProgress,
} from './transferProgress';

describe('transfer progress helpers', () => {
  it('counts receiver buffered bytes before an 8MB flush threshold is reached', () => {
    const progress = calculateReceiverBufferedProgress({
      bytesWritten: 0,
      pendingBytes: 5 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
    });

    expect(progress.bytesTransferred).toBe(5 * 1024 * 1024);
    expect(progress.progress).toBe(100);
  });

  it('reports incremental receiver progress while small files are still buffered', () => {
    const progress = calculateReceiverBufferedProgress({
      bytesWritten: 0,
      pendingBytes: 2 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
    });

    expect(progress.progress).toBe(40);
  });

  it('clamps sender progress based on actually queued transport bytes', () => {
    expect(calculateProgressPercent(6 * 1024 * 1024, 5 * 1024 * 1024)).toBe(100);
    expect(calculateProgressPercent(Number.NaN, 5 * 1024 * 1024)).toBe(0);
  });
});
