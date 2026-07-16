# PonsWarp File Transfer Logic Comparison & Redesign

Status: **design proposal (implementation-ready)**  
Date: 2026-07-16  
Owners: transfer plane (`SwarmManager`, `SinglePeerConnection`, `webRTCService`, `directFileWriter`)  
Related:

- `docs/design/hybrid-bulk-transport.md` — cross-network hybrid assist (keep)
- `docs/design/lan-transfer-pipeline.md` — gated LAN host pipeline evidence (keep, do not confuse with product path)
- PonsLink reference implementation (external sibling product):
  - `ponslink-room-frontend/src/stores/usePeerConnectionStore.ts`
  - `ponslink-room-frontend/src/services/realtimeTransport/policies.ts`
  - `ponslink-room-frontend/src/lib/fileTransfer/transferThroughput.ts`
  - `ponslink-room-frontend/src/workers/file-receiver.worker.ts`

---

## 1. Problem statement

On the same class of ~100 Mbps Wi-Fi LAN, **PonsLink chat file transfer is materially faster than PonsWarp E2E transfer**.

Measured (20 MB fixture, two physical devices, host-like path unless noted):

| Product / path | Approx throughput | Notes |
|---|---|---|
| PonsLink stable single-PC | **~50 Mbps** (~6.3 MB/s) | host-host, production-like |
| PonsLink best dual-PC | **~61 Mbps** (~7.7 MB/s) | one-shot peak; flaky |
| PonsWarp app E2E LAN-like | **~16–23 Mbps** (~2.0–2.9 MB/s) | complete transfers |
| PonsWarp raw 1× DataChannel | ~24–27 Mbps (~3.0–3.4 MB/s) | CDP microbench |
| PonsWarp raw multi-PC | ~40–48 Mbps (~5–6 MB/s) | not integrated safely |
| PonsWarp LTE↔home complete | ~5–9 Mbps (~0.6–1.1 MB/s) | uplink-limited |
| SSH / TCP baseline | ~72–82 Mbps (~9–10 MB/s) | network headroom |

Gap to close on LAN:

```text
PonsWarp app  ~20 Mbps
PonsLink      ~50 Mbps   (~2.5×)
TCP headroom  ~72 Mbps
Wi-Fi theory  ~100 Mbps
```

This document answers three questions:

1. **What exact logic differs** between PonsLink and PonsWarp?
2. **Which differences actually cause the speed gap?**
3. **How should PonsWarp be redesigned** without throwing away E2E encryption, resume, multi-file, and hybrid assist?

---

## 2. Product intent difference (context, not an excuse)

| Concern | PonsLink | PonsWarp |
|---|---|---|
| Primary UX | Room chat attachment | Standalone encrypted file drop |
| Security model | WebRTC DTLS only | **App-level E2E AES-GCM** + DTLS |
| Resume | lightweight pending transfer | offset/generation resume + crypto session |
| Multi-file | single file per transfer | zip/manifest multi-file stream |
| Cross-network | same WebRTC path | WebRTC + hybrid HTTP ciphertext assist |
| Media coexistence | yes (A/V can share PC) | file-only product |

PonsWarp carries more product requirements. That is expected.  
The current gap is **not fully explained by those requirements** — raw single DC already beats app E2E, and PonsLink shows a higher practical browser ceiling on the same Wi-Fi class.

---

## 3. End-to-end architecture comparison

### 3.1 PonsLink (throughput-oriented firehose)

```text
[UI sendFile]
    │
    ▼
usePeerConnectionStore.sendFile
    │  desktop: main-thread stream loop
    │  mobile: worker path
    │
    ├─ FileChunkReader (slice + pipeline slots)
    ├─ buildPacket(header + payload)   // no app crypto
    └─ sendToPeer / WebRTCManager
           │
           ▼
    RTCDataChannel "pons:file"
      ordered: false
      reliable (no maxRetransmits)
      high=4MiB, hard=8MiB
      bufferedAmountLowThreshold ≈ high/4
           │
           ▼
    receiver worker
      memory map if size < 64MiB
      else OPFS sync write + local reorder buffer
      sparse ack (every 64 chunks / 8MiB)
```

Key property: **one direction bulk stream**, paced only by local `bufferedAmount`.  
Receiver durability is local; sender does not wait for app-level partition ACKs.

### 3.2 PonsWarp (reliability-oriented partitioned pipeline)

```text
[SenderView]
    │
    ▼
SwarmManager.requestTransferStart / runPartitionedTransfer
    │
    ├─ MANIFEST / CRYPTO_SESSION / TRANSFER_STARTED  (JSON control)
    ├─ prepare ahead (read + optional AES-GCM encrypt)
    ├─ broadcastChunk on simple-peer DataChannel
    │     ordered: true
    │     single channel shares control + bulk
    ├─ every partition boundary:
    │     send PARTITION marker
    │     wait PARTITION_ACK from receivers
    │     (ACK only after contiguous reordering frontier)
    └─ EOS
           │
           ▼
webRTCService.handleData
    ├─ JSON control branch
    └─ binary → directFileWriter.writeChunk
           ├─ decrypt if encrypted
           ├─ reorderingBuffer / contiguous frontier
           ├─ FSA / StreamSaver write
           └─ PAUSE/RESUME if write buffer high (32MiB)
```

Key property: **bulk is gated by reverse control** (partition frontier, disk pause, ordered SCTP).  
This is excellent for completeness and resume, expensive for LAN fill-rate.

---

## 4. Concrete logic side-by-side

### 4.1 Transport object model

| Item | PonsLink | PonsWarp (today) |
|---|---|---|
| Peer library | native `RTCPeerConnection` | **simple-peer** wrapper |
| Channels | multi-channel policy (`control`, `text`, `file`, `media`…) | **one channel** for control + bulk |
| File channel label | `pons:file` / `pons:file-data` | default simple-peer channel |
| Channel order | **unordered reliable** for file | **ordered true** for everything |
| Optional dual PC | dedicated data-only PC (gated) | multi-PC stripe raw-only; app demux broken → OFF |

Evidence:

- PonsLink policy: `realtimeTransport/policies.ts` → `file.ordered = false`
- PonsWarp channel: `singlePeerConnection.ts` → `channelConfig.ordered = true`
- PonsWarp stripe: `constants.ts` → `LAN_STRIPE_LANES = 1`

**Impact rank: HIGH.**  
Ordered single channel means any lost/retransmitted bulk TSN can head-of-line-block subsequent bulk and control frames. PonsLink avoids that for file bytes.

### 4.2 Packet format / CPU path

| Item | PonsLink | PonsWarp |
|---|---|---|
| Header | ~type + idLen + transferId + chunkIndex + dataLen | 22B plain / 38B+tag encrypted |
| Checksum | none on hot path | CRC32 on plain packets |
| Crypto | none (DTLS only) | AES-GCM per chunk when session armed |
| Chunk size | 128–192 KiB preferred | 240 KiB (crypto-safe under 256 KiB) |
| Prefetch | pipeline slots 16 (desktop) | prepare-ahead 16 + 2 MiB block cache |

PonsLink packet builder (hot path):

```text
[u8 type=1][u16 idLen][id bytes][u32 chunkIndex][u32 dataLen][payload]
```

PonsWarp plain packet:

```text
[u16 fileIndex][u32 sequence][u64 offset][u32 dataLen][u32 crc32][payload]
```

Encrypted path adds nonce/tag and WebCrypto `encrypt` per chunk.

**Impact rank: MEDIUM–HIGH on laptop CPU / main-thread contention; MEDIUM alone on pure network-bound LAN.**  
Crypto alone does not fully explain 2.5×, but it:

1. serializes prepare order (`nextToSend` waits for sequence readiness),
2. enlarges effective packet work,
3. forces careful chunk ceilings,
4. competes with UI/simple-peer event handling.

### 4.3 Sender pacing algorithm

#### PonsLink desktop loop (`usePeerConnectionStore`)

```text
for chunkIndex in 0..totalChunks:
  prefetch next N slices
  while bufferedAmount + chunkSize > high:
    sleep 1–4ms
  packet = header + payload
  send(packet)                 // fire and continue
send END (twice)
// sparse receiver acks update UI only; do not gate send
```

Constants (desktop):

- `bufferHigh = 4 MiB`
- `bufferLow  = 1 MiB`
- `bufferHard = 8 MiB`
- `chunkSize  ≈ 192 KiB` when maxMessageSize allows
- progress UI every ~120 ms

#### PonsWarp partitioned loop (`SwarmManager.sendFilesPartitioned`)

```text
fill prepare-ahead (read+encrypt) up to 16
while not eof:
  wait until sequence nextToSend is ready
  while ready:
    if bufferedAmount > inFlightTarget: wait drain
    broadcastChunk(packet)
    if crossed partitionEnd:
      send PARTITION(offset)
      wait all receivers PARTITION_ACK(offset)   // CONTENTION POINT
      recompute next partitionEnd
      break inner burst
send EOS / finalize
```

Constants:

- host in-flight target: min 2 MiB / initial 4 MiB / max 6 MiB
- low water: 1 MiB
- partition size: **128 MiB** (or 4 MiB when stripe armed)
- `PARTITION_ACK_POLL_INTERVAL_MS = 10`

**Impact rank: HIGH.**  
Even with 128 MiB partitions, ACK waits on:

- receiver reordering frontier (`getContiguousReceivedOffset`)
- disk write catch-up
- control-message round trip on the **same ordered channel**

During that wait, SCTP cwnd can drain and restart cost appears as lower average Mbps.

### 4.4 Receiver logic

| Item | PonsLink | PonsWarp |
|---|---|---|
| Hot path store | worker Map / OPFS | `directFileWriter` + reordering buffer |
| Reorder | only required for OPFS sequential write | always for contiguous frontier / PARTITION_ACK |
| Large-file threshold | memory until **64 MiB**, then OPFS | FSA-first writer always durability oriented |
| Reverse pressure | sparse ack only | **PAUSE at 32 MiB**, RESUME at 16 MiB |
| Completion gate | receivedCount / end packet | contiguous offset + EOS + materialize |

**Impact rank: HIGH when disk/FSA is slow or main-thread busy; MEDIUM on fast SSD with small files.**  
PonsLink deliberately keeps medium files in memory for LAN speed. PonsWarp prioritizes durable write + frontier correctness for resume/multi-lane.

### 4.5 Control-plane coupling

| Item | PonsLink | PonsWarp |
|---|---|---|
| Control vs bulk | separate channels | **same ordered channel** |
| Start handshake | `file-meta` then bytes | MANIFEST + CRYPTO + STARTED + caps |
| During transfer control | rare pause/cancel/ack | PARTITION, PARTITION_ACK, PAUSE/RESUME, progress |
| Failure policy | cancel transfer | peer removal, resume offset, hybrid fallback |

**Impact rank: HIGH.**  
Mixing JSON control with bulk on one ordered channel means:

1. control latency inherits bulk queue delay,
2. bulk inherits control HOL risk,
3. partition ACK RTT is inflated by whatever is already buffered.

### 4.6 ICE / media / path selection

| Item | PonsLink | PonsWarp |
|---|---|---|
| STUN-first / delayed TURN | yes (desktop bootstrap) | normal ICE via configured servers |
| Host preference | yes in QA path | host diagnostics exist; product still one PC |
| Media during transfer | **mute/detach A/V** to free SCTP | N/A product, but simple-peer still generic |
| Dual data PC | optional dedicated transport | stripe lanes disabled in app |

**Impact rank: MEDIUM on LAN, HIGH if path falls to relay.**  
PonsLink actively protects the bulk path from media competition. PonsWarp product is file-only, but still pays ordered-channel and simple-peer costs.

### 4.7 Cross-network strategy

| Item | PonsLink | PonsWarp |
|---|---|---|
| Pure WebRTC | only path | baseline |
| Hybrid ciphertext HTTP | no | yes (`hybridBulkTransport`) |
| Host LAN hybrid | n/a | auto-skip (correct) |

Hybrid is the right strategy for weak uplinks / bad NAT. It does **not** solve the LAN gap and must remain orthogonal to the redesign below.

---

## 5. Root-cause ranking (why PonsWarp is slower)

Ordered by expected contribution on **same-LAN host-host** with encryption on:

| Rank | Cause | Why it hurts | Est. share of gap |
|---|---|---|---|
| 1 | **Single ordered DataChannel for control+bulk** | SCTP HOL + control/bulk interference | large |
| 2 | **Partition ACK barrier on contiguous frontier** | stops sender while receiver/disk/control catch up | large |
| 3 | **App-level encrypt/decrypt + prepare ordering** | CPU + sequence readiness stalls | medium |
| 4 | **Durability-first receiver (FSA/reorder/PAUSE)** | reverse pressure more aggressive than PonsLink memory path | medium |
| 5 | **simple-peer single association / no safe multi-lane** | leaves multi-PC raw gains unused | medium on high-BW LAN |
| 6 | ICE/path fallback to non-host | relay destroys throughput | situational |

What is *not* the main issue:

- chunk size 240 KiB vs 192 KiB (both fine under SCTP)
- lack of hybrid on LAN (hybrid is correctly skipped on host)
- missing per-chunk ACK (both products already avoid hot-path per-chunk ACK)

---

## 6. Design principles for the redesign

1. **Separate planes**: control channel ≠ bulk channel.
2. **Bulk should be reliable-unordered** (or multiple independent streams), not ordered-with-control.
3. **Pacing authority is local `bufferedAmount`**, not reverse app ACK, on healthy direct paths.
4. **Encryption stays mandatory**, but must be **pipeline-ahead** and never serialize the send loop beyond sequence packaging.
5. **Durability checkpoints are sparse and non-blocking by default**; blocking barriers only for resume snapshots / multi-receiver catch-up / degraded paths.
6. **Do not regress completeness**: final contiguous bytes == manifest size; integrity digest remains authoritative.
7. **Keep hybrid assist** for non-host/cross-net; do not let it complicate host bulk path.
8. **Measure with the same harness** across arms: host-host 20/256 MiB, complete time, peak/avg Mbps, integrity.

---

## 7. Target architecture (PonsWarp vNext bulk plane)

### 7.1 Channel layout

```text
PeerConnection (native RTCPeerConnection preferred; simple-peer only for signaling bootstrap if needed)

  dc:control   ordered:true, reliable, small buffers
               MANIFEST, CRYPTO_SESSION, TRANSFER_STARTED,
               PARTITION_CHECKPOINT, PAUSE/RESUME, ERROR, EOS_CTRL

  dc:bulk-0    ordered:false, reliable, large buffers
  dc:bulk-1..N optional additional bulk streams (phase 2)
               binary packets only
```

Rules:

- JSON never rides on bulk channels.
- Bulk channels never carry control that can HOL-block bytes.
- If browser max channels / negotiation fails, fall back to single bulk channel still **unordered reliable**, control stays separate.

### 7.2 Packet contract (keep crypto, slim hot path)

Keep existing encrypted packet semantics for compatibility where possible, but define an explicit bulk frame:

```text
BulkFrameV1
  magic: u8 = 0x01
  flags: u8          // bit0 encrypted, bit1 eos, bit2 checkpoint
  sequence: u32
  offset: u64
  payloadLen: u32
  payload: bytes     // plaintext or ciphertext+tag depending on flags
```

Compatibility mode:

- Phase 0 can keep current plain/encrypted packet bodies on `dc:bulk-*`.
- Only transport/channel semantics change first.

CRC on every plain packet is optional on host path; integrity should be:

- per-partition Merkle/rolling hash, or
- final SHA stream (already in evidence/WASM path),
not per-chunk main-thread CRC if it shows up in profiles.

### 7.3 Sender algorithm (host / direct path)

```text
arm crypto session on control
send MANIFEST + TRANSFER_STARTED on control

open bulk channel(s)
start prepare workers:
  while more data:
    slice -> encrypt ahead into readyQueue (cap by bytes, not just count)

send loop:
  while transfer active:
    if any receiver PAUSED: wait (event)
    if bufferedAmount(bulk) > high: wait bufferedamountlow
    pop next ready frame (sequence order per stream)
    bulk.send(frame)
    maybe emit sparse progress on control (100ms)

  send EOS on bulk and/or control
  wait FINAL_ACK only at end (or after sparse checkpoints)
```

Defaults (desktop host):

| Knob | Value | Rationale |
|---|---|---|
| bulk high watermark | 4–6 MiB | match PonsLink; avoid bufferbloat |
| bulk low watermark | 1–1.5 MiB | drain event cadence |
| prepare-ahead bytes | 4–8 MiB ciphertext | hide encrypt latency |
| chunk payload | 192–240 KiB | keep under SCTP message cap |
| progress control interval | 100–200 ms | UI only |
| checkpoint interval | 32–128 MiB or 2s | resume durability, non-blocking default |

### 7.4 Receiver algorithm

```text
control: init writer, crypto, manifest
bulk onmessage:
  decrypt if needed (worker preferred)
  accept out-of-order into reordering structure
  write contiguous frontier to FSA/OPFS/memory strategy
  if pending write bytes > pauseHigh: send PAUSE on control
  if drained < pauseLow: send RESUME
  if checkpoint requested and frontier >= offset: send CHECKPOINT_ACK
  if frontier == total and EOS seen: finalize/materialize
```

Strategy split:

| File size | Host path store | Why |
|---|---|---|
| < 64 MiB | memory assemble (or OPFS optional) | copy PonsLink LAN win |
| ≥ 64 MiB | OPFS/FSA stream | memory safety |
| multi-file zip stream | existing writer path | product requirement |

`PARTITION_ACK` blocking behavior becomes:

- **default off** for 1:1 host/direct,
- **on** for multi-receiver catch-up, resume snapshot, or degraded/loss paths.

### 7.5 Encryption design (must not be removed)

Goals:

- keys never leave browsers
- ciphertext may still go hybrid HTTP
- host path remains encrypted end-to-end

Implementation rules:

1. Encrypt in **worker or async pipeline**, never inline-blocking the send burst more than one frame.
2. Maintain `readyQueue` of already-encrypted frames sized to ≥ RTT×rate (LAN: a few MiB).
3. Prefer streaming encrypt APIs / wasm path if profiling shows WebCrypto main-thread cost.
4. Do not wait for receiver decrypt ACK.

### 7.6 Checkpoint / resume redesign

Today: blocking partition barrier every N bytes.  
Target:

```text
Sender may emit CHECKPOINT(offset) on control (sparse)
Receiver responds CHECKPOINT_ACK(offset) when durable frontier >= offset
Sender records resume watermark asynchronously
Sender does NOT stop bulk unless:
  - multi-receiver requires lockstep, or
  - loss/degraded mode enabled, or
  - checkpoint is marked durable-required before peer change
```

End-of-transfer still requires hard completion:

```text
frontier == totalSize && integrity OK
```

### 7.7 Multi-stream / multi-PC (phase 2)

Only after single unordered bulk channel is solid:

1. 2–4 bulk DataChannels on **one** PC (independent SIDs, less HOL)
2. then optional multi-PC host striping with native PC (not simple-peer demux)

Credit/scheduler:

- per-stream bufferedAmount fair queue
- global offset allocator
- receiver frontier still global for completion

Do not enable multi-PC in production until integrity soak passes.

### 7.8 Interaction with hybrid assist

Unchanged product policy:

- host path: hybrid auto-skip
- non-host: hybrid-primary optional
- control stays WebRTC
- HTTP body is ciphertext only

vNext bulk plane changes must keep hybrid packet format stable or versioned.

---

## 8. Implementation plan

### Phase 0 — Instrumentation (1–2 days)

Add counters without behavior change:

- selected candidate pair type/protocol
- `bufferedAmount` high-water histogram
- time blocked in: encrypt, waitDrain, waitPartitionAck, receiverPaused
- channel empty duty
- app vs SCTP limited samples

Acceptance: one LAN run explains where ≥70% of transfer time went.

### Phase 1 — Split control/bulk + unordered bulk (core)

Files likely touched:

- `src/services/singlePeerConnection.ts` (or replace bulk send surface)
- `src/services/swarmManager.ts`
- `src/services/webRTCService.ts`
- `src/utils/constants.ts`
- tests around flow control / packet parse

Steps:

1. Negotiate/open `control` + `bulk` channels.
2. Move all JSON control to `control`.
3. Set bulk `ordered:false` reliable.
4. Keep current packet bodies initially.
5. Disable blocking partition wait on 1:1 direct/host (`checkpointMode = 'async'`).
6. Keep PAUSE/RESUME on control.

Acceptance (same 20 MB host-host pair used for PonsLink QA):

- complete always
- median ≥ **40 Mbps**
- p05 ≥ **32 Mbps**
- no integrity mismatch

Stretch: approach PonsLink stable (~50 Mbps).

### Phase 2 — Encrypt pipeline + memory-fast receive path

1. Worker/async encrypt readyQueue by bytes.
2. For totalSize < 64 MiB, allow memory assemble path (feature-flagged) before FSA materialize.
3. Raise prepare-ahead based on measured drain rate (BDP-like, capped).

Acceptance:

- median ≥ **48–55 Mbps** on same LAN fixture
- encrypt wait share < 10% of transfer time

### Phase 3 — Multi bulk streams / optional multi-PC

1. 2–4 unordered bulk channels on one PC.
2. Only then revisit native multi-PC striping.

Acceptance:

- 256 MiB soak median ≥ **60 Mbps** when TCP baseline ≥ 70 Mbps
- zero incomplete transfers in 20-run soak

### Phase 4 — Cross-net verification

Confirm hybrid still arms on non-host and completeness unchanged.  
Do not use LTE uplink runs as LAN success criteria.

---

## 9. API / state machine sketch

### Sender states

```text
IDLE
  -> HANDSHAKING (control open, crypto, manifest)
  -> BULK_OPEN
  -> STREAMING
  -> FINALIZING
  -> COMPLETE | FAILED
```

### Receiver states

```text
IDLE
  -> READY (writer+crypto)
  -> RECEIVING
  -> PAUSED_DISK
  -> FINALIZING
  -> MATERIALIZED | FAILED
```

### Control messages (vNext)

| Message | Direction | Blocking? |
|---|---|---|
| `MANIFEST` | S→R | before bulk |
| `CRYPTO_SESSION` | S→R | before bulk |
| `TRANSFER_STARTED` | S→R | no |
| `PAUSE` / `RESUME` | R→S | yes (sender respects) |
| `CHECKPOINT` | S→R | no by default |
| `CHECKPOINT_ACK` | R→S | no by default |
| `FINAL_ACK` | R→S | yes at end |
| `ERROR` | either | yes |

### Bulk messages

Binary frames only. No JSON.

---

## 10. Explicit non-goals

- Removing E2E encryption from product path
- Making LAN TCP agents a production dependency
- Copying PonsLink room/media architecture wholesale
- Enabling broken simple-peer multi-PC demux
- Trading completeness for speed

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unordered bulk exposes writer bugs | keep reordering frontier; soak tests; fuzzy out-of-order unit tests |
| Control/bulk negotiation fails on old clients | capability flag + fallback single bulk unordered |
| Memory path OOM on mobile | size threshold + mobile always streaming write |
| Encrypt pipeline memory growth | hard cap readyQueue bytes; backpressure to slice stage |
| Regression on multi-receiver | lockstep checkpoint mode remains available |
| Hybrid drift | shared packet builder used by both paths |

---

## 12. Test matrix

| Case | Fixture | Path | Pass rule |
|---|---|---|---|
| LAN host 20MB | fixed random bin | host-host | complete + integrity + median Mbps target |
| LAN host 256MB | fixed | host-host | complete + no pause deadlock |
| Wi-Fi lossy | 20MB | host | complete, may be slower |
| Mobile receiver | 50MB | host | no OOM; streaming write |
| Resume mid-transfer | kill receiver tab | any | resume from checkpoint/offset |
| Multi-receiver 1:N | 20MB | host | all complete; lockstep mode ok |
| Cross-net hybrid | 20MB | non-host | hybrid arm + complete |
| Relay forced | 20MB | turn | complete; no crash |

Unit tests:

- unordered insert → contiguous frontier
- sender does not block on async checkpoint
- sender blocks on PAUSE
- control never sent on bulk channel
- encrypt readyQueue byte cap

---

## 13. Success metrics

### Product LAN goal

On the same physical pair / Wi-Fi class used for PonsLink QA:

| Metric | Current PonsWarp | Target after Phase 1 | Target after Phase 2 |
|---|---|---|---|
| 20MB complete median | ~16–23 Mbps | ≥ 40 Mbps | ≥ 50 Mbps |
| Gap vs PonsLink stable | ~2.5× slower | ≤ 1.3× | ≤ 1.1× |
| Incomplete rate | low | 0 / 20 | 0 / 20 |
| Integrity fail | 0 | 0 | 0 |

### Diagnostic goals

- `waitPartitionAck` time ≈ 0 on 1:1 host
- `channelEmptyDuty` reduced vs baseline
- selected pair remains host/UDP for LAN runs

---

## 14. Decision summary

**PonsLink is faster because it is a firehose:**

- unordered reliable bulk channel
- local bufferedAmount pacing only
- almost no reverse app barriers
- no app crypto
- memory-friendly receive for medium files

**PonsWarp is slower because it is a guarded pipeline:**

- ordered single channel (control+bulk)
- partition ACK frontier barriers
- encrypt/prepare sequencing
- durability/reorder/PAUSE-first receiver

**Redesign direction:** keep PonsWarp’s security/resume/hybrid product surface, but adopt PonsLink’s bulk-plane shape:

```text
control ordered + bulk reliable-unordered + local pacing + async checkpoints + pipelined encrypt
```

That is the minimum design that can plausibly close the LAN gap without abandoning PonsWarp’s product guarantees.

---

## 15. Immediate next actions

1. Land Phase 0 timers in `SwarmManager` / receiver writer.
2. Implement Phase 1 channel split + async checkpoint mode behind `VITE_BULK_PLANE_VNEXT=true`.
3. Run 20× host-host 20MB A/B (off/on) on the same local↔ssh home pair used for PonsLink.
4. Only after Phase 1 median ≥ 40 Mbps, start Phase 2 encrypt/memory path work.
5. Keep hybrid docs/behavior intact; do not mix LAN redesign with cross-net hybrid experiments.

---

## Appendix A — File map

### PonsWarp today

| File | Role |
|---|---|
| `src/services/swarmManager.ts` | transfer orchestration, partition send, ACK wait |
| `src/services/singlePeerConnection.ts` | simple-peer channel, ordered:true |
| `src/services/webRTCService.ts` | receiver control/binary demux |
| `src/services/directFileWriter.ts` | decrypt/write/reorder/PAUSE |
| `src/utils/transferFlowControl.ts` | in-flight profiles, host scheduler helpers |
| `src/utils/constants.ts` | chunk/buffer/partition constants |
| `src/utils/plainPacket.ts` | plain packet + CRC |
| `src/workers/file-sender.worker.ts` | worker read/encrypt helpers |
| `src/services/hybridBulkTransport.ts` | cross-net assist |

### PonsLink reference

| File | Role |
|---|---|
| `src/stores/usePeerConnectionStore.ts` | desktop firehose send loop |
| `src/services/webrtc.ts` | multi-channel send + backpressure |
| `src/services/realtimeTransport/policies.ts` | file unordered policy |
| `src/lib/fileTransfer/transferThroughput.ts` | high/low/chunk profile |
| `src/lib/fileTransfer/fileChunkReader.ts` | slice pipeline |
| `src/workers/file-receiver.worker.ts` | memory/OPFS receive |

### Evidence

| Artifact | Content |
|---|---|
| PonsLink `artifacts/file-transfer-qa/STATUS.json` | ~50 Mbps stable / ~61 best |
| PonsWarp `benchmarks/v1/LAN-PERF-NOTES.md` | ~2–2.9 MB/s app E2E |
| PonsWarp `benchmarks/v1/results/FINAL-TRANSFER-PERF-REPORT.md` | hybrid + cross-net findings |

---

## Appendix B — Pseudo-code for Phase 1 send path

```ts
// control: ordered reliable
// bulk: unordered reliable

async function streamTransferVnext(files, peers) {
  await openControlAndBulk(peers);
  sendControl({ type: 'CRYPTO_SESSION', ... });
  sendControl({ type: 'MANIFEST', manifest });
  sendControl({ type: 'TRANSFER_STARTED' });

  const ready = new ByteReadyQueue({ maxBytes: 6 * 1024 * 1024 });
  const producer = startEncryptProducer(files, ready); // async

  let offset = 0;
  while (!producer.done || !ready.empty()) {
    if (anyPeerPaused()) await waitResumeEvent();
    while (maxBuffered(peers, 'bulk') > HIGH) await waitBulkLow(peers);

    const frame = await ready.pop(); // already encrypted
    broadcastBulk(peers, frame.bytes);
    offset = frame.endOffset;

    if (shouldEmitAsyncCheckpoint(offset)) {
      sendControl({ type: 'CHECKPOINT', offset }); // do not await
    }
  }

  sendControl({ type: 'EOS' });
  await waitFinalAcks(peers);
}
```

---

*End of design document.*
