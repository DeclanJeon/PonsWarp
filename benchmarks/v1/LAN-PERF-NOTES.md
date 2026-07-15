# LAN Transfer Performance Notes (2026-07-16)

## Link capacity
- User LAN claim: 100 Mbps (~12.5 MB/s)
- SSH pipe local→home: ~8.2 MB/s (66 Mbps) — path lower bound including SSH overhead
- Raw TCP is fine; bottleneck is WebRTC/SCTP in Chromium

## Raw WebRTC DataChannel (no app crypto/control)
| Config | Throughput |
|--------|------------|
| 1 PC / 1 DC | ~3.0–3.4 MB/s |
| 1 PC / 4 DC | ~3.4 MB/s (+~10%) |
| 4–6 PeerConnections | ~5–6 MB/s |

## App end-to-end (encrypted, partition pipeline)
| Config | Result |
|--------|--------|
| Stable single PC (current default) | **peak ~2.9 MB/s, sustained ~2.4–2.7 MB/s, complete** |
| Multi-PC striping (LAN_STRIPE_LANES=4) | Incomplete receives (black-hole / ICE contention) |

## Changes that helped
- Burst send loop (no per-chunk await of broadcast promise)
- 240 KB chunks (SCTP ~256 KB max minus crypto header)
- Tighter in-flight window (avoid SCTP overbuffer)
- Prefer host diagnostics over unknown for BDP
- Disable reverse per-chunk ACK on bulk path
- Prepare-ahead encrypt pipeline

## What did not work safely
- Unordered DataChannel (broke control messages)
- 256 KB chunks (exceeded SCTP max with crypto overhead)
- Multi-PC striping over existing signaling without per-lane reliability

## Ceiling
Single SCTP association on this Wi-Fi/Chromium path tops out near **3–3.5 MB/s**.
App path now runs at **~80% of that ceiling** with complete transfers.
**10 MB/s requires either multi-homed striping that is reliability-safe, or a non-WebRTC LAN path (e.g. direct TCP/HTTP on host).**

## Flag
`LAN_STRIPE_LANES` in `PonsWarp/src/utils/constants.ts` (default `1`).
Scaffolding for multi-PC demux remains in swarmManager/webRTCService.
