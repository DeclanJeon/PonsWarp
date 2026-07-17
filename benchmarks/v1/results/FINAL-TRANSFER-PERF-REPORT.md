# PonsWarp File Transfer Performance — Final Report

**Date:** 2026-07-16  
**Branch:** `master`  
**Head (at report time):** `36724a7`  
**Deployed asset:** `index-kj3IWfK1.js` @ `https://warp.ponslink.com`  
**Design:** `PonsWarp/docs/design/hybrid-bulk-transport.md`  
**Related QA notes:** `benchmarks/v1/results/hybrid-transport-qa-report.md`, `benchmarks/v1/LAN-PERF-NOTES.md`

---

## 1. Objective

Improve PonsWarp 1:1 encrypted file transfer throughput toward ~10 MB/s on ~100 Mbps-class links, especially for **cross-network** use (not same-LAN only), without breaking completeness.

---

## 2. What we learned (bottlenecks)

| Layer | Finding |
|-------|---------|
| Network pipe | SSH local→home ~8.2 MB/s — raw path has headroom |
| WebRTC raw 1× DataChannel | ~3.0–3.4 MB/s ceiling on measured path |
| WebRTC raw multi-PC | ~5–6 MB/s (LAN CDP benches) |
| App E2E WebRTC | ~2.0–2.9 MB/s complete (same-path / host-like) |
| Cross-net (LTE hotspot ↔ home) | ~0.6–1.1 MB/s complete |
| LTE → R2 PUT probe | ~1.45 MB/s — **sender uplink ceiling** |

**Conclusion:** Pure browser P2P over WebRTC/SCTP is hard to push to 10 MB/s. On LTE hotspot, the **upload link itself (~1–1.5 MB/s)** caps both WebRTC and hybrid HTTP assist.

---

## 3. Approaches evaluated

| Approach | Verdict |
|----------|---------|
| Chunk / buffer / burst tuning | Helped stability; limited by SCTP |
| Multi-PC striping (simple-peer) | Raw gain yes; app path incomplete/black-hole → **default OFF** (`LAN_STRIPE_LANES=1`) |
| LAN TCP agent | Wrong for primary cross-network use |
| Mesh / data-grid | Overkill for 1:1 |
| **Hybrid: WebRTC + encrypted HTTP** (wormhole-style) | **Chosen** for cross-network |

Reference systems reviewed: wormhole.app (P2P + encrypted server/CDN), webwormhole (simple 1 DC + backpressure), FilePizza, ShareDrop/Snapdrop.

---

## 4. What shipped

### 4.1 Reliability / baseline
- Burst WebRTC send + `bufferedAmount` gating  
- PARTITION_ACK waits for **contiguous reordering frontier**  
- Per-chunk reverse ACKs disabled on bulk path  
- 240 KB chunks (under SCTP ~256 KB with crypto)  

### 4.2 Hybrid bulk transport
- Design doc: `PonsWarp/docs/design/hybrid-bulk-transport.md`  
- Module: `PonsWarp/src/services/hybridBulkTransport.ts`  
- Flag: `VITE_HYBRID_HTTP_ASSIST=true` (measurement builds)  
- **Host path:** hybrid auto-skipped (don’t slow LAN)  
- **Non-host / cross-net:** **hybrid-primary**
  1. Prebuild exact ciphertext packets (same as WebRTC would send)  
  2. Upload framed object to Cloud Drop (R2) with full uplink  
  3. `HYBRID_MANIFEST` + `HYBRID_READY` on WebRTC control  
  4. Receiver HTTP-downloads packets → `writeChunk`  
  5. If payload complete → inject EOS → finalize  
  6. If hybrid doesn’t finish in 120s → WebRTC bulk fallback  

### 4.3 Security invariants
- Session keys stay in browsers  
- HTTP object is **ciphertext only**  
- Control plane remains WebRTC  

---

## 5. QA results

### Unit / type
- `tsc --noEmit`: pass  
- `vitest`: **104 tests passed**

### Same-path / host-like (earlier)
| Metric | Result |
|--------|--------|
| Status | COMPLETE |
| Peak | ~2.0–2.9 MB/s |
| Incomplete | 0 |

### Cross-network: local **LTE hotspot** ↔ **ssh home** (20 MB)

| Run | Status | elapsed | peak MB/s | overall MB/s | Mbps |
|-----|--------|---------|-----------|--------------|------|
| Baseline-style | COMPLETE | 19.3s | 1.11 | 1.04 | 8.3 |
| After parallel work | COMPLETE | 22.6s | 0.96 | 0.89 | 7.1 |
| Repeat | COMPLETE | 33.1s | 0.62 | 0.61 | 4.8 |

### LTE → R2 raw upload (curl)
| Size | Result |
|------|--------|
| 10 MB PUT | ~1.45 MB/s (~11.6 Mbps) |

---

## 6. Why ~10 MB/s was not reached on this setup

```text
Required for 10 MB/s  ≈  80 Mbps sustained uplink
Measured LTE→R2       ≈  12 Mbps
Measured transfer     ≈  5–8 Mbps overall
```

Even with hybrid-primary, the sender must push ciphertext up once.  
If the sender is on an LTE hotspot, **physics wins**: you cannot deliver 10 MB/s end-to-end.

P2P (WebRTC) adds SCTP/ICE/TURN friction on top of that, which is why pure P2P felt even harder.

---

## 7. Deploy / git

| Item | Value |
|------|--------|
| Commits (selected) | `9762f34` hybrid feature, `36724a7` hybrid-primary, docs QA |
| Remote | `origin/master` pushed |
| Production static | matches `index-kj3IWfK1.js` |

---

## 8. Follow-ups (not done)

1. Retest with **high-uplink sender** (wired broadband) and LTE as receiver only.  
2. Forced-TURN cohort metrics (hybrid vs WebRTC-only).  
3. Streaming multipart hybrid for multi-GB without full prebuild RAM.  
4. Native multi-PC striping (only on direct paths) if pure P2P speed still needed.  
5. Consider default `VITE_HYBRID_HTTP_ASSIST=false` until product policy for free Cloud Drop cost is clear.

---

## 9. Bottom line

- **Stability:** transfers complete across LAN-like and LTE↔home paths.  
- **Architecture:** hybrid ciphertext assist is in place (wormhole-style), with safe host skip and WebRTC fallback.  
- **Speed:** improved engineering headroom, but **this LTE uplink caps ~1 MB/s-class throughput**; 10 MB/s needs a much stronger sender uplink (or different topology).  
- **Honest takeaway:** browser P2P file transfer is hard; hybrid helps availability/path diversity more than it can invent bandwidth the radio doesn’t have.

---

*End of report.*
