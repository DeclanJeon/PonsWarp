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

/** Mobile multi-select: larger chunks, fewer yields, less React thrash. */
const DEFAULT_CHUNK_SIZE = 256;
const DEFAULT_CONCURRENCY = 16;
/** Avoid re-rendering progress for every tiny batch on multi-thousand selections. */
const DEFAULT_PROGRESS_EVERY = 128;

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
    // MessageChannel yields faster than setTimeout(0) on many mobile browsers.
    if (typeof MessageChannel !== 'undefined') {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * Skip junk/system files early so mobile bulk folders stay smaller.
 * Hidden files (name starts with ".") are excluded except common non-dot junk names.
 */
export function shouldSkipScannedPath(
  name: string,
  relativePath: string
): boolean {
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
 * Copy a live FileList without one giant Array.from allocation pause.
 * Yields every `chunkSize` so multi-thousand mobile selections stay interactive.
 * Safe to clear `<input value="">` after this resolves.
 */
export async function snapshotFileListProgressive(
  fileList: FileList | null | undefined,
  options: Pick<FileScanOptions, 'chunkSize' | 'onProgress' | 'signal'> = {}
): Promise<File[]> {
  if (!fileList || fileList.length === 0) return [];
  const total = fileList.length;
  const chunkSize = Math.max(32, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const out: File[] = new Array(total);
  for (let i = 0; i < total; i++) {
    throwIfAborted(options.signal);
    out[i] = fileList[i];
    const processed = i + 1;
    if (processed % chunkSize === 0 || processed === total) {
      reportProgress(options.onProgress, {
        scannedFiles: 0,
        totalHint: total,
        phase: processed === total ? 'listing' : 'listing',
      });
      if (processed < total) {
        await yieldToMain();
      }
    }
  }
  return out;
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
  const progressEvery = Math.max(
    32,
    options.chunkSize ?? DEFAULT_PROGRESS_EVERY
  );
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

  const scanEntry = async (
    entry: FileSystemEntry,
    basePath: string
  ): Promise<void> => {
    throwIfAborted(options.signal);

    if (entry.isFile) {
      await acquire();
      try {
        throwIfAborted(options.signal);
        await new Promise<void>(resolve => {
          (entry as FileSystemFileEntry).file(
            file => {
              const fullPath = basePath
                ? `${basePath}${entry.name}`
                : entry.name;
              if (!shouldSkipScannedPath(file.name, fullPath)) {
                scannedFiles.push({ file, path: fullPath });
                if (scannedFiles.length % progressEvery === 0) {
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
    const currentPath = basePath
      ? `${basePath}${entry.name}/`
      : `${entry.name}/`;

    const readEntries = async (): Promise<void> => {
      throwIfAborted(options.signal);
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        dirReader.readEntries(resolve, reject);
      });
      if (batch.length === 0) return;

      // Bounded parallel scan of this batch, then continue reading more entries.
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(concurrency, batch.length) },
        async () => {
          while (cursor < batch.length) {
            const index = cursor;
            cursor += 1;
            await scanEntry(batch[index], currentPath);
          }
        }
      );
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
 *
 * Prefer passing the live FileList (or a progressive snapshot) and avoid an
 * extra full-array copy when the caller already owns a stable ArrayLike.
 */
/**
 * Snapshot a live FileList before clearing <input value="">.
 * FileList is a live view; resetting the input empties it immediately.
 *
 * For large mobile selections prefer `snapshotFileListProgressive` so the
 * copy itself does not freeze the tab.
 */
export function snapshotFileList(
  fileList: FileList | null | undefined
): File[] {
  if (!fileList || fileList.length === 0) return [];
  // Fast path: small selections copy in one shot.
  if (fileList.length <= DEFAULT_CHUNK_SIZE) {
    return Array.from(fileList);
  }
  // Large selections: still sync for API compatibility, but avoid Array.from
  // iterator overhead — indexed copy is cheaper on mobile Safari.
  const out = new Array<File>(fileList.length);
  for (let i = 0; i < fileList.length; i++) {
    out[i] = fileList[i];
  }
  return out;
}

export const processInputFiles = async (
  fileList: FileListLike,
  options: FileScanOptions = {}
): Promise<ScannedFile[]> => {
  const totalHint = fileList.length;
  if (totalHint === 0) {
    reportProgress(options.onProgress, {
      scannedFiles: 0,
      totalHint: 0,
      phase: 'done',
    });
    return [];
  }

  const chunkSize = Math.max(32, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const files: ScannedFile[] = [];
  let accepted = 0;
  for (let i = 0; i < totalHint; i++) {
    throwIfAborted(options.signal);
    const file = fileList[i];
    // Avoid repeated property access / string work when possible.
    const relative =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const path = relative.length > 0 ? relative : file.name;

    if (!shouldSkipScannedPath(file.name, path)) {
      files.push({ file, path });
      accepted += 1;
    }

    const processed = i + 1;
    if (processed % chunkSize === 0 || processed === totalHint) {
      reportProgress(options.onProgress, {
        scannedFiles: accepted,
        totalHint,
        phase: processed === totalHint ? 'done' : 'listing',
      });
      if (processed < totalHint) {
        await yieldToMain();
      }
    }
  }

  return files;
};

/**
 * Synchronous helper for tiny lists / unit tests.
 * Prefer the async processInputFiles() on UI paths.
 */
export const processInputFilesSync = (
  fileList: FileListLike
): ScannedFile[] => {
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
