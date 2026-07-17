# LAN Transfer Performance Notes (2026-07-16 night)

## A = Multi PeerConnection striping
Open N independent RTCPeerConnections (separate SCTP associations) to the same receiver and split bulk chunks across them. Raw CDP tests reached ~5-6 MB/s with 4-6 PCs. App integration via simple-peer + lane-in-SDP demux still loses bulk data (false-empty buffers / ICE demux), so default is off.

## Current production-safe path
- Single PeerConnection, ordered DataChannel
- 240KB chunks, burst send, host BDP window
- PARTITION_ACK waits for contiguous reordering frontier
- Measured two-device E2E: ~2.0-2.9 MB/s complete

## Ceilings
| Path | Throughput | Complete? |
|------|------------|-----------|
| SSH pipe | ~8.2 MB/s | n/a |
| Raw WebRTC 1 PC | ~3.0-3.4 MB/s | yes |
| Raw WebRTC 4-6 PC | ~5-6 MB/s | yes |
| App E2E 1 PC | ~2.2-2.9 MB/s | yes |
| App multi-PC striping | stall / incomplete | no |

## Path to ~10 MB/s
1. Replace simple-peer bulk lanes with native RTCPeerConnection + reliable credit/ACK, or
2. Add LAN-local TCP/HTTP host path when both peers share a private network (bypass SCTP).

## Hybrid transport (2026-07-16)

Design: `PonsWarp/docs/design/hybrid-bulk-transport.md`  
QA: `benchmarks/v1/results/hybrid-transport-qa-report.md`

- WebRTC remains baseline.
- Encrypted HTTP assist tees ciphertext to Cloud Drop when armed.
- Auto-skipped on host LAN path.
- Enable via `VITE_HYBRID_HTTP_ASSIST=true`.
