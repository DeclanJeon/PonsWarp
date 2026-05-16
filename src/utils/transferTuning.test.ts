import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE_INITIAL,
  HIGH_WATER_MARK,
  TRANSFER_PARTITION_SIZE,
} from './constants';

describe('transfer tuning constants', () => {
  it('uses an OSS-style 64KB chunk and bounded multi-megabyte send queue', () => {
    expect(CHUNK_SIZE_INITIAL).toBe(64 * 1024);
    expect(HIGH_WATER_MARK).toBe(2 * 1024 * 1024);
  });

  it('acks partitions less often than every megabyte while staying under receiver pause threshold', () => {
    expect(TRANSFER_PARTITION_SIZE).toBe(8 * 1024 * 1024);
    expect(TRANSFER_PARTITION_SIZE).toBeLessThan(32 * 1024 * 1024);
  });
});
