#!/usr/bin/env node
/**
 * Real browser E2E test - bypasses file save dialog
 * Uses Chrome DevTools Protocol to handle downloads
 */
import { chromium } from 'playwright';

const APP_URL = 'https://warp.ponslink.com';
const TEST_SIZE = 5 * 1024 * 1024; // 5MB

async function main() {
  console.log('=== REAL BROWSER E2E on warp.ponslink.com ===\n');
  console.log('(Using OPFS fallback to bypass file save dialog)\n');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
    ],
  });

  try {
    const ctx = await browser.newContext({
      acceptDownloads: true,
    });

    const sender = await ctx.newPage();
    const receiver = await ctx.newPage();

    // Force OPFS fallback instead of FSA by removing showSaveFilePicker
    await receiver.addInitScript(() => {
      // Remove showSaveFilePicker to force OPFS/blob fallback
      Object.defineProperty(window, 'showSaveFilePicker', {
        value: undefined, configurable: true, writable: true,
      });
    });

    const sLogs = [];
    sender.on('console', m => sLogs.push(`[S] ${m.text().substring(0, 200)}`));
    const rLogs = [];
    receiver.on('console', m => rLogs.push(`[R] ${m.text().substring(0, 200)}`));
    sender.on('pageerror', e => sLogs.push(`[S ERR] ${e.message}`));
    receiver.on('pageerror', e => rLogs.push(`[R ERR] ${e.message}`));

    console.log('[1] Loading...');
    await Promise.all([
      sender.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }),
      receiver.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }),
    ]);
    await Promise.all([sender.waitForTimeout(1500), receiver.waitForTimeout(1500)]);

    // SENDER
    console.log('[2] Sender setup...');
    await sender.locator('button:has-text("INITIALIZE LINK")').first().click();
    await sender.waitForTimeout(500);
    await sender.locator('button:has-text("SEND NOW")').first().click();
    await sender.waitForTimeout(1500);

    console.log('[3] Uploading 5MB file...');
    await sender.evaluate(async (size) => {
      const input = document.querySelector('input[type=file]');
      const data = new Uint8Array(size);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
      const file = new File([data], 'speedtest.bin', { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, TEST_SIZE);
    await sender.waitForTimeout(4000);

    // Get room code
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
    console.log(`  Room code: ${roomCode}`);
    if (!roomCode) { console.log('  ✗ No room code'); return; }

    // RECEIVER
    console.log('[4] Receiver setup...');
    await receiver.locator('button:has-text("INITIALIZE LINK")').first().click();
    await receiver.waitForTimeout(500);
    await receiver.locator('button:has-text("RECEIVE")').first().click();
    await receiver.waitForTimeout(500);

    await receiver.locator('input[placeholder*="CODE" i]').first().fill(roomCode);
    await receiver.locator('button:has-text("ESTABLISH LINK")').first().click();
    await receiver.waitForTimeout(3000);

    const matCount = await receiver.locator('button:has-text("MATERIALIZE")').count();
    if (matCount === 0) {
      console.log('  ✗ No MATERIALIZE');
      return;
    }

    console.log('[5] Materializing...');
    await receiver.locator('button:has-text("MATERIALIZE")').first().click();
    await receiver.waitForTimeout(3000);

    // MONITOR
    console.log('[6] Monitoring transfer (up to 60s)...');
    const startTime = Date.now();
    let lastSP = 0, lastSS = 0, lastRP = 0, lastRS = 0;
    let transferComplete = false, errorDetected = false;
    let errorText = '';

    for (let i = 0; i < 120; i++) {
      const sStatus = await sender.evaluate(() => {
        const text = document.body.innerText;
        const sm = text.match(/([\d.]+)\s*MB\/s/);
        const pm = text.match(/(\d+)%/);
        return { speed: sm ? parseFloat(sm[1]) : 0, progress: pm ? parseInt(pm[1]) : 0 };
      }).catch(() => ({ speed: 0, progress: 0 }));

      const rStatus = await receiver.evaluate(() => {
        const text = document.body.innerText;
        const sm = text.match(/([\d.]+)\s*KB\/s|([\d.]+)\s*MB\/s/);
        const pm = text.match(/(\d+)%/);
        return {
          speed: sm ? parseFloat(sm[1] || sm[2] || 0) : 0,
          progress: pm ? parseInt(pm[1]) : 0,
          hasError: text.includes('FAILED') || text.includes('ERROR'),
          hasComplete: text.includes('100%') || text.includes('DONE') || text.includes('Complete'),
        };
      }).catch(() => ({ speed: 0, progress: 0, hasError: false, hasComplete: false }));

      if (rStatus.hasError) {
        errorDetected = true;
        errorText = (await receiver.evaluate(() => document.body.innerText)).substring(0, 200);
        break;
      }
      if (rStatus.hasComplete) {
        transferComplete = true;
        break;
      }

      const elapsed = (Date.now() - startTime) / 1000;
      if (sStatus.progress !== lastSP || rStatus.progress !== lastRP) {
        console.log(`  ${elapsed.toFixed(1)}s | S: ${sStatus.progress}%@${sStatus.speed}MB/s | R: ${rStatus.progress}%@${rStatus.speed}KB/s`);
        lastSP = sStatus.progress; lastSS = sStatus.speed;
        lastRP = rStatus.progress; lastRS = rStatus.speed;
      }

      await receiver.waitForTimeout(500);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    console.log('\n=== FINAL RESULTS ===');
    console.log(`Time: ${elapsed.toFixed(1)}s`);
    console.log(`Sender: ${lastSP}% @ ${lastSS} MB/s`);
    console.log(`Receiver: ${lastRP}% @ ${lastRS} KB/s`);

    if (transferComplete) {
      const throughput = (TEST_SIZE / (1024 * 1024)) / elapsed;
      console.log(`✅ COMPLETED - Throughput: ${throughput.toFixed(1)} MB/s`);
    } else if (errorDetected) {
      console.log(`❌ ERROR: ${errorText}`);
    } else {
      console.log('❌ TIMEOUT');
    }

    // Print key logs
    console.log('\n--- KEY sender logs ---');
    sLogs.filter(l => l.includes('MB/s') || l.includes('Error') || l.includes('Send') || l.includes('transfer')).slice(-10).forEach(l => console.log(' ', l));
    console.log('\n--- KEY receiver logs ---');
    rLogs.filter(l => l.includes('MB/s') || l.includes('KB/s') || l.includes('Error') || l.includes('write') || l.includes('Save') || l.includes('storage')).slice(-10).forEach(l => console.log(' ', l));

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
