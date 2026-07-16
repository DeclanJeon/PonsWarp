# Bulk Plane vNext Phase 3 Experiment — Multi Bulk SIDs

Date: 2026-07-16  
Branch: `perf/bulk-plane-vnext`  
Deployed during experiment: `index-DFy5m8bS.js` (3 bulk SIDs)  
Rolled back to: `index-CGEwOibm.js` (`BULK_CHANNEL_COUNT=1`)

## Hypothesis

Multiple unordered reliable DataChannels on one `RTCPeerConnection` would reduce HOL and raise LAN throughput toward 40 Mbps.

## Implementation

- `BULK_CHANNEL_COUNT` (tried 3)
- labels `ponswarp-bulk`, `ponswarp-bulk-1`, ...
- lowest-`bufferedAmount` picker + RR when empty
- `getBufferedAmount()` summed across open bulk channels

## LAN QA (20MB local↔home)

### Multi-SID count=3

| Run | Status | overall Mbps | peak MB/s |
|-----|--------|--------------|-----------|
| 1 | COMPLETE | 5.9 | 0.38 |
| 2 | COMPLETE | 5.1 | 0.37 |
| 3 | FAILED | 0 | 0 |
| 4 | COMPLETE | 5.0 | 0.59 |
| 5 | COMPLETE | 4.7 | 0.49 |

- median complete ≈ **5.1 Mbps** (**severe regression**)

### Rollback count=1

| Run | Status | overall Mbps | peak MB/s |
|-----|--------|--------------|-----------|
| 1 | COMPLETE | 15.1 | 1.98 |
| 2 | COMPLETE | 15.3 | 2.21 |
| 3 | COMPLETE | 17.2 | 2.35 |

- median ≈ **15.3 Mbps** (restored Phase2 band)

## Conclusion

**Rejected for production default:** multi bulk DataChannels on the same PeerConnection **hurt** throughput on this path (~3× slower).

Likely reasons:

1. Same SCTP association — no extra network pipe
2. Summed bufferedAmount pacing + multi-stream scheduling overhead
3. Receiver demux/reorder cost increases with multi-stream arrival

Keep multi-SID code path available (`BULK_CHANNEL_COUNT`) but default **1**.

## Still open for ≥40 Mbps

1. Worker-thread encrypt/decrypt (true off-main-thread)
2. Native multi-PeerConnection striping (separate SCTP associations) — only if demux integrity is solved
3. Product-gated plain LAN mode (largest remaining app-layer cost is crypto)
4. Path verification: ensure host/UDP not relay during QA

## Comparison snapshot

| Phase | Best median Mbps | Best single Mbps |
|-------|------------------|------------------|
| Baseline app | ~16–23 | ~23 |
| Phase 1 | ~15.2 | ~15.2 |
| Phase 2 | **~17.3** | **19.3** |
| Phase 3 multi-SID | ~5.1 | 5.9 |
| Phase 3 rollback | ~15.3 | 17.2 |
| Target | ≥40 | |
| PonsLink | ~50 | ~61 |

---

*End of report.*
