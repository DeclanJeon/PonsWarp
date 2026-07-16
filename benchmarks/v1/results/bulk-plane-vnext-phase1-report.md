# Bulk Plane vNext Phase 1 — QA Report

Date: 2026-07-16  
Worktree: `/home/declan/Documents/Develop/Project/ponswarp-bulk-plane-vnext`  
Branch: `perf/bulk-plane-vnext`  
Head: `ddb7955` (+ docs/design commit `f57ae1c`)  
Design: `PonsWarp/docs/design/file-transfer-logic-comparison-and-redesign.md`  
Deploy: frontend-only to `warp.ponslink.com` static (`index-BcmADwcQ.js`, `wss://warp.ponslink.com/ws`, bulk label present)

## What shipped

1. `BULK_PLANE_VNEXT` flag (default ON; disable with `VITE_BULK_PLANE_VNEXT=false`)
2. Reliable-unordered default DataChannel under vNext
3. Optional dedicated `ponswarp-bulk` DataChannel (`ordered:false`, reliable)
4. `sendBulk()` path for binary frames; JSON control stays on string/control send
5. `shouldBlockOnPartitionAck()` — 1:1 host/srflx/unknown becomes **async checkpoint** (non-blocking)
6. Unit tests for checkpoint policy + channel policy

## Unit verification

```text
vitest: transferFlowControl + transferTuning + plainPacket
Test Files  3 passed
Tests       26 passed
```

## Dual-device LAN QA

Harness: `benchmarks/v1/two-device-lan-test.mjs`  
Fixture: `/tmp/ponswarp-lan-test-20mb.bin` (20 MiB)  
Path: local sender browser ↔ ssh `home` receiver Chrome CDP  
App: `https://warp.ponslink.com/?automation=1`

| Run | Status | elapsed | peak MB/s | overall MB/s | overall Mbps |
|-----|--------|---------|-----------|--------------|--------------|
| 1 | COMPLETE | 10.54s | 2.21 | 1.90 | **15.2** |
| 2 | FAILED | 11.67s | 0 | 0 | 0 |
| 3 | COMPLETE | 10.52s | 2.19 | 1.90 | **15.2** |

Artifacts:

- `artifacts/file-transfer-qa/lan-20mb-bulk-vnext-latest.json`
- `artifacts/file-transfer-qa/lan-20mb-bulk-vnext-run{1,2,3}.log`

## Comparison vs prior baselines

| Cohort | Approx Mbps |
|--------|-------------|
| Prior PonsWarp app E2E LAN-like | ~16–23 |
| Phase 1 complete runs (this report) | **15.2** |
| Prior PonsWarp raw 1× DC | ~24–27 |
| PonsLink stable host-host | ~50 |
| Phase 1 target | ≥40 |

## Interpretation

Phase 1 **did not close the LAN gap**. Completeness is preserved on successful runs, but throughput remains in the previous app E2E band (low end).

Likely remaining bottlenecks (ordered by suspicion):

1. **App-level AES-GCM encrypt/decrypt + prepare sequencing** still on hot path
2. **Receiver durability path** (reorder + FSA/write) still reverse-pressures via PAUSE
3. Dedicated bulk channel may open late / fall back to the same association; one SCTP association remains
4. One FAILED run indicates residual flakiness (join/transfer path), not just speed

What Phase 1 did achieve:

- Completeness still works with unordered + async checkpoints
- Control/bulk separation scaffolding is in place
- Measured evidence against production URL after deploy

## Success criteria status

| Criterion | Result |
|-----------|--------|
| Unit/type checks for changed policy | PASS (26 tests) |
| LAN host-host 20MB complete | PASS (2/3 runs) |
| Report measured Mbps vs baseline | PASS (this file) |
| Stretch median ≥ 40 Mbps | **FAIL** (15.2 Mbps) |

## Next actions (Phase 2)

1. Force bulk-channel readiness before first binary frame (wait `bulk-ready`)
2. Encrypt pipeline ahead by bytes (worker readyQueue ≥ 4–8 MiB)
3. Memory assemble path for ≤64 MiB host receives
4. Add sender instrumentation: time in encrypt / waitDrain / waitPartitionAck / paused
5. Re-run 10× host-host 20MB soak after Phase 2

## Deploy notes

- Full `deploy/deploy-production.sh` failed initially: missing `.env.production` in worktree, wrong default host (`pons-link` vs `ponslink`), cargo target dir issues.
- Successful path used: production Vite env + frontend-only static replace under `/home/declan/ponswarp-deploy/current/static`.
- Signaling backend unchanged and remained healthy (`/health` ok).

---

*End of report.*
