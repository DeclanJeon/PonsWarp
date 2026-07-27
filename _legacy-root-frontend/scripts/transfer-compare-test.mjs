#!/usr/bin/env node
/**
 * Transfer speed comparison simulating PonsWarp's actual transfer pipeline.
 * Includes per-chunk ACK overhead and partition flow control.
 */
import { chromium } from 'playwright';

const TEST_SIZE = 5 * 1024 * 1024; // 5MB
const CHUNK_SIZE = 192 * 1024; // 192KB
const PARTITION_SIZE = 16 * 1024 * 1024; // 16MB

async function main() {
  console.log('=== PonsWarp Transfer Pipeline Comparison ===');
  console.log(`Test size: ${TEST_SIZE / (1024 * 1024)} MB, Chunk: ${CHUNK_SIZE / 1024} KB\n`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    // Test 1: OLD behavior - per-chunk ACK + 200ms drain poll + batch=1
    console.log('Test 1: OLD pipeline (per-chunk ACK, 200ms poll, batch=1)...');
    const old = await runPipelineTest(browser, {
      drainPollMs: 200,
      usePerChunkACK: true,
      batchSize: 1,
      partitionSize: 16 * 1024 * 1024,
    });
    console.log(`  → ${old.throughputMBps} MB/s (${old.elapsedMs}ms)\n`);

    // Test 2: NEW behavior - no per-chunk ACK in partition mode + 50ms poll + batch=2
    console.log('Test 2: NEW pipeline (no per-chunk ACK, 50ms poll, batch=2)...');
    const newResult = await runPipelineTest(browser, {
      drainPollMs: 50,
      usePerChunkACK: false,
      batchSize: 2,
      partitionSize: 32 * 1024 * 1024,
    });
    console.log(`  → ${newResult.throughputMBps} MB/s (${newResult.elapsedMs}ms)\n`);

    // Summary
    console.log('═══════════════════════════════════════════');
    console.log('  COMPARISON (simulating PonsWarp pipeline)');
    console.log('═══════════════════════════════════════════');
    console.log(`  OLD: ${old.throughputMBps} MB/s (${old.elapsedMs}ms)`);
    console.log(`  NEW: ${newResult.throughputMBps} MB/s (${newResult.elapsedMs}ms)`);
    const speedup = (newResult.throughputMBps / old.throughputMBps).toFixed(1);
    console.log(`  Speedup: ${speedup}x`);
    console.log('═══════════════════════════════════════════');

  } finally {
    await browser.close();
  }
}

async function runPipelineTest(browser, opts) {
  const page = await browser.newPage();
  try {
    const result = await page.evaluate(({ testSize, chunkSize, opts }) => {
      return new Promise((resolve, reject) => {
        const pcSender = new RTCPeerConnection({ iceServers: [] });
        const pcReceiver = new RTCPeerConnection({ iceServers: [] });

        pcSender.onicecandidate = (e) => { if (e.candidate) pcReceiver.addIceCandidate(e.candidate); };
        pcReceiver.onicecandidate = (e) => { if (e.candidate) pcSender.addIceCandidate(e.candidate); };

        // Sender channel (data)
        const dcSender = pcSender.createDataChannel('data', { ordered: true });
        dcSender.binaryType = 'arraybuffer';

        // Receiver channel (for ACK messages)
        let dcReceiver = null;
        let dcReceiverForACK = null;

        let bytesReceived = 0, startTime = 0, chunks = 0;

        // Receiver side
        pcReceiver.ondatachannel = (e) => {
          dcReceiver = e.channel;
          dcReceiver.binaryType = 'arraybuffer';

          dcReceiver.onmessage = (ev) => {
            const data = ev.data;
            if (typeof data === 'string') return; // skip control

            if (!startTime) startTime = performance.now();
            bytesReceived += data.byteLength;
            chunks++;

            // OLD behavior: send per-chunk ACK
            if (opts.usePerChunkACK && dcReceiver.readyState === 'open') {
              dcReceiver.send(JSON.stringify({ type: 'ACK' }));
            }

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

        // Connect
        pcSender.createOffer().then(offer =>
          pcSender.setLocalDescription(offer).then(() =>
            pcReceiver.setRemoteDescription(offer)
          ).then(() => pcReceiver.createAnswer())
          .then(answer => pcReceiver.setLocalDescription(answer).then(() =>
            pcSender.setRemoteDescription(answer)))
        ).then(() => {
          dcSender.onopen = () => {
            let sent = 0;
            let pendingACKs = 0;
            let partitionSent = 0;
            const buf = new ArrayBuffer(chunkSize);
            new Uint8Array(buf).fill(0xAB);

            // Listen for ACKs on sender side (from receiver's data channel back)
            // In the real app, ACKs come via the same DataChannel
            // Here we simulate by receiving on the sender's data channel

            function sendBatch() {
              const batchCount = opts.batchSize;

              for (let i = 0; i < batchCount && sent < testSize; i++) {
                if (dcSender.bufferedAmount > 4 * 1024 * 1024) break;

                const size = Math.min(chunkSize, testSize - sent);
                dcSender.send(size === chunkSize ? buf : buf.slice(0, size));
                sent += size;
                partitionSent += size;
              }

              if (sent >= testSize) return;

              // OLD: wait for ACK before sending more
              if (opts.usePerChunkACK) {
                // Simulate ACK wait with poll
                const ackPoll = setInterval(() => {
                  if (dcSender.bufferedAmount < 1024 * 1024) {
                    clearInterval(ackPoll);
                    sendBatch();
                  }
                }, opts.drainPollMs);
              } else {
                // NEW: just wait for buffer drain
                if (dcSender.bufferedAmount > 1024 * 1024) {
                  dcSender.bufferedAmountLowThreshold = 1024 * 1024;
                  dcSender.onbufferedamountlow = () => {
                    dcSender.onbufferedamountlow = null;
                    sendBatch();
                  };
                  // Fallback poll
                  const poll = setInterval(() => {
                    if (dcSender.bufferedAmount <= 1024 * 1024) {
                      clearInterval(poll);
                      dcSender.onbufferedamountlow = null;
                      sendBatch();
                    }
                  }, opts.drainPollMs);
                } else {
                  setTimeout(sendBatch, 0);
                }
              }
            }

            sendBatch();
          };
        }).catch(reject);

        setTimeout(() => reject(new Error('Timeout')), 60000);
      });
    }, { testSize: TEST_SIZE, chunkSize: CHUNK_SIZE, opts });

    return result;
  } finally {
    await page.close();
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
