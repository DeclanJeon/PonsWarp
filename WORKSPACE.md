# PonsWarp Unified Workspace

**Single work path (use only this):**

```text
/home/declan/Documents/Develop/ponswarp
```

Branch: `feature/unified-workspace`  
Production frontend: `PonsWarp/` only  
Remote (when pushing monorepo): `https://github.com/DeclanJeon/PonsWarp`

## Layout

```text
ponswarp/
├── PonsWarp/                  # Vite production frontend (ONLY deployable UI)
├── ponswarp-signaling-rs/     # Rust signaling + Cloud Drop
├── pons-core-wasm/
├── contracts/
└── WORKSPACE.md               # this file
```

## What to run (production frontend)

```bash
cd /home/declan/Documents/Develop/ponswarp/PonsWarp
pnpm install
pnpm dev
```

- Web: Vite dev server (see `PonsWarp/package.json`)
- Signaling: monorepo `ponswarp-signaling-rs` (typically `:5502`)

## Experimental Next UI

Next.js experimental frontend lives on branch:

```text
experiment/ponswarp-next-ui
path: apps/web/
```

Checkout that branch only for UI experiments. Do **not** deploy it to `warp.ponslink.com`.

```bash
git switch experiment/ponswarp-next-ui
cd apps/web
pnpm install
pnpm dev   # localhost:3000
```

## Do NOT work in these (legacy / scratch)

- `/home/declan/Documents/Develop/warp`
- `/home/declan/Documents/Develop/warp-ponswarp-ui`
- `/home/declan/Documents/Develop/pons_p2p/PonsWarp` (main worktree checkout only)

## Env source

Copied from `ssh home:~/Documents/Develop/Project/ponswarp` into:

- `ponswarp-signaling-rs/.env*`
- `PonsWarp/.env*`

Never commit real `.env` files.
