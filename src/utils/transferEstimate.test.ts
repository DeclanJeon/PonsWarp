import { describe, expect, it } from 'vitest';
import { estimateRemainingSeconds, formatDuration } from './transferEstimate';

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
});
