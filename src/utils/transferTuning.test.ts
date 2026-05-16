import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE_INITIAL,
  HIGH_WATER_MARK,
  TRANSFER_PARTITION_SIZE,
} from './constants';

describe('transfer tuning constants', () => {
  it('uses a larger but browser-safe chunk and bounded multi-megabyte send queue', () => {
    expect(CHUNK_SIZE_INITIAL).toBe(128 * 1024);
    expect(HIGH_WATER_MARK).toBe(4 * 1024 * 1024);
  });

  it('acks larger partitions while staying under receiver pause threshold', () => {
    expect(TRANSFER_PARTITION_SIZE).toBe(16 * 1024 * 1024);
    expect(TRANSFER_PARTITION_SIZE).toBeLessThan(32 * 1024 * 1024);
  });
});
