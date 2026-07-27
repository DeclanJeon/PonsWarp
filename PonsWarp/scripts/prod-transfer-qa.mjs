#!/usr/bin/env node
/**
 * Production transfer QA smoke (1MB direct or relay).
 * Env:
 *   PROD_URL=https://warp.ponslink.com
 *   PROD_QA_RELAY=1   # optional: force relay path
 */
import { chromium } from 'playwright';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.PROD_URL || 'https://warp.ponslink.com';
const TEST_SIZE = 1 * 1024 * 1024;
const RELAY = !!process.env.PROD_QA_RELAY;

function makeTestFile() {
  const p = join(tmpdir(), `qa-${Date.now()}.bin`);
  const b = Buffer.alloc(TEST_SIZE, 0xAB);
  writeFileSync(p, b);
  return p;
}

async function run() {
  const file = makeTestFile();
  const browser = await chromium.launch({ headless: true });
  const ctxS = await browser.newContext();
  const ctxR = await browser.newContext();
  const s = await ctxS.newPage();
  const r = await ctxR.newPage();

  try {
    await s.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await r.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // sender: create room
    await s.getByRole('button', { name: /initialize link/i }).click();
    if (RELAY) await s.getByRole('button', { name: /force relay/i }).click().catch(() => {});
    await s.locator('input[type="file"]').setInputFiles(file);
    await s.getByRole('button', { name: /send now/i }).click();

    const code = await s.locator('text=/room code/i').locator('..').innerText().then(t => t.match(/[A-Z0-9]{6,}/)?.[0]).catch(() => null);
    if (!code) throw new Error('no room code');

    // receiver: join + materialize
    await r.getByPlaceholder(/enter code/i).fill(code);
    await r.getByRole('button', { name: /join/i }).click();
    await r.getByRole('button', { name: /materialize/i }).click();

    // wait for completion (simple timeout guard)
    await Promise.race([
      s.waitForSelector('text=/complete|success|done/i', { timeout: 120000 }),
      r.waitForSelector('text=/complete|success|done/i', { timeout: 120000 })
    ]);

    console.log(JSON.stringify({ ok: true, url: APP_URL, relay: RELAY, size: TEST_SIZE }));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, url: APP_URL, relay: RELAY, error: e.message }));
    process.exit(1);
  } finally {
    try { unlinkSync(file); } catch {}
    await browser.close();
  }
}

run();