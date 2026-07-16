# PonsWarp Unified Workspace

**Single work path (use only this):**

```text
/home/declan/Documents/Develop/ponswarp
```

Branch: `feature/unified-workspace`  
Remote (when pushing monorepo): `https://github.com/DeclanJeon/PonsWarp`

## Layout

```text
ponswarp/
├── PonsWarp/                  # Vite original frontend
├── ponswarp-signaling-rs/     # Rust signaling + Cloud Drop
├── pons-core-wasm/
├── apps/web/                  # Next.js UI integration (current active app)
├── contracts/
└── WORKSPACE.md               # this file
```

## What to run

```bash
cd /home/declan/Documents/Develop/ponswarp/apps/web
pnpm install
pnpm dev
```

- Web: http://localhost:3000
- Signaling: ws://localhost:5502/ws (via `scripts/dev-signaling.sh` → monorepo `ponswarp-signaling-rs`)

## Do NOT work in these (legacy / scratch)

- `/home/declan/Documents/Develop/warp`
- `/home/declan/Documents/Develop/warp-ponswarp-ui`
- `/home/declan/Documents/Develop/pons_p2p/PonsWarp` (main worktree checkout only)

## Env source

Copied from `ssh home:~/Documents/Develop/Project/ponswarp` into:

- `ponswarp-signaling-rs/.env*`
- `PonsWarp/.env*`
- `apps/web/.env.local` (Next mapping)

Never commit real `.env` files.
