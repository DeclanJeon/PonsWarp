#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const APP = `https://warp.ponslink.com/?automation=1&nocache=1&v=${Date.now()}`;
const TEST_FILE = '/tmp/ponswarp-lan-test-20mb.bin';
const REMOTE_DL = '/tmp/chrome-downloads';
const TUNNEL_PORT = 9223;
const REMOTE_PORT = 9222;
const CHROME_ARGS =
  '--headless=new --remote-debugging-port=9222 --no-first-run --no-sandbox --disable-gpu --user-data-dir=/tmp/chrome-hd-clean --disable-features=WebRtcHideLocalIpsWithMdns,Translate,MediaRouter';

const sh = (cmd) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sh0 = (cmd) => {
  try {
    return sh(cmd);
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
};

function ensureFile(mb = 20) {
  if (!existsSync(TEST_FILE)) {
    console.log(`[setup] create ${mb}MB file`);
    sh(`dd if=/dev/urandom of=${TEST_FILE} bs=1M count=${mb} status=none`);
  }
}

async function waitRemoteCDP(tries = 40) {
  for (let i = 0; i < tries; i++) {
    const out = sh0(
      `ssh home 'curl -s http://127.0.0.1:${REMOTE_PORT}/json/version'`
    );
    if (out.includes('Browser')) return true;
    await sleep(250);
  }
  return false;
}

async function waitLocalCDP(tries = 40) {
  for (let i = 0; i < tries; i++) {
    const out = sh0(`curl -s http://127.0.0.1:${TUNNEL_PORT}/json/version`);
    if (out.includes('Browser')) return true;
    await sleep(250);
  }
  return false;
}

async function setupRemote() {
  console.log('[setup] remote chrome');
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE_PORT} || true'`);
  await sleep(700);
  sh0(
    `ssh home 'mkdir -p ${REMOTE_DL} /tmp/chrome-hd-clean && rm -rf /tmp/chrome-hd-clean/*'`
  );
  sh0(
    `ssh home 'nohup google-chrome ${CHROME_ARGS} about:blank > /tmp/chrome-lan-test.log 2>&1 < /dev/null & echo $!'`
  );
  if (!(await waitRemoteCDP())) {
    throw new Error(
      'remote CDP not ready\n' +
        sh0(`ssh home 'tail -40 /tmp/chrome-lan-test.log'`)
    );
  }
  sh0(`pkill -f "ssh.*-L ${TUNNEL_PORT}" || true`);
  sh(
    `ssh -o ExitOnForwardFailure=yes -f -N -L ${TUNNEL_PORT}:127.0.0.1:${REMOTE_PORT} home`
  );
  if (!(await waitLocalCDP())) throw new Error('tunnel failed');
  console.log('[setup] remote ready');
}

async function clickButton(page, pattern, timeout = 15000) {
  const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
  await page.getByRole('button', { name: re }).first().click({ timeout });
}


  
  async function installDiagnostics(page, name) {
    await page.exposeFunction('__ponsLog', (level, msg) => {
      const line = `[${name}:${level}] ${String(msg).slice(0, 400)}`;
      logs[name].push(line);
      if (/error|fail|Peer|channel|closed|TRANSFER|connected|CRYPTO|path|Partition|removePeer|ready/i.test(line)) {
        console.log(line);
      }
    });
    await page.addInitScript(() => {
      const wrap = (level) => {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
          try {
            window.__ponsLog?.(level, args.map(a => {
              if (a instanceof Error) return a.stack || a.message;
              try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
            }).join(' '));
          } catch {}
          orig(...args);
        };
      };
      ['log','info','warn','error','debug'].forEach(wrap);
    });
  }

async function hardLoad(page) {
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.evaluate(async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch {}
    });
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

async function body(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || '');
  } catch {
    return '';
  }
}

async function main() {
  ensureFile(20);
  await setupRemote();

  const senderBrowser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  const receiverBrowser = await chromium.connectOverCDP(
    `http://127.0.0.1:${TUNNEL_PORT}`
  );

  const senderContext = await senderBrowser.newContext();
  const sender = await senderContext.newPage();
  const rctx =
    receiverBrowser.contexts()[0] || (await receiverBrowser.newContext());
  // Prefer a fresh page so console hooks are guaranteed.
  const receiver = await rctx.newPage();
  const logs = { sender: [], receiver: [] };
  const hook = (name, page) => {
    page.on('console', msg => {
      const text = msg.text();
      logs[name].push(`[console.${msg.type()}] ${text}`);
      if (/error|fail|Peer|channel|TRANSFER|connected/i.test(text)) {
        console.log(`[${name}] ${text.slice(0, 240)}`);
      }
    });
    page.on('pageerror', err => {
      logs[name].push(`[pageerror] ${err.message}`);
      console.log(`[${name} pageerror] ${err.message}`);
    });
  };
  hook('sender', sender);
  hook('receiver', receiver);
  // Re-create pages with init script for richer logs is hard after creation;
  // rely on page.on('console') plus periodic evaluate of transfer DOM.

  try {
    const cdp = await rctx.newCDPSession(receiver);
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: REMOTE_DL,
    });
  } catch (e) {
    console.log('[warn] download behavior', e.message);
  }

  console.log('[sender] open');
  await hardLoad(sender);
  await sleep(1000);
  await clickButton(sender, 'INITIALIZE LINK');
  await sleep(800);
  await clickButton(sender, 'SEND NOW');
  await sleep(800);
  await sender.locator('input[type=file]').first().setInputFiles(TEST_FILE);

  let senderText = '';
  for (let i = 0; i < 50; i++) {
    senderText = await body(sender);
    if (/WARP KEY/i.test(senderText)) break;
    await sleep(200);
  }
  const m = senderText.match(/WARP KEY\s*\n\s*([A-Z0-9]{4,10})/i);
  if (!m) throw new Error('room code missing\n' + senderText.slice(0, 800));
  const room = m[1];
  console.log(
    '[sender] room',
    room,
    '\n' + senderText.split('\n').slice(0, 18).join('\n')
  );

  console.log('[receiver] open/join');
  await hardLoad(receiver);
  await sleep(1000);
  await clickButton(receiver, 'INITIALIZE LINK');
  await sleep(800);
  await clickButton(receiver, 'CODE OR LINK');
  await sleep(600);
  await receiver.locator('input, textarea').first().fill(room);
  await sleep(200);
  await clickButton(receiver, 'ESTABLISH LINK');

  for (let i = 0; i < 60; i++) {
    const t = await body(receiver);
    if (t.includes('MATERIALIZE')) break;
    if (/FAILED|실패|CANCEL/i.test(t))
      throw new Error('join failed\n' + t.slice(0, 800));
    await sleep(250);
    if (i === 59) throw new Error('no MATERIALIZE\n' + t.slice(0, 800));
  }
  await clickButton(receiver, 'MATERIALIZE');
  console.log('[transfer] started');

  const t0 = Date.now();
  const samples = [];
  let status = 'TIMEOUT';
  let lastRecv = '';
  let lastSend = '';

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    lastRecv = await body(receiver);
    lastSend = await body(sender);
    const sm = lastRecv.match(/(\d+\.?\d*)\s*(MB|KB)\/s/i);
    if (sm) {
      const mbps = sm[2].toUpperCase() === 'MB' ? +sm[1] : +sm[1] / 1024;
      samples.push({ t: i + 1, mbps: +mbps.toFixed(3), raw: sm[0] });
      console.log(`[t+${i + 1}s] ${sm[0]}`);
    } else if (i % 5 === 0) {
      const r = lastRecv.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8).join(' | ');
      const s = lastSend.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 10).join(' | ');
      console.log(`[t+${i + 1}s] recv: ${r}`);
      console.log(`[t+${i + 1}s] send: ${s}`);
    }
    if (/COMPLETE|전송 완료|다운로드 완료/i.test(lastRecv)) {
      status = 'COMPLETE';
      break;
    }
    if (/FAILED|USER_CANCELLED|실패/i.test(lastRecv)) {
      status = 'FAILED';
      break;
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  const peak = samples.reduce((a, b) => Math.max(a, b.mbps), 0);
  const avg = samples.length
    ? samples.reduce((a, b) => a + b.mbps, 0) / samples.length
    : 0;
  const overall = status === 'COMPLETE' ? 20 / elapsed : avg;
  const result = {
    status,
    room,
    elapsedSec: +elapsed.toFixed(2),
    peakMBps: +peak.toFixed(3),
    avgMBps: +avg.toFixed(3),
    overallMBps: +overall.toFixed(3),
    overallMbps: +(overall * 8).toFixed(1),
    samples,
    senderTail: lastSend.split('\n').slice(0, 30),
    receiverTail: lastRecv.split('\n').slice(0, 30),
    senderLogs: logs.sender.slice(-40),
    receiverLogs: logs.receiver.slice(-40),
  };
  writeFileSync(
    '/tmp/ponswarp-lan-test-result.json',
    JSON.stringify(result, null, 2)
  );
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  await senderBrowser.close();
  try {
    await receiverBrowser.close();
  } catch {}
  sh0(`pkill -f "ssh.*-L ${TUNNEL_PORT}" || true`);
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE_PORT} || true'`);
  if (status !== 'COMPLETE') process.exit(2);
}

main().catch((e) => {
  console.error('[fatal]', e);
  sh0(`pkill -f "ssh.*-L ${TUNNEL_PORT}" || true`);
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE_PORT} || true'`);
  process.exit(1);
});
