import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW_CONTROL_PROFILE,
  calculateSafeBatchRequestSize,
  clampDataChannelChunkSize,
  getPacketPayloadSize,
  isPrematureTransferComplete,
  shouldRequestMoreChunks,
} from './transferFlowControl';

describe('transferFlowControl', () => {
  it('keeps the default profile below browser DataChannel pressure cliffs', () => {
    expect(DEFAULT_FLOW_CONTROL_PROFILE.chunkSize).toBe(16 * 1024);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.highWaterMark).toBe(128 * 1024);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.lowWaterMark).toBe(32 * 1024);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.batchSize).toBe(1);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.lowWaterMark).toBeLessThan(
      DEFAULT_FLOW_CONTROL_PROFILE.highWaterMark
    );
  });

  it('clamps chunk size to a safe browser-compatible range', () => {
    expect(clampDataChannelChunkSize(256 * 1024, 256 * 1024)).toBe(16 * 1024);
    expect(clampDataChannelChunkSize(64 * 1024, 32 * 1024)).toBe(16 * 1024);
    expect(clampDataChannelChunkSize(8 * 1024, 8 * 1024)).toBe(16 * 1024);
  });

  it('only requests more chunks when worker, peers, receiver, and channel queue are ready', () => {
    const ready = {
      isProcessingBatch: false,
      isTransferring: true,
      workerReady: true,
      activePeerCount: 1,
      highestBufferedAmount: 16 * 1024,
      highWaterMark: 128 * 1024,
      pausedPeerCount: 0,
    };

    expect(shouldRequestMoreChunks(ready)).toBe(true);
    expect(shouldRequestMoreChunks({ ...ready, isProcessingBatch: true })).toBe(false);
    expect(shouldRequestMoreChunks({ ...ready, activePeerCount: 0 })).toBe(false);
    expect(shouldRequestMoreChunks({ ...ready, pausedPeerCount: 1 })).toBe(false);
    expect(shouldRequestMoreChunks({ ...ready, pendingAckCount: 1 })).toBe(false);
    expect(
      shouldRequestMoreChunks({ ...ready, highestBufferedAmount: 128 * 1024 })
    ).toBe(false);
  });

  it('detects a worker completion report before the expected payload was queued', () => {
    expect(
      isPrematureTransferComplete({
        sentBytes: 37 * 1024 * 1024,
        expectedBytes: 500 * 1024 * 1024,
      })
    ).toBe(true);
    expect(
      isPrematureTransferComplete({
        sentBytes: 500 * 1024 * 1024,
        expectedBytes: 500 * 1024 * 1024,
      })
    ).toBe(false);
    expect(
      isPrematureTransferComplete({
        sentBytes: 500 * 1024 * 1024 - 1024,
        expectedBytes: 500 * 1024 * 1024,
        packetOverheadAllowance: 2048,
      })
    ).toBe(false);
  });

  it('caps each worker batch to the remaining DataChannel budget', () => {
    expect(
      calculateSafeBatchRequestSize({
        desiredBatchSize: 8,
        highestBufferedAmount: 0,
        highWaterMark: 128 * 1024,
        chunkPayloadSize: 16 * 1024,
        packetOverheadBytes: 64,
        minBatchSize: 1,
      })
    ).toBe(7);

    expect(
      calculateSafeBatchRequestSize({
        desiredBatchSize: 8,
        highestBufferedAmount: 120 * 1024,
        highWaterMark: 128 * 1024,
        chunkPayloadSize: 16 * 1024,
        packetOverheadBytes: 64,
        minBatchSize: 1,
      })
    ).toBe(1);

    expect(
      calculateSafeBatchRequestSize({
        desiredBatchSize: 8,
        highestBufferedAmount: 128 * 1024,
        highWaterMark: 128 * 1024,
        chunkPayloadSize: 16 * 1024,
        packetOverheadBytes: 64,
        minBatchSize: 1,
      })
    ).toBe(0);
  });

  it('counts file payload bytes, not packet envelope bytes, for transfer completion', () => {
    const plainPacket = new ArrayBuffer(22 + 64 * 1024);
    new DataView(plainPacket).setUint32(14, 64 * 1024, true);

    const encryptedPacket = new ArrayBuffer(38 + 64 * 1024 + 16);
    const encryptedBytes = new Uint8Array(encryptedPacket);
    encryptedBytes[0] = 0x02;
    new DataView(encryptedPacket).setUint32(16, 64 * 1024, true);

    expect(getPacketPayloadSize(plainPacket)).toBe(64 * 1024);
    expect(getPacketPayloadSize(encryptedPacket)).toBe(64 * 1024);
  });
});
