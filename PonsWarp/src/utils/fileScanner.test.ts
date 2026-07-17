import { describe, expect, it, vi } from 'vitest';
import {
  processInputFiles,
  processInputFilesSync,
  shouldSkipScannedPath,
  snapshotFileList,
} from './fileScanner';

function makeFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      for (const file of files) yield file;
    },
  } as FileList;
  files.forEach((file, index) => {
    Object.defineProperty(list, index, { value: file, enumerable: true });
  });
  return list;
}

describe('shouldSkipScannedPath', () => {
  it('skips common junk and hidden files', () => {
    expect(shouldSkipScannedPath('.DS_Store', '.DS_Store')).toBe(true);
    expect(shouldSkipScannedPath('Thumbs.db', 'pics/Thumbs.db')).toBe(true);
    expect(shouldSkipScannedPath('.env', 'app/.env')).toBe(true);
    expect(shouldSkipScannedPath('index.js', 'app/node_modules/pkg/index.js')).toBe(
      true
    );
    expect(shouldSkipScannedPath('photo.jpg', 'vacation/photo.jpg')).toBe(false);
  });
});

describe('processInputFiles progressive', () => {
  it('yields progress and filters junk while preserving relative paths', async () => {
    const keep = new File(['a'], 'a.txt');
    Object.defineProperty(keep, 'webkitRelativePath', {
      value: 'folder/a.txt',
    });
    const junk = new File(['x'], '.DS_Store');
    Object.defineProperty(junk, 'webkitRelativePath', {
      value: 'folder/.DS_Store',
    });
    const hidden = new File(['y'], '.gitignore');
    Object.defineProperty(hidden, 'webkitRelativePath', {
      value: 'folder/.gitignore',
    });

    const onProgress = vi.fn();
    const scanned = await processInputFiles(makeFileList([keep, junk, hidden]), {
      chunkSize: 1,
      onProgress,
    });

    expect(scanned).toEqual([{ file: keep, path: 'folder/a.txt' }]);
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      scannedFiles: 1,
      totalHint: 3,
      phase: 'done',
    });
  });

  it('sync helper matches progressive filtering', () => {
    const file = new File(['ok'], 'ok.bin');
    const junk = new File(['no'], 'desktop.ini');
    const sync = processInputFilesSync(makeFileList([file, junk]));
    expect(sync).toHaveLength(1);
    expect(sync[0].path).toBe('ok.bin');
  });
});


describe('snapshotFileList', () => {
  it('copies files so later FileList mutation does not empty the scan', async () => {
    const a = new File(['1'], 'one.txt');
    const b = new File(['22'], 'two.txt');
    const live = makeFileList([a, b]);
    const snapshot = snapshotFileList(live as unknown as FileList);

    // Simulate input.value = '' wiping the live list length.
    Object.defineProperty(live, 'length', { value: 0, configurable: true });

    const scanned = await processInputFiles(snapshot, { chunkSize: 1 });
    expect(scanned.map(x => x.path).sort()).toEqual(['one.txt', 'two.txt']);
  });
});
