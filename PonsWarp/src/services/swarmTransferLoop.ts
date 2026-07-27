/**
 * Pure transfer-loop helpers extracted from SwarmManager.
 * Keep side-effect free so unit tests can lock pacing/partition policy
 * without constructing the full SwarmManager graph.
 */

export type TransferPathKind = 'host' | 'srflx' | 'relay' | 'unknown' | string;

/** Bound prepared ciphertext slots from memory budget and chunk size. */
export function computePrepareAheadCount(
  chunkBytes: number,
  prepareAheadBytes: number
): number {
  const safeChunk = Math.max(16 * 1024, Math.floor(chunkBytes) || 16 * 1024);
  const budget = Math.max(0, Math.floor(prepareAheadBytes));
  return Math.max(16, Math.min(128, Math.floor(budget / safeChunk)));
}

/**
 * Scale the app-level in-flight target when multi-PC stripe lanes are armed.
 * Caps at 24 MiB to avoid unbounded SCTP buffer pressure.
 */
export function computeScaledInFlightTargetBytes(params: {
  baseInFlightBytes: number;
  stripeEnabled: boolean;
  lanStripeLanes: number;
  verifiedStripeKeyCount: number;
  maxBytes?: number;
}): number {
  const base = Math.max(0, Math.floor(params.baseInFlightBytes));
  const maxBytes = params.maxBytes ?? 24 * 1024 * 1024;
  if (!params.stripeEnabled || params.lanStripeLanes <= 1) return base;
  const lanes = Math.max(1, Math.floor(params.verifiedStripeKeyCount) || 1);
  return Math.min(base * lanes, maxBytes);
}

/** Per-burst send cap used by the main-thread prepare/send loop. */
export function computePartitionSendCap(params: {
  inFlightTargetBytes: number;
  stripeEnabled: boolean;
  lanStripeLanes: number;
  verifiedStripeKeyCount: number;
}): number {
  const target = Math.max(0, Math.floor(params.inFlightTargetBytes));
  const laneFactor =
    params.stripeEnabled && params.lanStripeLanes > 1
      ? Math.max(1, Math.floor(params.verifiedStripeKeyCount) || 1)
      : 1;
  return Math.min(target, laneFactor * target);
}

/**
 * Mid-transfer partition barrier size.
 * host/unknown/relay: barriers disabled (MAX_SAFE_INTEGER).
 */
export function resolveActivePartitionSize(params: {
  pathKind: TransferPathKind | null | undefined;
  stripeEnabled: boolean;
  lanStripeLanes: number;
  lanStripePartitionBytes: number;
  profilePartitionSize: number;
}): number {
  const path = (params.pathKind || 'unknown').toLowerCase();
  // 1:1 reliable SCTP: avoid mid-transfer partition barriers on host/unknown/relay.
  // Mobile Wi-Fi frequently selects TURN relay even on the same SSID.
  if (path === 'host' || path === 'unknown' || path === 'relay') {
    return Number.MAX_SAFE_INTEGER;
  }
  if (params.stripeEnabled && params.lanStripeLanes > 1) {
    return Math.min(
      Math.max(0, Math.floor(params.lanStripePartitionBytes)),
      Math.max(0, Math.floor(params.profilePartitionSize))
    );
  }
  return Math.max(0, Math.floor(params.profilePartitionSize));
}

/**
 * Host / unknown / relay skip mid-transfer PARTITION ACK wait.
 * Reliable SCTP owns reliability on those paths.
 */
export function shouldSkipPartitionAckBarrier(
  pathKind: TransferPathKind | null | undefined
): boolean {
  const path = (pathKind || 'unknown').toLowerCase();
  return path === 'host' || path === 'unknown' || path === 'relay';
}

/** Resume threshold for send-window polling (any free budget). */
export function hasOpenSendBudget(sendBudgetBytes: number): boolean {
  return sendBudgetBytes > 0;
}
