#!/usr/bin/env node
/**
 * Local 1:1 app-path encrypted transfer speed test.
 * Uses two Chromium contexts against a local Vite preview + Rust signaling.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const TEST_SIZE = Number(process.env.TEST_BYTES || 32 * 1024 * 1024);
const SIGNAL_BIN =
  process.env.SIGNAL_BIN ||
  new URL('../../ponswarp-signaling-rs/target/release/ponswarp-signaling-rs', import.meta.url)
    .pathname;

function spawnProc(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stdout.on('data', d => process.stdout.write(`[${cmd}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${cmd}] ${d}`));
  return child;
}

async function waitHttp(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function main() {
  console.log('=== Local app-path 1:1 speed test ===');
  console.log(`APP_URL=${APP_URL} size=${(TEST_SIZE / 1024 / 1024).toFixed(1)}MB`);

  let signal = null;
  let preview = null;
  const ownInfra = process.env.OWN_INFRA !== '0';

  try {
    if (ownInfra) {
      signal = spawnProc(SIGNAL_BIN, [], {
        HOST: '0.0.0.0',
        PORT: '5502',
        CORS_ORIGINS: '*',
        RUST_LOG: 'info',
      });
      await waitHttp('http://127.0.0.1:5502/health');
      preview = spawnProc(
        'pnpm',
        ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
        {
          VITE_USE_RUST_SIGNALING: 'true',
          VITE_RUST_SIGNALING_URL: 'ws://127.0.0.1:5502/ws',
        }
      );
      await waitHttp(APP_URL);
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });

    try {
      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      const sLogs = [];
      const rLogs = [];
      sender.on('console', m => sLogs.push(m.text()));
      receiver.on('console', m => rLogs.push(m.text()));

      await receiver.addInitScript(() => {
        Object.defineProperty(window, 'showSaveFilePicker', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      });

      await Promise.all([
        sender.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
        receiver.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      ]);
      await sleep(1500);

      // SENDER
      await sender.locator('button:has-text("INITIALIZE LINK")').first().click({ timeout: 10000 }).catch(() => {});
      await sleep(400);
      const sendNow = sender.locator('button:has-text("SEND NOW")').first();
      if (await sendNow.count()) await sendNow.click();
      await sleep(800);

      await sender.evaluate(async size => {
        const input = document.querySelector('input[type=file]');
        if (!input) throw new Error('no file input');
        const data = new Uint8Array(size);
        for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
        const file = new File([data], 'speedtest.bin', {
          type: 'application/octet-stream',
        });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, TEST_SIZE);
      await sleep(2500);

      const roomCode = await sender.evaluate(() => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
          if (el.children.length === 0) {
            const m = (el.textContent || '').trim().match(/^([A-Z0-9]{6})$/);
            if (m) return m[1];
          }
        }
        // fallback: any 6-char room-looking text
        const body = document.body.innerText;
        const m2 = body.match(/\b([A-Z0-9]{6})\b/);
        return m2 ? m2[1] : null;
      });
      console.log('roomCode=', roomCode);
      if (!roomCode) throw new Error('no room code');

      // RECEIVER
      await receiver.locator('button:has-text("INITIALIZE LINK")').first().click({ timeout: 10000 }).catch(() => {});
      await sleep(400);
      const recvBtn = receiver.locator('button:has-text("RECEIVE")').first();
      if (await recvBtn.count()) await recvBtn.click();
      await sleep(500);
      await receiver.locator('input').first().fill(roomCode);
      const establish = receiver.locator('button:has-text("ESTABLISH LINK")').first();
      if (await establish.count()) await establish.click();
      await sleep(2500);

      const mat = receiver.locator('button:has-text("MATERIALIZE")').first();
      if ((await mat.count()) === 0) {
        console.log('body snippet', (await receiver.innerText('body')).slice(0, 500));
        throw new Error('no MATERIALIZE button');
      }
      await mat.click();
      await sleep(1000);

      const start = Date.now();
      let lastProgress = 0;
      let lastSpeed = 0;
      let complete = false;
      for (let i = 0; i < 180; i++) {
        const status = await receiver.evaluate(() => {
          const text = document.body.innerText;
          const sm = text.match(/([\d.]+)\s*MB\/s/);
          const pm = text.match(/(\d+)%/);
          return {
            speed: sm ? parseFloat(sm[1]) : 0,
            progress: pm ? parseInt(pm[1], 10) : 0,
            complete:
              text.includes('100%') ||
              /complete|done|materialized/i.test(text),
            path: (text.match(/host|srflx|relay/i) || [null])[0],
          };
        });
        if (status.progress !== lastProgress || status.speed !== lastSpeed) {
          console.log(
            `t=${((Date.now() - start) / 1000).toFixed(1)}s progress=${status.progress}% speed=${status.speed} path=${status.path}`
          );
          lastProgress = status.progress;
          lastSpeed = status.speed;
        }
        if (status.complete || status.progress >= 100) {
          complete = true;
          break;
        }
        await sleep(500);
      }

      const elapsed = (Date.now() - start) / 1000;
      const MBps = TEST_SIZE / 1024 / 1024 / elapsed;
      console.log(
        JSON.stringify(
          {
            complete,
            elapsedSec: elapsed,
            effectiveMBps: MBps,
            lastUiSpeed: lastSpeed,
            lastProgress,
          },
          null,
          2
        )
      );

      if (!complete) {
        console.log('--- sender logs ---');
        sLogs.slice(-30).forEach(l => console.log(l));
        console.log('--- receiver logs ---');
        rLogs.slice(-30).forEach(l => console.log(l));
        process.exitCode = 1;
      } else if (MBps < 8) {
        console.log('WARN: completed but < 8 MB/s effective');
        process.exitCode = 2;
      } else {
        console.log('PASS: >= 8 MB/s effective');
      }
    } finally {
      await browser.close();
    }
  } finally {
    if (preview) preview.kill('SIGTERM');
    if (signal) signal.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
