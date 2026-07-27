/**
 * Mobile resume policy tests.
 * Full device screen-off resume behavior is manual-only and not exercised here.
 */
import { describe, expect, it } from 'vitest';

import {
  getPartitionedResumeCursor,
  shouldKeepReceiverReconnectAlive,
} from './mobileResumePolicy';

describe('mobile transfer resume policy', () => {
  it('keeps a resumable receiver session alive while the page is hidden even after normal retry attempts are exhausted', () => {
    expect(
      shouldKeepReceiverReconnectAlive({
        isTransferActive: true,
        hasRoom: true,
        hasWriter: true,
        fileCount: 1,
        reconnectAttempts: 5,
        maxReconnectAttempts: 5,
        pageHidden: true,
      })
    ).toBe(true);
  });

  it('does not keep retrying a visible page after normal reconnect attempts are exhausted', () => {
    expect(
      shouldKeepReceiverReconnectAlive({
        isTransferActive: true,
        hasRoom: true,
        hasWriter: true,
        fileCount: 1,
        reconnectAttempts: 5,
        maxReconnectAttempts: 5,
        pageHidden: false,
      })
    ).toBe(false);
  });

  it('maps a resume offset onto the correct file, sequence, and next partition boundary', () => {
    expect(
      getPartitionedResumeCursor({
        fileSizes: [10, 20, 30],
        startOffset: 25,
        chunkSize: 8,
        partitionSize: 16,
        totalSize: 60,
      })
    ).toEqual({
      fileIndex: 1,
      fileOffset: 15,
      globalOffset: 25,
      sequence: 3,
      nextPartitionEnd: 32,
    });
  });
  it('shouldKeepReceiverReconnectAlive: active transfer with all prerequisites and page hidden keeps alive past max retries', () => {
    expect(
      shouldKeepReceiverReconnectAlive({
        isTransferActive: true,
        hasRoom: true,
        hasWriter: true,
        fileCount: 2,
        reconnectAttempts: 10,
        maxReconnectAttempts: 3,
        pageHidden: true,
      })
    ).toBe(true);
  });

  it('shouldKeepReceiverReconnectAlive: missing writer returns false', () => {
    expect(
      shouldKeepReceiverReconnectAlive({
        isTransferActive: true,
        hasRoom: true,
        hasWriter: false,
        fileCount: 1,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        pageHidden: true,
      })
    ).toBe(false);
  });

  it('getPartitionedResumeCursor: start at offset 0', () => {
    expect(
      getPartitionedResumeCursor({
        fileSizes: [100],
        startOffset: 0,
        chunkSize: 16,
        partitionSize: 64,
        totalSize: 100,
      })
    ).toEqual({
      fileIndex: 0,
      fileOffset: 0,
      globalOffset: 0,
      sequence: 0,
      nextPartitionEnd: 64,
    });
  });

  it('getPartitionedResumeCursor: start at totalSize (complete)', () => {
    expect(
      getPartitionedResumeCursor({
        fileSizes: [50, 50],
        startOffset: 100,
        chunkSize: 10,
        partitionSize: 40,
        totalSize: 100,
      })
    ).toEqual({
      fileIndex: 2,
      fileOffset: 0,
      globalOffset: 100,
      sequence: 10,
      nextPartitionEnd: 100,
    });
  });

  it('getPartitionedResumeCursor: mid-file offset with multiple files', () => {
    expect(
      getPartitionedResumeCursor({
        fileSizes: [40, 60],
        startOffset: 55,
        chunkSize: 8,
        partitionSize: 32,
        totalSize: 100,
      })
    ).toEqual({
      fileIndex: 1,
      fileOffset: 15,
      globalOffset: 55,
      sequence: 6,
      nextPartitionEnd: 64,
    });
  });
});
