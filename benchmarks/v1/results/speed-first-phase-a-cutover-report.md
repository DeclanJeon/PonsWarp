# Speed-First Phase A Cutover Report

Date: 2026-07-16  
Branch: `perf/bulk-plane-vnext`  
Commit: `3219985`  
Design: `PonsWarp/docs/design/speed-first-file-transfer-redesign.md`

## Implemented

### Modules
- `src/transfer/BulkTransport.ts` — control/bulk facade over `SinglePeerConnection`
- `src/transfer/SpeedSender.ts` — partition-free plain firehose sender
- `src/transfer/SpeedReceiver.ts` — sequential/plain packet helpers
- `src/transfer/speedFrames.ts` — speed frame codec (earlier)

### Wiring
- `SwarmManager.sendFilesPartitioned`:
  - if `SPEED_TRANSFER && !isEncryptionEnabled()` → **`sendSpeedFirehose`**
  - else legacy partitioned/hardened path
- Default path already has app-AES disabled (`ensureTransferEncryption`)
- Receiver pause thresholds raised under speed mode
- Deployed frontend includes firehose strings (`index-CX_16tEb.js`)

### Tests / build
- unit: SpeedSender compatibility + frames + tuning/plainPacket passed
- `pnpm build` passed
- production static deploy succeeded

## Dual-device LAN QA status

**Blocked at report time:** `ssh home` / `100.65.42.93` unreachable (timeout / no route).

Previous same-day baseline before full cutover (AES-off only):

- median **15.4 Mbps**, max **17.1 Mbps**, 5/5 complete

Cutover multi-run remeasure is pending host recovery.

## Remaining for ≥30/40 Mbps

Even with firehose sender cutover, remaining suspects:

1. Receiver still uses reordering writer path (not pure append-only materializer)
2. simple-peer association still under bulk path
3. Network path / host availability variance

Next when `home` is back:

```bash
node benchmarks/v1/two-device-lan-test.mjs  # x5
```

Gate: median ≥ 30 Mbps (Phase A), stretch ≥ 40 Mbps.

## Files changed (cutover)

- `PonsWarp/src/transfer/BulkTransport.ts`
- `PonsWarp/src/transfer/SpeedSender.ts`
- `PonsWarp/src/transfer/SpeedReceiver.ts`
- `PonsWarp/src/transfer/SpeedSender.test.ts`
- `PonsWarp/src/services/swarmManager.ts`
- `PonsWarp/src/services/directFileWriter.ts`

---

*End of report.*
