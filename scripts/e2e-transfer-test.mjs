#!/usr/bin/env node
/**
 * E2E transfer test: verifies full file transfer through the app UI.
 * Uses Playwright to drive two browser tabs through the actual transfer flow.
 */
import { chromium } from 'playwright';
import { writeFileSync, statSync } from 'node:fs';

const APP_URL = 'http://localhost:5173';
const TEST_FILE = '/tmp/ponswarp-e2e-test.bin';
const TEST_SIZE = 5 * 1024 * 1024; // 5MB

async function main() {
  console.log('=== E2E Transfer Test ===\n');

  // Generate test file
  const buf = Buffer.alloc(TEST_SIZE);
  for (let i = 0; i < TEST_SIZE; i++) buf[i] = (i * 7 + 13) & 0xff;
  writeFileSync(TEST_FILE, buf);
  console.log(`Test file: ${TEST_FILE} (${(statSync(TEST_FILE).size / 1024 / 1024).toFixed(1)} MB)`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const ctx = await browser.newContext();
    const senderPage = await ctx.newPage();
    const receiverPage = await ctx.newPage();

    // Capture console logs
    senderPage.on('console', msg => {
      if (msg.type() === 'error' || msg.text().includes('error') || msg.text().includes('Error')) {
        console.log(`[Sender ${msg.type()}]`, msg.text().substring(0, 200));
      }
    });
    receiverPage.on('console', msg => {
      if (msg.type() === 'error' || msg.text().includes('error') || msg.text().includes('Error')) {
        console.log(`[Receiver ${msg.type()}]`, msg.text().substring(0, 200));
      }
    });

    console.log('\n[1/5] Loading pages...');
    await Promise.all([
      senderPage.goto(APP_URL, { waitUntil: 'load', timeout: 15000 }),
      receiverPage.goto(APP_URL, { waitUntil: 'load', timeout: 15000 }),
    ]);

    // Get room code from sender
    console.log('[2/5] Initializing sender...');
    await senderPage.click('button:has-text("INITIALIZE LINK")');
    await senderPage.waitForTimeout(500);
    await senderPage.click('button:has-text("SEND NOW")');
    await senderPage.waitForTimeout(500);

    // Upload test file
    const fileInput = await senderPage.$('input[type=file]');
    if (fileInput) {
      await fileInput.setInputFiles(TEST_FILE);
      console.log('  ✓ File uploaded');
    } else {
      console.log('  ✗ No file input found');
      return;
    }

    // Wait for room code to appear
    await senderPage.waitForTimeout(2000);
    const roomCode = await senderPage.evaluate(() => {
      // Try to find room code in the DOM
      const text = document.body.innerText;
      const match = text.match(/[A-Z0-9]{6,8}/);
      return match ? match[0] : null;
    });
    console.log(`  Room code: ${roomCode}`);

    if (!roomCode) {
      console.log('  ✗ Could not find room code');
      return;
    }

    // Enter room code on receiver
    console.log('[3/5] Connecting receiver...');
    await receiverPage.click('button:has-text("INITIALIZE LINK")');
    await receiverPage.waitForTimeout(500);

    // Look for the code input
    const codeInput = await receiverPage.$('input[placeholder*="code" i], input[type="text"]');
    if (codeInput) {
      await codeInput.fill(roomCode);
      console.log('  ✓ Room code entered');
    } else {
      console.log('  ✗ No code input found');
    }

    // Wait for transfer
    console.log('[4/5] Waiting for transfer (60s timeout)...');

    const startTime = Date.now();
    let lastProgress = 0;
    let transferComplete = false;

    for (let i = 0; i < 120; i++) { // 60s
      const status = await receiverPage.evaluate(() => {
        const text = document.body.innerText;
        if (text.includes('DONE') || text.includes('COMPLETE') || text.includes('100%')) return 'complete';
        if (text.includes('ERROR') || text.includes('FAILED')) return 'error';
        const speedMatch = text.match(/(\d+\.?\d*)\s*MB\/s/);
        const progressMatch = text.match(/(\d+)%/);
        return {
          status: 'progress',
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

      if (typeof status === 'object' && status.progress > lastProgress) {
        console.log(`  Progress: ${status.progress}% @ ${status.speed} MB/s`);
        lastProgress = status.progress;
      }

      await receiverPage.waitForTimeout(500);
    }

    const elapsed = (Date.now() - startTime) / 1000;

    console.log('\n[5/5] RESULTS:');
    if (transferComplete) {
      const throughput = (TEST_SIZE / (1024 * 1024)) / elapsed;
      console.log(`  ✅ Transfer completed in ${elapsed.toFixed(1)}s`);
      console.log(`  📊 Throughput: ${throughput.toFixed(1)} MB/s`);
    } else {
      console.log('  ❌ Transfer did not complete');
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
