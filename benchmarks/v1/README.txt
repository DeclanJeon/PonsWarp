PonsWarp benchmark v1 two-tier contract

The fixture stream is immutable: SHA-256 receives UTF8(seed), NUL, UTF8(fixture
ID), NUL, and unsigned u64(counter) in big-endian order. Digest blocks are
concatenated and truncated only for the final requested byte. The framing and
all tier bounds are recorded in fixtures/manifest.json.

Local/default tier (non-release evidence)

`node benchmarks/v1/fixtures/generate.mjs` writes one deterministic, regular
256 MiB fixture with bounded memory. `PONSWARP_LOCAL_REGULAR_BYTES` may select
a regular size from 256 MiB through 1 GiB. It never writes the 4 GiB+1 ZIP64
boundary: local mode uses the existing Rust and JS logical ZIP64 boundary tests
listed in the manifest. `node benchmarks/v1/run.mjs` performs local preflight and
prints `releaseEvidence:false`; it does not invent benchmark samples.

The optional 10% throughput/RSS budget is applied only when baseline and
candidate machine, image, browser, and netem fingerprints are identical. A
missing or different fingerprint never becomes a passing comparison. Set
`PONSWARP_LOCAL_BASELINE_JSON` only to a recorded fingerprint object; local
output remains non-release evidence regardless.

Release/nightly tier (optional, unsupported locally)

`node benchmarks/v1/fixtures/generate.mjs --release` is reserved for the
explicit dedicated release process. The local `run.mjs --release` command
rejects immediately rather than pseudo-verifying release evidence. That process
must use the committed pinned runner identity, image digest, browser identity,
topology/netem capture, checksums, and physical 1 GiB and 4 GiB+1 fixtures.
Sparse files, holes, zero-fill substitutions, smaller files, and synthetic
ranges are forbidden; release evidence is never substituted with local output.

`--init-baseline` is reserved for the explicit baseline-initialization process;
it atomically records computed hashes. Do not use it as a benchmark shortcut.
All writes are streamed, deterministically framed, synchronized, read-back
verified, and temporary files are removed on failure. No command fabricates a
sample or a pass result when instrumentation is unavailable.
