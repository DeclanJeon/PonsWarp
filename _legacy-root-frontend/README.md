# Legacy root frontend (quarantined)

This directory holds **non-canonical** frontend surfaces that previously lived at the monorepo root and drifted from `PonsWarp/`.

## Canonical production UI

Use only:

- `PonsWarp/` — Vite React app (deployed to warp.ponslink.com)
- `ponswarp-signaling-rs/` — Rust signaling/API
- `pons-core-wasm/` — WASM core

Root `package.json` is the **workspace orchestrator** only (`pnpm --dir PonsWarp ...`).

Do not restore these files to the repo root without an explicit monorepo layout redesign.
