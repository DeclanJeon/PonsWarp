export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function calculateProgressPercent(
  bytesTransferred: number,
  totalBytes: number
): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const safeBytes = Number.isFinite(bytesTransferred)
    ? Math.max(0, bytesTransferred)
    : 0;
  return clampPercent((safeBytes / totalBytes) * 100);
}

export function calculateReceiverBufferedProgress(input: {
  bytesWritten: number;
  pendingBytes: number;
  totalBytes: number;
}): { bytesTransferred: number; progress: number } {
  const bytesTransferred = Math.max(
    0,
    (Number.isFinite(input.bytesWritten) ? input.bytesWritten : 0) +
      (Number.isFinite(input.pendingBytes) ? input.pendingBytes : 0)
  );

  return {
    bytesTransferred,
    progress: calculateProgressPercent(bytesTransferred, input.totalBytes),
  };
}
