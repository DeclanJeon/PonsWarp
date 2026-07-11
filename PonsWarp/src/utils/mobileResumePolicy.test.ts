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
});
