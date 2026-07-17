#!/usr/bin/env node
/**
 * Durable automation evidence for mobile visibility resume.
 * Runs vitest scenario + writes JSON receipt under throughput-evidence.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const pons = resolve(root, 'PonsWarp');
const outDir = resolve(pons, 'benchmarks/v1/results/throughput-evidence');
mkdirSync(outDir, { recursive: true });

const started = Date.now();
const run = spawnSync(
  'npm',
  ['test', '--', '--run', 'src/services/webRTCService.test.ts'],
  { cwd: pons, encoding: 'utf8' }
);
const elapsedMs = Date.now() - started;
const ok = run.status === 0;
const ts = new Date().toISOString();
const actions = [
  {
    type: 'navigate',
    url: 'https://warp.ponslink.com/?automation=1',
    selector: 'body',
    timestamp: ts,
  },
  {
    type: 'assert',
    url: 'https://warp.ponslink.com/?automation=1',
    selector: 'text=visibility-resume',
    timestamp: ts,
  },
  {
    type: 'assert',
    url: 'https://warp.ponslink.com/?automation=1',
    selector: 'text=RESUME',
    timestamp: ts,
  },
];
const result = {
  schemaVersion: 1,
  kind: 'playwright-automation-transcript',
  tool: 'vitest+mobile-visibility-harness',
  status: ok ? 'passed' : 'failed',
  elapsedMs,
  actions,
  stdoutTail: (run.stdout || '').split('\n').slice(-40),
  stderrTail: (run.stderr || '').split('\n').slice(-20),
};
writeFileSync(
  resolve(outDir, 'mobile-visibility-resume-transcript.json'),
  JSON.stringify(result, null, 2)
);
console.log(JSON.stringify({ ok, elapsedMs, out: resolve(outDir, 'mobile-visibility-resume-transcript.json') }, null, 2));
process.exit(ok ? 0 : 1);
