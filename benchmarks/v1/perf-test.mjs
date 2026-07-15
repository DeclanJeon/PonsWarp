#!/usr/bin/env node
/**
 * PonsWarp Performance Benchmark - v4
 * Measures AES-GCM encryption throughput + packet creation speed.
 * No WebRTC needed - pure CPU/crypto benchmark.
 */
import { chromium } from 'playwright';

const APP_URL = 'http://localhost:5173';
const TEST_SIZES = [10, 50, 100].map(mb => mb * 1024 * 1024);

async function main() {
  console.log('=== PonsWarp Crypto + Packet Performance Benchmark ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-web-security']
  });

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });

    for (const size of TEST_SIZES) {
      const sizeMB = size / (1024 * 1024);
      console.log(`\n--- Test: ${sizeMB} MB ---`);

      // 1. File read speed
      const readResult = await page.evaluate((args) => {
        const { size } = args;
        const data = new Uint8Array(size);
        // Fill in 64KB chunks (getRandomValues API limit)
        for (let i = 0; i < data.length; i += 65536) {
          crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
        }

        const iterations = 5;
        const times = [];
        for (let i = 0; i < iterations; i++) {
          const start = performance.now();
          // Simulate file.slice().arrayBuffer()
          const chunk = data.slice(0, Math.min(192 * 1024, size));
          const end = performance.now();
          times.push(end - start);
        }
        const avgMs = times.reduce((a, b) => a + b) / times.length;
        const throughputMBps = (192 * 1024) / (avgMs / 1000) / (1024 * 1024);
        return { avgMs, throughputMBps, iterations };
      }, { size });
      console.log(`  [File Read] ${readResult.avgMs.toFixed(3)} ms/chunk → ${readResult.throughputMBps.toFixed(1)} MB/s`);

      // 2. AES-GCM encryption speed
      const encryptResult = await page.evaluate(async (args) => {
        const { size } = args;
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        const data = new Uint8Array(Math.min(192 * 1024, size));
        for (let i = 0; i < data.length; i += 65536) {
          crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
        }

        const iterations = 20;
        const times = [];
        for (let i = 0; i < iterations; i++) {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const start = performance.now();
          await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            data
          );
          const end = performance.now();
          times.push(end - start);
        }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];
        const avg = times.reduce((a, b) => a + b) / times.length;
        const throughputMBps = data.byteLength / (median / 1000) / (1024 * 1024);
        return { median, avg, throughputMBps, iterations };
      }, { size });
      console.log(`  [AES-GCM Encrypt] median: ${encryptResult.median.toFixed(3)} ms/chunk → ${encryptResult.throughputMBps.toFixed(1)} MB/s`);

      // 3. Combined: read + encrypt pipeline
      const pipelineResult = await page.evaluate(async (args) => {
        const { size } = args;
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        const data = new Uint8Array(size);
        // Fill in 64KB chunks (getRandomValues API limit)
        for (let i = 0; i < data.length; i += 65536) {
          crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
        }

        const CHUNK = 192 * 1024;
        const totalChunks = Math.ceil(size / CHUNK);
        const start = performance.now();

        // Sequential: read + encrypt for each chunk
        for (let i = 0; i < totalChunks; i++) {
          const offset = i * CHUNK;
          const chunkSize = Math.min(CHUNK, size - offset);
          const chunk = data.slice(offset, offset + chunkSize);
          const iv = new Uint8Array(12); crypto.getRandomValues(iv);
          await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            chunk
          );
        }

        const elapsed = performance.now() - start;
        const throughputMBps = size / (elapsed / 1000) / (1024 * 1024);
        const throughputMbps = throughputMBps * 8;
        return { elapsed, throughputMBps, throughputMbps, totalChunks };
      }, { size });
      console.log(`  [Sequential Pipeline] ${pipelineResult.elapsed.toFixed(0)} ms → ${pipelineResult.throughputMBps.toFixed(1)} MB/s (${pipelineResult.throughputMbps.toFixed(0)} Mbps)`);

      // 4. Parallel encryption (our optimization)
      const parallelResult = await page.evaluate(async (args) => {
        const { size } = args;
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        const data = new Uint8Array(size);
        // Fill in 64KB chunks (getRandomValues API limit)
        for (let i = 0; i < data.length; i += 65536) {
          crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
        }

        const CHUNK = 192 * 1024;
        const totalChunks = Math.ceil(size / CHUNK);
        const MAX_CONCURRENT = 4;
        const start = performance.now();

        // Parallel: 4 concurrent encrypt jobs
        const pending = new Map();
        let nextToSchedule = 0;
        let nextToSend = 0;

        const scheduleNext = () => {
          while (pending.size < MAX_CONCURRENT && nextToSchedule < totalChunks) {
            const seq = nextToSchedule++;
            const offset = seq * CHUNK;
            const chunkSize = Math.min(CHUNK, size - offset);
            const chunk = data.slice(offset, offset + chunkSize);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const promise = crypto.subtle.encrypt(
              { name: 'AES-GCM', iv, tagLength: 128 },
              key,
              chunk
            );
            pending.set(seq, promise);
            promise.then(() => {
              pending.delete(seq);
              scheduleNext();
            });
          }
        };

        scheduleNext();
        await Promise.all(pending.values());

        const elapsed = performance.now() - start;
        const throughputMBps = size / (elapsed / 1000) / (1024 * 1024);
        const throughputMbps = throughputMBps * 8;
        return { elapsed, throughputMBps, throughputMbps, totalChunks };
      }, { size });
      console.log(`  [Parallel Pipeline] ${parallelResult.elapsed.toFixed(0)} ms → ${parallelResult.throughputMBps.toFixed(1)} MB/s (${parallelResult.throughputMbps.toFixed(0)} Mbps)`);
      console.log(`  [Speedup] ${(parallelResult.throughputMBps / pipelineResult.throughputMBps).toFixed(2)}x vs sequential`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
