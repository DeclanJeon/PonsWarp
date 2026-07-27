#!/usr/bin/env node
/**
 * Production transfer QA smoke (default 1MB direct; optional force-relay).
 *
 * Flow matches the proven prod-speed-test.mjs path, with a single JSON summary
 * line for release gates.
 *
 * Env:
 *   PROD_URL=https://warp.ponslink.com
 *   PROD_QA_RELAY=1
 *   PROD_QA_TIMEOUT_MS=180000
 *   PROD_QA_SIZE_BYTES=1048576
 *   PROD_QA_HEADLESS=0
 *   PROD_QA_ARTIFACT_DIR=<dir>
 *
 * Exit 0 on PASS, 1 on FAIL. Always prints one JSON summary line.
 *
 * Release gate:
 *   pnpm run qa:prod-transfer
 *   deploy/RELEASE-CHECKLIST.md
 *   PONSWARP_RUN_PROD_TRANSFER_QA=1 bash deploy/deploy-production.sh
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_URL = process.env.PROD_URL || 'https://warp.ponslink.com';
const TEST_SIZE = Number(process.env.PROD_QA_SIZE_BYTES || 1 * 1024 * 1024);
const RELAY = process.env.PROD_QA_RELAY === '1';
const TIMEOUT_MS = Number(process.env.PROD_QA_TIMEOUT_MS || 180_000);
const HEADLESS = process.env.PROD_QA_HEADLESS !== '0';
const ARTIFACT_DIR =
  process.env.PROD_QA_ARTIFACT_DIR ||
  join(process.cwd(), 'artifacts', 'ops', 'qa');

function summary(payload) {
  console.log(JSON.stringify(payload));
}

function parseReceiverStatus(text) {
  const sm = text.match(/([\d.]+)\s*(KB|MB)\/s/i);
  let speedMBps = 0;
  if (sm) {
    const n = parseFloat(sm[1]);
    speedMBps = /mb/i.test(sm[2]) ? n : n / 1024;
  }
  const percents = [...text.matchAll(/(\d+)%/g)].map(m => parseInt(m[1], 10));
  const progress = percents.length ? Math.max(...percents) : 0;
  return {
    speedMBps,
    progress,
    hasError: /\bFAILED\b|\bERROR\b/.test(text),
    hasMaterialized: /\bMATERIALIZED\b/i.test(text),
    hasDoneCopy:
      /\btransfer complete\b|\breconstruction complete\b|\bdownload ready\b/i.test(
        text
      ),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const sLogs = [];
  const rLogs = [];
  let exitCode = 1;
  let sender;
  let receiver;

  try {
    const ctx = await browser.newContext({
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
    });
    sender = await ctx.newPage();
    receiver = await ctx.newPage();

    // Force OPFS/blob fallback (avoid native save picker hangs).
    await receiver.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    sender.on('console', m => sLogs.push(`[S] ${m.text().substring(0, 240)}`));
    receiver.on('console', m =>
      rLogs.push(`[R] ${m.text().substring(0, 240)}`)
    );
    sender.on('pageerror', e => sLogs.push(`[S ERR] ${e.message}`));
    receiver.on('pageerror', e => rLogs.push(`[R ERR] ${e.message}`));

    const fail = async error => {
      const shotS = join(
        ARTIFACT_DIR,
        `prod-transfer-sender-${Date.now()}.png`
      );
      const shotR = join(
        ARTIFACT_DIR,
        `prod-transfer-receiver-${Date.now()}.png`
      );
      try {
        await sender.screenshot({ path: shotS, fullPage: true });
      } catch {
        /* ignore */
      }
      try {
        await receiver.screenshot({ path: shotR, fullPage: true });
      } catch {
        /* ignore */
      }
      summary({
        ok: false,
        url: APP_URL,
        relay: RELAY,
        size: TEST_SIZE,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        screenshots: [shotS, shotR],
        senderLogs: sLogs.slice(-12),
        receiverLogs: rLogs.slice(-12),
      });
      exitCode = 1;
    };

    try {
      await Promise.all([
        sender.goto(APP_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        }),
        receiver.goto(APP_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        }),
      ]);
      await Promise.all([
        sender.waitForTimeout(1500),
        receiver.waitForTimeout(1500),
      ]);

      // --- SENDER ---
      await sender.locator('button:has-text("INITIALIZE LINK")').first().click();
      await sender.waitForTimeout(500);
      if (RELAY) {
        const force = sender.locator(
          'button:has-text("FORCE RELAY"), button:has-text("Force Relay")'
        );
        if ((await force.count()) > 0) {
          await force.first().click().catch(() => {});
        }
      }
      await sender.locator('button:has-text("SEND NOW")').first().click();
      await sender.waitForTimeout(1500);

      await sender.evaluate(async size => {
        const input = document.querySelector('input[type=file]');
        if (!input) throw new Error('file input missing');
        const data = new Uint8Array(size);
        for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
        const file = new File([data], 'qa-transfer.bin', {
          type: 'application/octet-stream',
        });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, TEST_SIZE);
      await sender.waitForTimeout(4000);

      const roomCode = await sender.evaluate(() => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
          if (el.children.length === 0) {
            const m = (el.textContent || '').trim().match(/^([A-Z0-9]{6})$/);
            if (m) return m[1];
          }
        }
        return null;
      });
      if (!roomCode) throw new Error('sender: room code not found');

      // --- RECEIVER ---
      await receiver
        .locator('button:has-text("INITIALIZE LINK")')
        .first()
        .click();
      await receiver.waitForTimeout(500);
      await receiver.locator('button:has-text("RECEIVE")').first().click();
      await receiver.waitForTimeout(500);

      await receiver
        .locator('input[placeholder*="CODE" i]')
        .first()
        .fill(roomCode);
      await receiver
        .locator('button:has-text("ESTABLISH LINK")')
        .first()
        .click();
      await receiver.waitForTimeout(3000);

      // Wait for MATERIALIZE (manifest arrives after peer connect)
      let matReady = false;
      const matDeadline = Date.now() + 90_000;
      while (Date.now() < matDeadline) {
        if (
          (await receiver.locator('button:has-text("MATERIALIZE")').count()) > 0
        ) {
          matReady = true;
          break;
        }
        const body = await receiver.evaluate(() => document.body.innerText);
        if (
          /FAILED|ERROR|invalid/i.test(body) &&
          /room|code|link/i.test(body)
        ) {
          throw new Error(`receiver join failed: ${body.slice(0, 180)}`);
        }
        await receiver.waitForTimeout(500);
      }
      if (!matReady) throw new Error('receiver: MATERIALIZE not available');

      await receiver.locator('button:has-text("MATERIALIZE")').first().click();

      // Monitor — poll fast; 1MB can finish between slow samples.
      const startTime = Date.now();
      let lastSP = 0;
      let lastRP = 0;
      let peakMBps = 0;
      let sawProgress = false;
      let sawMaterialized = false;
      let transferComplete = false;
      let errorText = '';

      while (Date.now() - startTime < TIMEOUT_MS) {
        const sStatus = await sender
          .evaluate(() => {
            const text = document.body.innerText;
            const sm = text.match(/([\d.]+)\s*MB\/s/);
            const percents = [...text.matchAll(/(\d+)%/g)].map(m =>
              parseInt(m[1], 10)
            );
            return {
              speed: sm ? parseFloat(sm[1]) : 0,
              progress: percents.length ? Math.max(...percents) : 0,
            };
          })
          .catch(() => ({ speed: 0, progress: 0 }));

        const rText = await receiver
          .evaluate(() => document.body.innerText)
          .catch(() => '');
        const rStatus = parseReceiverStatus(rText);

        lastSP = Math.max(lastSP, sStatus.progress || 0);
        lastRP = Math.max(lastRP, rStatus.progress || 0);
        peakMBps = Math.max(
          peakMBps,
          sStatus.speed || 0,
          rStatus.speedMBps || 0
        );

        if (
          lastSP > 0 ||
          lastRP > 0 ||
          (sStatus.speed || 0) > 0.05 ||
          (rStatus.speedMBps || 0) > 0.05
        ) {
          sawProgress = true;
        }
        if (rStatus.hasMaterialized || rStatus.hasDoneCopy) {
          sawMaterialized = true;
        }

        if (rStatus.hasError) {
          errorText = rText.substring(0, 200);
          throw new Error(`transfer error: ${errorText}`);
        }

        // Pass conditions (any one):
        // 1) receiver >= 90% or sender 100%
        // 2) MATERIALIZED/done UI after any progress/speed signal
        // 3) peak throughput observed AND final UI landed
        if (
          lastRP >= 90 ||
          lastSP >= 100 ||
          (sawMaterialized && (sawProgress || peakMBps > 0.05)) ||
          (sawMaterialized && lastRP >= 30)
        ) {
          transferComplete = true;
          break;
        }

        await receiver.waitForTimeout(150);
      }

      if (!transferComplete) {
        throw new Error(
          `transfer timeout after ${TIMEOUT_MS}ms (sender=${lastSP}% receiver=${lastRP}% sawProgress=${sawProgress} materialized=${sawMaterialized} peakMBps=${peakMBps.toFixed(2)})`
        );
      }

      summary({
        ok: true,
        url: APP_URL,
        relay: RELAY,
        size: TEST_SIZE,
        roomCode,
        senderProgress: lastSP,
        receiverProgress: lastRP,
        sawProgress,
        sawMaterialized,
        peakMBps: Number(peakMBps.toFixed(3)),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      });
      exitCode = 0;
    } catch (e) {
      await fail(e);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  process.exit(exitCode);
}

main().catch(e => {
  summary({
    ok: false,
    url: APP_URL,
    relay: RELAY,
    size: TEST_SIZE,
    error: e instanceof Error ? e.message : String(e),
    finishedAt: new Date().toISOString(),
  });
  process.exit(1);
});
