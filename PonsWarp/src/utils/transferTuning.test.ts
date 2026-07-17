import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE_INITIAL,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
  PARTITION_ACK_POLL_INTERVAL_MS,
  SEND_WINDOW_POLL_INTERVAL_MS,
  TRANSFER_PARTITION_SIZE,
} from './constants';

describe('transfer tuning constants', () => {
  it('uses browser-safe chunk and measured Chromium send-queue water marks', () => {
    expect(CHUNK_SIZE_INITIAL).toBe(240 * 1024);
    expect(CHUNK_SIZE_INITIAL).toBeLessThanOrEqual(256 * 1024);
    // Keep the SCTP queue filled without multi-tens-of-MB overflow.
    expect(HIGH_WATER_MARK).toBe(8 * 1024 * 1024);
    expect(LOW_WATER_MARK).toBe(2 * 1024 * 1024);
  });

  it('acks larger partitions while staying under receiver pause threshold', () => {
    expect(TRANSFER_PARTITION_SIZE).toBe(128 * 1024 * 1024);
    expect(TRANSFER_PARTITION_SIZE).toBeLessThanOrEqual(128 * 1024 * 1024);
  });

  it('uses short partitioned-transfer polling fallback intervals', () => {
    expect(SEND_WINDOW_POLL_INTERVAL_MS).toBeLessThanOrEqual(5);
    expect(PARTITION_ACK_POLL_INTERVAL_MS).toBeLessThanOrEqual(10);
  });
});
