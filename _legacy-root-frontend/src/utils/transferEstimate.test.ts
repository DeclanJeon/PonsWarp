import { describe, expect, it } from 'vitest';
import {
  estimateRemainingSeconds,
  formatDuration,
  formatRemainingTime,
  getTransferFeedbackLabel,
  updateRollingSpeedSample,
} from './transferEstimate';

describe('transferEstimate', () => {
  it('returns null while speed is unknown', () => {
    expect(estimateRemainingSeconds(100, 1000, 0)).toBeNull();
  });

  it('estimates remaining seconds from bytes and speed', () => {
    expect(estimateRemainingSeconds(400, 1000, 200)).toBe(3);
  });

  it('formats long transfers in hours and minutes', () => {
    expect(formatDuration(7_500)).toBe('2h 5m');
  });

  it('formats remaining time with user-facing ETA wording', () => {
    expect(formatRemainingTime(null)).toBe('Calculating ETA');
    expect(formatRemainingTime(0)).toBe('Finishing now');
    expect(formatRemainingTime(45)).toBe('Less than 1 min remaining');
    expect(formatRemainingTime(125)).toBe('3 min remaining');
  });

  it('updates rolling speed from byte deltas', () => {
    const first = updateRollingSpeedSample(null, 100, 1_000);
    const second = updateRollingSpeedSample(first, 1_100, 2_000);

    expect(first.bytesPerSecond).toBe(0);
    expect(second.bytesPerSecond).toBe(1_000);
  });

  it('smooths rolling speed after the first measured sample', () => {
    const first = updateRollingSpeedSample(null, 0, 0);
    const second = updateRollingSpeedSample(first, 1_000, 1_000);
    const third = updateRollingSpeedSample(second, 3_000, 2_000, 0.5);

    expect(third.bytesPerSecond).toBe(1_500);
  });

  it('keeps the previous speed for non-forward samples', () => {
    const first = updateRollingSpeedSample(null, 1_000, 1_000);
    const second = updateRollingSpeedSample(
      { ...first, bytesPerSecond: 500 },
      900,
      2_000
    );

    expect(second.bytesPerSecond).toBe(500);
  });

  it('describes transfer feedback from available progress data', () => {
    expect(getTransferFeedbackLabel(0, 1_000, 0)).toBe('Starting transfer');
    expect(getTransferFeedbackLabel(500, 1_000, 0)).toBe(
      'Paused, waiting for data'
    );
    expect(getTransferFeedbackLabel(500, 1_000, 250)).toBe(
      'Less than 1 min remaining'
    );
    expect(getTransferFeedbackLabel(1_000, 1_000, 250)).toBe('Finalizing');
  });
});
