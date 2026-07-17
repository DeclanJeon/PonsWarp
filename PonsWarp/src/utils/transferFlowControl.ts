export interface FlowControlProfile {
  chunkSize: number;
  highWaterMark: number;
  lowWaterMark: number;
  batchSize: number;
  prefetchBufferSize: number;
}

export type CandidatePathKind = 'host' | 'srflx' | 'relay' | 'unknown';

/** The complete route identity used by the LAN scheduler. */
export interface CandidateEligibilityTuple {
  selectedPairId: string | null;
  localCandidateId: string | null;
  remoteCandidateId: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  localProtocol: string | null;
  remoteProtocol: string | null;
  selectedOrNominatedSucceeded: boolean;
  sampledAtMs: number;
}

export function normalizeCandidateProtocol(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() || null : null;
}

export function isStableHostUdpTuple(
  tuple: CandidateEligibilityTuple | null | undefined
): boolean {
  return (
    !!tuple &&
    tuple.selectedOrNominatedSucceeded === true &&
    tuple.localCandidateType === 'host' &&
    tuple.remoteCandidateType === 'host' &&
    normalizeCandidateProtocol(tuple.localProtocol) === 'udp' &&
    normalizeCandidateProtocol(tuple.remoteProtocol) === 'udp' &&
    typeof tuple.selectedPairId === 'string' &&
    tuple.selectedPairId.length > 0 &&
    typeof tuple.localCandidateId === 'string' &&
    tuple.localCandidateId.length > 0 &&
    typeof tuple.remoteCandidateId === 'string' &&
    tuple.remoteCandidateId.length > 0
  );
}

export function candidateTuplesEqual(
  a: CandidateEligibilityTuple | null | undefined,
  b: CandidateEligibilityTuple | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    a.selectedPairId === b.selectedPairId &&
    a.localCandidateId === b.localCandidateId &&
    a.remoteCandidateId === b.remoteCandidateId &&
    a.localCandidateType === b.localCandidateType &&
    a.remoteCandidateType === b.remoteCandidateType &&
    normalizeCandidateProtocol(a.localProtocol) ===
      normalizeCandidateProtocol(b.localProtocol) &&
    normalizeCandidateProtocol(a.remoteProtocol) ===
      normalizeCandidateProtocol(b.remoteProtocol) &&
    a.selectedOrNominatedSucceeded === b.selectedOrNominatedSucceeded
  );
}

export const PREPARATION_LEDGER_BYTES = 1_376_450;
export const PEER_ADMISSION_BYTES = 4 * 1024 * 1024;
export const MAX_UNSETTLED_RESERVATIONS = 2;

export interface TransferReservation {
  readonly cursor: number;
  readonly bytes: number;
  readonly nonce: number;
}
export class HostTransferScheduler {
  private cursor: number;
  private nonce: number;
  private reservations = new Map<number, TransferReservation>();
  private enabled = false;
  constructor(
    private readonly totalBytes: number,
    startCursor = 0,
    nextNonce = 0
  ) {
    this.cursor = Math.max(0, Math.min(totalBytes, Math.floor(startCursor)));
    this.nonce = Math.max(0, Math.floor(nextNonce));
  }
  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.enabled = false;
    this.reservations.clear();
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  getCursor(): number {
    return this.cursor;
  }
  getUnsettledCount(): number {
    return this.reservations.size;
  }
  getUnsettledBytes(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) total += reservation.bytes;
    return total;
  }
  getPreparationLedgerTelemetry(): {
    unsettledBytes: number;
    limitBytes: number;
    remainingBytes: number;
  } {
    const unsettledBytes = this.getUnsettledBytes();
    return {
      unsettledBytes,
      limitBytes: PREPARATION_LEDGER_BYTES,
      remainingBytes: Math.max(0, PREPARATION_LEDGER_BYTES - unsettledBytes),
    };
  }
  reserve(maxBytes: number): TransferReservation | null {
    if (
      !this.enabled ||
      this.reservations.size >= MAX_UNSETTLED_RESERVATIONS ||
      this.cursor >= this.totalBytes ||
      this.getUnsettledBytes() >= PREPARATION_LEDGER_BYTES
    )
      return null;
    const bytes = Math.min(
      Math.max(0, Math.floor(maxBytes)),
      PEER_ADMISSION_BYTES,
      this.totalBytes - this.cursor
    );
    if (bytes === 0 || this.getUnsettledBytes() + bytes > PREPARATION_LEDGER_BYTES)
      return null;
    const reservation = { cursor: this.cursor, bytes, nonce: this.nonce++ };
    this.cursor += bytes;
    this.reservations.set(reservation.cursor, reservation);
    return reservation;
  }
  settle(reservation: TransferReservation): boolean {
    return this.reservations.delete(reservation.cursor);
  }
  /** Failed attempts burn their nonce; only the newest reservation may roll back the cursor. */
  abandon(reservation: TransferReservation): boolean {
    if (!this.reservations.has(reservation.cursor)) return false;
    if (reservation.cursor + reservation.bytes !== this.cursor) return false;
    this.reservations.delete(reservation.cursor);
    this.cursor = reservation.cursor;
    return true;
  }
}

export interface TransferDiagnostics {
  candidatePathKind: CandidatePathKind;
  protocol?: string | null;
  relayProtocol?: string | null;
  rttMs?: number | null;
  availableOutgoingBitrateBps?: number | null;
  bufferedAmountBytes?: number | null;
  candidateTuple?: CandidateEligibilityTuple | null;
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
  chunkSizeBytes: 240 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  // Chromium send-queue sweet spot measured ~4MB; keep headroom to 12MB.
  maxInFlightBytes: 12 * MIB,
  lowWaterBytes: 1 * MIB,
  // Host: no mid-transfer partition barrier (reliable SCTP + end checkpoint)
  partitionSizeBytes: Number.MAX_SAFE_INTEGER,
  receiverPauseHighBytes: RECEIVER_PAUSE_HIGH_BYTES,
  receiverPauseLowBytes: RECEIVER_PAUSE_LOW_BYTES,
};
export const DIRECT_SRFLX_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  ...DIRECT_HOST_TRANSFER_TUNING_PROFILE,
  pathKind: 'srflx',
};
export const RELAY_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  ...DIRECT_HOST_TRANSFER_TUNING_PROFILE,
  pathKind: 'relay',
  // Mobile same-Wi-Fi often lands on TURN relay (phone AP isolation / CGNAT).
  // 16MB partition ACK stop-and-wait + 4MB max window caps real Wi-Fi far below radio.
  chunkSizeBytes: 192 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  maxInFlightBytes: 8 * MIB,
  lowWaterBytes: 1 * MIB,
  // End/resume checkpoint only — mid-transfer app ACK is the mobile Wi-Fi killer.
  partitionSizeBytes: Number.MAX_SAFE_INTEGER,
};
export const UNKNOWN_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  ...DIRECT_HOST_TRANSFER_TUNING_PROFILE,
  pathKind: 'unknown',
  chunkSizeBytes: 240 * KIB,
  partitionSizeBytes: Number.MAX_SAFE_INTEGER,
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
    default:
      return UNKNOWN_TRANSFER_TUNING_PROFILE;
  }
}
export function selectInFlightTargetBytes(
  profile: TransferTuningProfile,
  diagnostics?: Partial<TransferDiagnostics> | null
): number {
  const direct =
    diagnostics?.candidatePathKind === 'host' ||
    diagnostics?.candidatePathKind === 'srflx';
  const b = diagnostics?.availableOutgoingBitrateBps,
    r = diagnostics?.rttMs;
  if (
    typeof b === 'number' &&
    Number.isFinite(b) &&
    b > 0 &&
    typeof r === 'number' &&
    Number.isFinite(r) &&
    r > 0
  ) {
    // Use a generous BDP multiple. Chrome's availableOutgoingBitrate is often
    // pessimistic on LAN and would otherwise starve the send pipeline.
    const bdp = Math.floor((b / 8) * Math.max(r, 10) / 1000 * (direct ? 16 : 4));
    return Math.max(
      profile.minInFlightBytes,
      Math.min(profile.maxInFlightBytes, Math.max(bdp, profile.initialInFlightBytes))
    );
  }
  // Without bitrate samples, prefer max window so mobile Wi-Fi/TURN is not
  // stuck at the conservative initial value for the whole transfer.
  return profile.maxInFlightBytes;
}
export function calculateSendBudget(p: {
  targetInFlightBytes: number;
  bufferedAmountBytes: number;
  paused: boolean;
}): number {
  return p.paused
    ? 0
    : Math.max(
        0,
        Math.floor(p.targetInFlightBytes) -
          Math.max(0, Math.floor(p.bufferedAmountBytes))
      );
}
export function selectPartitionSize(profile: TransferTuningProfile): number {
  return Math.max(0, Math.floor(profile.partitionSizeBytes));
}
export const DEFAULT_FLOW_CONTROL_PROFILE: FlowControlProfile = {
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
  return Math.max(
    16 * KIB,
    Math.min(
      requestedBytes,
      maxMessageSize && maxMessageSize > 0
        ? maxMessageSize
        : DEFAULT_FLOW_CONTROL_PROFILE.chunkSize,
      DEFAULT_FLOW_CONTROL_PROFILE.chunkSize
    )
  );
}
export function shouldRequestMoreChunks(p: {
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
    p.isTransferring &&
    p.workerReady &&
    !p.isProcessingBatch &&
    p.activePeerCount > 0 &&
    p.pausedPeerCount === 0 &&
    (p.pendingAckCount ?? 0) === 0 &&
    p.highestBufferedAmount < p.highWaterMark
  );
}
export function calculateSafeBatchRequestSize(p: {
  desiredBatchSize: number;
  highestBufferedAmount: number;
  highWaterMark: number;
  chunkPayloadSize: number;
  packetOverheadBytes?: number;
  minBatchSize?: number;
}): number {
  const d = Math.max(0, Math.floor(p.desiredBatchSize));
  if (!d) return 0;
  const b = p.highWaterMark - p.highestBufferedAmount;
  if (b <= 0) return 0;
  const n = Math.max(
    1,
    p.chunkPayloadSize + Math.max(0, p.packetOverheadBytes ?? 0)
  );
  const q = Math.floor(b / n);
  const m = Math.max(0, Math.floor(p.minBatchSize ?? 0));
  return q > 0
    ? Math.min(d, q)
    : m > 0 && p.highestBufferedAmount < p.highWaterMark
      ? Math.min(d, m)
      : 0;
}
export function isPrematureTransferComplete(p: {
  sentBytes: number;
  expectedBytes: number;
  packetOverheadAllowance?: number;
}): boolean {
  return (
    p.expectedBytes > 0 &&
    p.sentBytes + Math.max(0, p.packetOverheadAllowance ?? 0) < p.expectedBytes
  );
}
const PLAIN_PACKET_HEADER_SIZE = 22,
  ENCRYPTED_PACKET_HEADER_SIZE = 38,
  ENCRYPTED_AUTH_TAG_SIZE = 16;
export function getPacketPayloadSize(packet: ArrayBuffer): number {
  if (packet.byteLength < PLAIN_PACKET_HEADER_SIZE) return 0;
  const v = new DataView(packet),
    b = new Uint8Array(packet);
  if (b[0] === 2 && b[1] === 1) {
    if (
      packet.byteLength <
      ENCRYPTED_PACKET_HEADER_SIZE + ENCRYPTED_AUTH_TAG_SIZE
    )
      return 0;
    const n = v.getUint32(16, true);
    return ENCRYPTED_PACKET_HEADER_SIZE + n + ENCRYPTED_AUTH_TAG_SIZE ===
      packet.byteLength
      ? n
      : 0;
  }
  const n = v.getUint32(14, true);
  return PLAIN_PACKET_HEADER_SIZE + n === packet.byteLength ? n : 0;
}
export function hasStableHostRoute(
  samples: CandidateEligibilityTuple[]
): boolean {
  if (samples.length < 2) return false;
  const first = samples[samples.length - 2];
  const second = samples[samples.length - 1];
  return (
    second.sampledAtMs - first.sampledAtMs >= 500 &&
    isStableHostUdpTuple(first) &&
    isStableHostUdpTuple(second) &&
    candidateTuplesEqual(first, second)
  );
}

export function canAdmitPeer(
  queuedBytes: number,
  additionalBytes = PEER_ADMISSION_BYTES
): boolean {
  return (
    Number.isFinite(queuedBytes) &&
    queuedBytes >= 0 &&
    queuedBytes + additionalBytes <= PEER_ADMISSION_BYTES
  );
}
