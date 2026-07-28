/**
 * Pure writer backpressure / resume-policy helpers extracted from DirectFileWriter.
 * Side-effect free so unit tests lock buffer thresholds without constructing the writer.
 */

/** Pause sender when pending write buffer reaches this many bytes. */
export const WRITE_BUFFER_HIGH_MARK = 48 * 1024 * 1024;
/** Resume sender when pending write buffer drains to this many bytes. */
export const WRITE_BUFFER_LOW_MARK = 16 * 1024 * 1024;
/** Mobile screen-off can stall the channel multiple times in one transfer. */
export const MAX_RESUME_ATTEMPTS = 12;

export type WriterBackpressureAction = 'PAUSE' | 'RESUME' | null;

/**
 * Decide whether the receiver should emit PAUSE/RESUME based on pending buffer bytes.
 * Mirrors DirectFileWriter.checkBackpressure thresholds exactly.
 */
export function resolveWriterBackpressureAction(params: {
  isPaused: boolean;
  pendingBytesInBuffer: number;
  highMark?: number;
  lowMark?: number;
}): WriterBackpressureAction {
  const high = params.highMark ?? WRITE_BUFFER_HIGH_MARK;
  const low = params.lowMark ?? WRITE_BUFFER_LOW_MARK;
  if (!params.isPaused && params.pendingBytesInBuffer >= high) {
    return 'PAUSE';
  }
  if (params.isPaused && params.pendingBytesInBuffer <= low) {
    return 'RESUME';
  }
  return null;
}

/**
 * Whether the writer may emit another RESUME_REQUEST to the sender.
 * Requires an active multi-file/single-file manifest and remaining attempt budget.
 */
export function canRequestWriterResume(params: {
  hasResumeCallback: boolean;
  hasManifest: boolean;
  fileCount: number;
  resumeAttempts: number;
  maxResumeAttempts?: number;
}): boolean {
  const max = params.maxResumeAttempts ?? MAX_RESUME_ATTEMPTS;
  return (
    params.hasResumeCallback &&
    params.hasManifest &&
    params.fileCount > 0 &&
    params.resumeAttempts < max
  );
}
