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
