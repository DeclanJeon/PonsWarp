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

/** Default UI smoothing: slower reaction reduces "speed bounce". */
export const DEFAULT_SPEED_SMOOTHING = 0.18;
/** Ignore micro-bursts shorter than this when sampling. */
export const MIN_SPEED_SAMPLE_MS = 250;
/** Rolling window used by TransferSpeedMeter (recent throughput). */
export const SPEED_WINDOW_MS = 2500;

/**
 * EMA over successive progress samples.
 * Prefer TransferSpeedMeter for continuous transfers — it also windows the
 * recent byte rate so bufferedAmount pauses do not collapse the display.
 */
export const updateRollingSpeedSample = (
  previousSample: RollingSpeedSample | null,
  bytesTransferred: number,
  timestampMs: number,
  smoothing = DEFAULT_SPEED_SMOOTHING
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

  // Non-forward / tiny intervals: keep last smoothed value (no flicker).
  if (elapsedMs < MIN_SPEED_SAMPLE_MS || bytesDelta < 0) {
    return {
      bytesTransferred:
        bytesDelta < 0
          ? previousSample.bytesTransferred
          : nextBytesTransferred,
      timestampMs:
        elapsedMs < 0 ? previousSample.timestampMs : timestampMs,
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

type SpeedPoint = { t: number; bytes: number };

/**
 * Display-oriented throughput meter for live transfers.
 * Uses a short rolling window + EMA so UI speed does not bounce with every
 * SCTP fill/drain or multipart part completion.
 */
export class TransferSpeedMeter {
  private points: SpeedPoint[] = [];
  private smoothedBps = 0;
  private lastSampleAt = 0;
  private windowMs: number;
  private smoothing: number;
  private minSampleMs: number;

  constructor(options?: {
    windowMs?: number;
    smoothing?: number;
    minSampleMs?: number;
  }) {
    this.windowMs = options?.windowMs ?? SPEED_WINDOW_MS;
    this.smoothing = options?.smoothing ?? DEFAULT_SPEED_SMOOTHING;
    this.minSampleMs = options?.minSampleMs ?? MIN_SPEED_SAMPLE_MS;
  }

  reset(bytesTransferred = 0, timestampMs = nowMs()): void {
    const bytes = Math.max(0, bytesTransferred);
    this.points = [{ t: timestampMs, bytes }];
    this.smoothedBps = 0;
    this.lastSampleAt = timestampMs;
  }

  /** Current smoothed bytes/sec (does not mutate). */
  get bytesPerSecond(): number {
    return this.smoothedBps;
  }

  /**
   * Feed cumulative transferred bytes. Returns smoothed B/s for UI.
   */
  update(bytesTransferred: number, timestampMs = nowMs()): number {
    const bytes = Math.max(0, bytesTransferred);

    if (this.points.length === 0) {
      this.reset(bytes, timestampMs);
      return 0;
    }

    const last = this.points[this.points.length - 1];

    // Monotonic guard: progress regressions (multipart retry) keep last speed.
    if (bytes < last.bytes) {
      return this.smoothedBps;
    }

    // Throttle sample cadence so 16-chunk bursts do not dominate the window.
    if (
      timestampMs - this.lastSampleAt < this.minSampleMs &&
      bytes === last.bytes
    ) {
      return this.smoothedBps;
    }

    if (timestampMs - this.lastSampleAt >= this.minSampleMs || bytes > last.bytes) {
      this.points.push({ t: timestampMs, bytes });
      this.lastSampleAt = timestampMs;
    } else {
      return this.smoothedBps;
    }

    const cutoff = timestampMs - this.windowMs;
    while (this.points.length > 2 && this.points[0].t < cutoff) {
      this.points.shift();
    }

    const oldest = this.points[0];
    const newest = this.points[this.points.length - 1];
    const elapsedMs = newest.t - oldest.t;
    if (elapsedMs < this.minSampleMs) {
      return this.smoothedBps;
    }

    const windowBps = ((newest.bytes - oldest.bytes) / elapsedMs) * 1000;
    if (!Number.isFinite(windowBps) || windowBps < 0) {
      return this.smoothedBps;
    }

    const alpha = this.smoothing;
    this.smoothedBps =
      this.smoothedBps > 0
        ? this.smoothedBps * (1 - alpha) + windowBps * alpha
        : windowBps;

    return this.smoothedBps;
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

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
