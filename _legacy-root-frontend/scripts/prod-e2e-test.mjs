#!/usr/bin/env node
/**
 * Production E2E transfer test v2
 */
import { chromium } from 'playwright';

const APP_URL = 'http://localhost:5173';
const TEST_SIZE = 3 * 1024 * 1024; // 3MB

async function main() {
  console.log('=== Production E2E Transfer Test v2 ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const ctx = await browser.newContext();
    const senderPage = await ctx.newPage();
    const receiverPage = await ctx.newPage();

    senderPage.on('pageerror', err => console.log('[Sender err]', err.message));
    receiverPage.on('pageerror', err => console.log('[Receiver err]', err.message));

    console.log('[1] Loading pages...');
    await Promise.all([
      senderPage.goto(APP_URL, { waitUntil: 'load', timeout: 15000 }),
      receiverPage.goto(APP_URL, { waitUntil: 'load', timeout: 15000 }),
    ]);

    // === SENDER ===
    console.log('[2] Setting up sender...');
    await senderPage.locator('button:has-text("INITIALIZE LINK")').click();
    await senderPage.waitForTimeout(500);
    await senderPage.locator('button:has-text("SEND NOW")').click();
    await senderPage.waitForTimeout(1000);

    await senderPage.evaluate(async (size) => {
      const input = document.querySelector('input[type=file]');
      const data = new Uint8Array(size);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
      const file = new File([data], 'test.bin', { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, TEST_SIZE);
    console.log('  ✓ File uploaded');

    await senderPage.waitForTimeout(3000);
    const roomCode = await senderPage.evaluate(() => {
      const text = document.body.innerText;
      const matches = text.match(/\b[A-Z0-9]{6}\b/g);
      return matches ? matches[0] : null;
    });

    if (!roomCode) {
      console.log('  ✗ No room code found');
      return;
    }
    console.log(`  ✓ Room code: ${roomCode}`);

    // === RECEIVER ===
    console.log('[3] Setting up receiver...');
    await receiverPage.locator('button:has-text("INITIALIZE LINK")').click();
    await receiverPage.waitForTimeout(500);
    await receiverPage.locator('button:has-text("RECEIVE")').click();
    await receiverPage.waitForTimeout(1500);

    // Get all inputs and their attributes
    const inputs = await receiverPage.locator('input').all();
    console.log(`  Found ${inputs.length} input(s)`);

    if (inputs.length > 0) {
      const firstInput = inputs[0];
      const placeholder = await firstInput.getAttribute('placeholder');
      const type = await firstInput.getAttribute('type');
      console.log(`  First input: type=${type}, placeholder="${placeholder}"`);
      await firstInput.fill(roomCode);
      console.log(`  ✓ Code filled: ${roomCode}`);

      // Try to submit
      const submitBtn = await receiverPage.locator('button[type="submit"], button:has-text("Join"), button:has-text("Connect")').first();
      if (await submitBtn.count() > 0) {
        await submitBtn.click();
        console.log('  ✓ Submit clicked');
      } else {
        // Try Enter key
        await firstInput.press('Enter');
        console.log('  ✓ Enter pressed');
      }
    }

    // === MONITOR ===
    console.log('[4] Monitoring transfer (45s)...');
    const startTime = Date.now();
    let transferComplete = false;
    let lastProgress = 0;

    for (let i = 0; i < 90; i++) {
      const status = await receiverPage.evaluate(() => {
        const text = document.body.innerText;
        if (text.includes('DONE') || text.includes('100%') || text.includes('Downloaded') || text.includes('Complete')) return 'complete';
        if (text.includes('ERROR') || text.includes('FAILED') || text.includes('Connection Failed')) return 'error';
        const speedMatch = text.match(/(\d+\.?\d*)\s*MB\/s/);
        const progressMatch = text.match(/(\d+)%/);
        return {
          speed: speedMatch ? parseFloat(speedMatch[1]) : 0,
          progress: progressMatch ? parseInt(progressMatch[1]) : 0,
        };
      });

      if (status === 'complete') {
        transferComplete = true;
        break;
      }
      if (status === 'error') {
        console.log('  ✗ Transfer error detected');
        break;
      }

      if (status.progress > lastProgress) {
        console.log(`  ${status.progress}% @ ${status.speed} MB/s`);
        lastProgress = status.progress;
      }

      await receiverPage.waitForTimeout(500);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    console.log('\n[5] RESULTS:');
    if (transferComplete) {
      const throughput = (TEST_SIZE / (1024 * 1024)) / elapsed;
      console.log(`  ✅ Transfer completed in ${elapsed.toFixed(1)}s`);
      console.log(`  📊 Throughput: ${throughput.toFixed(1)} MB/s`);
    } else {
      console.log(`  ❌ Incomplete (last: ${lastProgress}%)`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
