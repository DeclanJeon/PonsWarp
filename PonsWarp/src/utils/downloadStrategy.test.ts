import { describe, expect, it } from 'vitest';
import {
  getPreferredDownloadStrategies,
  shouldUseBlobFallbackBeforeStreaming,
} from './downloadStrategy';

describe('downloadStrategy', () => {
  it('prefers memory Blob for medium files even when File System Access exists', () => {
    expect(
      getPreferredDownloadStrategies({
        isFirefox: false,
        hasFileSystemAccess: true,
        fileSize: 20 * 1024 * 1024,
      })[0]
    ).toBe('blob-fallback');
  });

  it('prefers real streaming writes for large files when File System Access is available', () => {
    expect(
      getPreferredDownloadStrategies({
        isFirefox: false,
        hasFileSystemAccess: true,
        fileSize: 128 * 1024 * 1024,
      }).slice(0, 2)
    ).toEqual(['file-system-access', 'streamsaver']);
  });

  it('uses memory Blob path up to 64MB inclusive', () => {
    expect(shouldUseBlobFallbackBeforeStreaming(5 * 1024 * 1024)).toBe(true);
    expect(shouldUseBlobFallbackBeforeStreaming(64 * 1024 * 1024)).toBe(true);
    expect(shouldUseBlobFallbackBeforeStreaming(64 * 1024 * 1024 + 1)).toBe(
      false
    );
  });

  it('keeps Firefox away from StreamSaver until safer fallbacks have failed', () => {
    expect(
      getPreferredDownloadStrategies({
        isFirefox: true,
        hasFileSystemAccess: false,
        fileSize: 64 * 1024 * 1024,
      })
    ).toEqual(['blob-fallback', 'opfs-fallback', 'streamsaver']);
  });
});
