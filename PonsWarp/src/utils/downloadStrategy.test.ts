import { describe, expect, it } from 'vitest';
import {
  getPreferredDownloadStrategies,
  shouldUseBlobFallbackBeforeStreaming,
} from './downloadStrategy';

describe('downloadStrategy', () => {
  it('prefers real streaming writes over Blob accumulation in Chromium when File System Access is available', () => {
    expect(
      getPreferredDownloadStrategies({
        isFirefox: false,
        hasFileSystemAccess: true,
        fileSize: 64 * 1024 * 1024,
      }).slice(0, 2)
    ).toEqual(['file-system-access', 'streamsaver']);
  });

  it('does not put 64MB+ transfers into Blob fallback before streaming', () => {
    expect(shouldUseBlobFallbackBeforeStreaming(5 * 1024 * 1024)).toBe(true);
    expect(shouldUseBlobFallbackBeforeStreaming(64 * 1024 * 1024)).toBe(false);
  });

  it('keeps Firefox away from StreamSaver until safer fallbacks have failed', () => {
    expect(
      getPreferredDownloadStrategies({
        isFirefox: true,
        hasFileSystemAccess: false,
        fileSize: 64 * 1024 * 1024,
      })
    ).toEqual(['opfs-fallback', 'streamsaver']);
  });
});
