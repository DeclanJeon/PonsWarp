export interface ScannedFile {
  file: File;
  path: string; // full relative path (e.g. "folder/subfolder/image.png")
}

export type FileScanProgress = {
  scannedFiles: number;
  totalHint?: number;
  phase: 'listing' | 'done';
};

export type FileScanOptions = {
  /** Files processed before yielding to the main thread. */
  chunkSize?: number;
  /** Max concurrent entry.file() / directory reads during drag-drop scan. */
  concurrency?: number;
  onProgress?: (progress: FileScanProgress) => void;
  signal?: AbortSignal;
};

/** Snapshot-friendly list: FileList is live and can be wiped by input.value = ''. */
export type FileListLike = ArrayLike<File> & { length: number };

const DEFAULT_CHUNK_SIZE = 64;
const DEFAULT_CONCURRENCY = 12;

const SKIP_NAME_EXACT = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.localized',
]);

const SKIP_PATH_SEGMENTS = [
  '/node_modules/',
  '/.git/',
  '/__macosx/',
  '/.svn/',
  '/.hg/',
];

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('File scan aborted', 'AbortError');
  }
}

async function yieldToMain(): Promise<void> {
  await new Promise<void>(resolve => {
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === 'function') {
      void scheduler.yield().then(() => resolve(), () => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * Skip junk/system files early so mobile bulk folders stay smaller.
 * Hidden files (name starts with ".") are excluded except common non-dot junk names.
 */
export function shouldSkipScannedPath(name: string, relativePath: string): boolean {
  const base = name.trim();
  if (!base) return true;
  const lowerName = base.toLowerCase();
  if (SKIP_NAME_EXACT.has(lowerName)) return true;
  if (base.startsWith('.')) return true;

  const normalized = `/${relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()}/`;
  return SKIP_PATH_SEGMENTS.some(segment => normalized.includes(segment));
}

function reportProgress(
  onProgress: FileScanOptions['onProgress'],
  progress: FileScanProgress
): void {
  onProgress?.(progress);
}

/**
 * FileSystemEntry recursive scan for drag-and-drop folder structure.
 * Uses bounded concurrency and main-thread yields for large trees.
 */
export const scanFiles = async (
  items: DataTransferItemList,
  options: FileScanOptions = {}
): Promise<ScannedFile[]> => {
  const scannedFiles: ScannedFile[] = [];
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  let inFlight = 0;
  const waitQueue: Array<() => void> = [];

  const acquire = async () => {
    if (inFlight < concurrency) {
      inFlight += 1;
      return;
    }
    await new Promise<void>(resolve => waitQueue.push(resolve));
    inFlight += 1;
  };

  const release = () => {
    inFlight = Math.max(0, inFlight - 1);
    const next = waitQueue.shift();
    if (next) next();
  };

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
  }

  const scanEntry = async (entry: FileSystemEntry, basePath: string): Promise<void> => {
    throwIfAborted(options.signal);

    if (entry.isFile) {
      await acquire();
      try {
        throwIfAborted(options.signal);
        await new Promise<void>(resolve => {
          (entry as FileSystemFileEntry).file(
            file => {
              const fullPath = basePath ? `${basePath}${entry.name}` : entry.name;
              if (!shouldSkipScannedPath(file.name, fullPath)) {
                scannedFiles.push({ file, path: fullPath });
                if (scannedFiles.length % DEFAULT_CHUNK_SIZE === 0) {
                  reportProgress(options.onProgress, {
                    scannedFiles: scannedFiles.length,
                    phase: 'listing',
                  });
                }
              }
              resolve();
            },
            err => {
              console.warn(`Failed to read file: ${entry.name}`, err);
              resolve();
            }
          );
        });
      } finally {
        release();
      }
      return;
    }

    if (!entry.isDirectory) return;

    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const currentPath = basePath ? `${basePath}${entry.name}/` : `${entry.name}/`;

    const readEntries = async (): Promise<void> => {
      throwIfAborted(options.signal);
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        dirReader.readEntries(resolve, reject);
      });
      if (batch.length === 0) return;

      // Bounded parallel scan of this batch, then continue reading more entries.
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
        while (cursor < batch.length) {
          const index = cursor;
          cursor += 1;
          await scanEntry(batch[index], currentPath);
        }
      });
      await Promise.all(workers);
      await yieldToMain();
      await readEntries();
    };

    await readEntries();
  };

  await Promise.all(entries.map(entry => scanEntry(entry, '')));
  reportProgress(options.onProgress, {
    scannedFiles: scannedFiles.length,
    phase: 'done',
  });
  return scannedFiles;
};

/**
 * Progressive FileList processing for <input type="file" multiple />.
 * Yields to the main thread every chunk so mobile UI stays responsive.
 */
/**
 * Snapshot a live FileList before clearing <input value="">.
 * FileList is a live view; resetting the input empties it immediately.
 */
export function snapshotFileList(fileList: FileList | null | undefined): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList);
}

export const processInputFiles = async (
  fileList: FileListLike,
  options: FileScanOptions = {}
): Promise<ScannedFile[]> => {
  const files: ScannedFile[] = [];
  const chunkSize = Math.max(8, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const totalHint = fileList.length;

  for (let i = 0; i < fileList.length; i++) {
    throwIfAborted(options.signal);
    const file = fileList[i];
    const path =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;

    if (!shouldSkipScannedPath(file.name, path)) {
      files.push({ file, path });
    }

    const processed = i + 1;
    if (processed % chunkSize === 0 || processed === totalHint) {
      reportProgress(options.onProgress, {
        scannedFiles: files.length,
        totalHint,
        phase: processed === totalHint ? 'done' : 'listing',
      });
      if (processed < totalHint) {
        await yieldToMain();
      }
    }
  }

  if (totalHint === 0) {
    reportProgress(options.onProgress, {
      scannedFiles: 0,
      totalHint: 0,
      phase: 'done',
    });
  }

  return files;
};

/**
 * Synchronous helper for tiny lists / unit tests.
 * Prefer the async processInputFiles() on UI paths.
 */
export const processInputFilesSync = (fileList: FileListLike): ScannedFile[] => {
  const files: ScannedFile[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const path =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    if (!shouldSkipScannedPath(file.name, path)) {
      files.push({ file, path });
    }
  }
  return files;
};
