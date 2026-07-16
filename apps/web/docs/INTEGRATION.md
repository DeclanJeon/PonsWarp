# PonsWarp UI + WarpSpace Engine Integration

## Branch / worktree

- Branch: `feature/ponswarp-ui-integration`
- Worktree: `~/Documents/Develop/warp-ponswarp-ui`
- Upstream PonsWarp clone (read-only): `~/Documents/Develop/pons_p2p/PonsWarp`
- Original WarpSpace tree: `~/Documents/Develop/warp` (stash has prior WIP on `main`)

No PonsWarp monorepo branch is checked out or modified by this worktree.

## Mapping

```
Browser UI (PonsWarp look)
  AppShell + SpaceField + intro/selection
  existing transfer dashboard components restyled via tokens
        │
        ▼
useTransferSession / TransferEngine  (WarpSpace chunk DataChannel)
        │
        ▼
PonsWarpSignalingClient  →  ws://host:5502/ws
        │
        ▼
ponswarp-signaling-rs (JoinRoom, Offer, Answer, IceCandidate, RequestTurnConfig)
```

## Key files

- `src/lib/signaling/ponswarp-client.ts` — Rust protocol client
- `src/lib/webrtc/transfer-engine.ts` — transfer logic on PonsWarp signaling
- `src/components/ponswarp/*` — SpaceField, MagneticButton
- `src/app/globals.css` — PonsWarp design tokens
- `scripts/dev-signaling.sh` — launches sibling `ponswarp-signaling-rs`

## Origin gate

Rust signaling validates `Origin`. Dev script sets:

```
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:3500
```

Browser pages from `:3000` work. Headless WS clients must send `Origin: http://localhost:3000`.

## Room codes

PonsWarp style: client generates 6-char base36 uppercase; first `JoinRoom` creates the room.
