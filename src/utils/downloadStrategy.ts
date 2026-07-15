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

export function isHeadlessBrowser(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator.webdriver === true ||
     /HeadlessChrome/.test(navigator.userAgent))
  );
}

export function getPreferredDownloadStrategies(
  capability: DownloadCapability
): DownloadStrategy[] {
  const strategies: DownloadStrategy[] = [];

  // 🚀 Headless 브라우저: Blob/OPFS 우선 (StreamSaver는 headless에서 작동 안 함)
  if (isHeadlessBrowser()) {
    if (shouldUseBlobFallbackBeforeStreaming(capability.fileSize)) {
      strategies.push('blob-fallback');
    }
    strategies.push('opfs-fallback');
    if (capability.hasFileSystemAccess) strategies.push('file-system-access');
    strategies.push('streamsaver');
    return strategies;
  }

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
