# Speed-First Phase A Cutover Report

Date: 2026-07-16  
Branch: `perf/bulk-plane-vnext`  
Environment: dual-device LAN (`ssh home` ↔ local), production static `warp.ponslink.com` deploy, headless Chrome both sides.

## Goal
Approach theoretical Wi‑Fi capacity (~100 Mbps advertised). Success criterion: dual-device LAN file transfer near link capacity.

## What shipped
1. **Speed firehose default path** (`SPEED_TRANSFER`):
   - App AES off (`DEFAULT_APP_AES = !SPEED_TRANSFER`)
   - Partition ACK barriers skipped
   - Plain packets with optional CRC skip (`createPlainDataPacketFast`)
   - Send loop uses existing `broadcastChunk` + bufferedAmount pacing
2. **Unordered reliable default DataChannel** under speed path (no HOL blocking)
3. **Receiver sequential fast path**:
   - `WasmReorderingBuffer.advanceTo` / JS `advanceTo`
   - Avoid reordering map on in-order packets
   - Pipelined `scheduleFlush` + atomic buffer snapshot
   - Blob mode defers intermediate flushes for ≤64MB
4. **Hybrid HTTP assist forced off** on speed plain path
5. **QA harness**:
   - Lightweight progress polling (less main-thread steal)
   - `window.__ponswarpSwarm.getQaDiagnostics()` path/rtt/buffer snapshot

## Dual-device LAN results (20MB)

| Build | Status | Overall Mbps | Peak MB/s | Notes |
|------|--------|--------------|-----------|-------|
| AES-off legacy baseline | COMPLETE | ~15–17 | ~2.2 | Working reference |
| Firehose + unordered + recv opts | COMPLETE | ~12–16 | ~1.7–2.3 | host/host UDP confirmed |
| Negotiated multi bulk DC (2) | COMPLETE/FAILED | ~4–5 | <0.5 | Regressed; disabled (`SPEED_BULK_CHANNELS=0`) |
| LAN stripe lanes=2 | TIMEOUT | n/a | <0.2 | Sender finished early, receiver starved (black-hole); reverted |
| Tight 2MB high-water | COMPLETE | ~11–15 | ~1.5–2.0 | No gain |

### Representative mid-transfer diagnostics
```
candidatePathKind: host
local/remote: host/host
protocol: udp
rttMs: ~4–30 (sometimes spikes 90–140 on Wi‑Fi)
bufferedAmount: often several MB while drain ~2 MB/s
```

## Interpretation
- Path is **true LAN host UDP**, not TURN.
- Bottleneck is **SCTP/DTLS drain rate**, not app AES or partition ACKs.
- Sender can enqueue far faster than the association drains (~app buffer stays multi‑MB).
- Multi-association striping / multi-DC attempts currently **hurt** under simple-peer demux.

## Theoretical ceiling context
- Advertised Wi‑Fi: ~100 Mbps.
- Two STA through one AP is half-duplex; practical TCP often ~40–60 Mbps.
- Current WebRTC DataChannel steady state: **~12–16 Mbps overall** on this harness.
- Gap to goal: ~6× vs 100 Mbps, ~3× vs a realistic 50 Mbps LAN target.

## Rejected / parked
- Post-connect non-negotiated bulk DC (renegotiation stalls)
- Negotiated multi bulk DC count=2 (throughput collapse)
- `LAN_STRIPE_LANES=2` (black-hole under current demux)

## Next high-impact work (ordered)
1. Fix multi-PeerConnection striping demux end-to-end (range-partitioned, not RR) and re-QA.
2. Same-subnet **LAN WebSocket/HTTP assist** when host path is proven (PairDrop-style dual path).
3. Headed browser QA (current remote host has no DISPLAY for headed Chrome).
4. 100–500MB transfers to separate slow-start/UI finalize from steady-state goodput.
5. Capture `chrome://webrtc-internals` from both peers during a run for SCTP CWND/loss.

## Files touched (primary)
- `PonsWarp/src/transfer/SpeedSender.ts`
- `PonsWarp/src/transfer/SpeedReceiver.ts`
- `PonsWarp/src/transfer/BulkTransport.ts` (earlier experiments)
- `PonsWarp/src/services/swarmManager.ts`
- `PonsWarp/src/services/singlePeerConnection.ts`
- `PonsWarp/src/services/directFileWriter.ts`
- `PonsWarp/src/services/reorderingBuffer.ts`
- `PonsWarp/src/services/wasmReorderingBuffer.ts`
- `PonsWarp/src/utils/constants.ts`
- `PonsWarp/src/utils/plainPacket.ts`
- `benchmarks/v1/two-device-lan-test.mjs`

## Follow-up 2026-07-16 evening

- Best stable dual-device result after cutover: **~14–18 Mbps** overall (host/host UDP).
- Range-partitioned dual-lane firehose implemented (`endOffset` + per-lane send) but left **disabled** (`LAN_STRIPE_LANES=1`) after incomplete transfer at ~offset 11MB.
- Harness bug fixed: `INCOMPLETE_TRANSFER` no longer matches `COMPLETE`.
- Next: prove gap-free range-stripe, then same-subnet direct socket assist.


## Secondary-lane diagnosis (2026-07-16 cont.)

| Mode | Result |
|------|--------|
| Single lane firehose | COMPLETE ~12–16 Mbps |
| Sequential dual-PC range + full drain | COMPLETE (no speed gain) |
| Parallel dual-PC range | FAILED incomplete mid-file |
| Parallel same-PC dual negotiated DC range | FAILED ~2MB then incomplete |
| writeChunk arrival-order serialization | landed (correctness) |
| Legacy re-send after stripe fail | disabled when stripeEnabled |

Conclusion: secondary lane can deliver bulk when exclusive; **concurrency** across streams/associations is what creates gaps. Speed ceiling remains single SCTP association goodput on this Wi‑Fi dual-STA path.
