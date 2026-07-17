# Agbrowse headed two-device LAN (2026-07-17)

## Setup
- Sender: `declan-MG137156-1651` (local) headed Chrome via `agbrowse start --headed` CDP :9222
- Receiver: `declan-laptop` (ssh home) headed Chrome via agbrowse + Xwayland auth, CDP tunneled :9223
- App: https://warp.ponslink.com
- Harness: `benchmarks/v1/agbrowse-headed-lan-test.mjs`

## 20 MB COMPLETE
- room: R0YGJ8
- elapsed: 8.21s
- peak: **2.82 MB/s**
- avg sample: 2.17 MB/s
- overall: **2.44 MB/s** (~19.5 Mbps)
- sender SUCCESS / receiver MATERIALIZED 20.00 MB

## 50 MB attempt (stalled)
- room: XANKZ0
- peak before stall: **3.85 MB/s**
- stalled ~t+15s with `Cannot resume encrypted transfer without an active crypto key`
- later control/bulk channel close + peer connection failed
- not counted as complete; peak still ~same band as headless/raw DC

## Conclusion
Headed real Chrome on two physical machines does **not** unlock ≥8 MB/s on this Wi‑Fi path.
Throughput remains ~2.4–3.9 MB/s, consistent with prior headless + raw DC ceiling (~3.7 MB/s).
