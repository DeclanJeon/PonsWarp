export function estimateRemainingSeconds(
  bytesTransferred: number,
  totalBytes: number,
  speedBps: number,
): number | null {
  if (!Number.isFinite(speedBps) || speedBps < 1024) return null;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const remaining = totalBytes - bytesTransferred;
  if (remaining <= 0) return 0;
  return remaining / speedBps;
}

export function formatRemainingTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "Calculating ETA...";
  if (seconds < 1) return "Almost done";
  if (seconds < 60) return `~${Math.ceil(seconds)}s left`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `~${mins}m ${secs}s left`;
  const hours = Math.floor(mins / 60);
  return `~${hours}h ${mins % 60}m left`;
}

export function getTransferFeedbackLabel(
  bytesTransferred: number,
  totalBytes: number,
  speedBps: number,
): string {
  if (bytesTransferred <= 0) return "Warming up warp tunnel...";
  if (speedBps <= 0) return "Measuring link speed...";
  const eta = estimateRemainingSeconds(bytesTransferred, totalBytes, speedBps);
  return formatRemainingTime(eta);
}
