# PonsWarp Hybrid Bulk Transport

Status: **approved for implementation (v1)**  
Date: 2026-07-16  
Owners: transfer plane (SwarmManager / ReceiverService / CloudShare)

## 1. Problem

Cross-network 1:1 transfers are the primary product path. Current pure WebRTC DataChannel throughput on the measured path tops out near:

| Path | Observed |
|------|----------|
| App E2E WebRTC | ~2.0–2.9 MB/s complete |
| Raw single DataChannel | ~3.0–3.4 MB/s |
| SSH pipe (network headroom) | ~8.2 MB/s |

SCTP/WebRTC is the ceiling for pure browser P2P on many NAT/TURN paths. LAN-only TCP helpers do not match the real usage pattern (mostly different networks).

## 2. Goals

1. Keep **cross-network** transfers working without any LAN agent.
2. Preserve **E2E encryption** (server never sees plaintext or keys).
3. Improve effective throughput toward **~10 MB/s when network allows**, using hybrid assist.
4. Never regress completeness: received payload bytes must equal expected size.
5. Keep pure WebRTC as the always-on baseline and fallback.
6. Leave a clean extension point for later **direct multi-PC striping** (Phase 3).

Non-goals for v1:

- Mesh / multi-receiver swarm piece markets
- LAN TCP sidecar agents
- Replacing Cloud Drop product UX
- Changing room-code / signaling auth model

## 3. Design principles (from public systems)

| System | Takeaway applied here |
|--------|------------------------|
| wormhole.app | Prefer P2P, **parallel encrypted HTTP** for speed/availability |
| webwormhole | Simple 1×DataChannel + `bufferedAmount` pacing; no protocol thrash |
| FilePizza v2 | Prefer simple WebRTC over complex torrent for 1:1 |
| ShareDrop/Snapdrop | Control plane separate from bulk bytes |

## 4. Architecture

```text
┌──────────────────────────────────────────────────────────┐
│ App protocol (unchanged)                                 │
│ CRYPTO_SESSION / MANIFEST / TRANSFER_STARTED / RESUME    │
│ PARTITION / EOS / UI progress                            │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│ BulkTransportCoordinator                                 │
│  - path diagnostics                                      │
│  - policy: which bulk paths are armed                    │
│  - byte-range ownership / completion                     │
└───────────────┬─────────────────────────────┬────────────┘
                │                             │
     ┌──────────▼──────────┐       ┌──────────▼──────────┐
     │ WebRtcBulkPath      │       │ HttpAssistBulkPath  │
     │ (primary, always)   │       │ (optional hybrid)   │
     │ ordered DC stream   │       │ encrypted object    │
     └──────────┬──────────┘       └──────────┬──────────┘
                │                             │
           SCTP/DTLS                    HTTPS PUT/GET
           (P2P or TURN)               (R2/S3 via Cloud Share)
```

### 4.1 Invariants

1. **Keys never leave the browsers** (existing session key / random prefix).
2. HTTP objects are **ciphertext only**.
3. Control messages travel only on **WebRTC primary**.
4. Receiver reassembly is **offset-contiguous** (`getContiguousReceivedOffset`).
5. If hybrid fails, transfer continues on WebRTC alone.
6. If WebRTC dies after hybrid object is complete, receiver may finish from HTTP.

## 5. Phases

### Phase 0 — Path instrumentation (required)

Emit and persist per-transfer diagnostics:

- `candidatePathKind`: `host | srflx | relay | unknown`
- `rttMs`, `availableOutgoingBitrateBps`
- `bufferedAmountBytes`, `targetWindowBytes`
- `hybridArmed`, `hybridBytes`, `webrtcBytes`
- `effectiveMBps` samples

Surface in sender/receiver progress events and QA JSON.

### Phase 1 — WebRTC baseline hardening (required)

Keep single PeerConnection bulk path production-safe:

- Burst send with `bufferedAmount` gate (webwormhole-style)
- No reverse per-chunk ACK on bulk
- PARTITION_ACK only after contiguous frontier
- `LAN_STRIPE_LANES=1` by default

### Phase 2 — Encrypted HTTP assist (v1 main deliverable)

#### 2.1 Arming policy

Hybrid arms when **all** are true:

1. Feature flag `VITE_HYBRID_HTTP_ASSIST === 'true'` (build-time) **or** runtime room capability exchange.
2. Cloud API base URL configured.
3. Transfer size ≥ `HYBRID_MIN_BYTES` (default 8 MiB) — avoid overhead on tiny files.
4. Peer capability: receiver advertises `hybridHttp: true` in ready/hello.
5. Optional soft trigger: after 2s, if WebRTC sample rate `< HYBRID_TRIGGER_MBps` (default 4.0), arm even mid-transfer for remaining bytes.

v1 simplifies mid-transfer arming: **arm at transfer start** when flags + size + capability match.

#### 2.2 Object layout

One hybrid object per transfer run:

```text
hybrid/{roomId}/{runId}/payload.bin
```

Payload format = **concatenation of the same encrypted packets** already used on WebRTC
(`createPartitionDataPacket` ciphertext frames).  
This allows the receiver to feed HTTP-fetched bytes into the existing `writeChunk` pipeline without a second crypto format.

Manifest sidecar (control message, not server-visible plaintext names beyond existing cloud metadata):

```json
{
  "type": "HYBRID_MANIFEST",
  "runId": 123,
  "shareId": "...",
  "fileId": "...",
  "objectBytes": 10485760,
  "packetCount": 42,
  "totalPayloadBytes": 10485760,
  "downloadToken": "..."
}
```

#### 2.3 Sender algorithm

```text
on transfer start (if hybrid armed):
  create ephemeral cloud share (or hybrid-specific share API)
  start WebRTC partitioned send (existing)
  parallel:
    for each prepared encrypted packet:
      append to hybrid upload stream / multipart parts
    complete share
    send HYBRID_MANIFEST on primary DC
    send HYBRID_READY

on WebRTC completion:
  wait hybrid upload complete (bounded timeout)
  send EOS as today
```

v1 implementation note: full streaming multipart of live packets is complex.  
**v1.0 practical approach:**

1. WebRTC path unchanged and authoritative for interactive progress.
2. Hybrid builds ciphertext by re-encoding file chunks with the **same crypto session** into a single blob upload (or multipart) in parallel workers.
3. Receiver may consume hybrid object as a packet stream (length-delimited) identical to DC packets.

Packet framing on HTTP object:

```text
uint32be length | packet bytes | uint32be length | packet bytes | ...
```

#### 2.4 Receiver algorithm

```text
on HYBRID_MANIFEST:
  start HTTP GET (or ranged GET) of object
  parse length-delimited packets
  for each packet: writer.writeChunk(packet)  // same path as DC

on WebRTC data:
  writer.writeChunk(packet) as today

reordering buffer dedupes by offset:
  duplicate offsets ignored / already-written skipped
```

Duplicate delivery is expected under parallel paths.  
`DirectFileWriter` / reordering must treat already-satisfied offsets as no-ops (verify/adjust).

#### 2.5 Progress accounting

```text
bytesAccepted = contiguous frontier
webrtcBytes += dc packets accepted
hybridBytes += http packets accepted
displaySpeed = d(bytesAccepted)/dt
```

Do not sum webrtc+hybrid raw accepts (double count).

### Phase 3 — Multi-PC striping (later, direct only)

Not required for v1 ship. Extension point only:

- `WebRtcStripeBulkPath` behind `LAN_STRIPE_LANES > 1`
- Arm only when diagnostics are `host|srflx` and all lanes pass bulk ping
- Same packet format; coordinator assigns packets to least-loaded verified lane

## 6. Control messages (v1)

| Type | Direction | Purpose |
|------|-----------|---------|
| `PEER_CAPS` | either | `{ hybridHttp: boolean, version: 1 }` |
| `HYBRID_MANIFEST` | S→R | object identity + size |
| `HYBRID_READY` | S→R | object finalized and readable |
| `HYBRID_ABORT` | either | disable assist for run |

Existing messages remain authoritative for start/resume/end.

## 7. Feature flags & config

| Name | Default | Meaning |
|------|---------|---------|
| `VITE_HYBRID_HTTP_ASSIST` | `false` | compile/runtime enable |
| `HYBRID_MIN_BYTES` | `8 * 1024 * 1024` | min transfer size |
| `HYBRID_TRIGGER_MBps` | `4` | optional slow-path trigger |
| `HYBRID_UPLOAD_CONCURRENCY` | `3` | multipart workers |
| `LAN_STRIPE_LANES` | `1` | multi-PC off in v1 |

## 8. Failure & security

| Failure | Behavior |
|---------|----------|
| Cloud create/upload fails | log + continue WebRTC only |
| HTTP GET fails | continue WebRTC only |
| WebRTC dies, hybrid complete | finish from HTTP packets |
| Both fail | existing incomplete/resume path |
| Auth/plan denied | hybrid off, no user-blocking error |

Security:

- Reuse Cloud Share auth tokens / short-lived download URLs
- Ciphertext-only objects
- TTL on hybrid objects (align with cloud share TTL; prefer ≤24h ephemeral)
- No key material in HTTP headers or object metadata

## 9. File map (implementation)

| File | Change |
|------|--------|
| `docs/design/hybrid-bulk-transport.md` | this document |
| `src/utils/constants.ts` | hybrid flags/thresholds |
| `src/services/hybridBulkTransport.ts` | coordinator + HTTP path |
| `src/services/swarmManager.ts` | arm hybrid, emit caps/manifest, dual send |
| `src/services/webRTCService.ts` | recv caps/manifest, HTTP fetch→writeChunk |
| `src/services/cloudShareService.ts` | thin helpers for ephemeral hybrid share |
| `src/services/directFileWriter.ts` | ignore duplicate offsets safely |
| `src/utils/transferFlowControl.ts` | optional diagnostics fields |
| `benchmarks/v1/*` | hybrid metrics in QA output |
| tests | caps, framing, duplicate offset, arming policy |

## 10. QA plan

1. Unit: framing encode/decode, arming policy, duplicate offset.
2. Typecheck + existing vitest suite green.
3. Two-device benchmark (local↔home):
   - hybrid **off**: baseline complete speed
   - hybrid **on**: complete speed + `hybridBytes`/`webrtcBytes` split
4. Forced relay scenario (if available): hybrid should improve more.
5. Failure injection: abort cloud mid-upload → WebRTC still completes.
6. Success criteria:
   - no incomplete receives
   - hybrid on does not reduce completeness
   - when cloud path healthy, effective rate improves vs baseline on constrained WebRTC paths
   - report published under `benchmarks/v1/results/` + final summary doc

## 11. Rollout

1. Land design + flags default **off**
2. Enable in QA builds / staging
3. Compare metrics
4. Consider default-on only after cross-network samples show gain without reliability regressions

## 12. Decision record

- **Rejected pure LAN TCP as primary:** wrong usage pattern (cross-network).
- **Rejected mesh/data-grid for v1:** overhead without 1:1 benefit.
- **Rejected multi-PC as v1 default:** app-path reliability not proven.
- **Accepted wormhole-style hybrid:** best match for cross-network speed + completeness.
- **Accepted single ciphertext packet format for both paths:** avoids dual crypto stacks.
