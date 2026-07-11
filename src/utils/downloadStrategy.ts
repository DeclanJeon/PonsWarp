export type DownloadCapability = {
  isFirefox: boolean;
  hasFileSystemAccess: boolean;
  fileSize: number;
};

export type DownloadStrategy =
  | 'file-system-access'
  | 'streamsaver'
  | 'blob-fallback'
  | 'opfs-fallback';

const SMALL_BLOB_LIMIT = 50 * 1024 * 1024;

export function shouldUseBlobFallbackBeforeStreaming(fileSize: number): boolean {
  return fileSize > 0 && fileSize <= SMALL_BLOB_LIMIT;
}

export function getPreferredDownloadStrategies(
  capability: DownloadCapability
): DownloadStrategy[] {
  const strategies: DownloadStrategy[] = [];

  if (capability.isFirefox) {
    if (capability.hasFileSystemAccess) strategies.push('file-system-access');
    if (shouldUseBlobFallbackBeforeStreaming(capability.fileSize)) {
      strategies.push('blob-fallback');
    }
    strategies.push('opfs-fallback', 'streamsaver');
    return strategies;
  }

  if (capability.hasFileSystemAccess) strategies.push('file-system-access');
  strategies.push('streamsaver');
  if (shouldUseBlobFallbackBeforeStreaming(capability.fileSize)) {
    strategies.push('blob-fallback');
  }
  strategies.push('opfs-fallback');
  return strategies;
}
