# Speed-First Redesign — Phase A Report

Date: 2026-07-16  
Worktree: `ponswarp-bulk-plane-vnext`  
Branch: `perf/bulk-plane-vnext`  
Design: `PonsWarp/docs/design/speed-first-file-transfer-redesign.md`  
Vault copies:
- `Obsidian Vault/Projects/ponswarp/Docs/design/speed-first-file-transfer-redesign.md`
- `Obsidian Vault/Projects/PonsWarp/Docs/design/speed-first-file-transfer-redesign.md`

Deployed: `index-BNX33UIW.js` @ `https://warp.ponslink.com`  
Strings present: `Speed transfer mode`, `app-AES disabled`

## Phase A scope delivered

1. Design persisted locally (repo + Obsidian vault)
2. Ultragoal plan created for speed-first Phase A
3. `SPEED_TRANSFER` flag default ON
4. `DEFAULT_APP_AES = false` under speed mode
5. `SwarmManager.ensureTransferEncryption()` skips app AES session generation in speed mode
6. Speed frame helpers + tests (`src/transfer/speedFrames.ts`)
7. Higher speed buffer cap wiring (`SPEED_BUFFER_HIGH=8MiB`)
8. Unit tests + production build + dual-device LAN QA

## Unit / build

```text
vitest: 29 passed (speedFrames + tuning + flowControl + cryptoPlaneClient)
vite build: ok
```

## Dual-device LAN QA (20MB local↔ssh home)

| Run | Status | overall Mbps | peak MB/s | elapsed s |
|-----|--------|--------------|-----------|-----------|
| 1 | COMPLETE | 17.1 | 2.53 | 9.36 |
| 2 | COMPLETE | 15.3 | 2.13 | 10.44 |
| 3 | COMPLETE | 4.4 | 1.04 | 36.26 |
| 4 | COMPLETE | 7.5 | 1.02 | 21.28 |
| 5 | FAILED | 0 | 0 | 11.39 |

- complete: **4/5**
- complete median: **11.4–15.3 Mbps** (sorted complete: 4.4, 7.5, 15.3, 17.1)
- max: **17.1 Mbps**

## Gate evaluation

| Gate | Target | Result |
|------|--------|--------|
| Phase A median | ≥ 30 Mbps | **FAIL** |
| Stretch | ≥ 40 Mbps | **FAIL** |
| Completeness mostly works | yes | 4/5 |
| App AES disabled on default path | yes | shipped |

## Interpretation

Turning off default app AES alone **did not unlock 30–40 Mbps**.

This confirms the redesign thesis only partially:

- App AES was a tax, but not the only dominant tax on this path.
- Remaining default path still uses the old partitioned sender/receiver machine:
  - plain packet framing + CRC path
  - reordering writer
  - reverse PAUSE possible
  - simple-peer bulk path / single association behavior
- High run-to-run variance (4–17 Mbps) suggests path/receiver stalls still dominate.

## Required next implementation (still Phase A / early B)

Per design doc, AES-off is insufficient without hot-path rewrite:

1. `SpeedSender` firehose (no partition state machine)
2. `SpeedReceiver` append-first writer (no decrypt/reorder tax)
3. Native `BulkTransport` control/bulk split used end-to-end
4. Sparse progress only; FINAL_OK at end

Until those land, expect continued ~15 Mbps class results even with app AES off.

## Artifacts

- `/tmp/ponswarp-speed-a-summary.json`
- `/tmp/ponswarp-speed-a-run{1..5}.log`
- Design doc (repo + vault)

---

*End of report.*


## Follow-up patches after first QA

### A2
- Partition markers no-op under `SPEED_TRANSFER`
- Partition size = MAX_SAFE_INTEGER on speed path
- Receiver PAUSE thresholds raised to 256/128 MiB

Result (4/5 complete): median ~14 Mbps, max 17.2

### A3
- `createPlainDataPacketFast` skips per-chunk CRC on speed path

Result (**5/5 complete**):
| Run | Mbps |
|-----|------|
| 1 | 15.4 |
| 2 | 15.4 |
| 3 | 15.4 |
| 4 | 14.0 |
| 5 | 17.1 |

- median **15.4 Mbps**
- max **17.1 Mbps**
- stability improved, absolute speed still far below Phase A gate (30 Mbps)

## Conclusion for Phase A gate

AES-off + barrier-off + CRC-off on the existing sender/receiver still lands at **~15 Mbps class**.

Therefore Phase A is **not complete** against the ≥30 Mbps gate. The remaining work is the real hot-path rewrite (`SpeedSender`/`SpeedReceiver`/`BulkTransport`) described in the design doc, not more micro-tuning of the old protocol machine.

