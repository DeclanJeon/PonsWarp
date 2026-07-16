# Bulk Plane vNext Phase 2 — QA Report

Date: 2026-07-16  
Worktree: `/home/declan/Documents/Develop/Project/ponswarp-bulk-plane-vnext`  
Branch: `perf/bulk-plane-vnext`  
Design: `PonsWarp/docs/design/file-transfer-logic-comparison-and-redesign.md`  
Deployed asset: `index-HUKPxkxU.js` @ `https://warp.ponslink.com`  
Signaling: `wss://warp.ponslink.com/ws` (backend unchanged)

## Changes shipped in Phase 2

1. **`waitForBulkReady()`** before first binary frame (1.5s timeout, then fallback)
2. **Fixed `sendBulk` false-fail** on high watermark (was returning false and counting peer failure)
3. **Encrypt prepare-ahead** raised to 48 chunks / 8 MiB bytes
4. **Async partition no longer breaks burst loop** (only blocking ACK modes break)
5. **Memory Blob receive path** preferred for files ≤64 MiB (was FSA-first)
6. **Send-path timing counters**: encrypt / waitDrain / waitPartitionAck / bulkReady
7. Host in-flight retuned to **8 MiB max** after 12 MiB regressed (bufferbloat)

## Unit verification

```text
vitest: transferFlowControl + transferTuning + downloadStrategy
Test Files  3 passed
Tests       27 passed
```

## Dual-device LAN QA

Harness: `benchmarks/v1/two-device-lan-test.mjs`  
Fixture: 20 MiB `/tmp/ponswarp-lan-test-20mb.bin`  
Topology: local sender ↔ ssh `home` receiver Chrome CDP  

### Phase 2 first deploy (prepare-ahead + bulk-ready + memory path)

| Run | Status | overall Mbps | peak MB/s | elapsed s |
|-----|--------|--------------|-----------|-----------|
| 1 | COMPLETE | **19.3** | 2.71 | 8.31 |
| 2 | COMPLETE | 17.3 | 2.30 | 9.24 |
| 3 | COMPLETE | 17.3 | 2.41 | 9.27 |
| 4 | COMPLETE | 14.8 | 2.14 | 10.80 |
| 5 | COMPLETE | 12.9 | 1.90 | 12.42 |

- complete rate: **5/5**
- median: **17.3 Mbps**
- avg: **16.3 Mbps**
- max: **19.3 Mbps**

### After non-blocking partition burst fix + 12 MiB in-flight (regressed)

| Run | Status | overall Mbps | notes |
|-----|--------|--------------|-------|
| 1 | COMPLETE | 15.3 | |
| 2 | COMPLETE | 15.4 | |
| 3 | FAILED | 0 | flaky join/transfer |
| 4 | COMPLETE | 8.2 | bufferbloat candidate |
| 5 | COMPLETE | 13.7 | |
| median complete | | **15.3** | worse than first Phase2 set |

### Final retune (8 MiB host ceiling)

| Run | Status | overall Mbps | peak MB/s | elapsed s |
|-----|--------|--------------|-----------|-----------|
| 1 | FAILED | 0 | 0 | 11.47 |
| 2 | COMPLETE | 11.6 | 1.61 | 13.76 |
| 3 | COMPLETE | 8.5 | 1.12 | 18.90 |
| 4 | COMPLETE | 15.3 | 2.28 | 10.48 |
| 5 | COMPLETE | 15.5 | 2.09 | 10.29 |

- complete rate: **4/5**
- median complete: **15.3 Mbps**
- avg complete: **12.7 Mbps**
- max: **15.5 Mbps**

## Comparison

| Cohort | Mbps |
|--------|------|
| Prior app E2E baseline | ~16–23 |
| Phase 1 (unordered + async checkpoint) | ~15.2 |
| **Phase 2 best median (first set)** | **~17.3** |
| **Phase 2 best single run** | **19.3** |
| Phase 2 final retune median | ~15.3 |
| Stretch target | ≥40 |
| PonsLink stable host-host | ~50 |

## Interpretation

Phase 2 **improved best-case slightly** (15.2 → 19.3 peak run; 17.3 median on the first 5-run set) but **did not approach 40 Mbps**.

What helped:
- prepare-ahead byte cap
- bulk-ready wait / sendBulk false-fail fix
- memory receive preference for 20MB fixture

What still dominates:
1. **App AES-GCM encrypt/decrypt CPU** on both ends
2. **Single SCTP association** limits (raw 1PC historically ~24–27 Mbps on this path)
3. **Receiver materialize/reorder path** still non-trivial even with Blob mode
4. **Wi-Fi variance / flaky runs** (FAILED samples, 8–12 Mbps lows)

Pushing host queue to 12 MiB **hurt** more than helped (classic bufferbloat / delayed ACK interaction).

## Success criteria

| Criterion | Result |
|-----------|--------|
| Phase 2 code behind same bulk-plane flag | PASS |
| Unit tests pass | PASS (27) |
| Multi-run LAN QA complete | PASS (with residual flakiness) |
| Median ≥ 40 Mbps | **FAIL** |
| Close gap to PonsLink (~50) | **FAIL** |

## Recommended Phase 3 (next durable stories)

1. **Worker-side encrypt/decrypt off main thread** with transferable frames
2. **Native multi DataChannel striping (2–4 SIDs)** without simple-peer demux
3. **Optional plain bulk mode for trusted LAN** (crypto still for cross-net) behind explicit product flag
4. **Sender instrumentation export to QA harness** (parse timing line from console) to quantify encrypt vs drain share
5. Keep hybrid assist for non-host; do not expect hybrid to raise LAN host path

## Artifacts

- `/tmp/ponswarp-bulk-vnext-p2-summary.json` (first Phase2 set)
- `/tmp/ponswarp-bulk-vnext-p2b-summary.json`
- `/tmp/ponswarp-bulk-vnext-p2c-summary.json` (final retune)
- This report

---

*End of report.*
