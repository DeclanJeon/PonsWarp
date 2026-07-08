#!/usr/bin/env bash
set -euo pipefail

# PonsWarp production deployment.
# This script intentionally deploys the backend with signaling-rs/.env.production only.
# Do not switch this script to .env or .env.local; those files are for local/default runs.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR"
BACKEND_DIR="$ROOT_DIR/signaling-rs"

REMOTE_HOST="${PONSWARP_DEPLOY_HOST:-pons-link}"
REMOTE_DIR="${PONSWARP_DEPLOY_DIR:-/home/declan/ponswarp-deploy}"
REMOTE_STATIC_ROOT="${PONSWARP_STATIC_ROOT:-/var/www/ponswarp}"
REMOTE_NETWORK="${PONSWARP_DOCKER_NETWORK:-ponslink-sfu_default}"
REMOTE_PORT_BIND="${PONSWARP_PORT_BIND:-127.0.0.1:5502:5502}"

PRODUCTION_ENV="$BACKEND_DIR/.env.production"
FRONTEND_ARCHIVE="/tmp/ponswarp-frontend.tar.gz"

if [[ ! -f "$PRODUCTION_ENV" ]]; then
  echo "Missing production backend env file: $PRODUCTION_ENV" >&2
  exit 1
fi

echo "Building frontend with production Vite settings..."
(
  cd "$FRONTEND_DIR"
  npm run build
  tar -C dist -czf "$FRONTEND_ARCHIVE" .
)

echo "Building backend release binary..."
(
  cd "$BACKEND_DIR"
  cargo build --release
)

echo "Uploading production artifacts and .env.production..."
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR/bin' '$REMOTE_DIR/signaling' '$REMOTE_DIR/nginx'"
scp "$FRONTEND_ARCHIVE" "$REMOTE_HOST:$REMOTE_DIR/frontend.tar.gz"
scp "$BACKEND_DIR/target/release/ponswarp-signaling-rs" "$REMOTE_HOST:$REMOTE_DIR/bin/ponswarp-signaling-rs"
scp "$ROOT_DIR/deploy/Dockerfile.ponswarp-signaling" "$REMOTE_HOST:$REMOTE_DIR/bin/Dockerfile.ponswarp-signaling"
scp "$ROOT_DIR/deploy/nginx/warp.ponslink.com.conf" "$REMOTE_HOST:$REMOTE_DIR/nginx/warp.ponslink.com.conf"
scp "$PRODUCTION_ENV" "$REMOTE_HOST:$REMOTE_DIR/signaling/.env.production"

echo "Applying production deployment on $REMOTE_HOST..."
ssh "$REMOTE_HOST" "set -euo pipefail
chmod +x '$REMOTE_DIR/bin/ponswarp-signaling-rs'
cd '$REMOTE_DIR/bin'
docker build -f Dockerfile.ponswarp-signaling -t ponswarp-signaling:latest .
docker rm -f ponswarp-signaling >/dev/null 2>&1 || true
docker run -d --name ponswarp-signaling \\
  --restart unless-stopped \\
  --network '$REMOTE_NETWORK' \\
  --env-file '$REMOTE_DIR/signaling/.env.production' \\
  -e PONSWARP_ENV=production \\
  -p '$REMOTE_PORT_BIND' \\
  ponswarp-signaling:latest

docker run --rm \\
  -v '$REMOTE_STATIC_ROOT:/target' \\
  -v '$REMOTE_DIR/frontend.tar.gz:/tmp/frontend.tar.gz:ro' \\
  ubuntu:24.04 sh -c 'rm -rf /target/* && tar -xzf /tmp/frontend.tar.gz -C /target && chown -R 33:33 /target'

docker run --rm \\
  -v /etc/nginx:/etc/nginx \\
  -v '$REMOTE_DIR/nginx/warp.ponslink.com.conf:/tmp/warp.ponslink.com.conf:ro' \\
  ubuntu:24.04 sh -c 'cp /tmp/warp.ponslink.com.conf /etc/nginx/sites-available/warp.ponslink.com && [ -e /etc/nginx/sites-enabled/warp.ponslink.com ] || ln -s /etc/nginx/sites-available/warp.ponslink.com /etc/nginx/sites-enabled/warp.ponslink.com'

docker run --rm --privileged --pid=host --network=host ubuntu:24.04 nsenter -t 1 -m -u -n -i nginx -t
docker run --rm --privileged --pid=host --network=host ubuntu:24.04 nsenter -t 1 -m -u -n -i nginx -s reload
"

echo "Production deployment completed with backend env: $REMOTE_DIR/signaling/.env.production"
