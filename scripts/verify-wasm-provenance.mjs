#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedVersion = '0.4.3';
const frontend = resolve(repo, 'PonsWarp');
function fail(message) { console.error(`WASM provenance verification failed: ${message}`); process.exit(1); }
function json(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`invalid ${label}: ${error.message}`); }
}
const build = spawnSync('pnpm', ['--dir', 'pons-core-wasm', 'build'], { cwd: repo, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(build.stderr || build.stdout || `WASM build exited ${build.status}\n`); process.exit(build.status || 1); }
const packageCheck = spawnSync(process.execPath, [resolve(repo, 'pons-core-wasm/scripts/verify-package.mjs')], { cwd: repo, encoding: 'utf8' });
if (packageCheck.status !== 0) { process.stderr.write(packageCheck.stderr || packageCheck.stdout || `package verifier exited ${packageCheck.status}\n`); process.exit(packageCheck.status || 1); }
const outerPackage = json(resolve(repo, 'pons-core-wasm/package.json'), 'WASM workspace package manifest');
const generatedPackage = json(resolve(repo, 'pons-core-wasm/pkg/package.json'), 'generated WASM package manifest');
if (outerPackage.name !== 'pons-core-wasm' || outerPackage.version !== expectedVersion) fail(`WASM workspace package must be pons-core-wasm@${expectedVersion}`);
if (generatedPackage.name !== 'pons-core-wasm' || generatedPackage.version !== expectedVersion) fail(`generated WASM package must be pons-core-wasm@${expectedVersion}`);
const app = json(resolve(frontend, 'package.json'), 'frontend package manifest');
if (app.dependencies?.['pons-core-wasm'] !== 'workspace:*') fail(`frontend must depend on pons-core-wasm via workspace:*, found ${app.dependencies?.['pons-core-wasm'] ?? 'missing'}`);
const lockPath = resolve(repo, 'pnpm-lock.yaml');
if (!existsSync(lockPath)) fail(`missing root lockfile: ${lockPath}`);
const lock = readFileSync(lockPath, 'utf8');
const importer = lock.match(/\n  PonsWarp:\n([\s\S]*?)(?=\n  [^ ]|\npackages:)/)?.[1];
if (!importer) fail('root lockfile is missing the PonsWarp importer');
const dependency = importer.match(/\n      pons-core-wasm:\n        specifier: ([^\n]+)\n        version: ([^\n]+)/);
if (!dependency || dependency[1] !== 'workspace:*' || dependency[2] !== 'link:../pons-core-wasm') fail('PonsWarp importer must resolve pons-core-wasm as workspace:* / link:../pons-core-wasm');
if (/\n      pons-core-wasm:\n        specifier: (?!workspace:\*)[^\n]+/m.test(importer)) fail('PonsWarp importer contains a non-workspace pons-core-wasm specifier');
const generatedDigest = createHash('sha256').update(readFileSync(resolve(repo, 'pons-core-wasm/pkg/pons_core_wasm.js'))).update(readFileSync(resolve(repo, 'pons-core-wasm/pkg/pons_core_wasm.d.ts'))).update(readFileSync(resolve(repo, 'pons-core-wasm/pkg/pons_core_wasm_bg.wasm'))).digest('hex');
console.log(`WASM workspace provenance verified at ${expectedVersion}; generated digest ${generatedDigest}`);
