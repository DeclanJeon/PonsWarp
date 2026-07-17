import { describe, expect, it } from 'vitest';
import {
  estimateRemainingSeconds,
  formatDuration,
  formatRemainingTime,
  getTransferFeedbackLabel,
  TransferSpeedMeter,
  updateRollingSpeedSample,
  MIN_SPEED_SAMPLE_MS,
} from './transferEstimate';

describe('transferEstimate', () => {
  it('returns null while speed is unknown', () => {
    expect(estimateRemainingSeconds(100, 1000, 0)).toBeNull();
  });

  it('estimates remaining seconds from bytes and speed', () => {
    expect(estimateRemainingSeconds(400, 1000, 200)).toBe(3);
  });

  it('formats long transfers in hours and minutes', () => {
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatRemainingTime(90)).toBe('2 min remaining');
  });

  it('updates rolling speed from byte deltas after min sample window', () => {
    const first = updateRollingSpeedSample(null, 100, 1_000);
    const second = updateRollingSpeedSample(
      first,
      1_100,
      1_000 + MIN_SPEED_SAMPLE_MS
    );

    expect(first.bytesPerSecond).toBe(0);
    expect(second.bytesPerSecond).toBeCloseTo(1_000 / (MIN_SPEED_SAMPLE_MS / 1000), 0);
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
    expect(second.bytesTransferred).toBe(1_000);
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

  it('smooths bursty TransferSpeedMeter samples', () => {
    const meter = new TransferSpeedMeter({
      windowMs: 2000,
      smoothing: 0.5,
      minSampleMs: 100,
    });
    meter.reset(0, 0);
    // 1MB in 100ms burst then idle
    meter.update(1_000_000, 100);
    const afterBurst = meter.update(1_000_000, 500);
    // another 1MB over next 500ms
    const afterSteady = meter.update(2_000_000, 1000);
    expect(afterBurst).toBeGreaterThan(0);
    expect(afterSteady).toBeGreaterThan(0);
    // steady window rate should be closer to ~2MB/s than pure burst rate
    expect(afterSteady).toBeLessThan(20_000_000);
  });

  it('ignores progress regressions without collapsing speed', () => {
    const meter = new TransferSpeedMeter({ minSampleMs: 50, smoothing: 0.5 });
    meter.reset(0, 0);
    meter.update(5_000_000, 1000);
    const before = meter.bytesPerSecond;
    meter.update(4_000_000, 1200); // multipart retry regression
    expect(meter.bytesPerSecond).toBe(before);
  });
});
