# PonsWarp WebRTC Bulk Throughput Redesign

Status: **draft for implementation**  
Date: 2026-07-16  
Owners: transfer plane (`SwarmManager` / `webRTCService` / peer transport / `DirectFileWriter`)  
Related:

- `docs/design/hybrid-bulk-transport.md` — cross-network HTTP assist (keep; not a LAN fix)
- `docs/design/lan-transfer-pipeline.md` — evidence/certificate pipeline (orthogonal; do not weaken integrity gates)

## 1. Problem statement

### 1.1 Observed

| Environment | Result |
|-------------|--------|
| User Wi-Fi, same network, browser P2P app path | ~**3 MB/s** (~24 Mbps) |
| User internet (fast.com) | ~**100 Mbps** (~12.5 MB/s theoretical payload) |
| Expected same-LAN Wi-Fi headroom | **≥ 40–80 Mbps** app payload on healthy 5 GHz / AC / AX path; higher if radio allows |

3 MB/s on same-Wi-Fi is not “network saturated”. It is an **application / WebRTC configuration ceiling**.

### 1.2 Root-cause inventory (current code)

These are the bottlenecks found in the live hot path. Ranked by impact on same-Wi-Fi 1:1 transfer.

| # | Bottleneck | Where | Why it hurts |
|---|------------|-------|--------------|
| B1 | Single DataChannel carries **control + bulk**, always `ordered: true` | `singlePeerConnection.ts` | SCTP HOL blocking; control frames can stall bulk; no unordered bulk option |
| B2 | **App-level AIMD** on top of SCTP congestion control | `networkAdaptiveController.ts` | Double congestion control; false “congestion” shrinks window |
| B3 | **Hard in-flight caps** too low for Wi-Fi BDP | `constants.ts`, `transferFlowControl.ts` | `maxInFlightBytes=6MB`, `HIGH_WATER_MARK=4MB` starve the pipe |
| B4 | **Partition ACK barrier** + receiver `waitForIdle` | `swarmManager.ts`, `webRTCService.ts` | App-level stop-and-wait every partition; redundant with reliable SCTP |
| B5 | **Main-thread partitioned send** after worker terminate | `swarmManager.ts` `runPartitionedTransfer` | Kills worker zero-copy path; File.slice + encrypt + send on UI thread |
| B6 | Receiver **decrypt → copy → reorder → serial writeQueue** | `directFileWriter.ts` | Extra copies and artificial serialization on every chunk |
| B7 | **LAN multi-PC striping disabled** | `LAN_STRIPE_LANES = 1` | Single SCTP association ceiling; comment admits simple-peer demux black-hole |
| B8 | **simple-peer abstraction** | `singlePeerConnection.ts` | Opaque channel lifecycle; multi-channel/stripe hard; Blob coercion paths |
| B9 | Dead / misleading “high performance” stack | worker, WASM software AES, FEC, Merkle, BBR constants | Complexity without hot-path benefit; software AES is catastrophic if used |
| B10 | Hybrid HTTP assist | host path correctly skipped | Correct for LAN; **not** a Wi-Fi fix. Do not use hybrid to paper over B1–B8 |

### 1.3 Non-causes (do not “optimize” these first)

- Reed-Solomon FEC (not on bulk path)
- Merkle tree (not on bulk path)
- ZIP64 streaming (multi-file uses raw manifest path)
- Cloud Drop product path
- Signaling latency after connect

### 1.4 Goals

1. On **same-Wi-Fi host UDP** path, raise 1:1 encrypted transfer to:
   - **Target A (must):** median ≥ **8 MB/s** on ≥100 MB fixture
   - **Target B (should):** median ≥ **12 MB/s** when radio/CPU allow
   - **Floor:** p05 ≥ **5 MB/s** on same fixture / same pair
2. Preserve **E2E encryption** (session key never leaves browsers).
3. Preserve **completeness** (received contiguous payload == expected size).
4. Preserve **resume** after disconnect.
5. Keep **cross-network** behavior no worse than today; hybrid remains the cross-net assist.
6. Make transport **inspectable**: every transfer reports path kind, window, channel stats, effective MB/s.

### 1.5 Non-goals

- Redesigning room codes / signaling auth
- Mesh multi-receiver markets
- Making software WASM AES competitive with WebCrypto
- Replacing Cloud Drop product
- Weakening `lan-transfer-pipeline.md` integrity/certificate rules
- “BBR from scratch” research project

---

## 2. Design principles

| Principle | Application |
|-----------|-------------|
| One congestion controller | **SCTP only** on bulk. App only does **bufferedAmount pacing**, never AIMD cwnd. |
| Separate planes | **Control channel** ≠ **bulk channel(s)**. |
| Native WebRTC | Drop simple-peer for transfer peers. Use `RTCPeerConnection` + explicit `RTCDataChannel`. |
| Path-aware policy | `host` Wi-Fi/LAN is aggressive; `relay` stays conservative; never apply relay knobs to host. |
| Reliable bulk without app ACK storms | SCTP reliability is enough for in-order delivery guarantees we need; app ACK only for **resume checkpoints**. |
| Copy minimization | Encrypt once, send ciphertext view; receiver decrypt once, write once. No ceremonial reordering on single ordered bulk stream. |
| Delete dead speed theater | If a module is not on the measured hot path, quarantine or delete; do not keep “optimized” code that transfer start terminates. |

Reference systems (what we actually copy):

| System | Takeaway |
|--------|----------|
| webwormhole | Single bulk stream + `bufferedAmount` high/low water; no protocol thrash |
| wormhole.app | Keep P2P simple; parallel HTTP only when P2P is weak (already hybrid doc) |
| FilePizza / ShareDrop | Control messages out of bulk byte path |
| Browser WebRTC practice | Multiple DataChannels or multiple PeerConnections beat one overloaded ordered channel |

---

## 3. Target architecture

```text
                        Signaling (unchanged)
                               │
                               ▼
                    ┌─────────────────────┐
                    │  PeerSession (native)│
                    │  RTCPeerConnection   │
                    └──────────┬──────────┘
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
   DC "control"           DC "bulk-0"         DC "bulk-1..N"
   ordered:true           reliable bulk       optional stripes
   reliable               (see §4.2)          host-only
   JSON msgs              binary packets      binary packets
           │                   │                   │
           │                   └─────────┬─────────┘
           │                             ▼
           │                    BulkSendPipeline
           │                    - read ahead
           │                    - WebCrypto AES-GCM
           │                    - bufferedAmount gate
           │                    - no AIMD
           │                             │
           ▼                             ▼
   Control handlers              ReceiverBulkIngress
   MANIFEST/CRYPTO/RESUME        - decrypt
   PARTITION_CHECKPOINT*         - direct write / light reorder
                                 - backpressure PAUSE only if disk stalls
```

\* Partition checkpoint is **optional** and path-dependent (§5.4). Not a per-window stop-wait on host.

### 3.1 Component responsibilities

| Component | Responsibility | Replaces |
|-----------|----------------|----------|
| `PeerSession` | Native PC, ICE, two+ data channels, stats, drain events | `SinglePeerConnection` + simple-peer |
| `ControlPlane` | JSON control only on `control` channel | mixed `peer.send(string\|buffer)` |
| `BulkSendPipeline` | Read → encrypt → paced send on bulk channel(s) | `sendFilesPartitioned` main-thread maze + dead worker path |
| `BulkReceivePipeline` | Decrypt → write with minimal copies | `writeChunk` normalize/reorder ceremony for single-stream |
| `PathPolicy` | host / srflx / relay tuning tables | `NetworkAdaptiveController` AIMD + partial tuning profiles |
| `TransferDiagnosticsBus` | Continuous samples for UI + QA | ad-hoc progress fields |

---

## 4. Transport redesign (B1, B7, B8)

### 4.1 Remove simple-peer from transfer path

**Decision:** implement `PeerSession` on native WebRTC.

Required surface:

```ts
class PeerSession {
  readonly id: string;
  connect(opts: {
    initiator: boolean;
    iceServers: RTCIceServer[];
    bulkChannelCount: number; // 1 default; >1 host stripe
  }): void;

  // signaling
  onSignal(cb: (descOrCandidate: SignalMessage) => void): void;
  acceptSignal(msg: SignalMessage): void;

  // planes
  sendControl(obj: object): void;
  sendBulk(channelIndex: number, packet: ArrayBuffer): boolean; // false = backpressure

  getBulkBufferedAmount(channelIndex?: number): number;
  onBulkDrain(cb: (channelIndex: number) => void): void;
  onControlMessage(cb: (msg: unknown) => void): void;
  onBulkPacket(cb: (packet: ArrayBuffer, channelIndex: number) => void): void;

  getDiagnostics(): Promise<TransferDiagnostics>;
  destroy(): void;
}
```

Migration:

1. Keep signaling adapter messages unchanged (`signal` relay payload format).
2. Feature flag `VITE_NATIVE_PEER=true` (default **on** in dev, staged in prod).
3. Delete simple-peer import from transfer peers once flag sticky-on.
4. Do **not** keep a permanent dual stack; dual is only a rollback bridge for one release.

### 4.2 Channel configuration

#### Control channel

```ts
pc.createDataChannel('control', {
  ordered: true,
  // reliable (default)
});
```

Carries only:

- `CRYPTO_SESSION`, `MANIFEST`, `TRANSFER_STARTED`, `PEER_CAPS`
- `PAUSE` / `RESUME` (receiver disk backpressure)
- `RESUME_FROM` / incomplete recovery
- `PARTITION_CHECKPOINT` / `CHECKPOINT_ACK` (renamed; see §5.4)
- `EOS` control (optional; binary EOS packet may still exist on bulk)
- Hybrid control messages (`HYBRID_*`) if armed

#### Bulk channel(s)

**Host / same-Wi-Fi default (preferred):**

```ts
pc.createDataChannel('bulk-0', {
  ordered: true,          // phase 1: keep ordered for simpler receiver
  // reliable
});
```

Phase 1 keeps bulk **ordered+reliable** but **isolated** from control. This alone removes control/bulk HOL coupling.

**Phase 2 experiment (flagged):**

```ts
pc.createDataChannel('bulk-0', {
  ordered: false,
  maxRetransmits: 30,     // still mostly reliable, less HOL than fully ordered
});
```

Only enable after receiver offset-dedup is proven (already needed for hybrid/stripe).

**Never:** put MANIFEST/CRYPTO on bulk.

### 4.3 Multi-bulk striping (host only)

Goal: beat single SCTP association ceiling on Wi-Fi/LAN.

Policy:

| Path | Bulk channels | PeerConnections |
|------|---------------|-----------------|
| `host` | `N = 2` default, max 4 | Prefer **N channels on 1 PC** first; escalate to multi-PC only if single-PC multi-channel plateaus |
| `srflx` | 1 | 1 |
| `relay` | 1 | 1 |
| `unknown` | 1 until classified | 1 |

Why channels-before-multi-PC:

- simpler ICE
- one DTLS session
- avoids previous simple-peer demux black-hole class of bugs
- enough for many browsers to raise throughput

Stripe scheduler:

```text
for each prepared packet:
  pick bulk channel with minimal bufferedAmount
  if all channels > highWater: wait for any onbufferedamountlow
  send on chosen channel
```

Receiver:

- accept packets on any bulk channel
- integrity by **payload offset**, not arrival order
- write via contiguous frontier (existing concept) but without ACK gating send window on host

Arming:

1. Create bulk-0..bulk-(N-1) at connect.
2. Optional 64 KiB probe ping/pong on each bulk channel before transfer.
3. If probe fails on secondary, fall back to bulk-0 only for that run.

### 4.4 binaryType and zero Blob path

Hard rules:

- `channel.binaryType = 'arraybuffer'` immediately on open
- reject / log if Blob arrives (should not happen)
- no `arrayBuffer()` conversion in steady state

---

## 5. Send pipeline redesign (B2, B3, B4, B5)

### 5.1 Delete app-level AIMD

**Decision:** remove `NetworkAdaptiveController` from the bulk send path.

Replace with webwormhole-style water marks only:

```ts
type PaceConfig = {
  highWaterBytes: number; // stop filling when bufferedAmount >= this
  lowWaterBytes: number;  // resume on bufferedamountlow / below this
  chunkSizeBytes: number;
  prepareAheadPackets: number;
};
```

No `cwnd *= 0.7`. No RTT-ratio multiplicative decrease.  
SCTP already reacts to loss/delay.

`networkAdaptiveController.ts` fate:

- Phase 0: bypass on `host|srflx`
- Phase 1: delete or reduce to diagnostics-only bitrate sampler

### 5.2 Path policy tables (replace current caps)

```ts
// Host / same-Wi-Fi (aggressive, still memory-safe)
HOST_PACE = {
  chunkSizeBytes: 256 * 1024,      // raise from 240KiB after maxMessageSize check
  highWaterBytes: 32 * 1024 * 1024,
  lowWaterBytes: 8 * 1024 * 1024,
  prepareAheadPackets: 32,
  checkpointEveryBytes: 0,         // 0 = only end-of-file checkpoint
  bulkChannels: 2,
};

SRFLX_PACE = {
  chunkSizeBytes: 256 * 1024,
  highWaterBytes: 16 * 1024 * 1024,
  lowWaterBytes: 4 * 1024 * 1024,
  prepareAheadPackets: 24,
  checkpointEveryBytes: 64 * 1024 * 1024,
  bulkChannels: 1,
};

RELAY_PACE = {
  chunkSizeBytes: 128 * 1024,
  highWaterBytes: 4 * 1024 * 1024,
  lowWaterBytes: 1 * 1024 * 1024,
  prepareAheadPackets: 12,
  checkpointEveryBytes: 16 * 1024 * 1024,
  bulkChannels: 1,
};
```

Clamp chunk size with existing `clampDataChannelChunkSize(maxMessageSize)`.

**Important:** do not use Chrome `availableOutgoingBitrate` as a hard cap on host. It is often pessimistic on LAN/Wi-Fi and was already noted in code comments. Use it as a **metric only** on host.

### 5.3 BulkSendPipeline algorithm

Single producer loop (worker **or** async main with yielding — prefer **Dedicated Worker** for read+encrypt):

```text
state = { offset, sequence, runId }
pace = PathPolicy.select(diagnostics)

// pipeline stages (parallel):
//  1) reader: File.slice / BYOB into packet payloads (prepareAhead)
//  2) encrypt: WebCrypto AES-GCM only
//  3) sender: paced DC send

while offset < totalSize:
  await waitUntilAnyBulkChannelBelow(pace.highWaterBytes)
  packet = await takePrepared()   // already encrypted
  ok = peer.sendBulk(pickChannel(), packet)
  if !ok: await drain
  offset += payloadSize
  maybeEmitProgress()

  if pace.checkpointEveryBytes > 0 and crossedCheckpoint(offset):
    await control.checkpoint(offset)   // NOT on host default

send binary EOS on bulk-0
await control.finalCheckpoint(totalSize)  // resume durability only
```

Rules:

1. **Do not terminate** a working encrypt worker at transfer start.
2. If worker is used: worker outputs **ciphertext packets** (ArrayBuffer transferables).
3. Main thread only paces + `dc.send`.
4. No `partitionAckWaiters` gate on host default path.
5. `PREPARE_AHEAD` stays full whenever any channel has room.

### 5.4 Checkpoints vs partition ACK (B4)

Rename conceptually:

| Old | New | Host default |
|-----|-----|--------------|
| `PARTITION` every 128 MiB + wait ACK | `CHECKPOINT` optional | **disabled** (`checkpointEveryBytes=0`) |
| Receiver `waitForIdle` before ACK | Checkpoint ACK only flushes writer if durable resume required | end-of-file only |
| Send stalls until ACK | Send never stalls on host for checkpoint | n/a |

Resume model:

- Receiver tracks `contiguousReceivedOffset`
- On reconnect, receiver sends `RESUME_FROM { offset }`
- Sender restarts bulk at that offset
- Checkpoint ACKs are an optimization for crash durability, **not** a throughput control loop

Relay/srflx may keep periodic checkpoints because middlebox loss + long RTT makes durable progress useful.

### 5.5 Encryption policy (B9)

Hot path **WebCrypto only**:

- Sender: `crypto.subtle.encrypt` AES-GCM
- Receiver: `crypto.subtle.decrypt` AES-GCM
- Key import once per run (`partitionCryptoKey` pattern, keep)

Quarantine:

- WASM software AES-GCM (`pons-core-wasm` table S-box) — **not allowed** in bulk hot path
- Keep WASM only if needed for non-hot features (zip, hashing), not packet crypto

Packet format: **keep current ciphertext packet layout** (version/flags/header/nonce/tag) so hybrid HTTP assist and resume stay compatible.

### 5.6 What happens to the existing worker

Current bug: transfer start **terminates** worker then runs main-thread partitioned send.

Target:

| Mode | Behavior |
|------|----------|
| Default | `BulkSendWorker`: read + encrypt + post transferable packets |
| Fallback | main-thread pipeline if worker init fails |
| Forbidden | terminate healthy worker “because partition mode” |

Worker responsibilities (narrow):

- file cursor / multi-file concat
- WebCrypto encrypt (worker has subtle crypto)
- packet header assembly
- **no** WebRTC access
- respond to `set-pace`, `seek(offset)`, `stop`

---

## 6. Receive pipeline redesign (B6)

### 6.1 Fast path for single ordered bulk stream

When `bulkChannels === 1 && ordered === true`:

```text
onBulkPacket(packet):
  plaintext = await decrypt(packet)          // parallelizable with previous write
  enqueueWrite(plaintext, offset)            // no reordering buffer
```

Skip:

- normalize copy into new header+payload buffer when possible
- `WasmReorderingBuffer` / JS reordering for steady-state sequential offsets

Keep lightweight guard:

```ts
if (offset < contiguousOffset) return; // dup
if (offset > contiguousOffset) {
  // unexpected gap on ordered channel → request RESUME_FROM contiguousOffset
}
```

### 6.2 Multi-channel / unordered path

When striping or unordered bulk enabled:

- keep offset map / reordering
- still **decrypt outside** the serial write lock (already partially done)
- write only contiguous spans

### 6.3 Copy budget per packet (target)

Current (approx): decrypt out → new ArrayBuffer normalize → slice into reorder → merge → write  
Target host path:

1. decrypt → plaintext `ArrayBuffer`
2. write plaintext to disk stream  
≤ **1 mandatory crypto buffer + 1 write handoff**

Avoid:

- `buffer.slice` when view is already standalone
- double header rewrite unless resume/compatibility requires plain packet shape internally

Internal adapter may still present a plain packet to writer **without** re-encoding a full new packet if writer API is updated to `writePayload({offset, bytes})`.

### 6.4 Disk backpressure only

Receiver may send control `PAUSE` / `RESUME` when pending write bytes exceed:

- pause: 64 MiB pending
- resume: 16 MiB pending

This is **disk** backpressure, not network AIMD.  
Sender reacts by stopping bulk fills (water mark already 0 effective) until RESUME.

### 6.5 Writer modes

Unchanged priority for product:

1. File System Access  
2. StreamSaver  
3. OPFS  
4. Blob fallback (small only)

Throughput QA should force FSA or OPFS; Blob mode is not a speed target.

---

## 7. Diagnostics & observability (required before claiming victory)

Every transfer emits a `ThroughputTrace` sample every 250 ms:

```ts
type ThroughputTrace = {
  t: number;
  pathKind: 'host' | 'srflx' | 'relay' | 'unknown';
  protocol: string | null;
  rttMs: number | null;
  availableOutgoingBitrateBps: number | null;
  bulkBufferedAmount: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  inflightPreparedBytes: number;
  chunkSizeBytes: number;
  bulkChannelsArmed: number;
  bytesSent: number;
  bytesReceivedContiguous: number;
  sendMBps: number;
  recvMBps: number;
  checkpointWaits: number;
  pauseCount: number;
  decryptMsEma: number;
  writeMsEma: number;
  channelEmptyMs: number; // time sender wanted to send but waited on water mark
};
```

UI: optional debug overlay behind `?throughputDebug=1`.  
QA: write JSONL under `benchmarks/v1/results/throughput/`.

Acceptance runs must include `pathKind=host` proof.  
If tests ran on `relay`/`srflx`, do not claim Wi-Fi P2P results.

---

## 8. Phased implementation plan

### Phase 0 — Measure ground truth (0.5–1 day)

No behavior change except logging.

1. Emit `ThroughputTrace`.
2. Record for same-Wi-Fi pair:
   - app path MB/s
   - raw native DataChannel microbench MB/s (`scripts/transfer-speed-test.mjs` upgraded to native dual-channel)
3. Confirm `candidatePathKind` on failing runs.

**Exit:** we know whether ceiling is browser SCTP (~raw) or app stack (app << raw).

### Phase 1 — Native peer + channel split (primary fix) (2–3 days)

1. Implement `PeerSession` native.
2. Control vs bulk channel split.
3. Route all JSON to control; all file packets to bulk-0.
4. Keep encryption + packet format.
5. Feature flag rollback to simple-peer for one release if needed.

**Exit criteria (same Wi-Fi, host):**

- app MB/s ≥ **min(0.7 × rawBench, 8 MB/s)** on 100–512 MB fixture
- no functional regression on resume smoke

### Phase 2 — Kill double congestion control + raise host water marks (1 day)

1. Bypass/delete AIMD controller on host/srflx.
2. Install `HOST_PACE` water marks.
3. Disable host partition/checkpoint wait (`checkpointEveryBytes=0`).
4. Keep end-of-transfer durability handshake only.

**Exit:**

- median ≥ **8 MB/s**
- `checkpointWaits == 0` during host bulk
- bufferedAmount actually oscillates near highWater (not stuck ~0)

### Phase 3 — Receiver fast path (1–2 days)

1. `writePayload(offset, bytes)` API.
2. Skip reorder on single ordered bulk.
3. Decrypt parallel to write; single serial writer for disk only.
4. Raise disk pause thresholds.

**Exit:**

- receiver CPU decrypt/write not saturated before network
- gap/resume still works in fault injection

### Phase 4 — Restore encrypt worker correctly (1–2 days)

1. Worker produces ciphertext transferable packets.
2. Main thread only sends.
3. Remove “terminate worker at transfer start”.

**Exit:**

- UI thread remains responsive during 512 MB transfer
- throughput ≥ Phase 2 (no regression)

### Phase 5 — Host multi-bulk channels (2 days)

1. `bulkChannels=2` on host.
2. Least-bufferedAmount scheduling.
3. Receiver multi-ingress offset dedup.

**Exit:**

- Target B: median ≥ **12 MB/s** when raw bench supports it
- if no gain vs 1 channel, keep N=1 (document measurement)

### Phase 6 — Cleanup (1 day)

1. Remove simple-peer dependency from transfer.
2. Quarantine/delete dead AIMD, unused FEC/Merkle from product bundle if unused.
3. Mark WASM software AES as non-hot-path only (or remove export from app).
4. Update hybrid doc: host speed is native bulk path, not HTTP assist.

---

## 9. Wire protocol changes

### 9.1 Unchanged

- Signaling room join/offer-answer relay
- Ciphertext packet binary layout
- `CRYPTO_SESSION`, `MANIFEST`, `TRANSFER_STARTED`
- Resume offset semantics
- Hybrid object framing (still ciphertext packets)

### 9.2 Changed / added

| Message | Change |
|---------|--------|
| bulk binary | moves to `bulk-*` channels only |
| control JSON | moves to `control` only |
| `PARTITION` / `PARTITION_ACK` | deprecate on host; replace with optional `CHECKPOINT` / `CHECKPOINT_ACK` |
| `PEER_CAPS` | add `{ nativePeer: true, bulkChannels: number, bulkOrdered: boolean, throughputProto: 2 }` |
| `PAUSE`/`RESUME` | disk backpressure only; ignore as network congestion signal |

Compatibility:

- If remote `throughputProto < 2`, fall back to single-channel legacy behavior for that peer.
- Do not break old receivers mid-rollout.

---

## 10. File map

| File | Action |
|------|--------|
| `docs/design/webrtc-bulk-throughput.md` | this design |
| `src/services/peerSession.ts` | **new** native PeerSession |
| `src/services/singlePeerConnection.ts` | thin adapter → PeerSession, then delete |
| `src/services/swarmManager.ts` | BulkSendPipeline integration; remove host partition wait; stop worker terminate |
| `src/services/webRTCService.ts` | control/bulk handlers split; checkpoint optional |
| `src/services/directFileWriter.ts` | fast payload write path; reorder optional |
| `src/services/networkAdaptiveController.ts` | bypass/delete AIMD |
| `src/utils/constants.ts` | new water marks; bulk channel counts; flags |
| `src/utils/transferFlowControl.ts` | PathPolicy tables; remove host-starving caps |
| `src/workers/file-sender.worker.ts` | ciphertext producer only; keep alive during transfer |
| `src/services/hybridBulkTransport.ts` | unchanged semantics; host still skips |
| `scripts/transfer-speed-test.mjs` | native control+bulk microbench |
| `scripts/transfer-compare-test.mjs` | app vs raw compare harness |
| tests under `src/services/*.test.ts` | channel split, pace, checkpoint policy, resume |

---

## 11. Testing plan

### 11.1 Unit

- PeerSession: control message never lands on bulk handler
- PathPolicy selection by diagnostics
- paced send stops above highWater and resumes on lowWater
- host path issues zero mid-transfer checkpoints
- receiver fast path rejects gaps with resume request
- multi-bulk offset dedup

### 11.2 Same-Wi-Fi bench protocol (user environment)

Fixture: **256 MiB** pseudo-random file (not sparse zeros only).

Arms:

1. **Raw native** 1 bulk channel ordered reliable  
2. **Raw native** 2 bulk channels  
3. **App Phase1** encrypted  
4. **App Phase2+** encrypted host policy  
5. **App relay forced** (sanity that conservative path still completes)

For each arm, N=5 runs, report median / p05 MB/s, pathKind, rtt, peak bufferedAmount.

### 11.3 Correctness gates (must stay green)

- encrypt/decrypt roundtrip
- incomplete transfer detection
- resume from mid-offset
- multi-file manifest reassembly
- hybrid still works on non-host (no regression)

### 11.4 Success criteria (ship)

Same Wi-Fi, `pathKind=host`, Chrome recent stable, 256 MiB:

| Metric | Must | Should |
|--------|------|--------|
| App median payload MB/s | ≥ 8 | ≥ 12 |
| App p05 | ≥ 5 | ≥ 8 |
| Completeness | 100% | 100% |
| Resume smoke | pass | pass |
| App/raw ratio | ≥ 0.6 | ≥ 0.75 |

If raw bench itself is ~3 MB/s on that Wi-Fi pair, the network/browser is the ceiling; document and stop blaming app policy. Then investigate radio/AP/client isolation/power save, not more app complexity.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Unordered bulk exposes writer gaps | Phase 1 stays ordered; unordered behind flag |
| Large highWater increases memory | cap prepareAhead; monitor JS heap; 32 MiB host default is intentional |
| Multi-channel fairness bugs | least-bufferedAmount + per-run probe; auto fallback to 1 |
| simple-peer removal regressions | flag + one-release dual support |
| Checkpoint removal weakens resume durability | end checkpoint + contiguous offset resume still required |
| Wi-Fi power save / AP client isolation | diagnostics show host but low raw; document env issue |
| Main-thread encrypt jank | Phase 4 worker mandatory for large files |

---

## 13. Explicit deletions / freezes

### Freeze (do not expand)

- AIMD/BBR-inspired app congestion control
- FEC on bulk path
- Merkle per-chunk verification on bulk path
- Hybrid HTTP as LAN accelerator
- New abstract “transport frameworks” without bench proof

### Delete or quarantine after Phase 6

- simple-peer transfer dependency
- host `PARTITION` wait loop
- worker terminate-on-start
- software AES bulk fallback
- unused stripe code paths that cannot arm (`LAN_STRIPE_LANES=1` dead multi-PC under simple-peer)

---

## 14. Decision record

| Decision | Choice | Why |
|----------|--------|-----|
| Peer library | **Native RTCPeerConnection** | simple-peer blocks multi-channel/stripe and hides channel config |
| Bulk reliability Phase 1 | **ordered + reliable**, separate channel | max compatibility, still removes control HOL |
| Congestion control | **SCTP only + bufferedAmount water marks** | double AIMD was starving Wi-Fi |
| Host checkpoints | **off mid-transfer** | partition ACK is throughput tax, not needed for reliable SCTP |
| Crypto | **WebCrypto only** | software WASM AES is not a throughput strategy |
| Striping | **multi DataChannel first**, multi-PC later | lower complexity than previous multi-PC black-hole |
| Hybrid | **keep for cross-network only** | correct product split; not a Wi-Fi fix |
| Evidence pipeline | **untouched** | orthogonal integrity program |

---

## 15. Implementation order (checklist)

```text
[ ] Phase 0 traces + raw native bench on the real Wi-Fi pair
[ ] PeerSession native + control/bulk split
[ ] SwarmManager send on bulk only
[ ] Receiver accept bulk only for binary packets
[ ] Disable AIMD on host
[ ] Raise host water marks; disable host mid-transfer partition wait
[ ] Receiver writePayload fast path
[ ] Worker ciphertext pipeline restored
[ ] Optional second bulk channel on host
[ ] Remove simple-peer; clean dead code
[ ] Publish before/after bench JSON under benchmarks/v1/results/throughput/
```

---

## 16. One-sentence contract

**Same-Wi-Fi transfers must be limited by the radio and the browser SCTP stack, not by app-level ACK barriers, AIMD, single mixed ordered channels, or a main-thread pipeline that killed its own worker.**

---

## 17. External review alignment (ChatGPT share 6a59c81a)

Source: https://chatgpt.com/share/6a59c81a-b268-83ee-8b19-8e77d9ab0911

Mapped recommendations → PonsWarp status after this pass:

| Recommendation | Status | Notes |
|----------------|--------|-------|
| P0 remove per-chunk ACK | **done** | Partitioned path only; SCTP reliability |
| P0 remove ACK window=4 | **done** | No app chunk ACK window |
| P0 setTimeout(100ms) buffer wait → bufferedamountlow | **done** | Event + 25ms watchdog fallback |
| P0 remove 500ms meta delay | **done** | 20ms settle at EOS only |
| P0 ICE path in UI/logs | **done** | path/protocol/rtt/hostAddressScope |
| P0 disk stream receive | **done** | DirectFileWriter FSA/OPFS/StreamSaver |
| P1 chunk not fixed 240KiB | **done** | 128KiB host, 64KiB relay/high-RTT |
| P1 control vs bulk channels | **done** | PeerSession control + bulk-0 |
| P1 multi bulk channels | freeze | BULK_CHANNEL_COUNT=1 until proven |
| P1 crypto/CRC off main | **done (sender)** | `bulk-encrypt.worker` + Transferable packets; CRC removed; receiver decrypt still main |
| P1 UI throttle 4–10 Hz | **done** | 200ms / 32 chunks |
| P1 bounded prepare-ahead | **done** | PREPARE_AHEAD_BYTES=12MiB |
| P2 adaptive profiles | **done** | host / elevated-host / srflx / relay |
| P2 hybrid/WebTransport | later | hybrid hard-off on hot path; WebTransport not for browser-browser P2P |

Design principles reinforced by the review:

1. **One congestion controller** — SCTP only; app paces on `bufferedAmount`.
2. **No app stop-and-wait** on bulk except resume checkpoints.
3. **Path-aware knobs** — high-RTT host is not LAN host.
4. **Bounded memory pipeline** — prepare-ahead by bytes, not unbounded count.
5. **Separate control plane** — never mix large bulk with control on one channel.
