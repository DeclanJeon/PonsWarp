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

/** Force Blob/OPFS path for automated QA (URL ?automation=1 or ?dl=blob). */
export function isAutomationDownloadMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const flag = (params.get('automation') || params.get('dl') || '').toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'blob' || flag === 'opfs';
  } catch {
    return false;
  }
}

export function getPreferredDownloadStrategies(
  capability: DownloadCapability
): DownloadStrategy[] {
  const strategies: DownloadStrategy[] = [];

  // 🚀 Headless/자동화: Blob/OPFS 우선 (StreamSaver/FSA 대화상자 회피)
  if (isHeadlessBrowser() || isAutomationDownloadMode()) {
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
