#!/usr/bin/env node
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const TUNNEL = 9223;
const REMOTE = 9222;
const SIZE = 20 * 1024 * 1024;

const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sh0 = (c) => { try { return sh(c); } catch (e) { return e.stdout || ''; } };

async function setupRemote() {
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE} || true'`);
  await sleep(400);
  sh0(`ssh home 'mkdir -p /tmp/chrome-hd-raw; rm -rf /tmp/chrome-hd-raw/*'`);
  sh0(`ssh home 'nohup google-chrome --headless=new --remote-debugging-port=${REMOTE} --no-first-run --no-sandbox --disable-gpu --user-data-dir=/tmp/chrome-hd-raw --disable-features=WebRtcHideLocalIpsWithMdns --disable-background-timer-throttling --disable-renderer-backgrounding about:blank >/tmp/raw-dc.log 2>&1 </dev/null &'`);
  for (let i = 0; i < 40; i++) {
    const o = sh0(`ssh home 'curl -s http://127.0.0.1:${REMOTE}/json/version || true'`);
    if (o.includes('webSocketDebuggerUrl')) break;
    await sleep(200);
  }
  sh0(`pkill -f "ssh.*-L ${TUNNEL}" || true`);
  sh(`ssh -o ExitOnForwardFailure=yes -f -N -L ${TUNNEL}:127.0.0.1:${REMOTE} home`);
  for (let i = 0; i < 20; i++) {
    const o = sh0(`curl -s http://127.0.0.1:${TUNNEL}/json/version || true`);
    if (o.includes('webSocketDebuggerUrl')) return;
    await sleep(200);
  }
  throw new Error('remote CDP not ready');
}

async function runCase({ ordered, chunk, high, pcs }) {
  const local = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling'],
  });
  const remote = await chromium.connectOverCDP(`http://127.0.0.1:${TUNNEL}`);
  const offerPage = await (await local.newContext()).newPage();
  const rctx = remote.contexts()[0];
  const answerPage = rctx.pages()[0] || (await rctx.newPage());
  await offerPage.goto('https://example.com');
  await answerPage.goto('https://example.com');

  const q = { offer: [], answer: [] };
  await offerPage.exposeFunction('sigSend', (msg) => { q[msg.to].push(msg); });
  await answerPage.exposeFunction('sigSend', (msg) => { q[msg.to].push(msg); });
  await offerPage.exposeFunction('sigRecv', async (who) => {
    for (;;) {
      if (q[who].length) return q[who].shift();
      await new Promise((r) => setTimeout(r, 5));
    }
  });
  await answerPage.exposeFunction('sigRecv', async (who) => {
    for (;;) {
      if (q[who].length) return q[who].shift();
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  const params = { size: SIZE, chunk, high, ordered, pcs };
  const resultPromise = Promise.all([
    offerPage.evaluate(async (p) => {
      const pcs = [];
      const dcs = [];
      const openWaits = [];
      for (let i = 0; i < p.pcs; i++) {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcs.push(pc);
        pc.onicecandidate = (e) =>
          window.sigSend({ to: 'answer', type: 'ice', i, candidate: e.candidate });
        const dc = pc.createDataChannel('raw' + i, { ordered: p.ordered });
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = Math.floor(p.high / 4);
        dcs.push(dc);
        openWaits.push(new Promise((res) => (dc.onopen = res)));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        window.sigSend({ to: 'answer', type: 'offer', i, sdp: pc.localDescription });
      }
      (async () => {
        for (;;) {
          const msg = await window.sigRecv('offer');
          if (msg.type === 'ice' && msg.candidate) {
            try { await pcs[msg.i].addIceCandidate(msg.candidate); } catch {}
          } else if (msg.type === 'answer') {
            await pcs[msg.i].setRemoteDescription(msg.sdp);
          }
        }
      })();
      await Promise.all(openWaits);
      const start = performance.now();
      const buf = new Uint8Array(p.chunk);
      for (let i = 0; i < buf.length; i += 65536) {
        crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, buf.length)));
      }
      let sent = 0;
      let rr = 0;
      while (sent < p.size) {
        // pick lowest buffer dc
        let best = 0;
        let bestBuf = dcs[0].bufferedAmount;
        for (let i = 1; i < dcs.length; i++) {
          if (dcs[i].bufferedAmount < bestBuf) { best = i; bestBuf = dcs[i].bufferedAmount; }
        }
        const dc = dcs[best];
        while (dc.bufferedAmount > p.high) {
          await new Promise((r) => {
            const done = () => { dc.removeEventListener('bufferedamountlow', done); r(); };
            dc.addEventListener('bufferedamountlow', done);
            setTimeout(r, 4);
          });
        }
        const n = Math.min(p.chunk, p.size - sent);
        dc.send(n === p.chunk ? buf : buf.subarray(0, n));
        sent += n;
        rr++;
      }
      while (dcs.some((d) => d.bufferedAmount > 0)) await new Promise((r) => setTimeout(r, 5));
      const elapsed = (performance.now() - start) / 1000;
      for (const pc of pcs) pc.close();
      return { side: 'sender', sent, elapsed, Mbps: (sent * 8) / elapsed / 1e6, MBps: sent / elapsed / 1048576 };
    }, params),
    answerPage.evaluate(async (p) => {
      const pcs = [];
      const dcs = [];
      let bytes = 0;
      let start = 0;
      const done = new Promise((resolve) => {
        const onMsg = (e) => {
          if (!start) start = performance.now();
          bytes += e.data.byteLength || e.data.size || 0;
          if (bytes >= p.size) {
            const elapsed = (performance.now() - start) / 1000;
            resolve({ side: 'receiver', bytes, elapsed, Mbps: (bytes * 8) / elapsed / 1e6, MBps: bytes / elapsed / 1048576 });
          }
        };
        window.__onRaw = onMsg;
      });
      (async () => {
        for (;;) {
          const msg = await window.sigRecv('answer');
          if (msg.type === 'ice' && msg.candidate) {
            try { await pcs[msg.i].addIceCandidate(msg.candidate); } catch {}
          } else if (msg.type === 'offer') {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pcs[msg.i] = pc;
            pc.onicecandidate = (e) =>
              window.sigSend({ to: 'offer', type: 'ice', i: msg.i, candidate: e.candidate });
            pc.ondatachannel = (e) => {
              const dc = e.channel;
              dc.binaryType = 'arraybuffer';
              dc.onmessage = window.__onRaw;
              dcs.push(dc);
            };
            await pc.setRemoteDescription(msg.sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            window.sigSend({ to: 'offer', type: 'answer', i: msg.i, sdp: pc.localDescription });
          }
        }
      })();
      return await done;
    }, params),
  ]);
  const [sender, receiver] = await resultPromise;
  await local.close();
  try { await remote.close(); } catch {}
  return { sender, receiver };
}

await setupRemote();
const cases = [
  { name: '1pc-ordered-192k', ordered: true, chunk: 192*1024, high: 4*1024*1024, pcs: 1 },
  { name: '1pc-unordered-192k', ordered: false, chunk: 192*1024, high: 8*1024*1024, pcs: 1 },
  { name: '1pc-unordered-240k', ordered: false, chunk: 240*1024, high: 8*1024*1024, pcs: 1 },
  { name: '2pc-unordered-192k', ordered: false, chunk: 192*1024, high: 4*1024*1024, pcs: 2 },
  { name: '4pc-unordered-192k', ordered: false, chunk: 192*1024, high: 2*1024*1024, pcs: 4 },
];
const out = [];
for (const c of cases) {
  try {
    const r = await runCase(c);
    out.push({ ...c, ...r, ok: true });
    console.log(JSON.stringify({ case: c.name, senderMbps: r.sender.Mbps, receiverMbps: r.receiver.Mbps }));
  } catch (e) {
    out.push({ ...c, ok: false, error: String(e) });
    console.log(JSON.stringify({ case: c.name, error: String(e) }));
  }
  // cleanup between cases
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE} || true'`);
  sh0(`pkill -f "ssh.*-L ${TUNNEL}" || true`);
  await sleep(500);
  await setupRemote();
}
console.log('=== SUMMARY ===');
console.log(JSON.stringify(out, null, 2));
sh0(`pkill -f "ssh.*-L ${TUNNEL}" || true`);
sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE} || true'`);
