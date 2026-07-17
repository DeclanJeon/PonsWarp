import { FileNode, TransferManifest } from '../types/types';
import { ScannedFile } from './fileScanner';

const MANIFEST_YIELD_EVERY = 512;

async function yieldToMain(): Promise<void> {
  await new Promise<void>(resolve => {
    const scheduler = (
      globalThis as { scheduler?: { yield?: () => Promise<void> } }
    ).scheduler;
    if (typeof scheduler?.yield === 'function') {
      void scheduler.yield().then(
        () => resolve(),
        () => resolve()
      );
      return;
    }
    if (typeof MessageChannel !== 'undefined') {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
      return;
    }
    setTimeout(resolve, 0);
  });
}

function resolveRootMeta(scannedFiles: ScannedFile[]): {
  rootName: string;
  isFolder: boolean;
} {
  if (scannedFiles.length === 0) {
    return { rootName: 'Transfer', isFolder: false };
  }

  const firstPath = scannedFiles[0].path;
  if (firstPath.includes('/')) {
    return { rootName: firstPath.split('/')[0] || 'Transfer', isFolder: true };
  }
  if (scannedFiles.length > 1) {
    return {
      rootName: `Files (${scannedFiles.length})`,
      isFolder: true,
    };
  }
  return {
    rootName: scannedFiles[0].file.name,
    isFolder: false,
  };
}

/**
 * Sync manifest build — fine for small selections / unit helpers.
 * Large mobile multi-select should use `createManifestProgressive`.
 */
export const createManifest = (
  scannedFiles: ScannedFile[]
): { manifest: TransferManifest; files: File[] } => {
  const count = scannedFiles.length;
  const fileNodes: FileNode[] = new Array(count);
  const rawFiles: File[] = new Array(count);
  let totalSize = 0;

  for (let index = 0; index < count; index++) {
    const item = scannedFiles[index];
    totalSize += item.file.size;
    rawFiles[index] = item.file;
    fileNodes[index] = {
      id: index,
      name: item.file.name,
      path: item.path,
      size: item.file.size,
      type: item.file.type || 'application/octet-stream',
      lastModified: item.file.lastModified,
    };
  }

  const { rootName, isFolder } = resolveRootMeta(scannedFiles);

  const manifest: TransferManifest = {
    transferId: `warp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    totalSize,
    totalFiles: count,
    rootName,
    files: fileNodes,
    isFolder,
    // ZIP / multi-file: receiver may treat size as estimated for StreamSaver.
    isSizeEstimated: isFolder || count > 1,
  };

  return { manifest, files: rawFiles };
};

/**
 * Progressive manifest build for large mobile selections.
 * Yields to the main thread so the SCANNING UI stays alive while building
 * thousands of FileNode entries.
 */
export const createManifestProgressive = async (
  scannedFiles: ScannedFile[],
  options: {
    yieldEvery?: number;
    signal?: AbortSignal;
    onProgress?: (built: number, total: number) => void;
  } = {}
): Promise<{ manifest: TransferManifest; files: File[] }> => {
  const count = scannedFiles.length;
  if (count === 0) {
    return createManifest(scannedFiles);
  }
  // Small lists: avoid async tax.
  if (count <= MANIFEST_YIELD_EVERY) {
    return createManifest(scannedFiles);
  }

  const yieldEvery = Math.max(64, options.yieldEvery ?? MANIFEST_YIELD_EVERY);
  const fileNodes: FileNode[] = new Array(count);
  const rawFiles: File[] = new Array(count);
  let totalSize = 0;

  for (let index = 0; index < count; index++) {
    if (options.signal?.aborted) {
      throw new DOMException('Manifest build aborted', 'AbortError');
    }
    const item = scannedFiles[index];
    totalSize += item.file.size;
    rawFiles[index] = item.file;
    fileNodes[index] = {
      id: index,
      name: item.file.name,
      path: item.path,
      size: item.file.size,
      type: item.file.type || 'application/octet-stream',
      lastModified: item.file.lastModified,
    };

    const built = index + 1;
    if (built % yieldEvery === 0 || built === count) {
      options.onProgress?.(built, count);
      if (built < count) {
        await yieldToMain();
      }
    }
  }

  const { rootName, isFolder } = resolveRootMeta(scannedFiles);
  const manifest: TransferManifest = {
    transferId: `warp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    totalSize,
    totalFiles: count,
    rootName,
    files: fileNodes,
    isFolder,
    isSizeEstimated: isFolder || count > 1,
  };

  return { manifest, files: rawFiles };
};

export const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};
