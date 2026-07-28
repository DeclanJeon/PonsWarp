import { describe, expect, it } from 'vitest';
import {
  MAX_RESUME_ATTEMPTS,
  WRITE_BUFFER_HIGH_MARK,
  WRITE_BUFFER_LOW_MARK,
  canRequestWriterResume,
  resolveWriterBackpressureAction,
} from './writerFlowControl';

describe('writerFlowControl', () => {
  it('pauses at high mark and resumes at low mark', () => {
    expect(
      resolveWriterBackpressureAction({
        isPaused: false,
        pendingBytesInBuffer: WRITE_BUFFER_HIGH_MARK,
      })
    ).toBe('PAUSE');
    expect(
      resolveWriterBackpressureAction({
        isPaused: false,
        pendingBytesInBuffer: WRITE_BUFFER_HIGH_MARK - 1,
      })
    ).toBe(null);
    expect(
      resolveWriterBackpressureAction({
        isPaused: true,
        pendingBytesInBuffer: WRITE_BUFFER_LOW_MARK,
      })
    ).toBe('RESUME');
    expect(
      resolveWriterBackpressureAction({
        isPaused: true,
        pendingBytesInBuffer: WRITE_BUFFER_LOW_MARK + 1,
      })
    ).toBe(null);
  });

  it('gates resume attempts by callback, manifest, and budget', () => {
    expect(
      canRequestWriterResume({
        hasResumeCallback: true,
        hasManifest: true,
        fileCount: 1,
        resumeAttempts: 0,
      })
    ).toBe(true);
    expect(
      canRequestWriterResume({
        hasResumeCallback: true,
        hasManifest: true,
        fileCount: 1,
        resumeAttempts: MAX_RESUME_ATTEMPTS,
      })
    ).toBe(false);
    expect(
      canRequestWriterResume({
        hasResumeCallback: false,
        hasManifest: true,
        fileCount: 1,
        resumeAttempts: 0,
      })
    ).toBe(false);
    expect(
      canRequestWriterResume({
        hasResumeCallback: true,
        hasManifest: true,
        fileCount: 0,
        resumeAttempts: 0,
      })
    ).toBe(false);
  });
});
