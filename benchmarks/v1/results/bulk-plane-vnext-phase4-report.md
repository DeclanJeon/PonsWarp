# Bulk Plane vNext Phase 4 — Worker Crypto Offload

Date: 2026-07-16  
Worktree: `ponswarp-bulk-plane-vnext`  
Branch: `perf/bulk-plane-vnext`  
Deployed: `index-CeFgDeLn.js` + `crypto-plane.worker-Q2t9yM8h.js`  
URL: `https://warp.ponslink.com`

## Objective

Move AES-GCM encrypt/decrypt off the main thread with transferable frames; remeasure dual-device LAN 20MB toward 40 Mbps while keeping E2E keys client-side.

## Implementation

| Piece | Path |
|-------|------|
| Worker | `PonsWarp/src/workers/crypto-plane.worker.ts` |
| Pool client | `PonsWarp/src/services/cryptoPlaneClient.ts` (2 workers) |
| Sender | `SwarmManager.createPartitionDataPacket` prefers worker encrypt |
| Receiver | `DirectFileWriter.normalizePacket` prefers worker decrypt |
| Fallback | main-thread WebCrypto if worker arm/send fails |
| Keys | imported into workers only; never sent to server |

## Unit / build

```text
vitest: 25–29 related tests passed (cryptoPlaneClient + flow/tuning/download)
vite build: includes crypto-plane.worker-*.js chunk
```

## Dual-device LAN QA (20MB local↔ssh home)

### First deploy (crypto arm race on existing session)

| Run | Status | Mbps |
|-----|--------|------|
| 1 | FAILED | 0 |
| 2 | COMPLETE | 17.1 |
| 3 | FAILED | 0 |
| 4 | FAILED | 0 |
| 5 | COMPLETE | 12.5 |

Complete rate 2/5 (flaky). Failures showed receiver “Sender did not respond” / 0% — connection/start race, not mid-transfer crypto.

### After arm-on-existing-session fix

| Run | Status | overall Mbps | peak MB/s | elapsed s |
|-----|--------|--------------|-----------|-----------|
| 1 | COMPLETE | 17.1 | 2.47 | 9.37 |
| 2 | COMPLETE | 15.3 | 2.07 | 10.43 |
| 3 | COMPLETE | 15.5 | 1.99 | 10.32 |
| 4 | COMPLETE | 17.2 | 2.42 | 9.31 |
| 5 | COMPLETE | 15.2 | 2.08 | 10.50 |

- complete rate: **5/5**
- median: **15.5 Mbps**
- avg: **16.1 Mbps**
- max: **17.2 Mbps**

## Comparison

| Phase | Best median | Best single |
|-------|-------------|-------------|
| Baseline app | ~16–23 | ~23 |
| Phase 1 | ~15.2 | ~15.2 |
| Phase 2 | **~17.3** | **19.3** |
| Phase 3 multi-SID | ~5.1 (rejected) | 5.9 |
| **Phase 4 worker crypto** | **~15.5** | **17.2** |
| Target | ≥40 | |
| PonsLink | ~50 | ~61 |

## Interpretation

Worker crypto **stabilized after arm fix** but **did not raise LAN throughput** vs Phase 2. Off-main-thread AES still pays:

1. worker postMessage / structured clone of ~240KB frames
2. same SCTP association ceiling (~raw 1PC historically ~24–27 Mbps here)
3. remaining receiver reorder/materialize cost

So crypto CPU was **not the sole bottleneck** on this path once prepare-ahead existed; transfer cost is dominated by **browser DataChannel/SCTP + protocol durability path**.

## Decisions

- **Keep** crypto plane workers (main-thread jank reduction; correctness with fallback)
- **Do not claim** 40 Mbps reached
- **Next highest-EV options** (product decision required for some):
  1. Trusted-LAN optional plain bulk (largest remaining app-layer cost)
  2. Native multi-PeerConnection striping with integrity soak
  3. Accept ~15–20 Mbps app E2E ceiling on this Wi-Fi class for encrypted single-PC path

## Artifacts

- `/tmp/ponswarp-bulk-vnext-p4-summary.json`
- `/tmp/ponswarp-bulk-vnext-p4b-summary.json`
- This report

---

*End of report.*
