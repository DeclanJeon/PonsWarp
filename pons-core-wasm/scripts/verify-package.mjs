#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = '0.4.3';
const cargoPath = resolve(root, 'Cargo.toml');
const packagePath = resolve(root, 'package.json');
const pkgDir = resolve(root, 'pkg');

function fail(message) {
  console.error(`WASM package verification failed: ${message}`);
  process.exit(1);
}
function readJson(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`invalid JSON in ${label}: ${error.message}`); }
}
function readText(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  return readFileSync(path, 'utf8');
}

const cargo = readText(cargoPath, 'Cargo.toml');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVersion !== expectedVersion) fail(`Cargo version is ${cargoVersion ?? 'missing'}, expected ${expectedVersion}`);

const outer = readJson(packagePath, 'outer package manifest');
if (outer.name !== 'pons-core-wasm') fail(`outer package name is ${outer.name ?? 'missing'}`);
if (outer.version !== expectedVersion) fail(`outer package version is ${outer.version ?? 'missing'}, expected ${expectedVersion}`);

const generated = readJson(resolve(pkgDir, 'package.json'), 'generated package manifest');
if (generated.name !== 'pons-core-wasm') fail(`generated package name is ${generated.name ?? 'missing'}`);
if (generated.version !== expectedVersion) fail(`generated package version is ${generated.version ?? 'missing'}, expected ${expectedVersion}`);
for (const file of ['pons_core_wasm.js', 'pons_core_wasm.d.ts', 'pons_core_wasm_bg.wasm']) {
  if (!existsSync(resolve(pkgDir, file))) fail(`missing generated output pkg/${file}`);
}

console.log(`WASM package provenance verified at ${expectedVersion}`);
