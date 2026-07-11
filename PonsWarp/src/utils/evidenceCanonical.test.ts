import { describe, expect, it } from 'vitest';
import {
  canonicalTransferManifest,
  canonicalTransferManifestBytes,
} from './evidenceCanonical';

const manifest = () => ({
  transferId: 't',
  totalSize: 3,
  totalFiles: 2,
  rootName: 'e\u0301',
  files: [
    {
      id: 1,
      name: 'b',
      path: 'b',
      size: 2,
      type: 'text/plain',
      lastModified: 2,
    },
    {
      id: 0,
      name: 'a',
      path: 'a',
      size: 1,
      type: 'text/plain',
      lastModified: 1,
      checksum: 'x',
    },
  ],
  isFolder: true,
});

describe('canonical TransferManifest evidence bytes', () => {
  it('normalizes strings, sorts keys, preserves array order, and nulls omitted optionals', () => {
    expect(canonicalTransferManifest(manifest())).toBe(
      '{"files":[{"checksum":null,"id":1,"lastModified":2,"name":"b","path":"b","size":2,"type":"text/plain"},{"checksum":"x","id":0,"lastModified":1,"name":"a","path":"a","size":1,"type":"text/plain"}],"isFolder":true,"isSizeEstimated":null,"rootName":"é","totalFiles":2,"totalSize":3,"transferId":"t"}'
    );
  });

  it('is deterministic for insertion order and bounded', () => {
    const a = manifest();
    const b = { ...a, files: a.files.map(file => ({ ...file })) };
    expect(Array.from(canonicalTransferManifestBytes(a))).toEqual(
      Array.from(canonicalTransferManifestBytes(b))
    );
    expect(() =>
      canonicalTransferManifest({ ...a, rootName: 'x'.repeat(256 * 1024) })
    ).toThrow(/256 KiB/);
  });

  it('rejects unknown, inherited, polluted, undefined, unsafe and non-finite values', () => {
    const withUnknown: Record<string, unknown> = { ...manifest(), extra: 1 };
    expect(() => canonicalTransferManifestBytes(withUnknown)).toThrow();
    const inherited = Object.create({ transferId: 'inherited' });
    Object.assign(inherited, manifest());
    expect(() => canonicalTransferManifest(inherited)).toThrow();
    const polluted = {
      ...manifest(),
      files: [{ ...manifest().files[0], __proto__: { bad: true } }],
    };
    expect(() => canonicalTransferManifest(polluted)).toThrow();
    expect(() =>
      canonicalTransferManifest({ ...manifest(), totalSize: undefined })
    ).toThrow();
    expect(() =>
      canonicalTransferManifest({
        ...manifest(),
        totalSize: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toThrow();
    expect(() =>
      canonicalTransferManifest({ ...manifest(), totalSize: Infinity })
    ).toThrow();
  });
});
