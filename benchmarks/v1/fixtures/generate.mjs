#!/usr/bin/env node
/** Generate deterministic v1 fixtures. Local mode never materializes the ZIP64 boundary. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'manifest.json');
const BLOCK = 1024 * 1024;
const ONE_GIB = 1024 ** 3;
const MIN_LOCAL = 256 * 1024 * 1024;
function blocked(message) { throw new Error(`BLOCKED: ${message}`); }
function digest(seed, id, counter) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(counter);
  return createHash('sha256').update(Buffer.from(seed)).update(Buffer.from([0]))
    .update(Buffer.from(id)).update(Buffer.from([0])).update(c).digest();
}
async function* streamBytes(seed, id, length) {
  let counter = 0n; let remaining = BigInt(length);
  while (remaining > 0n) {
    const out = Buffer.alloc(Math.min(BLOCK, Number(remaining))); let offset = 0;
    while (offset < out.length) { const block = digest(seed, id, counter++); const take = Math.min(block.length, out.length - offset); block.copy(out, offset, 0, take); offset += take; }
    remaining -= BigInt(out.length); yield out;
  }
}
async function hashFile(path, expectedLength) {
  const stat = await fs.stat(path);
  if (stat.size !== expectedLength) blocked(`${path} has length ${stat.size}; expected ${expectedLength}`);
  const hash = createHash('sha256'); const handle = await fs.open(path, 'r'); const buffer = Buffer.alloc(BLOCK); let total = 0;
  try { while (total < expectedLength) { const { bytesRead } = await handle.read(buffer, 0, Math.min(BLOCK, expectedLength - total), total); if (!bytesRead) blocked(`${path} ended early`); hash.update(buffer.subarray(0, bytesRead)); total += bytesRead; } return hash.digest('hex'); }
  finally { await handle.close(); }
}
async function writeFixture(spec, length, init) {
  if (length < MIN_LOCAL || length > ONE_GIB || !Number.isSafeInteger(length)) blocked('regular fixture length is outside the manifest bounds');
  const target = join(HERE, spec.file); const temporary = `${target}.tmp-${process.pid}-${Date.now()}`; const handle = await fs.open(temporary, 'wx'); const hash = createHash('sha256'); let total = 0;
  try {
    for await (const chunk of streamBytes(spec.seed, spec.id, length)) { let offset = 0; while (offset < chunk.length) { const written = await handle.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) blocked('zero-byte fixture write'); offset += written.bytesWritten; } hash.update(chunk); total += chunk.length; }
    await handle.sync();
  } catch (error) { await handle.close(); await fs.rm(temporary, { force: true }); if (error.message?.startsWith('BLOCKED:')) throw error; blocked(`cannot materialize ${spec.file}: ${error.message}`); }
  await handle.close(); if (total !== length) { await fs.rm(temporary, { force: true }); blocked(`${spec.file} length mismatch`); }
  const actual = hash.digest('hex'); if (!init && typeof spec.expectedSha256 === 'string' && actual !== spec.expectedSha256) { await fs.rm(temporary, { force: true }); blocked(`${spec.file} SHA-256 mismatch`); }
  await fs.rename(temporary, target); if (await hashFile(target, length) !== actual) blocked(`${spec.file} failed physical read verification`); return actual;
}
async function main() {
  const args = process.argv.slice(2); const release = args.includes('--release'); const init = args.includes('--init-baseline');
  if (args.some((arg) => !['--release', '--init-baseline'].includes(arg)) || args.length !== new Set(args).size) blocked('unknown or duplicate arguments');
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')); const tier = release ? manifest.tiers.release : manifest.tiers.local;
  if (!tier || manifest.stream?.algorithm !== 'SHA-256') blocked('unsupported manifest');
  if (release) {
    const regular = manifest.fixtures.regular; const boundary = manifest.fixtures.zip64Boundary;
    if (tier.regularBytes !== ONE_GIB || tier.zip64BoundaryBytes !== 4294967297 || tier.zip64BoundaryAllocation !== 'fully-materialized-no-holes') blocked('release tier is not strict physical v1');
    regular.file = 'regular-1GiB.bin'; boundary.allocation = 'fully-materialized-no-holes';
    const hashes = { regular: await writeFixture(regular, ONE_GIB, init), zip64Boundary: await writeFixture(boundary, 4294967297, init) };
    if (init) { const next = structuredClone(manifest); next.fixtures.regular.file = regular.file; next.fixtures.regular.length = ONE_GIB; next.fixtures.zip64Boundary.allocation = boundary.allocation; for (const [key, value] of Object.entries(hashes)) next.fixtures[key].expectedSha256 = value; await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`); }
    console.log(JSON.stringify({ status: 'READY', tier: 'release', fixtureHashes: hashes })); return;
  }
  const requested = process.env.PONSWARP_LOCAL_REGULAR_BYTES ? Number(process.env.PONSWARP_LOCAL_REGULAR_BYTES) : tier.regularBytes.default;
  if (!Number.isSafeInteger(requested) || requested < tier.regularBytes.min || requested > tier.regularBytes.max) blocked('PONSWARP_LOCAL_REGULAR_BYTES is outside manifest bounds');
  const regular = manifest.fixtures.regular; const hash = await writeFixture(regular, requested, init);
  console.log(JSON.stringify({ status: 'READY', tier: 'local', releaseEvidence: false, regularBytes: requested, fixtureHash: hash, zip64Boundary: 'logical-only' }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 2; });
