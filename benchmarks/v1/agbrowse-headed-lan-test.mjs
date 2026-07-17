#!/usr/bin/env node
/**
 * Real headed Chrome LAN transfer via agbrowse CDP on two machines.
 * local (this host)  = SENDER   CDP :9222
 * ssh home (laptop)  = RECEIVER CDP :9222 (tunneled to local :9223)
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
// Prefer project playwright, then agbrowse's playwright-core.
let chromium;
try {
  ({ chromium } = require('/home/declan/Documents/Develop/ponswarp/PonsWarp/node_modules/playwright'));
} catch {
  ({ chromium } = require('/home/declan/.nvm/versions/node/v24.15.0/lib/node_modules/agbrowse/node_modules/playwright-core'));
}

const APP = `https://warp.ponslink.com/?automation=1&nocache=1&headed=1&v=${Date.now()}`;
const TEST_FILE = process.env.TEST_FILE || '/tmp/ponswarp-lan-test-50mb.bin';
const REMOTE_DL = '/tmp/chrome-downloads-agbrowse';
const LOCAL_CDP = 9222;
const TUNNEL_PORT = 9223;
const REMOTE_PORT = 9222;
const FILE_MB = Number(process.env.FILE_MB || 50);

const sh = (cmd) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sh0 = (cmd) => {
  try {
    return sh(cmd);
  } catch (e) {
    return e.stdout || e.stderr || String(e.message || e);
  }
};

function ensureFile(mb = FILE_MB) {
  if (!existsSync(TEST_FILE) || !existsSync(TEST_FILE)) {
    console.log(`[setup] create ${mb}MB file`);
    sh(`dd if=/dev/urandom of=${TEST_FILE} bs=1M count=${mb} status=none`);
  }
  // also ensure on remote for symmetry (not required for receive)
  sh0(
    `ssh home 'test -f ${TEST_FILE} || dd if=/dev/urandom of=${TEST_FILE} bs=1M count=${mb} status=none'`
  );
}

async function waitCdp(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const out = sh0(`curl -s ${url}`);
    if (out.includes('Browser')) return true;
    await sleep(250);
  }
  return false;
}

function ensureLocalAgbrowse() {
  const ok = sh0(`curl -s http://127.0.0.1:${LOCAL_CDP}/json/version`);
  if (ok.includes('Browser')) {
    console.log('[setup] local headed CDP already up');
    return;
  }
  console.log('[setup] starting local agbrowse headed');
  sh0(`export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"; agbrowse stop || true`);
  sh(
    `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"; agbrowse start --headed --port ${LOCAL_CDP}`
  );
}

function ensureRemoteAgbrowse() {
  console.log('[setup] remote headed CDP (home)');
  const remoteCmd = `
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:/usr/bin:$PATH"
export DISPLAY=:0
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
AUTH=\$(ps e -u declan 2>/dev/null | tr ' ' '\\n' | grep '^XAUTHORITY=' | head -1 | cut -d= -f2)
export XAUTHORITY=\${AUTH:-/run/user/1000/.mutter-Xwaylandauth.0PGCS3}
if curl -s http://127.0.0.1:${REMOTE_PORT}/json/version | grep -q Browser; then
  echo remote-cdp-ready
  exit 0
fi
agbrowse stop 2>/dev/null || true
rm -f /home/declan/.browser-agent/profile.lock
agbrowse start --headed --port ${REMOTE_PORT}
`.trim();
  console.log(sh0(`ssh home bash -lc ${JSON.stringify(remoteCmd)}`));
  if (!sh0(`ssh home 'curl -s http://127.0.0.1:${REMOTE_PORT}/json/version'`).includes('Browser')) {
    throw new Error('remote headed CDP not ready');
  }
  sh0(`pkill -f "ssh.*-L ${TUNNEL_PORT}" || true`);
  sh(
    `ssh -o ExitOnForwardFailure=yes -f -N -L ${TUNNEL_PORT}:127.0.0.1:${REMOTE_PORT} home`
  );
  if (!(waitCdpSync(`http://127.0.0.1:${TUNNEL_PORT}/json/version`))) {
    throw new Error('tunnel to home CDP failed');
  }
  console.log('[setup] remote headed ready via tunnel');
}

function waitCdpSync(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const out = sh0(`curl -s ${url}`);
    if (out.includes('Browser')) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return false;
}

async function clickButton(page, pattern, timeout = 15000) {
  const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
  await page.getByRole('button', { name: re }).first().click({ timeout });
}

async function hardLoad(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
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

async function attachPage(browser, role) {
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (/error|fail|Peer|channel|TRANSFER|connected|path=|CRYPTO|Partition/i.test(text)) {
      console.log(`[${role}] ${text.slice(0, 260)}`);
    }
  });
  page.on('pageerror', (err) => {
    console.log(`[${role} pageerror] ${err.message}`);
  });
  return { ctx, page };
}

async function main() {
  ensureFile(FILE_MB);
  ensureLocalAgbrowse();
  ensureRemoteAgbrowse();

  if (!(await waitCdp(`http://127.0.0.1:${LOCAL_CDP}/json/version`))) {
    throw new Error('local CDP missing');
  }

  console.log('[connect] local sender + remote receiver headed chromes');
  const senderBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${LOCAL_CDP}`);
  const receiverBrowser = await chromium.connectOverCDP(
    `http://127.0.0.1:${TUNNEL_PORT}`
  );

  const { page: sender } = await attachPage(senderBrowser, 'sender');
  const { ctx: rctx, page: receiver } = await attachPage(receiverBrowser, 'receiver');

  try {
    const cdp = await rctx.newCDPSession(receiver);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: REMOTE_DL,
      eventsEnabled: true,
    });
  } catch (e) {
    try {
      const cdp = await rctx.newCDPSession(receiver);
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: REMOTE_DL,
      });
    } catch (e2) {
      console.log('[warn] download behavior', e2.message || e.message);
    }
  }
  sh0(`ssh home 'mkdir -p ${REMOTE_DL}'`);

  console.log('[sender] open headed');
  await hardLoad(sender);
  await sleep(1000);
  await clickButton(sender, 'INITIALIZE LINK');
  await sleep(800);
  await clickButton(sender, 'SEND NOW');
  await sleep(800);
  // Playwright caps setInputFiles over CDP at 50MB; use CDP DOM.setFileInputFiles for local path.
  {
    const sctx = sender.context();
    const cdp = await sctx.newCDPSession(sender);
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'input[type=file]',
    });
    if (!nodeId) throw new Error('file input not found for CDP upload');
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [TEST_FILE] });
    console.log('[sender] file attached via CDP', TEST_FILE);
  }

  let senderText = '';
  for (let i = 0; i < 50; i++) {
    senderText = await body(sender);
    if (/WARP KEY/i.test(senderText)) break;
    await sleep(200);
  }
  const m = senderText.match(/WARP KEY\s*\n\s*([A-Z0-9]{4,10})/i);
  if (!m) throw new Error('room code missing\n' + senderText.slice(0, 800));
  const room = m[1];
  console.log('[sender] room', room);

  console.log('[receiver] open/join headed on home');
  await hardLoad(receiver);
  await sleep(1000);
  await clickButton(receiver, 'INITIALIZE LINK');
  await sleep(800);
  await clickButton(receiver, 'CODE OR LINK');
  await sleep(600);
  await receiver.locator('input, textarea').first().fill(room);
  await sleep(200);
  await clickButton(receiver, 'ESTABLISH LINK');

  for (let i = 0; i < 80; i++) {
    const t = await body(receiver);
    if (t.includes('MATERIALIZE')) break;
    if (/FAILED|실패|CANCEL/i.test(t)) throw new Error('join failed\n' + t.slice(0, 800));
    await sleep(250);
    if (i === 79) throw new Error('no MATERIALIZE\n' + t.slice(0, 800));
  }
  await clickButton(receiver, 'MATERIALIZE');
  console.log('[transfer] started (headed browsers)');

  const t0 = Date.now();
  const samples = [];
  let status = 'TIMEOUT';
  let lastRecv = '';
  let lastSend = '';

  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    lastRecv = await body(receiver);
    lastSend = await body(sender);
    const sm = lastRecv.match(/(\d+\.?\d*)\s*(MB|KB)\/s/i) || lastSend.match(/(\d+\.?\d*)\s*(MB|KB)\/s/i);
    if (sm) {
      const mbps = sm[2].toUpperCase() === 'MB' ? +sm[1] : +sm[1] / 1024;
      samples.push({ t: i + 1, mbps: +mbps.toFixed(3), raw: sm[0] });
      console.log(`[t+${i + 1}s] ${sm[0]}`);
    } else if (i % 5 === 0) {
      const r = lastRecv
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 8)
        .join(' | ');
      const s = lastSend
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join(' | ');
      console.log(`[t+${i + 1}s] recv: ${r}`);
      console.log(`[t+${i + 1}s] send: ${s}`);
    }
    if (/COMPLETE|전송 완료|다운로드 완료|MATERIALIZED/i.test(lastRecv) && /SUCCESS|COMPLETE|전송 완료/i.test(lastSend + lastRecv)) {
      // Prefer terminal success; MATERIALIZED alone is also success for receiver path.
      status = 'COMPLETE';
      break;
    }
    if (/MATERIALIZED/i.test(lastRecv) && !/FAILED/i.test(lastRecv)) {
      status = 'COMPLETE';
      break;
    }
    if (/FAILED|USER_CANCELLED|실패/i.test(lastRecv + lastSend)) {
      status = 'FAILED';
      break;
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  const peak = samples.reduce((a, b) => Math.max(a, b.mbps), 0);
  const avg = samples.length
    ? samples.reduce((a, b) => a + b.mbps, 0) / samples.length
    : 0;
  const overall = status === 'COMPLETE' ? FILE_MB / elapsed : avg;
  const result = {
    mode: 'agbrowse-headed-two-device',
    status,
    room,
    fileMB: FILE_MB,
    elapsedSec: +elapsed.toFixed(2),
    peakMBps: +peak.toFixed(3),
    avgMBps: +avg.toFixed(3),
    overallMBps: +overall.toFixed(3),
    overallMbps: +(overall * 8).toFixed(1),
    samples,
    senderTail: lastSend.split('\n').slice(0, 30),
    receiverTail: lastRecv.split('\n').slice(0, 30),
    senderHost: sh0('hostname').trim(),
    receiverHost: sh0('ssh home hostname').trim(),
  };
  writeFileSync('/tmp/ponswarp-headed-lan-result.json', JSON.stringify(result, null, 2));
  console.log('\n=== HEADED RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  // Leave browsers open for visual inspection; only close playwright connections.
  try {
    await senderBrowser.close();
  } catch {}
  try {
    await receiverBrowser.close();
  } catch {}
  sh0(`pkill -f "ssh.*-L ${TUNNEL_PORT}" || true`);
  if (status !== 'COMPLETE') process.exit(2);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
