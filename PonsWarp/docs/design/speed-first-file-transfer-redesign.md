# PonsWarp Speed-First File Transfer Redesign

Status: **design proposal (implementation-ready)**  
Date: 2026-07-16  
Branch context: `perf/bulk-plane-vnext`  
Owners: transfer plane (`SwarmManager`, `SinglePeerConnection`/`native bulk transport`, `webRTCService`, `directFileWriter`)

Related:

- `docs/design/file-transfer-logic-comparison-and-redesign.md` — root-cause vs PonsLink
- `docs/design/hybrid-bulk-transport.md` — cross-network ciphertext assist (keep as secondary path)
- `docs/design/lan-transfer-pipeline.md` — evidence-only host pipeline (do not confuse with product hot path)
- Evidence:
  - `benchmarks/v1/results/bulk-plane-vnext-phase2-report.md`
  - `benchmarks/v1/results/bulk-plane-vnext-phase3-report.md`
  - `benchmarks/v1/results/bulk-plane-vnext-phase4-report.md`
  - `benchmarks/v1/LAN-PERF-NOTES.md`

---

## 0. Product decision (authoritative)

### Priority order for file transfer

1. **Speed**
2. Completeness (bytes received == bytes sent)
3. Cross-network availability
4. Resume convenience
5. App-layer E2E crypto extras

### Explicit policy change

Previous designs treated app-level E2E AES-GCM as non-negotiable on every bulk byte.  
**This redesign reverses that for the hot path.**

| Mode | Default | Crypto | Goal |
|------|---------|--------|------|
| **Speed path (primary)** | ON | WebRTC DTLS only (no app AES on bulk) | maximize Mbps |
| Hardened path | optional / cross-net / user toggle | app AES-GCM + optional hybrid | security-sensitive transfers |
| Hybrid assist | non-host / weak P2P only | ciphertext object assist | availability, not LAN peak |

If product later requires default encryption again, it must be implemented **without reintroducing the old partition/ACK/reorder tax** on the speed path. Encryption becomes a mode, not the architecture.

---

## 1. Problem statement

On the same ~100 Mbps Wi-Fi class:

| Path | Observed |
|------|----------|
| TCP / SCP headroom | ~70–80 Mbps |
| PonsLink stable app | **~50 Mbps** |
| PonsWarp raw 1× DataChannel | ~24–27 Mbps |
| PonsWarp app E2E (current) | **~15–19 Mbps** |
| Same-PC multi bulk SID experiment | ~5 Mbps (rejected) |

Root cause is not “WebRTC is slow.”  
Root cause is **PonsWarp app logic turns WebRTC into a heavy protocol machine**:

```text
encrypt every chunk
  + prepare/partition state machine
  + receiver decrypt/reorder/writer PAUSE
  + reverse control coupling
  = raw DC ceiling further reduced
```

Tuning (unordered, prepare-ahead, worker crypto, multi-SID) moved the needle only slightly or regressed. A **full hot-path rewrite** is required.

---

## 2. Goals / non-goals

### Goals

1. **LAN 1:1 complete median ≥ 40 Mbps** on the same dual-device harness used for recent QA.
2. Stretch: approach PonsLink stable (**~50 Mbps**) on host/UDP.
3. Keep transfers **complete and integrity-checked**.
4. Keep room join / signaling UX.
5. Keep multi-file send as a product feature without forcing zip/encrypt on the hot path.
6. Keep cross-network working via:
   - plain/DTLS WebRTC when possible, else
   - hardened encrypted path and/or hybrid assist.
7. Make the speed path simple enough that future changes are hard to overcomplicate.

### Non-goals (v1 of this redesign)

- Mesh / multi-receiver marketplace economics
- Perfect mid-chunk resume for every crash scenario on speed path
- Same-PC multi DataChannel striping as a performance feature (measured regression)
- LAN TCP sidecar agents as a product dependency
- Preserving the old partition-ACK protocol as default

---

## 3. Design principles

1. **Firehose first**  
   Local `bufferedAmount` is the only hot-path backpressure.

2. **Control ≠ bulk**  
   JSON control never shares the bulk byte stream semantics.

3. **No app crypto on speed path**  
   DTLS is enough for default P2P confidentiality against network observers.  
   App AES is an optional hardened mode.

4. **Receiver stays dumb on speed path**  
   Append bytes, sparse progress, final integrity. No reverse PAUSE except hard memory danger.

5. **One SCTP association, used well**  
   Prefer one high-efficiency unordered reliable bulk channel over clever multi-SID tricks.

6. **Measure real complete time**  
   Mbps = `fileBytes / wallClockCompleteSec * 8`. UI instantaneous speed is secondary.

7. **Delete complexity that does not pay rent**  
   If a mechanism does not improve complete Mbps or completeness, remove it from the default path.

---

## 4. Target architecture

### 4.1 Plane split

```text
                    Signaling (room/code/ICE)
                              │
                              ▼
                 Native RTCPeerConnection
                 (simple-peer only if needed for signaling bootstrap)
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
   dc:control (ordered, reliable)        dc:bulk (unordered, reliable)
   - HELLO / CAPS                        - binary frames only
   - MANIFEST                            - no JSON
   - START / EOS_CTRL                    - no per-chunk ACK
   - PROGRESS (sparse)
   - ERROR / CANCEL
   - MODE (speed|hardened)
```

### 4.2 Speed-path data flow

```text
Sender
  File/File[] 
    -> sequential slice reader (pipeline prefetch)
    -> lightweight frame header + payload
    -> bulk.send while bufferedAmount < high
    -> EOS
    -> wait FINAL_OK on control

Receiver
  bulk.onmessage
    -> parse frame
    -> write/append (memory if <= 256MB desktop, else OPFS/stream)
    -> sparse PROGRESS
    -> on EOS: integrity check + materialize download
    -> FINAL_OK
```

### 4.3 Hardened-path data flow (optional)

```text
Sender
  slice -> AES-GCM encrypt in worker pool -> bulk frames
Receiver
  bulk frames -> worker decrypt -> append
Still no partition ACK barriers.
Resume watermark optional and async.
Hybrid assist may tee ciphertext for non-host paths.
```

---

## 5. Protocol redesign

### 5.1 Control messages (JSON on `dc:control`)

| Message | Dir | Required on speed path |
|---------|-----|------------------------|
| `CAPS` | both | yes (features, maxMessageSize, mode support) |
| `MANIFEST` | S→R | yes |
| `START` | S→R | yes |
| `PROGRESS` | R→S | sparse only |
| `EOS` | S→R | yes (also bulk EOS frame) |
| `FINAL_OK` | R→S | yes |
| `ERROR` / `CANCEL` | either | yes |
| `MODE` | S→R | yes (`speed` default) |
| `RESUME_FROM` | R→S | hardened / optional |

No `PARTITION`, no per-chunk `ACK`, no lockstep barrier on speed path.

### 5.2 Bulk frame (binary only)

Speed frame v1:

```text
u8  magic = 0xA1
u8  flags   // bit0=EOS, bit1=hardened-encrypted, bit2=has-file-index
u32 seq
u64 offset
u32 payloadLen
u16 fileIndex   // if has-file-index
payload bytes
```

Rules:

- `seq` monotonic per transfer.
- `offset` is global payload offset for multi-file stream.
- Receiver may accept out-of-order frames if writer needs it, but sender should still send mostly in order to keep receiver simple.
- EOS can be bulk flag and/or control `EOS`.

### 5.3 Manifest (speed path)

Minimal:

```ts
type SpeedManifest = {
  transferId: string;
  mode: 'speed' | 'hardened';
  totalBytes: number;
  files: Array<{ name: string; size: number; type?: string }>;
  // optional
  sha256?: string;          // full transfer digest if precomputed cheaply
  chunkHint?: number;       // sender preferred payload size
};
```

Integrity:

- Default: exact `totalBytes` + optional final SHA if cheap.
- Hardened: ciphertext integrity + plaintext digest after decrypt.

### 5.4 Backpressure

Sender only:

```text
high = 4–8 MiB
low  = 1–2 MiB
send while bufferedAmount + frameSize <= high
wait onbufferedamountlow / short watchdog
```

Receiver reverse pressure:

- speed path: only if pending memory > hard danger threshold (e.g. 256 MiB) → `ERROR` or rare `PAUSE`
- no 32 MiB PAUSE flapping as normal operation

---

## 6. Component redesign

### 6.1 Replace “protocol machine” with two clear modules

| Old (current) | New |
|---|---|
| `SwarmManager` does everything | `TransferSession` orchestrates modes |
| `sendFilesPartitioned` + ACK waiters | `SpeedSender` firehose |
| `directFileWriter` decrypt/reorder/PAUSE heavy | `SpeedReceiverWriter` append-first |
| simple-peer single channel semantics | `BulkTransport` native channels |
| app AES always | `CryptoMode = none \| app-aes` |

Suggested file layout:

```text
src/transfer/
  TransferSession.ts
  SpeedSender.ts
  SpeedReceiver.ts
  BulkTransport.ts
  frames.ts
  integrity.ts
  modes.ts
src/transfer/hardened/
  HardenedSender.ts
  HardenedReceiver.ts
  cryptoPlaneClient.ts   // reuse
```

Keep UI/signaling entrypoints, but stop growing `swarmManager.ts` as the speed path.

### 6.2 BulkTransport requirements

Must provide:

- open control + bulk channels
- `sendControl(obj)`
- `sendBulk(ArrayBuffer): boolean`
- `getBulkBufferedAmount()`
- `waitBulkLow()`
- selected ICE pair diagnostics (`host|srflx|relay`)
- destroy/cleanup

Implementation preference:

1. **native `RTCPeerConnection` + DataChannels`**
2. simple-peer only as temporary signaling adapter if needed

Do not put bulk bytes through simple-peer `data` event if it forces ordered single-channel semantics.

### 6.3 SpeedSender algorithm

```ts
async function sendSpeed(files, transport, manifest) {
  await transport.waitOpen();
  transport.sendControl({ type: 'MODE', mode: 'speed' });
  transport.sendControl({ type: 'MANIFEST', manifest });
  transport.sendControl({ type: 'START' });

  const reader = new SlicePipeline(files, chunkSize);
  let offset = 0;
  let seq = 0;

  while (true) {
    const slice = await reader.next(); // prefetched
    if (!slice) break;

    while (transport.getBulkBufferedAmount() + slice.byteLength > HIGH) {
      await transport.waitBulkLow();
    }

    const frame = encodeSpeedFrame({
      seq: seq++,
      offset,
      payload: slice.bytes,
      fileIndex: slice.fileIndex,
    });
    if (!transport.sendBulk(frame)) throw new Error('bulk send failed');
    offset += slice.byteLength;
    maybeEmitLocalProgress(offset);
  }

  transport.sendBulk(encodeEosFrame(seq, offset));
  transport.sendControl({ type: 'EOS', offset });
  await transport.waitControl('FINAL_OK', timeout);
}
```

### 6.4 SpeedReceiver algorithm

```ts
onBulkFrame(frame) {
  if (frame.eos) { markEos(); return; }
  writer.append(frame.offset, frame.payload);
  if (shouldSparseProgress()) sendControl(PROGRESS);
}

onEos() {
  assert writer.receivedBytes === manifest.totalBytes;
  maybe verify digest;
  materialize download;
  sendControl(FINAL_OK);
}
```

Writer strategy:

| Size | Desktop speed path | Mobile |
|------|--------------------|--------|
| ≤ 256 MiB | memory assemble → single download Blob | OPFS/stream preferred earlier |
| > 256 MiB | OPFS sync append / stream | OPFS/stream |

No decrypt. No partition frontier. No 32 MiB PAUSE loop.

### 6.5 Multi-file

Speed path should support multi-file without mandatory zip:

- global offset stream + `fileIndex` in frames, or
- one transfer per file with tiny control overhead

Prefer **global offset stream** for fewer round trips.

### 6.6 Resume policy (speed path)

Default:

- no mid-chunk resume
- on disconnect: fail cleanly, user retries
- optional later: file-level resume (`RESUME_FROM` next file boundary)

Hardened path may keep offset resume.

This is an intentional speed tradeoff.

---

## 7. Security model after redesign

### Speed path

- Transport confidentiality: **DTLS**
- Integrity: length check + optional hash
- Server never sees bulk bytes on pure P2P path
- Threat model: not protecting against malicious peer with shared room code (they already receive the file)

### Hardened path

- App AES-GCM
- Optional hybrid ciphertext assist on poor networks
- Keys remain in browsers
- Use when user enables “Secure mode” or when path is relay/cross-net policy says so

### Product defaults (proposal)

| Condition | Mode |
|-----------|------|
| host/srflx 1:1 | **speed** |
| relay | hardened or hybrid |
| user toggles Secure | hardened |
| multi-receiver | hardened or serialized speed per peer |

---

## 8. What to delete / demote from default path

### Delete from speed hot path

- partition marker + blocking `PARTITION_ACK`
- per-chunk reverse ACK ideas
- app AES encrypt/decrypt
- CRC-on-every-packet if final digest exists
- receiver PAUSE at 32 MiB as normal control
- same-PC multi bulk SID striping
- complex adaptive BBR-like chunk resizing on LAN

### Demote to optional modules

- crypto plane workers
- hybrid bulk transport
- host evidence pipeline / gate certificates
- stripe multi-PC experimental code

### Keep

- room/code signaling
- ICE diagnostics
- complete-byte accounting
- cancel
- basic progress UI

---

## 9. Migration plan

### Phase A — Speed transport skeleton (no product cutover)

1. Implement `BulkTransport` native control/bulk channels.
2. Implement `SpeedSender` / `SpeedReceiver` behind `VITE_SPEED_TRANSFER=true`.
3. Feature flag dual-path: old protocol remains default until soak.

Acceptance:

- 20MB dual-device LAN complete
- no app crypto frames on wire (`magic=0xA1`, flags hardened bit clear)
- median ≥ 30 Mbps

### Phase B — Make speed path default for host/srflx 1:1

1. Auto-select mode by candidate pair.
2. UI shows “Fast transfer” vs “Secure transfer”.
3. Old partition path only for hardened/legacy peers.

Acceptance:

- median ≥ **40 Mbps**
- p05 ≥ 30 Mbps over 10 runs
- complete rate ≥ 9/10

### Phase C — Receiver/writer simplification

1. Memory path up to 256 MiB desktop.
2. Remove reverse PAUSE except hard fail.
3. Final materialize only.

Acceptance:

- reduce receiver-bound stalls in timings
- large 256MB soak complete

### Phase D — Hardened mode as secondary

1. Reintroduce app AES as optional mode using crypto workers.
2. No partition barriers even in hardened mode.
3. Hybrid remains non-host assist.

Acceptance:

- hardened mode works
- speed mode unchanged

### Phase E — Optional multi-PC striping (only if needed)

Only if speed path still < 40 Mbps while raw multi-PC shows headroom.

Rules:

- separate `RTCPeerConnection`s (separate SCTP)
- credit-based allocator
- integrity soak mandatory
- default off until 20-run pass

---

## 10. Metrics and QA contract

### Required counters

Sender:

- `t_open_ms`
- `t_first_byte_ms`
- `bytes_sent`
- `wait_drain_ms`
- `wait_control_ms`
- `selected_pair` (`host/srflx/relay`)
- `mode`

Receiver:

- `bytes_received`
- `t_first_byte_ms`
- `t_complete_ms`
- `write_ms`
- `ooo_frames`
- `mode`

### Harness

Reuse dual-device:

- local sender browser
- ssh `home` receiver Chrome CDP
- fixed 20MB then 256MB fixtures
- report complete Mbps only

### Success gates

| Gate | Metric |
|------|--------|
| G1 | speed mode host/UDP 20MB median ≥ 40 Mbps |
| G2 | complete rate ≥ 90% over 10 runs |
| G3 | integrity failures = 0 |
| G4 | hardened mode still completes (may be slower) |
| G5 | no regression: room join + cancel works |

---

## 11. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Users expect default app E2E | Clear UI: Fast (DTLS) vs Secure (app AES); docs |
| Loss of mid-transfer resume | Explicit tradeoff; retry whole transfer; later file-level resume |
| Receiver OOM on huge files | Size thresholds; stream/OPFS above cap |
| Mode negotiation mismatch | CAPS + fail closed to hardened or error |
| simple-peer interference | native bulk transport; isolate from simple-peer data path |
| Hybrid/speed interaction bugs | hybrid only on non-host hardened path |

---

## 12. Implementation checklist (first PR)

1. [ ] `frames.ts` encode/decode + tests  
2. [ ] `BulkTransport` open control/bulk, diagnostics  
3. [ ] `SpeedSender` firehose loop  
4. [ ] `SpeedReceiver` append + FINAL_OK  
5. [ ] Feature flag wiring from Sender/Receiver views  
6. [ ] Dual-device 20MB QA report artifact  
7. [ ] Remove speed-path dependency on `sendPartitionMarkerAndWait`  
8. [ ] Ensure no app AES frames in speed mode (test)  

Second PR:

1. [ ] Auto mode selection by ICE pair  
2. [ ] Default cutover for host/srflx  
3. [ ] Secure mode toggle UI  
4. [ ] 10-run soak + 256MB soak  

---

## 13. Decision summary

### Current PonsWarp (slow)

```text
secure-by-default app protocol
  on top of WebRTC
  with partition/pause/reorder taxes
```

### Target PonsWarp (fast)

```text
speed-by-default firehose bulk
  DTLS transport security
  optional hardened mode
  hybrid only when network path needs it
```

### Non-negotiable for this redesign

- **Speed is the primary optimization target**
- Default hot path must look like PonsLink’s successful shape:
  - unordered reliable bulk
  - local bufferedAmount pacing
  - almost no reverse control
  - no app crypto on bulk
- Completeness remains required
- Complexity that does not improve complete Mbps is removed from default

---

## 14. Expected outcome

If executed cleanly:

| Stage | Expected complete Mbps (same LAN class) |
|-------|------------------------------------------|
| Now | ~15–19 |
| Phase A skeleton | ≥30 |
| Phase B default speed path | **≥40** |
| Stretch | ~50 (PonsLink-class) |

If Phase B fails while raw DC stays ~25, the remaining gap is transport usage/ICE path, not protocol tax — then Phase E multi-PC becomes justified.

---

## 15. Immediate next action

Implement **Phase A** in `perf/bulk-plane-vnext` (or a fresh speed-redesign worktree):

1. Add `src/transfer/*` speed-path modules.  
2. Flag `VITE_SPEED_TRANSFER=true`.  
3. Run dual-device 20MB QA.  
4. Publish report under `benchmarks/v1/results/`.  
5. Only then flip default mode selection.

---

*End of design document.*
