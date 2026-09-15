#!/usr/bin/env node
/**
 * LAN DataChannel throughput benchmark.
 * Two browser pages connected via WebRTC, measuring raw transfer speed.
 */
import { chromium } from 'playwright';

const APP_URL = 'http://localhost:5173';
const TEST_SIZE = 10 * 1024 * 1024; // 10MB
const CHUNK_SIZE = 192 * 1024; // 192KB

async function main() {
  console.log('=== PonsWarp LAN Transfer Speed Test ===');
  console.log(`Test size: ${TEST_SIZE / (1024 * 1024)} MB, Chunk: ${CHUNK_SIZE / 1024} KB\n`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    const ctx = await browser.newContext();
    const senderPage = await ctx.newPage();
    const receiverPage = await ctx.newPage();

    console.log('[1/4] Loading pages...');
    await Promise.all([
      senderPage.goto(APP_URL, { waitUntil: 'load', timeout: 15000 }),
      receiverPage.goto(APP_URL, { waitUntil: 'load', timeout: 15000 }),
    ]);

    console.log('[2/4] Setting up WebRTC DataChannel...');

    // Shared signaling via BroadcastChannel (same-origin)
    const receiverResult = receiverPage.evaluate((args) => {
      return new Promise((resolve, reject) => {
        const { testSize, chunkSize } = args;
        const ch = new BroadcastChannel('bench-rtc');
        const pc = new RTCPeerConnection({ iceServers: [] });
        const dc = pc.createDataChannel('bench', { ordered: true });

        dc.binaryType = 'arraybuffer';

        let bytesReceived = 0;
        let startTime = 0;
        let chunks = 0;

        dc.onmessage = (e) => {
          if (!startTime) startTime = performance.now();
          bytesReceived += e.data.byteLength;
          chunks++;
          if (bytesReceived >= testSize) {
            const elapsed = performance.now() - startTime;
            resolve({
              bytes: bytesReceived,
              elapsedMs: Math.round(elapsed),
              throughputMBps: +((bytesReceived / (1024 * 1024)) / (elapsed / 1000)).toFixed(1),
              chunks,
            });
          }
        };

        ch.onmessage = async (ev) => {
          const { type, data } = ev.data;
          if (type === 'answer') await pc.setRemoteDescription(data);
          else if (type === 'ice') await pc.addIceCandidate(data);
        };

        pc.onicecandidate = (e) => {
          if (e.candidate) ch.postMessage({ type: 'ice', data: e.candidate });
        };

        pc.createOffer().then((offer) => pc.setLocalDescription(offer).then(() => {
          ch.postMessage({ type: 'offer', data: offer });
        }));

        setTimeout(() => reject(new Error('Receiver timeout')), 60000);
      });
    }, { testSize: TEST_SIZE, chunkSize: CHUNK_SIZE });

    await new Promise(r => setTimeout(r, 300));

    const senderDone = senderPage.evaluate((args) => {
      return new Promise((resolve) => {
        const { testSize, chunkSize } = args;
        const ch = new BroadcastChannel('bench-rtc');
        const pc = new RTCPeerConnection({ iceServers: [] });

        ch.onmessage = async (ev) => {
          const { type, data } = ev.data;
          if (type === 'offer') {
            await pc.setRemoteDescription(data);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ch.postMessage({ type: 'answer', data: answer });
          } else if (type === 'ice') {
            await pc.addIceCandidate(data);
          }
        };

        pc.onicecandidate = (e) => {
          if (e.candidate) ch.postMessage({ type: 'ice', data: e.candidate });
        };

        pc.ondatachannel = (e) => {
          const dc = e.channel;
          dc.onopen = () => {
            let sent = 0;
            const buf = new ArrayBuffer(chunkSize);
            new Uint8Array(buf).fill(0xAB);

            function sendMore() {
              while (sent < testSize) {
                if (dc.bufferedAmount > 4 * 1024 * 1024) {
                  dc.bufferedAmountLowThreshold = 1024 * 1024;
                  dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; sendMore(); };
                  return;
                }
                const size = Math.min(chunkSize, testSize - sent);
                dc.send(size === chunkSize ? buf : buf.slice(0, size));
                sent += size;
              }
            }
            sendMore();
          };
        };

        setTimeout(() => resolve({ senderDone: true }), 60000);
      });
    }, { testSize: TEST_SIZE, chunkSize: CHUNK_SIZE });

    console.log('[3/4] Transferring...');
    const result = await Promise.race([receiverResult, senderDone]);

    if (result.throughputMBps) {
      console.log('\n[4/4] RESULTS:');
      console.log(`  ✅ Throughput: ${result.throughputMBps} MB/s`);
      console.log(`  Time: ${result.elapsedMs} ms`);
      console.log(`  Bytes: ${(result.bytes / (1024 * 1024)).toFixed(1)} MB`);
      console.log(`  Chunks: ${result.chunks}`);
      console.log(`  Avg chunk: ${(result.bytes / result.chunks / 1024).toFixed(1)} KB`);
    } else {
      console.error('Sender completed but no receiver data');
    }

  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
