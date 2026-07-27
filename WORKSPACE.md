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
├── _legacy-root-frontend/     # quarantined stale root UI (do not deploy)
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

Signaling (separate terminal):

```bash
cd ponswarp-signaling-rs
cp .env.local.example .env.local   # if needed
cargo run
```

## Do not

- Edit or deploy from `_legacy-root-frontend/`
- Put secrets in `VITE_*` env vars
- Run root Vite configs (they were removed/quarantined on purpose)
