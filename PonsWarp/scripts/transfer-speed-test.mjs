#!/usr/bin/env node
/**
 * WebRTC DataChannel throughput benchmark.
 * Single page with two RTCPeerConnections connected via manual signaling.
 */
import { chromium } from 'playwright';

const TEST_SIZE = 10 * 1024 * 1024; // 10MB
const CHUNK_SIZE = 192 * 1024; // 192KB

async function main() {
  console.log('=== PonsWarp LAN Transfer Speed Test ===');
  console.log(`Test size: ${TEST_SIZE / (1024 * 1024)} MB, Chunk: ${CHUNK_SIZE / 1024} KB\n`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();

    console.log('[1/3] Setting up WebRTC DataChannel...');

    // Single page, two peer connections - no BroadcastChannel needed
    const result = await page.evaluate(({ testSize, chunkSize }) => {
      return new Promise((resolve, reject) => {
        // Sender peer connection
        const pcSender = new RTCPeerConnection({ iceServers: [] });
        // Receiver peer connection
        const pcReceiver = new RTCPeerConnection({ iceServers: [] });

        // ICE candidate exchange
        pcSender.onicecandidate = (e) => {
          if (e.candidate) pcReceiver.addIceCandidate(e.candidate);
        };
        pcReceiver.onicecandidate = (e) => {
          if (e.candidate) pcSender.addIceCandidate(e.candidate);
        };

        // Create data channel on sender
        const dcSender = pcSender.createDataChannel('bench', { ordered: true });
        dcSender.binaryType = 'arraybuffer';

        let bytesReceived = 0;
        let startTime = 0;
        let chunks = 0;

        // Receiver data channel
        pcReceiver.ondatachannel = (e) => {
          const dcReceiver = e.channel;
          dcReceiver.binaryType = 'arraybuffer';

          dcReceiver.onmessage = (ev) => {
            if (!startTime) startTime = performance.now();
            bytesReceived += ev.data.byteLength;
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
        };

        // Create offer and connect
        pcSender.createOffer().then(offer => {
          return pcSender.setLocalDescription(offer).then(() => {
            return pcReceiver.setRemoteDescription(offer);
          });
        }).then(() => {
          return pcReceiver.createAnswer();
        }).then(answer => {
          return pcReceiver.setLocalDescription(answer).then(() => {
            return pcSender.setRemoteDescription(answer);
          });
        }).then(() => {
          // Send data when channel opens
          dcSender.onopen = () => {
            let sent = 0;
            const buf = new ArrayBuffer(chunkSize);
            new Uint8Array(buf).fill(0xAB);

            function sendMore() {
              while (sent < testSize) {
                if (dcSender.bufferedAmount > 4 * 1024 * 1024) {
                  dcSender.bufferedAmountLowThreshold = 1024 * 1024;
                  dcSender.onbufferedamountlow = () => {
                    dcSender.onbufferedamountlow = null;
                    sendMore();
                  };
                  return;
                }
                const size = Math.min(chunkSize, testSize - sent);
                dcSender.send(size === chunkSize ? buf : buf.slice(0, size));
                sent += size;
              }
            }
            sendMore();
          };
        }).catch(reject);

        setTimeout(() => reject(new Error('Transfer timeout (30s)')), 30000);
      });
    }, { testSize: TEST_SIZE, chunkSize: CHUNK_SIZE });

    console.log('[2/3] Transfer complete.');
    console.log('\n[3/3] RESULTS:');
    console.log(`  ✅ Throughput: ${result.throughputMBps} MB/s`);
    console.log(`  ⏱️  Time: ${result.elapsedMs} ms`);
    console.log(`  📦 Bytes: ${(result.bytes / (1024 * 1024)).toFixed(1)} MB`);
    console.log(`  📊 Chunks: ${result.chunks}`);
    console.log(`  📏 Avg chunk: ${(result.bytes / result.chunks / 1024).toFixed(1)} KB`);

    if (result.throughputMBps < 10) {
      console.log('\n  ⚠️  Below expected LAN throughput (>10 MB/s)');
    } else if (result.throughputMBps < 50) {
      console.log('\n  ℹ️  Moderate. Good for typical WiFi LAN.');
    } else {
      console.log('\n  🚀 Excellent! LAN optimizations working well.');
    }

  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
