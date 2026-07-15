#!/usr/bin/env node
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const TUNNEL = 9223;
const REMOTE = 9222;
const SIZE = 30 * 1024 * 1024;
const CHUNK = 192 * 1024;

const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sh0 = (c) => { try { return sh(c); } catch (e) { return e.stdout || ''; } };

async function setupRemote() {
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE} || true'`);
  await sleep(400);
  sh0(`ssh home 'mkdir -p /tmp/chrome-hd-raw; rm -rf /tmp/chrome-hd-raw/*'`);
  sh0(`ssh home 'nohup google-chrome --headless=new --remote-debugging-port=${REMOTE} --no-first-run --no-sandbox --disable-gpu --user-data-dir=/tmp/chrome-hd-raw --disable-features=WebRtcHideLocalIpsWithMdns about:blank >/tmp/raw-dc.log 2>&1 </dev/null &'`);
  for (let i = 0; i < 40; i++) {
    if (sh0(`ssh home 'curl -s http://127.0.0.1:${REMOTE}/json/version'`).includes('Browser')) break;
    await sleep(250);
  }
  sh0(`pkill -f "ssh.*-L ${TUNNEL}" || true`);
  sh(`ssh -o ExitOnForwardFailure=yes -f -N -L ${TUNNEL}:127.0.0.1:${REMOTE} home`);
  for (let i = 0; i < 20; i++) {
    if (sh0(`curl -s http://127.0.0.1:${TUNNEL}/json/version`).includes('Browser')) break;
    await sleep(250);
  }
}

async function main() {
  await setupRemote();
  const local = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const remote = await chromium.connectOverCDP(`http://127.0.0.1:${TUNNEL}`);
  const offerPage = await (await local.newContext()).newPage();
  const rctx = remote.contexts()[0];
  const answerPage = rctx.pages()[0] || (await rctx.newPage());
  await offerPage.goto('https://example.com');
  await answerPage.goto('https://example.com');

  const q = { offer: [], answer: [] };
  await offerPage.exposeFunction('sigSend', (msg) => {
    q[msg.to].push(msg);
  });
  await answerPage.exposeFunction('sigSend', (msg) => {
    q[msg.to].push(msg);
  });
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

  const resultPromise = Promise.all([
    offerPage.evaluate(
      async ({ size, chunk }) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.onicecandidate = (e) =>
          window.sigSend({ to: 'answer', type: 'ice', candidate: e.candidate });
        (async () => {
          for (;;) {
            const msg = await window.sigRecv('offer');
            if (msg.type === 'ice' && msg.candidate) {
              try {
                await pc.addIceCandidate(msg.candidate);
              } catch {}
            } else if (msg.type === 'answer') {
              await pc.setRemoteDescription(msg.sdp);
            }
          }
        })();
        const dc = pc.createDataChannel('raw', { ordered: true });
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 1024 * 1024;
        const opened = new Promise((res) => (dc.onopen = res));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        window.sigSend({ to: 'answer', type: 'offer', sdp: pc.localDescription });
        await opened;
        const start = performance.now();
        const buf = new Uint8Array(chunk);
        for (let i = 0; i < buf.length; i += 65536) {
          crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, buf.length)));
        }
        let sent = 0;
        while (sent < size) {
          while (dc.bufferedAmount > 4 * 1024 * 1024) {
            await new Promise((r) => {
              const done = () => {
                dc.removeEventListener('bufferedamountlow', done);
                r();
              };
              dc.addEventListener('bufferedamountlow', done);
              setTimeout(r, 5);
            });
          }
          const n = Math.min(chunk, size - sent);
          dc.send(n === chunk ? buf : buf.subarray(0, n));
          sent += n;
        }
        while (dc.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 5));
        const elapsed = (performance.now() - start) / 1000;
        return {
          side: 'sender',
          sent,
          elapsed,
          MBps: sent / elapsed / 1048576,
          Mbps: (sent * 8) / elapsed / 1e6,
        };
      },
      { size: SIZE, chunk: CHUNK }
    ),
    answerPage.evaluate(
      async ({ size }) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.onicecandidate = (e) =>
          window.sigSend({ to: 'offer', type: 'ice', candidate: e.candidate });
        (async () => {
          for (;;) {
            const msg = await window.sigRecv('answer');
            if (msg.type === 'ice' && msg.candidate) {
              try {
                await pc.addIceCandidate(msg.candidate);
              } catch {}
            } else if (msg.type === 'offer') {
              await pc.setRemoteDescription(msg.sdp);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              window.sigSend({
                to: 'offer',
                type: 'answer',
                sdp: pc.localDescription,
              });
            }
          }
        })();
        const dc = await new Promise((res) => {
          pc.ondatachannel = (e) => res(e.channel);
        });
        dc.binaryType = 'arraybuffer';
        let bytes = 0;
        let start = 0;
        return await new Promise((resolve) => {
          dc.onmessage = (e) => {
            if (!start) start = performance.now();
            bytes += e.data.byteLength;
            if (bytes >= size) {
              const elapsed = (performance.now() - start) / 1000;
              resolve({
                side: 'receiver',
                bytes,
                elapsed,
                MBps: bytes / elapsed / 1048576,
                Mbps: (bytes * 8) / elapsed / 1e6,
              });
            }
          };
        });
      },
      { size: SIZE }
    ),
  ]);

  const [sender, receiver] = await resultPromise;
  console.log(JSON.stringify({ sender, receiver }, null, 2));
  await local.close();
  try {
    await remote.close();
  } catch {}
  sh0(`pkill -f "ssh.*-L ${TUNNEL}" || true`);
  sh0(`ssh home 'pkill -f remote-debugging-port=${REMOTE} || true'`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
