#!/usr/bin/env node
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const APP = `https://warp.ponslink.com/?automation=1&v=${Date.now()}`;
const TEST_FILE = '/tmp/ponswarp-lan-test-20mb.bin';
const REMOTE_DL = '/tmp/chrome-downloads';
const TUNNEL_PORT = 9223;
const REMOTE_PORT = 9222;
// home has stronger Wi-Fi TX; default sender=local is the weak uplink.
const HOME_SENDER = process.env.HOME_SENDER !== '0';
const REMOTE_TEST_FILE = '/tmp/ponswarp-lan-test-20mb.bin';
const CHROME_ARGS =
  '--headless=new --remote-debugging-port=9222 --no-first-run --no-sandbox --disable-gpu --user-data-dir=/tmp/chrome-hd-clean --disable-features=WebRtcHideLocalIpsWithMdns,Translate,MediaRouter --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --enable-features=NetworkServiceInProcess2';

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

  const localBrowser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const remoteBrowser = await chromium.connectOverCDP(
    `http://127.0.0.1:${TUNNEL_PORT}`
  );

  let sender;
  let receiver;
  let senderBrowser;
  let receiverBrowser;
  let localPage;
  let remotePage;

  const rctx = remoteBrowser.contexts()[0] || (await remoteBrowser.newContext());
  remotePage = rctx.pages()[0] || (await rctx.newPage());
  localPage = await (await localBrowser.newContext()).newPage();

  if (HOME_SENDER) {
    // Stronger radio (home) sends; local receives.
    sender = remotePage;
    receiver = localPage;
    senderBrowser = remoteBrowser;
    receiverBrowser = localBrowser;
    console.log('[roles] sender=HOME receiver=LOCAL');
  } else {
    sender = localPage;
    receiver = remotePage;
    senderBrowser = localBrowser;
    receiverBrowser = remoteBrowser;
    console.log('[roles] sender=LOCAL receiver=HOME');
  }

  try {
    const cdp = await receiver.context().newCDPSession(receiver);
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: HOME_SENDER ? '/tmp/chrome-downloads-local' : REMOTE_DL,
    });
  } catch (e) {
    console.log('[warn] download behavior', e.message);
  }
  if (HOME_SENDER) {
    sh0('mkdir -p /tmp/chrome-downloads-local');
  }

  console.log('[sender] open');
  await sender.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1000);
  await clickButton(sender, 'INITIALIZE LINK');
  await sleep(800);
  await clickButton(sender, 'SEND NOW');
  await sleep(800);
  // Playwright uploads this local path into whichever browser owns the page
  // (including remote CDP), so no manual scp is required.
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
  await receiver.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
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

  // One-shot path diagnostics (best effort).
  try {
    const diag = await sender.evaluate(() => {
      const g = globalThis;
      const sm = g.__ponswarpSwarm || null;
      return {
        hasSwarm: !!sm,
        qa: sm && typeof sm.getQaDiagnostics === 'function' ? sm.getQaDiagnostics() : null,
      };
    });
    console.log('[diag]', JSON.stringify(diag));
  } catch (e) {
    console.log('[diag] unavailable', String(e).slice(0, 120));
  }

  const t0 = Date.now();
  const samples = [];
  let status = 'TIMEOUT';
  let lastRecv = '';
  let lastSend = '';

  for (let i = 0; i < 90; i++) {
    // Lightweight poll: avoid full body.innerText every second (starves WebRTC).
    await sleep(500);
    let snap = { text: '', speed: null, done: false, failed: false };
    try {
      snap = await receiver.evaluate(() => {
        const t = document.body ? document.body.innerText : '';
        const speed = t.match(/(\d+\.?\d*)\s*(MB|KB)\/s/i);
        const done = /(?:^|\n)\s*(?:COMPLETE|전송 완료|다운로드 완료)\b|MATERIALIZED|File reconstruction complete|All transfers have been completed/i.test(t);
        const failed = /FAILED|USER_CANCELLED|실패|CONNECTION FAILED/i.test(t);
        // Only return a short tail to keep CDP payload small.
        return {
          text: t.slice(0, 400),
          speed: speed ? speed[0] : null,
          unit: speed ? speed[2] : null,
          val: speed ? speed[1] : null,
          done,
          failed,
        };
      });
    } catch (e) {
      // ignore transient CDP errors
    }
    lastRecv = snap.text || lastRecv;
    if (i === 4) {
      try {
        const mid = await sender.evaluate(() => {
          const sm = globalThis.__ponswarpSwarm;
          return sm && sm.getQaDiagnostics ? sm.getQaDiagnostics() : null;
        });
        console.log('[mid-diag]', JSON.stringify(mid));
      } catch {}
    }
    if (snap.speed && snap.val) {
      const mbps = String(snap.unit).toUpperCase() === 'MB' ? +snap.val : +snap.val / 1024;
      samples.push({ t: (i + 1) * 0.5, mbps: +mbps.toFixed(3), raw: snap.speed });
      if (i % 2 === 0) console.log(`[t+${((i + 1) * 0.5).toFixed(1)}s] ${snap.speed}`);
    } else if (i % 10 === 0) {
      console.log(`[t+${((i + 1) * 0.5).toFixed(1)}s] waiting | ${String(lastRecv).split('\n').map(x=>x.trim()).filter(Boolean).slice(0,4).join(' | ')}`);
    }
    if (snap.done) {
      status = 'COMPLETE';
      break;
    }
    if (snap.failed) {
      status = 'FAILED';
      break;
    }
  }
  // Final full tails only once.
  try { lastRecv = await body(receiver); } catch {}
  try { lastSend = await body(sender); } catch {}

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
  };
  writeFileSync(
    '/tmp/ponswarp-lan-test-result.json',
    JSON.stringify(result, null, 2)
  );
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  try { await localBrowser.close(); } catch {}
  try { await remoteBrowser.close(); } catch {}
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
