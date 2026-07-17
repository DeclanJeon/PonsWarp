# Hybrid HTTP assist path policy

WebRTC remains the control + primary bulk path on healthy LAN.

## Arm hybrid only when
- compile/env flag on (`VITE_HYBRID_HTTP_ASSIST`)
- cloud API configured
- remote peer advertises `hybridHttp`
- transfer size ≥ `HYBRID_MIN_BYTES` (8 MiB)
- **and** one of:
  - ICE path is `relay`
  - path is `host`/`srflx` with elevated RTT (≥ `HYBRID_ELEVATED_RTT_MS`, default 120)
  - direct path observed throughput &lt; `HYBRID_TRIGGER_MBps` (default 4)
  - `unknown` path with elevated RTT / slow throughput

## Never
- block host/udp/lan primary DataChannel send with hybrid-primary prebuild
- re-encrypt packets (tee same ciphertext)

## Implementation
- `shouldArmHybrid` in `src/services/hybridBulkTransport.ts`
- `SwarmManager.evaluateHybridArmingForCurrentPath` after ICE diagnostics sample
