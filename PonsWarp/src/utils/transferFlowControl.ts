export interface FlowControlProfile {
  chunkSize: number;
  highWaterMark: number;
  lowWaterMark: number;
  batchSize: number;
  prefetchBufferSize: number;
}

export type CandidatePathKind = 'host' | 'srflx' | 'relay' | 'unknown';

export interface TransferDiagnostics {
  candidatePathKind: CandidatePathKind;
  protocol?: string | null;
  relayProtocol?: string | null;
  rttMs?: number | null;
  availableOutgoingBitrateBps?: number | null;
  bufferedAmountBytes?: number | null;
}

export interface TransferTuningProfile {
  pathKind: CandidatePathKind;
  chunkSizeBytes: number;
  minInFlightBytes: number;
  initialInFlightBytes: number;
  maxInFlightBytes: number;
  lowWaterBytes: number;
  partitionSizeBytes: number;
  receiverPauseHighBytes: number;
  receiverPauseLowBytes: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;

const RECEIVER_PAUSE_HIGH_BYTES = 32 * MIB;
const RECEIVER_PAUSE_LOW_BYTES = 16 * MIB;

export const DIRECT_HOST_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  pathKind: 'host',
  chunkSizeBytes: 192 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  maxInFlightBytes: 8 * MIB,
  lowWaterBytes: 1024 * KIB,
  partitionSizeBytes: 64 * MIB,
  receiverPauseHighBytes: RECEIVER_PAUSE_HIGH_BYTES,
  receiverPauseLowBytes: RECEIVER_PAUSE_LOW_BYTES,
};

export const DIRECT_SRFLX_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  pathKind: 'srflx',
  chunkSizeBytes: 192 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  maxInFlightBytes: 8 * MIB,
  lowWaterBytes: 1024 * KIB,
  partitionSizeBytes: 64 * MIB,
  receiverPauseHighBytes: RECEIVER_PAUSE_HIGH_BYTES,
  receiverPauseLowBytes: RECEIVER_PAUSE_LOW_BYTES,
};

export const RELAY_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  pathKind: 'relay',
  chunkSizeBytes: 128 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  maxInFlightBytes: 8 * MIB,
  lowWaterBytes: 1024 * KIB,
  partitionSizeBytes: 32 * MIB,
  receiverPauseHighBytes: RECEIVER_PAUSE_HIGH_BYTES,
  receiverPauseLowBytes: RECEIVER_PAUSE_LOW_BYTES,
};

export const UNKNOWN_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  pathKind: 'unknown',
  chunkSizeBytes: 128 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  maxInFlightBytes: 8 * MIB,
  lowWaterBytes: 1024 * KIB,
  partitionSizeBytes: 16 * MIB,
  receiverPauseHighBytes: RECEIVER_PAUSE_HIGH_BYTES,
  receiverPauseLowBytes: RECEIVER_PAUSE_LOW_BYTES,
};

export function selectTransferTuningProfile(
  diagnostics?: Partial<TransferDiagnostics> | null
): TransferTuningProfile {
  switch (diagnostics?.candidatePathKind) {
    case 'host':
      return DIRECT_HOST_TRANSFER_TUNING_PROFILE;
    case 'srflx':
      return DIRECT_SRFLX_TRANSFER_TUNING_PROFILE;
    case 'relay':
      return RELAY_TRANSFER_TUNING_PROFILE;
    case 'unknown':
    default:
      return UNKNOWN_TRANSFER_TUNING_PROFILE;
  }
}

export function selectInFlightTargetBytes(
  profile: TransferTuningProfile,
  diagnostics?: Partial<TransferDiagnostics> | null
): number {
  const directPath =
    diagnostics?.candidatePathKind === 'host' ||
    diagnostics?.candidatePathKind === 'srflx';

  const bitrate = diagnostics?.availableOutgoingBitrateBps;
  const rtt = diagnostics?.rttMs;
  if (
    typeof bitrate === 'number' &&
    Number.isFinite(bitrate) &&
    bitrate > 0 &&
    typeof rtt === 'number' &&
    Number.isFinite(rtt) &&
    rtt > 0
  ) {
    const bdpBytes = (bitrate / 8) * (rtt / 1000);
    const target = directPath ? bdpBytes * 4 : bdpBytes * 2;
    return Math.max(
      profile.minInFlightBytes,
      Math.min(profile.maxInFlightBytes, Math.floor(target))
    );
  }

  return directPath ? profile.maxInFlightBytes : profile.initialInFlightBytes;
}

export function calculateSendBudget(params: {
  targetInFlightBytes: number;
  bufferedAmountBytes: number;
  paused: boolean;
}): number {
  if (params.paused) return 0;

  return Math.max(
    0,
    Math.floor(params.targetInFlightBytes) -
      Math.max(0, Math.floor(params.bufferedAmountBytes))
  );
}

export function selectPartitionSize(profile: TransferTuningProfile): number {
  return Math.max(0, Math.floor(profile.partitionSizeBytes));
}
export const DEFAULT_FLOW_CONTROL_PROFILE: FlowControlProfile = {
  // Conservative hotfix profile: one small chunk per pump. This sacrifices
  // throughput but avoids overfilling SCTP/DataChannel queues on real browsers.
  chunkSize: 16 * KIB,
  highWaterMark: 128 * KIB,
  lowWaterMark: 32 * KIB,
  batchSize: 1,
  prefetchBufferSize: 0,
};

export function clampDataChannelChunkSize(
  requestedBytes: number,
  maxMessageSize?: number | null
): number {
  const safeDefault = DEFAULT_FLOW_CONTROL_PROFILE.chunkSize;
  const protocolFloor = 16 * KIB;
  const reportedMax =
    typeof maxMessageSize === 'number' && maxMessageSize > 0
      ? maxMessageSize
      : safeDefault;

  return Math.max(
    protocolFloor,
    Math.min(requestedBytes, reportedMax, safeDefault)
  );
}

export function shouldRequestMoreChunks(params: {
  isProcessingBatch: boolean;
  isTransferring: boolean;
  workerReady: boolean;
  activePeerCount: number;
  highestBufferedAmount: number;
  highWaterMark: number;
  pausedPeerCount: number;
  pendingAckCount?: number;
}): boolean {
  return (
    params.isTransferring &&
    params.workerReady &&
    !params.isProcessingBatch &&
    params.activePeerCount > 0 &&
    params.pausedPeerCount === 0 &&
    (params.pendingAckCount ?? 0) === 0 &&
    params.highestBufferedAmount < params.highWaterMark
  );
}

export function calculateSafeBatchRequestSize(params: {
  desiredBatchSize: number;
  highestBufferedAmount: number;
  highWaterMark: number;
  chunkPayloadSize: number;
  packetOverheadBytes?: number;
  minBatchSize?: number;
}): number {
  const desired = Math.max(0, Math.floor(params.desiredBatchSize));
  if (desired === 0) return 0;

  const budget = params.highWaterMark - params.highestBufferedAmount;
  if (budget <= 0) return 0;

  const estimatedPacketBytes = Math.max(
    1,
    params.chunkPayloadSize + Math.max(0, params.packetOverheadBytes ?? 0)
  );
  const budgeted = Math.floor(budget / estimatedPacketBytes);

  if (budgeted <= 0) {
    const minBatchSize = Math.max(0, Math.floor(params.minBatchSize ?? 0));
    return minBatchSize > 0 &&
      params.highestBufferedAmount < params.highWaterMark
      ? Math.min(desired, minBatchSize)
      : 0;
  }

  return Math.min(desired, budgeted);
}

export function isPrematureTransferComplete(params: {
  sentBytes: number;
  expectedBytes: number;
  packetOverheadAllowance?: number;
}): boolean {
  if (params.expectedBytes <= 0) return false;
  const allowance = Math.max(0, params.packetOverheadAllowance ?? 0);
  return params.sentBytes + allowance < params.expectedBytes;
}

const PLAIN_PACKET_HEADER_SIZE = 22;
const ENCRYPTED_PACKET_HEADER_SIZE = 38;
const ENCRYPTED_AUTH_TAG_SIZE = 16;

export function getPacketPayloadSize(packet: ArrayBuffer): number {
  if (packet.byteLength < PLAIN_PACKET_HEADER_SIZE) return 0;

  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);

  if (bytes[0] === 0x02 && bytes[1] === 0x01) {
    if (
      packet.byteLength <
      ENCRYPTED_PACKET_HEADER_SIZE + ENCRYPTED_AUTH_TAG_SIZE
    ) {
      return 0;
    }

    const plaintextLength = view.getUint32(16, true);
    const expectedLength =
      ENCRYPTED_PACKET_HEADER_SIZE + plaintextLength + ENCRYPTED_AUTH_TAG_SIZE;

    return expectedLength === packet.byteLength ? plaintextLength : 0;
  }

  const payloadLength = view.getUint32(14, true);
  return PLAIN_PACKET_HEADER_SIZE + payloadLength === packet.byteLength
    ? payloadLength
    : 0;
}
