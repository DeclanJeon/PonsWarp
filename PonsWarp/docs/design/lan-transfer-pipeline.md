# PonsWarp LAN Transfer Pipeline

## Status and authority

This document is the executable design and operations contract for the no-cost LAN evidence pipeline. It is default-off: `VITE_LAN_HOST_PIPELINE=true` compiles the candidate code but never enables host scheduling without a valid, authenticated, unexpired `GateCertificateV1` bound to the active run. Normal direct, encrypted/resumable, relay, srflx, and unknown-route behavior remains unchanged.

Approved source (revision 12): `.gjc/_session-019f504c-2d05-7000-90f8-e3dd1e4f9f1b/plans/ralplan/019f504c-2d05-7000-90f8-e3dd1e4f9f1b/pending-approval.md`. It retains:

- stage 11: `.gjc/_session-019f504c-2d05-7000-90f8-e3dd1e4f9f1b/plans/ralplan/019f504c-2d05-7000-90f8-e3dd1e4f9f1b/stage-11-revision.md`, SHA-256 `3e5648d5f3488238f3a04dee9af436b424b5738ed1a2421784b437ae15ea8097`;
- stage 10: `.gjc/_session-019f504c-2d05-7000-90f8-e3dd1e4f9f1b/plans/ralplan/019f504c-2d05-7000-90f8-e3dd1e4f9f1b/stage-10-revision.md`, SHA-256 `cd2062761ddc982cf7413e1061fb60cc71025ca0e7aeabf2a2313e1c4c210002`;
- stage 9: `.gjc/_session-019f504c-2d05-7000-90f8-e3dd1e4f9f1b/plans/ralplan/019f504c-2d05-7000-90f8-e3dd1e4f9f1b/stage-09-revision.md` (retained by stage 10; its digest is not stated in the approved plan).

No paid infrastructure, TURN region, hosted storage, external service, or transfer-wire protocol change is part of this pipeline.

## Promotion policy

Instrumentation is first. The serial `serial-metrics/off` arm runs before any host scheduler reservation. Ten valid serial samples on one native browser, physical pair, `lan256` profile, and signaling cohort must show:

- optimistic ceiling median `>=96 Mbps`;
- median slice-plus-encrypt ratio `>=0.20`;
- median channel-empty duty `>=0.15`.

Only then may a certificate be issued for the distinct `pipeline-on/on` arm. Physical promotion requires, separately for every native browser family and physical host pair, 20 interleaved off/on `lan256` pairs with exact identity and integrity. The on cohort must have median `>=80 Mbps` and nearest-rank p05 `>=64 Mbps` (for 20 samples, p05 is sorted index 0). A valid `lan1g` off/on soak is also required. Firefox is a normal-functionality WATCH cohort, not a promotion cohort. A miss retains serial/off and opens Option C writer planning.

## StartIntent and release gate

Every start path uses the sole entry `requestTransferStart` with:

```ts
type StartIntent = {
  offset: number;
  generation: number;
  reason: 'initial' | 'resume' | 'queued';
};
```

The entry validates a finite integer offset, current generation, manifest bounds, and resume policy. In unarmed mode it executes the existing behavior. In evidence `ARMED`, it stores only the latest valid intent and enters `TRANSFER_READY`; no payload, worker batch, partition, or EOS is sent before release. Controller release validates the binding, atomically captures the intent, enters `RELEASED`, and calls `runPartitionedTransfer(intent.offset)` exactly once. `STARTED` is emitted once only for the initial start. In `RELEASED`, validated reconnect/resume/queued intents execute at their nonzero offset without another START or STARTED. Stale generations, duplicate release, and payload-before-release fail. Encrypted and plain nonzero resume are both covered.

## Candidate route and bounded scheduler

`SinglePeerConnection` exports the raw selected-pair tuple:

```text
selectedPairId, localCandidateId, remoteCandidateId,
localCandidateType, remoteCandidateType, localProtocol,
remoteProtocol, selectedOrNominatedSucceeded, sampledAtMs
```

Host scheduling requires two samples at least 500 ms apart with exact equality of all tuple IDs, both candidate types `host`, normalized protocols `udp`, and succeeded selection. Missing data or any field mutation downgrades before reservation; relay/srflx/unknown routes remain serial.

The scheduler has at most two unsettled reservations. It uses burn-only key-session nonce attempts, one exclusive `nextUnsentCursor`, explicit zero/partial handoff and downgrade behavior, and preserves ACK, PAUSE/resume, partition, EOS, reconnect, and relay semantics. Preparation ledger is capped at `1,376,450` bytes; each peer's full envelope admission is capped at `4 MiB`; pending work is capped at `32 MiB`. Resource, queue, channel, pause, and cursor limits are hard validity gates, not tuning suggestions.

## Immutable arms, archive, and digest

Build from repository root with a deterministic `SOURCE_DATE_EPOCH`, identical normalized signaling URL in both Vite variables, and these public flags:

```sh
SOURCE_DATE_EPOCH=$EPOCH \
VITE_LAN_TRANSFER_METRICS=true VITE_LAN_HOST_PIPELINE=false \
VITE_LAN_EVIDENCE_BRIDGE=true VITE_LAN_EVIDENCE_FSA=true \
VITE_RUST_SIGNALING_URL=$SIGNALING_URL VITE_SIGNALING_SERVER_URL=$SIGNALING_URL \
pnpm --dir PonsWarp build -- --outDir dist-lan/serial-metrics

SOURCE_DATE_EPOCH=$EPOCH \
VITE_LAN_TRANSFER_METRICS=true VITE_LAN_HOST_PIPELINE=true \
VITE_LAN_EVIDENCE_BRIDGE=true VITE_LAN_EVIDENCE_FSA=true \
VITE_RUST_SIGNALING_URL=$SIGNALING_URL VITE_SIGNALING_SERVER_URL=$SIGNALING_URL \
pnpm --dir PonsWarp build -- --outDir dist-lan/pipeline-on
```

`--signaling-url` is required on every evidence invocation and normalizes to lowercase `ws://<non-loopback-LAN-IP>:5502/ws` with no query, fragment, or trailing slash. The two arm manifest variables and `normalizedSignalingUrl` must match byte-for-byte; loopback, unspecified, production, wrong port, wrong path, and mismatches reject before launch.

Archive with `tar-stream@3.1.7`, deterministic POSIX ustar ordering (NFC lexical path order), mode `0644`, uid/gid `0`, empty uname/gname, and mtime `SOURCE_DATE_EPOCH`. Reject absolute/traversal, duplicate or NFC-collision paths, links, devices/FIFOs, unsupported types, paths over 255 UTF-8 bytes, components over 100 bytes, files over 1 GiB, and archives over 2 GiB. Exclude exactly `evidence-arm.json`, `server.log`, `server-*.log`, and `run-artifacts/**`.

The raw tree digest is `SHA256(UTF8(path)||NUL||u64be(len)||NUL||rawBytes records)`. Canonical manifest bytes are sorted-key, UTF-8, no-whitespace JSON with deterministic source epoch, arm, public flags, git SHA, exclusions, and tree digest. The arm digest is:

```text
SHA256(UTF8("ponswarp-evidence-arm-v1\n") || rawTreeDigest32 || rawManifestDigest32)
```

The controller makes one archive and copies it bit-for-bit to both hosts. Each host unpacks read-only and independently recomputes archive, tree, manifest, and arm digests before browser, profile, or token issuance. Off and on tuples are stable within cohort and must differ in archive, manifest, and arm digest; swapped labels, equal identities, changed identities, mixed epochs/URLs, and wrong flags are invalid.

## GateCertificateV1

`lan:evidence gate` emits canonical sorted-key JSON signed with HMAC-SHA-256 over the object excluding `signature`, using the preprovisioned run secret (never stored or exported):

```json
{
  "version": 1,
  "runId": "uuid",
  "certificateId": "uuid",
  "issuedAtMs": 0,
  "expiresAtMs": 0,
  "serialArm": {
    "archiveSha256": "...",
    "treeDigest": "...",
    "manifestDigest": "...",
    "armDigest": "...",
    "sourceDateEpoch": 0,
    "normalizedSignalingUrl": "...",
    "flags": {
      "metrics": true,
      "pipeline": false,
      "bridge": true,
      "evidenceFsa": true
    }
  },
  "pipelineArm": {
    "archiveSha256": "...",
    "treeDigest": "...",
    "manifestDigest": "...",
    "armDigest": "...",
    "sourceDateEpoch": 0,
    "normalizedSignalingUrl": "...",
    "flags": {
      "metrics": true,
      "pipeline": true,
      "bridge": true,
      "evidenceFsa": true
    }
  },
  "browser": {
    "family": "chrome|edge",
    "executableSha256": "...",
    "version": "..."
  },
  "hostPair": { "senderId": "...", "receiverId": "..." },
  "profile": "lan256",
  "serialSamples": [
    {
      "sampleId": "...",
      "artifactSha256": "...",
      "fixtureDigest": "...",
      "hostUdpTupleDigest": "...",
      "integrityDigest": "...",
      "resumeGate": "pass",
      "browserGate": "pass"
    }
  ],
  "equations": {
    "ceiling": "payloadBytes/(transportDurationMs-sliceEncryptStallMs)*1000",
    "sliceEncryptRatio": "sliceEncryptStallMs/transportDurationMs",
    "channelEmptyDuty": "channelEmptyMs/transportDurationMs"
  },
  "results": {
    "validSamples": 10,
    "medianCeilingMbps": 0,
    "medianSliceEncryptRatio": 0,
    "medianChannelEmptyDuty": 0
  },
  "signature": "base64url-hmac-sha256"
}
```

`expiresAtMs` equals `issuedAtMs + 30 minutes`; nonpositive, overflow, or expired values reject. The gate command validates ten complete serial artifacts, exact cohort/fixture/profile/browser/pair/URL identity, source/readback equality, encrypted resume, two stable host/UDP tuples per endpoint, bridge/FSA lifecycle, and absence of timeout/route/relay/error. Pipeline-on validates HMAC, expiry, run, browser, pair, profile, URL, exact arm tuples, serial hashes, equations, and flags before the first host reservation. Missing, stale, tampered, or mismatched certificates keep serial behavior and mark the attempted sample `GATE_CERTIFICATE_REJECTED`; verification resets on run or intent-generation change.

## Evidence listeners, bridge, and signaling

Receiver starts first. It binds paired shared-state listeners on exactly `127.0.0.1:4174` and `::1:4174`, probes both health endpoints, verifies localhost resolves only to those live listeners, and sends authenticated `RECEIVER_LISTENERS_READY` with origin, port, probe results, and arm digest. Controller then binds/probes `127.0.0.1:4173` and `::1:4173`, validates distinct origins, and only then launches:

```sh
HOST=<selected-controller-LAN-IP> PORT=5502 LAN_EVIDENCE_MODE=true \
LAN_EVIDENCE_WS_ORIGINS=http://localhost:4173,http://localhost:4174 \
CORS_ORIGINS=http://localhost:4173,http://localhost:4174 \
cargo run --manifest-path ponswarp-signaling-rs/Cargo.toml --release
```

The selected host is a non-loopback LAN address; evidence never binds wildcard. Health and allowed/forbidden WebSocket preflights run from both agents before browsers or bridge tokens. Any collision, occupied port, range error (overrides are integers `1024..65535` and must differ), bind/probe failure, forged ready record, origin mismatch, or preflight failure aborts before signaling continuation, token issuance, profile creation, or browser launch.

Evidence mode requires exactly the two unique canonical localhost origins and rejects wildcard, production, IP-literal, non-localhost, HTTPS, malformed, duplicate, or absent values. `/ws` checks Origin before upgrade and permits only those two exact values; HTTP CORS remains separate. In normal mode, existing `CORS_ORIGINS` and normal configured-origin WebSocket policy remain active, including configured `https://warp.ponslink.com`; evidence localhost restrictions do not leak into production signaling.

Listeners share state and tear down atomically. Any failure closes listeners, TCP, signaling child, browsers, bridge streams, tokens, and held handles and removes `.part` artifacts.

## Browser, FSA, hashing, and readback

Use absolute non-symlink Chrome or Edge executables, authenticated version/hash metadata, a fresh temporary profile per sample, and `lan256` (`256 MiB`, 30 min) or `lan1g` (`1 GiB`, 90 min). Token expiry is issuance plus deadline plus five minutes, capped at 95 minutes, and binds run nonce, role, profile, arm, and deadlines. Sender and receiver gestures are required; receiver holds a native save handle, verifies canonical manifest, and reaches `RECEIVER_READY`; controller release is the sole START latch.

Normal writing remains FSA-first, then existing StreamSaver/fallback. Evidence uses only a verified held `EvidenceFsaHandleContext` and rejects fallback. Readback is raw binary, max exactly `131072` bytes per request, never base64; headers, order, index, stream cap, and digest are validated before source digest commit and temporary-file deletion.

The single SHA authority is WASM `sha2 = "=0.10.9"` with `zeroize = "=1.8.1"`. `Sha256Stream` accepts updates in chunks no larger than 1 MiB, finalizes once, supports reset/free/Drop zeroization, rejects use-after-free, and retains at most 2 MiB. Canonical manifests allow only the approved root/file fields, preserve array order, NFC-normalize strings, serialize absent optional root fields as `null`, and reject unknown, undefined, inherited, polluted, or unsafe values.

## Commands and analysis

```sh
pnpm --dir PonsWarp lan:evidence controller --listen <controller-lan-ip>:43117 --run-id <uuid> --secret <0600-secret> --sender-static-port 4173 --arm serial-metrics --control off --archive arms/serial-metrics.tar --signaling-url ws://<controller-lan-ip>:5502/ws --browser chrome --browser-executable /absolute/path/to/chrome --profile lan256 --artifact-dir benchmarks/v1/results/lan/<run-id>
pnpm --dir PonsWarp lan:evidence receiver --connect <controller-lan-ip>:43117 --run-id <uuid> --secret <0600-secret> --receiver-static-port 4174 --arm serial-metrics --control off --archive <bit-identical-serial-metrics.tar> --signaling-url ws://<controller-lan-ip>:5502/ws --browser chrome --browser-executable /absolute/path/to/chrome --profile lan256 --artifact-dir <receiver-artifacts>
pnpm --dir PonsWarp lan:evidence gate --serial-run <serial-run-root> --pipeline-arm <pipeline-on-arm-manifest-or-archive> --run-id <uuid> --secret <0600-secret> --browser chrome --host-pair <senderId,receiverId> --profile lan256 --out <gate-certificate.json>
pnpm --dir PonsWarp lan:evidence analyze --input benchmarks/v1/results/lan/<run-id> --require-paired-interleaved --browser chrome --host-pair <senderId,receiverId>
```

Repeat controller/receiver with `--arm pipeline-on --control on`, then repeat Chrome with Edge. Use `lan1g` for the soak. Analysis requires exactly 20 valid interleaved off/on pairs per browser and physical pair, matching fixture, identities, route tuples, source/readback digests, and signaling cohort. The artifact records monotonic STARTED/FINALIZED times, rate, browser/host metadata, route history, resource telemetry, ledger, queue, memory, and validity.

## Rollback and implementation map

Rollback the next run to serial/off, or disable the active run with `disableLanHostPipelineForActiveRun(reason)` for integrity, nonce/cursor, resource/queue, route, certificate, signaling/preflight, bridge/harness/browser, or relay regression. No integrity, relay, or normal writer behavior is weakened to preserve throughput.

| File                                                              | Responsibility                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PonsWarp/src/services/swarmManager.ts`                           | StartIntent gate, release/resume, scheduler, cursor, nonce, ledger  |
| `PonsWarp/src/services/singlePeerConnection.ts`                   | Full candidate tuple and drain                                      |
| `PonsWarp/src/utils/transferFlowControl.ts`                       | Envelope, ledger, route equality                                    |
| `PonsWarp/src/services/webRTCService.ts`                          | Room/manifest/readiness lifecycle; no wire change                   |
| `PonsWarp/src/services/directFileWriter.ts`                       | Telemetry and isolated evidence FSA                                 |
| `PonsWarp/src/services/lanEvidenceAdapter.ts`                     | Tokens, gestures, bridge, START, readback, hashing                  |
| `PonsWarp/src/components/SenderView.tsx`, `ReceiverView.tsx`      | Evidence-only status and arming                                     |
| `PonsWarp/src/utils/evidenceCanonical.ts`                         | Canonical manifest                                                  |
| `pons-core-wasm/Cargo.toml`, `src/sha256_stream.rs`, `src/lib.rs` | Pinned bounded SHA authority                                        |
| `PonsWarp/scripts/lan-evidence.mjs`                               | Listeners, signaling, archives, profiles, artifacts, gate, analysis |
| `ponswarp-signaling-rs/src/config.rs`, `src/main.rs`              | Evidence/normal origin modes, health, `/ws` pre-upgrade validation  |
| `PonsWarp/package.json`, `pnpm-lock.yaml`                         | `tar-stream` pin and evidence commands                              |
| `PonsWarp/docs/design/lan-transfer-pipeline.md`                   | This operations/design contract                                     |
