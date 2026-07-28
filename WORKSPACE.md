# PonsWarp Unified Workspace

**Canonical work path:**

```text
/home/declan/Documents/Develop/Project/ponswarp
```

Production frontend: **`PonsWarp/` only**  
Remote: `https://github.com/DeclanJeon/PonsWarp`

## Layout

```text
ponswarp/
├── package.json               # workspace orchestrator (pnpm scripts)
├── PonsWarp/                  # Vite production frontend (ONLY deployable UI)
├── ponswarp-signaling-rs/     # Rust signaling + Cloud Drop
├── pons-core-wasm/            # WASM transfer core
├── contracts/                 # protocol/compat contracts
├── deploy/                    # production deploy scripts + nginx
├── benchmarks/                # throughput/evidence benches
├── scripts/                   # monorepo tooling (e.g. wasm provenance)
└── WORKSPACE.md               # this file
```

## Commands

```bash
pnpm install
pnpm --dir PonsWarp dev
pnpm run frontend:type-check
pnpm run frontend:test
pnpm run backend:test
pnpm run verify
```

Release / prod transfer QA (networked; **not** in default preflight):

```bash
pnpm run release:checklist
pnpm run qa:prod-transfer              # after deploy / manual release habit
pnpm run qa:prod-transfer:nightly      # cron wrapper + summary artifact
PROD_QA_RELAY=1 pnpm run qa:prod-transfer
```

Tracked workflow template: `deploy/github-workflows/nightly-prod-transfer-qa.yml`  
(copy into `.github/workflows/` with a token that has `workflow` scope).  
See `deploy/RELEASE-CHECKLIST.md`.

Signaling (separate terminal):

```bash
cd ponswarp-signaling-rs
cp .env.local.example .env.local   # if needed
cargo run
```

## Do not

- Put secrets in `VITE_*` env vars
- Run root Vite configs (they were removed/quarantined on purpose)
