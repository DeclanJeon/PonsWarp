export const estimateRemainingSeconds = (
  bytesTransferred: number,
  totalBytes: number,
  bytesPerSecond: number
): number | null => {
  if (totalBytes <= 0 || bytesPerSecond <= 0) return null;
  const remainingBytes = Math.max(0, totalBytes - bytesTransferred);
  if (remainingBytes === 0) return 0;
  return Math.ceil(remainingBytes / bytesPerSecond);
};

export const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return 'Calculating';
  if (seconds <= 0) return 'Finishing';
  if (seconds < 60) return '<1 min';

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
};

export const formatRemainingTime = (seconds: number | null): string => {
  if (seconds === null) return 'Calculating ETA';
  if (seconds <= 0) return 'Finishing now';
  if (seconds < 60) return 'Less than 1 min remaining';

  return `${formatDuration(seconds)} remaining`;
};

export type RollingSpeedSample = {
  bytesTransferred: number;
  timestampMs: number;
  bytesPerSecond: number;
};

export const updateRollingSpeedSample = (
  previousSample: RollingSpeedSample | null,
  bytesTransferred: number,
  timestampMs: number,
  smoothing = 0.35
): RollingSpeedSample => {
  const nextBytesTransferred = Math.max(0, bytesTransferred);

  if (!previousSample) {
    return {
      bytesTransferred: nextBytesTransferred,
      timestampMs,
      bytesPerSecond: 0,
    };
  }

  const elapsedMs = timestampMs - previousSample.timestampMs;
  const bytesDelta = nextBytesTransferred - previousSample.bytesTransferred;

  if (elapsedMs <= 0 || bytesDelta < 0) {
    return {
      bytesTransferred: nextBytesTransferred,
      timestampMs,
      bytesPerSecond: previousSample.bytesPerSecond,
    };
  }

  const instantBytesPerSecond = (bytesDelta / elapsedMs) * 1000;
  const clampedSmoothing = Math.min(1, Math.max(0, smoothing));
  const bytesPerSecond =
    previousSample.bytesPerSecond > 0
      ? previousSample.bytesPerSecond * (1 - clampedSmoothing) +
        instantBytesPerSecond * clampedSmoothing
      : instantBytesPerSecond;

  return {
    bytesTransferred: nextBytesTransferred,
    timestampMs,
    bytesPerSecond,
  };
};

export const getTransferFeedbackLabel = (
  bytesTransferred: number,
  totalBytes: number,
  bytesPerSecond: number
): string => {
  if (totalBytes > 0 && bytesTransferred >= totalBytes) return 'Finalizing';
  if (bytesTransferred <= 0) return 'Starting transfer';
  if (bytesPerSecond <= 0) return 'Paused, waiting for data';

  return formatRemainingTime(
    estimateRemainingSeconds(bytesTransferred, totalBytes, bytesPerSecond)
  );
};
