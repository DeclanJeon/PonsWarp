# Warp + PonsWarp UI (worktree)

Isolated branch: `feature/ponswarp-ui-integration`  
Worktree path: `~/Documents/Develop/warp-ponswarp-ui`

## What is combined

| Layer | Source |
|---|---|
| Visual UI / branding | PonsWarp (`SpaceField`, Orbitron/Rajdhani, cyan–purple glass) |
| File transfer DataChannel engine | WarpSpace (chunk protocol, progress, integrity) |
| Signaling | **PonsWarp Rust** `ponswarp-signaling-rs` (`ws://localhost:5502/ws`) |

The original WarpSpace Node signaling (`server/signaling.mjs`) remains as `pnpm dev:signal:legacy` only.

## Why a worktree

PonsWarp monorepo branches stay untouched. This worktree never checks out PonsWarp `master`/`develop`; it only **reads** the sibling clone for UI reference and launches the Rust signaling binary.

```
~/Documents/Develop/
  warp/                      # main WarpSpace tree
  warp-ponswarp-ui/          # this worktree (feature/ponswarp-ui-integration)
  pons_p2p/PonsWarp/         # upstream PonsWarp clone (read-only for us)
    ponswarp-signaling-rs/   # cargo run → :5502
```

## Quick start

```bash
# 1) ensure PonsWarp is cloned (signaling source)
git clone https://github.com/DeclanJeon/PonsWarp.git ~/Documents/Develop/pons_p2p/PonsWarp

# 2) from this worktree
cd ~/Documents/Develop/warp-ponswarp-ui
cp .env.local.example .env.local
pnpm install
pnpm dev
```

- Web: http://localhost:3000  
- Signaling: ws://127.0.0.1:5502/ws  

Requires Rust toolchain (`cargo`) for `scripts/dev-signaling.sh`.

Optional:

```bash
export PONSWARP_SIGNALING_DIR=/path/to/ponswarp-signaling-rs
export CORS_ORIGINS=http://localhost:3000
pnpm dev:signal
```

## Protocol notes

Client room codes are 6-char base36 uppercase (PonsWarp style).  
First `JoinRoom` creates the room on the Rust server.  
ICE/TURN via `RequestTurnConfig` when the server is configured; otherwise STUN fallback.

Wire format: `{ "type": "JoinRoom", "payload": { "room_id": "ABC123" } }`  
See `contracts/protocol/v1/messages.json` in the PonsWarp repo.

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Next + PonsWarp Rust signaling |
| `pnpm dev:web` | Next only |
| `pnpm dev:signal` | Rust signaling only |
| `pnpm dev:signal:legacy` | Old WarpSpace `ws` server |
| `pnpm build` | Production build |
| `pnpm test:unit` | Format/progress unit tests |

## Not in scope (this branch)

- Cloud Drop / R2 share flows
- PonsWarp SwarmManager / simple-peer stack
- Multi-receiver swarm
- Hybrid HTTP assist
