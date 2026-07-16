#!/usr/bin/env node
/**
 * Native WebRTC control+bulk DataChannel throughput microbench.
 * Proves browser SCTP ceiling without app protocol overhead.
 */
import { chromium } from 'playwright';

const TEST_SIZE = Number(process.env.BENCH_BYTES || 32 * 1024 * 1024);
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 240 * 1024);
const HIGH_WATER = Number(process.env.HIGH_WATER || 32 * 1024 * 1024);
const LOW_WATER = Number(process.env.LOW_WATER || 8 * 1024 * 1024);

async function main() {
  console.log('=== Native control+bulk DataChannel bench ===');
  console.log(`size=${(TEST_SIZE / 1024 / 1024).toFixed(1)}MB chunk=${CHUNK_SIZE} high=${HIGH_WATER}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--use-fake-ui-for-media-stream'],
  });

  try {
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('[page]', msg.text());
    });

    const result = await page.evaluate(
      async ({ TEST_SIZE, CHUNK_SIZE, HIGH_WATER, LOW_WATER }) => {
        function waitIce(pc) {
          return new Promise(resolve => {
            if (pc.iceGatheringState === 'complete') return resolve();
            pc.onicegatheringstatechange = () => {
              if (pc.iceGatheringState === 'complete') resolve();
            };
          });
        }

        const a = new RTCPeerConnection({ iceServers: [] });
        const b = new RTCPeerConnection({ iceServers: [] });

        a.onicecandidate = e => {
          if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {});
        };
        b.onicecandidate = e => {
          if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {});
        };

        // Control + bulk channels on initiator
        const controlA = a.createDataChannel('control', { ordered: true });
        const bulkA = a.createDataChannel('bulk-0', {
          ordered: true,
          bufferedAmountLowThreshold: LOW_WATER,
        });
        controlA.binaryType = 'arraybuffer';
        bulkA.binaryType = 'arraybuffer';

        let controlB = null;
        let bulkB = null;
        b.ondatachannel = ev => {
          const ch = ev.channel;
          ch.binaryType = 'arraybuffer';
          if (ch.label === 'control') controlB = ch;
          if (ch.label.startsWith('bulk')) bulkB = ch;
        };

        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await waitIce(a);
        await b.setRemoteDescription(a.localDescription);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await waitIce(b);
        await a.setRemoteDescription(b.localDescription);

        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('channel open timeout')), 15000);
          const check = () => {
            if (
              controlA.readyState === 'open' &&
              bulkA.readyState === 'open' &&
              controlB?.readyState === 'open' &&
              bulkB?.readyState === 'open'
            ) {
              clearTimeout(t);
              resolve();
            }
          };
          for (const ch of [controlA, bulkA]) {
            ch.onopen = check;
          }
          const iv = setInterval(() => {
            check();
            if (
              controlA.readyState === 'open' &&
              bulkA.readyState === 'open' &&
              controlB?.readyState === 'open' &&
              bulkB?.readyState === 'open'
            ) {
              clearInterval(iv);
            }
          }, 20);
        });

        // Control path smoke
        await new Promise(resolve => {
          controlB.onmessage = () => resolve();
          controlA.send(JSON.stringify({ type: 'PING' }));
        });

        let received = 0;
        const recvDone = new Promise(resolve => {
          bulkB.onmessage = ev => {
            const n =
              ev.data instanceof ArrayBuffer
                ? ev.data.byteLength
                : ev.data.byteLength || 0;
            received += n;
            if (received >= TEST_SIZE) resolve(performance.now());
          };
        });

        const start = performance.now();
        let sent = 0;
        const payload = new Uint8Array(CHUNK_SIZE);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

        while (sent < TEST_SIZE) {
          // Stay well under browser send-queue hard limit.
          while (bulkA.bufferedAmount > HIGH_WATER) {
            await new Promise(r => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                bulkA.onbufferedamountlow = null;
                r();
              };
              bulkA.bufferedAmountLowThreshold = LOW_WATER;
              bulkA.onbufferedamountlow = done;
              setTimeout(done, 2);
            });
          }
          const left = TEST_SIZE - sent;
          const n = Math.min(CHUNK_SIZE, left);
          try {
            bulkA.send(n === CHUNK_SIZE ? payload : payload.subarray(0, n));
          } catch (e) {
            // Queue full — wait and retry same chunk.
            await new Promise(r => setTimeout(r, 5));
            continue;
          }
          sent += n;
        }

        const end = await recvDone;
        const ms = end - start;
        const MBps = TEST_SIZE / 1024 / 1024 / (ms / 1000);

        // path diagnostics
        const stats = await a.getStats();
        let pathKind = 'unknown';
        let rttMs = null;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
            if (report.currentRoundTripTime != null) {
              rttMs = report.currentRoundTripTime * 1000;
            }
          }
          if (report.type === 'local-candidate' && report.candidateType === 'host') {
            pathKind = 'host';
          }
        });

        a.close();
        b.close();
        return { ms, MBps, received, pathKind, rttMs, sent };
      },
      { TEST_SIZE, CHUNK_SIZE, HIGH_WATER, LOW_WATER }
    );

    console.log(JSON.stringify(result, null, 2));
    console.log(`Throughput: ${result.MBps.toFixed(2)} MB/s`);
    if (result.MBps < 8) {
      console.log('NOTE: raw bench < 8 MB/s — environment may be the ceiling');
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
