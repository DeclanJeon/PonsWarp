#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"                 # apps/web
MONOREPO_ROOT="$(cd "$ROOT/../.." && pwd)"               # ponswarp
SIGNAL_DIR="${PONSWARP_SIGNALING_DIR:-$MONOREPO_ROOT/ponswarp-signaling-rs}"

if [[ ! -d "$SIGNAL_DIR" ]]; then
  echo "[dev-signaling] PonsWarp signaling not found at $SIGNAL_DIR" >&2
  exit 1
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-5502}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000,http://localhost:3500}"

cd "$SIGNAL_DIR"
echo "[dev-signaling] cargo run in $SIGNAL_DIR (ws://$HOST:$PORT/ws)"
exec cargo run
