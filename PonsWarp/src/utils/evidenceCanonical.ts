import type { TransferManifest } from '../types/types';

const MAX_CANONICAL_BYTES = 256 * 1024;
const MANIFEST_KEYS = [
  'files',
  'isFolder',
  'isSizeEstimated',
  'rootName',
  'totalFiles',
  'totalSize',
  'transferId',
] as const;
const FILE_KEYS = [
  'checksum',
  'id',
  'lastModified',
  'name',
  'path',
  'size',
  'type',
] as const;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const actual = Object.keys(value);
  if (
    actual.some(key => !allowed.includes(key)) ||
    allowed.some(
      key =>
        !Object.prototype.hasOwnProperty.call(value, key) &&
        key !== 'checksum' &&
        key !== 'isSizeEstimated'
    )
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${label} must be a string`);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (
        i + 1 >= value.length ||
        value.charCodeAt(++i) < 0xdc00 ||
        value.charCodeAt(i) > 0xdfff
      )
        throw new TypeError(`${label} contains an invalid string`);
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TypeError(`${label} contains an invalid string`);
  }
  return value.normalize('NFC');
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a safe finite integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean')
    throw new TypeError(`${label} must be boolean`);
  return value;
}

function fileNode(input: unknown, index: number): Record<string, unknown> {
  const source = plainRecord(input, `files[${index}]`);
  exactKeys(source, FILE_KEYS, `files[${index}]`);
  if (
    Object.prototype.hasOwnProperty.call(source, 'checksum') &&
    source.checksum === undefined
  )
    throw new TypeError(`files[${index}].checksum must not be undefined`);
  return {
    checksum:
      source.checksum == null
        ? null
        : text(source.checksum, `files[${index}].checksum`),
    id: integer(source.id, `files[${index}].id`),
    lastModified: integer(source.lastModified, `files[${index}].lastModified`),
    name: text(source.name, `files[${index}].name`),
    path: text(source.path, `files[${index}].path`),
    size: integer(source.size, `files[${index}].size`),
    type: text(source.type, `files[${index}].type`),
  };
}

/** Return deterministic UTF-8 bytes for the allowlisted TransferManifest contract. */
export function canonicalTransferManifestBytes(input: unknown): Uint8Array {
  const source = plainRecord(input, 'manifest');
  exactKeys(source, MANIFEST_KEYS, 'manifest');
  if (
    Object.prototype.hasOwnProperty.call(source, 'isSizeEstimated') &&
    source.isSizeEstimated === undefined
  ) {
    throw new TypeError('manifest.isSizeEstimated must not be undefined');
  }
  if (!Array.isArray(source.files))
    throw new TypeError('manifest.files must be an array');
  const normalized: Record<string, unknown> = {
    files: source.files.map(fileNode),
    isFolder: boolean(source.isFolder, 'manifest.isFolder'),
    isSizeEstimated:
      source.isSizeEstimated == null
        ? null
        : boolean(source.isSizeEstimated, 'manifest.isSizeEstimated'),
    rootName: text(source.rootName, 'manifest.rootName'),
    totalFiles: integer(source.totalFiles, 'manifest.totalFiles'),
    totalSize: integer(source.totalSize, 'manifest.totalSize'),
    transferId: text(source.transferId, 'manifest.transferId'),
  };
  const json = JSON.stringify(normalized);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_CANONICAL_BYTES)
    throw new RangeError('canonical manifest exceeds 256 KiB');
  return bytes;
}

export function canonicalTransferManifest(input: TransferManifest): string {
  return new TextDecoder().decode(canonicalTransferManifestBytes(input));
}
