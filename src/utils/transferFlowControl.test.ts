import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW_CONTROL_PROFILE,
  DIRECT_HOST_TRANSFER_TUNING_PROFILE,
  DIRECT_SRFLX_TRANSFER_TUNING_PROFILE,
  RELAY_TRANSFER_TUNING_PROFILE,
  UNKNOWN_TRANSFER_TUNING_PROFILE,
  PREPARATION_LEDGER_BYTES,
  PEER_ADMISSION_BYTES,
  HostTransferScheduler,
  candidateTuplesEqual,
  hasStableHostRoute,
  calculateSendBudget,
  calculateSafeBatchRequestSize,
  clampDataChannelChunkSize,
  getPacketPayloadSize,
  isPrematureTransferComplete,
  selectPartitionSize,
  selectInFlightTargetBytes,
  selectTransferTuningProfile,
  shouldRequestMoreChunks,
} from './transferFlowControl';

describe('transferFlowControl', () => {
  it('requires two identical host/udp samples at least 500ms apart', () => {
    const base = {
      selectedPairId: 'pair',
      localCandidateId: 'local',
      remoteCandidateId: 'remote',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      localProtocol: 'udp',
      remoteProtocol: 'udp',
      selectedOrNominatedSucceeded: true,
    };
    expect(
      hasStableHostRoute([
        { ...base, sampledAtMs: 0 },
        { ...base, sampledAtMs: 499 },
      ])
    ).toBe(false);
    expect(
      hasStableHostRoute([
        { ...base, sampledAtMs: 0 },
        { ...base, sampledAtMs: 500 },
      ])
    ).toBe(true);
    expect(
      candidateTuplesEqual(
        { ...base, sampledAtMs: 0 },
        { ...base, remoteCandidateId: 'changed', sampledAtMs: 500 }
      )
    ).toBe(false);
  });

  it('bounds reservations and burns nonce attempts', () => {
    const chunkBytes = 512 * 1024;
    const totalBytes = 8 * 1024 * 1024;
    const scheduler = new HostTransferScheduler(totalBytes);
    scheduler.enable();
    const first = scheduler.reserve(chunkBytes);
    const second = scheduler.reserve(chunkBytes);
    expect(first?.bytes).toBe(chunkBytes);
    expect(second?.bytes).toBe(chunkBytes);
    expect(scheduler.getUnsettledCount()).toBe(2);
    expect(scheduler.reserve(1)).toBeNull();
    scheduler.abandon(second!);
    const retry = scheduler.reserve(chunkBytes);
    expect(retry?.cursor).toBe(chunkBytes);
    expect(retry?.nonce).toBe(2);
    expect(scheduler.getUnsettledBytes()).toBe(chunkBytes * 2);
    expect(PREPARATION_LEDGER_BYTES).toBe(1376450);
  });
  it('starts from a resume cursor with the next nonce', () => {
    const scheduler = new HostTransferScheduler(
      16 * 1024 * 1024,
      5 * 1024 * 1024,
      7
    );
    scheduler.enable();
    const reservation = scheduler.reserve(1024);
    expect(reservation).toEqual({
      cursor: 5 * 1024 * 1024,
      bytes: 1024,
      nonce: 7,
    });
  });
  it('clears reservations on downgrade without rewinding the burned cursor', () => {
    const scheduler = new HostTransferScheduler(16 * 1024 * 1024);
    scheduler.enable();
    const first = scheduler.reserve(1024)!;
    scheduler.settle(first);
    const second = scheduler.reserve(2048)!;
    expect(second.cursor).toBe(1024);
    scheduler.disable();
    expect(scheduler.getUnsettledCount()).toBe(0);
    expect(scheduler.getCursor()).toBe(3072);
    scheduler.enable();
    const resumed = scheduler.reserve(1024)!;
    expect(resumed.cursor).toBe(3072);
    expect(resumed.nonce).toBe(2);
  });
  it('keeps the default profile below browser DataChannel pressure cliffs', () => {
    expect(DEFAULT_FLOW_CONTROL_PROFILE.chunkSize).toBe(16 * 1024);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.highWaterMark).toBe(128 * 1024);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.lowWaterMark).toBe(32 * 1024);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.batchSize).toBe(1);
    expect(DEFAULT_FLOW_CONTROL_PROFILE.lowWaterMark).toBeLessThan(
      DEFAULT_FLOW_CONTROL_PROFILE.highWaterMark
    );
  });

  it('selects direct profiles with bounded sender targets below receiver PAUSE', () => {
    const receiverPauseHighBytes = 32 * 1024 * 1024;

    expect(selectTransferTuningProfile({ candidatePathKind: 'host' })).toBe(
      DIRECT_HOST_TRANSFER_TUNING_PROFILE
    );
    expect(selectTransferTuningProfile({ candidatePathKind: 'srflx' })).toBe(
      DIRECT_SRFLX_TRANSFER_TUNING_PROFILE
    );
    expect(DIRECT_HOST_TRANSFER_TUNING_PROFILE.initialInFlightBytes).toBe(
      2 * 1024 * 1024
    );
    expect(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.initialInFlightBytes).toBe(
      2 * 1024 * 1024
    );
    expect(
      DIRECT_HOST_TRANSFER_TUNING_PROFILE.chunkSizeBytes + 38 + 16
    ).toBeLessThanOrEqual(256 * 1024 + 54);
    expect(
      DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.chunkSizeBytes + 38 + 16
    ).toBeLessThanOrEqual(256 * 1024 + 54);
    expect(DIRECT_HOST_TRANSFER_TUNING_PROFILE.maxInFlightBytes).toBeLessThan(
      receiverPauseHighBytes
    );
    expect(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.maxInFlightBytes).toBeLessThan(
      receiverPauseHighBytes
    );
    expect(
      DIRECT_HOST_TRANSFER_TUNING_PROFILE.maxInFlightBytes
    ).toBeLessThanOrEqual(28 * 1024 * 1024);
    expect(
      DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.maxInFlightBytes
    ).toBeLessThanOrEqual(28 * 1024 * 1024);
  });

  it('keeps relay and unknown profiles conservative', () => {
    expect(selectTransferTuningProfile({ candidatePathKind: 'relay' })).toBe(
      RELAY_TRANSFER_TUNING_PROFILE
    );
    expect(selectTransferTuningProfile({ candidatePathKind: 'unknown' })).toBe(
      UNKNOWN_TRANSFER_TUNING_PROFILE
    );
    expect(selectTransferTuningProfile()).toBe(UNKNOWN_TRANSFER_TUNING_PROFILE);
    expect(selectTransferTuningProfile(null)).toBe(
      UNKNOWN_TRANSFER_TUNING_PROFILE
    );
    expect(
      RELAY_TRANSFER_TUNING_PROFILE.initialInFlightBytes
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(
      UNKNOWN_TRANSFER_TUNING_PROFILE.initialInFlightBytes
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('selects direct in-flight targets up to the profile maximum when bitrate stats are absent', () => {
    expect(
      selectInFlightTargetBytes(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE, {
        candidatePathKind: 'srflx',
      })
    ).toBe(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.maxInFlightBytes);
    expect(
      selectInFlightTargetBytes(RELAY_TRANSFER_TUNING_PROFILE, {
        candidatePathKind: 'relay',
      })
    ).toBe(RELAY_TRANSFER_TUNING_PROFILE.initialInFlightBytes);
  });

  it('uses available bitrate and RTT to clamp in-flight targets within profile bounds', () => {
    expect(
      selectInFlightTargetBytes(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE, {
        candidatePathKind: 'srflx',
        availableOutgoingBitrateBps: 200_000_000,
        rttMs: 100,
      })
    ).toBeGreaterThan(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.minInFlightBytes);

    expect(
      selectInFlightTargetBytes(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE, {
        candidatePathKind: 'srflx',
        availableOutgoingBitrateBps: 5_000_000_000,
        rttMs: 250,
      })
    ).toBe(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE.maxInFlightBytes);

    expect(
      selectInFlightTargetBytes(RELAY_TRANSFER_TUNING_PROFILE, {
        candidatePathKind: 'relay',
        availableOutgoingBitrateBps: 64_000,
        rttMs: 50,
      })
    ).toBe(RELAY_TRANSFER_TUNING_PROFILE.minInFlightBytes);
  });

  it('calculates send budget without going negative and honors receiver pause', () => {
    expect(
      calculateSendBudget({
        targetInFlightBytes: 8 * 1024 * 1024,
        bufferedAmountBytes: 3 * 1024 * 1024,
        paused: false,
      })
    ).toBe(5 * 1024 * 1024);
    expect(
      calculateSendBudget({
        targetInFlightBytes: 4 * 1024 * 1024,
        bufferedAmountBytes: 6 * 1024 * 1024,
        paused: false,
      })
    ).toBe(0);
    expect(
      calculateSendBudget({
        targetInFlightBytes: 8 * 1024 * 1024,
        bufferedAmountBytes: 0,
        paused: true,
      })
    ).toBe(0);
  });

  it('selects partition size from the active profile', () => {
    expect(selectPartitionSize(DIRECT_SRFLX_TRANSFER_TUNING_PROFILE)).toBe(
      64 * 1024 * 1024
    );
    expect(selectPartitionSize(RELAY_TRANSFER_TUNING_PROFILE)).toBe(
      32 * 1024 * 1024
    );
    expect(selectPartitionSize(UNKNOWN_TRANSFER_TUNING_PROFILE)).toBe(
      64 * 1024 * 1024
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
    expect(shouldRequestMoreChunks({ ...ready, isProcessingBatch: true })).toBe(
      false
    );
    expect(shouldRequestMoreChunks({ ...ready, activePeerCount: 0 })).toBe(
      false
    );
    expect(shouldRequestMoreChunks({ ...ready, pausedPeerCount: 1 })).toBe(
      false
    );
    expect(shouldRequestMoreChunks({ ...ready, pendingAckCount: 1 })).toBe(
      false
    );
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
    encryptedBytes[1] = 0x01;
    new DataView(encryptedPacket).setUint32(16, 64 * 1024, true);

    expect(getPacketPayloadSize(plainPacket)).toBe(64 * 1024);
    expect(getPacketPayloadSize(encryptedPacket)).toBe(64 * 1024);
  });
  it('treats plain file id 2 packets as plain packets, not encrypted packets', () => {
    const packet = new ArrayBuffer(22 + 3);
    const view = new DataView(packet);
    const bytes = new Uint8Array(packet);
    view.setUint16(0, 2, true);
    view.setUint32(14, 3, true);
    bytes.set([1, 2, 3], 22);

    expect(getPacketPayloadSize(packet)).toBe(3);
  });
});
