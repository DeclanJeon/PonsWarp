import { describe, expect, it } from 'vitest';
import { bytesToBase64, base64ToBytes } from '../services/cryptoService';
import { createManifest, formatBytes } from './fileUtils';

describe('crypto encoding helpers', () => {
  it('round-trips binary session material through base64', () => {
    const source = new Uint8Array([0, 1, 2, 253, 254, 255]);

    expect(Array.from(base64ToBytes(bytesToBase64(source)))).toEqual(
      Array.from(source)
    );
  });
});

describe('file manifest utilities', () => {
  it('marks a single file transfer as exact-size non-folder payload', () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const { manifest, files } = createManifest([{ file, path: 'hello.txt' }]);

    expect(files).toEqual([file]);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.totalSize).toBe(5);
    expect(manifest.rootName).toBe('hello.txt');
    expect(manifest.isFolder).toBe(false);
    expect(manifest.isSizeEstimated).toBe(false);
  });

  it('marks multi-file transfers as estimated ZIP payloads', () => {
    const first = new File(['a'], 'a.txt');
    const second = new File(['bb'], 'b.txt');
    const { manifest } = createManifest([
      { file: first, path: 'folder/a.txt' },
      { file: second, path: 'folder/b.txt' },
    ]);

    expect(manifest.totalFiles).toBe(2);
    expect(manifest.totalSize).toBe(3);
    expect(manifest.rootName).toBe('folder');
    expect(manifest.isFolder).toBe(true);
    expect(manifest.isSizeEstimated).toBe(true);
  });

  it('formats byte counts for transfer UI', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
