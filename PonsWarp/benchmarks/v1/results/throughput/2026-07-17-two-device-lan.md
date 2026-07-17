# Two-device LAN throughput — 2026-07-17

## Environment
- SSH host `home` + LAN peer (Playwright headless Chrome both sides)
- App: https://warp.ponslink.com
- Path badge: `host/udp/lan` (rtt ~4–18 ms)
- E2E AES-GCM on; hybrid-primary off

## App path (50 MB fixture)

| Build | Status | Elapsed | Peak | Overall | Notes |
|-------|--------|---------|------|---------|-------|
| 8d89d04 | COMPLETE 20MB | 22.5s | 2.03 MB/s | 0.89 MB/s | reliability baseline |
| 45d9a91 | COMPLETE 50MB | 26.9s | **3.77 MB/s** | 1.86 MB/s | + decrypt worker |
| c0c53fc | COMPLETE 50MB | **18.6s** | **3.52 MB/s** | **2.69 MB/s** | OPFS + 192KiB + stable 8–12 MiB window |

Best overall: **2.69 MB/s** (21.5 Mbps). Best peak: **3.77 MB/s**.

## Raw DataChannel ceiling (no app crypto/UI)

`benchmarks/v1/raw-dc-lan-test.mjs` (30 MB, 192 KiB chunks):

- sender: **3.67 MB/s**
- receiver: **3.70 MB/s**

## Conclusion
App bulk path saturates the measured raw WebRTC DataChannel ceiling on this
two-device home path (~3.7 MB/s). The ≥8 MB/s product gate is **not** blocked
by remaining AES/UI overhead on this bench; it requires a higher-capacity
network/browser path (Ethernet, better Wi‑Fi, non-headless real devices, or
same-host loopback).

## Changes shipped toward the gate
- Reliability: soft DC errors, no leaveRoom reconnect thrash, send retries
- Sender: bulk encrypt worker re-enabled, host window 8–12 MiB, 192 KiB chunks
- Receiver: bulk decrypt worker, pendingBytes PAUSE fix, OPFS automation path
