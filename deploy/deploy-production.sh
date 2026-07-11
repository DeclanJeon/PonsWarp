#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/PonsWarp"
BACKEND_DIR="$ROOT_DIR/ponswarp-signaling-rs"
REMOTE_HOST="${PONSWARP_DEPLOY_HOST:-pons-link}"
REMOTE_DIR="${PONSWARP_DEPLOY_DIR:-/home/declan/ponswarp-deploy}"
REMOTE_NETWORK="${PONSWARP_DOCKER_NETWORK:-ponslink-sfu_default}"
PUBLIC_URL="${PONSWARP_PUBLIC_URL:-https://warp.ponslink.com}"
PRODUCTION_ENV="$BACKEND_DIR/.env.production"

if [[ "${1:-}" == rollback ]]; then
  [[ $# == 2 ]] || { echo "usage: $0 rollback <release-id>" >&2; exit 2; }
  MODE=rollback
  RELEASE_ID="$2"
  [[ "$RELEASE_ID" =~ ^[0-9]{14}-[0-9a-fA-F]{7,40}$ ]] || { echo "invalid rollback release id: $RELEASE_ID" >&2; exit 2; }
else
  MODE=deploy
  GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  GIT_SHA="${GIT_SHA:-${PONSWARP_RELEASE_REVISION:-}}"
  [[ "$GIT_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo 'missing release revision: set PONSWARP_RELEASE_REVISION outside a Git checkout' >&2; exit 1; }
  RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-$GIT_SHA"
fi
[[ "$RELEASE_ID" =~ ^[0-9]{14}-[0-9a-fA-F]{7,40}$ ]] || { echo "invalid release id: $RELEASE_ID" >&2; exit 1; }
FRONTEND_ARCHIVE="/tmp/ponswarp-frontend-${RELEASE_ID}.tar.gz"
STAGING_PATH=''
cleanup_local() {
  rm -f "$FRONTEND_ARCHIVE"
  [[ -z "$STAGING_PATH" ]] || ssh "$REMOTE_HOST" "rm -rf -- '$STAGING_PATH'" >/dev/null 2>&1 || true
}
trap cleanup_local EXIT

if [[ "$MODE" == deploy ]]; then
  [[ -f "$PRODUCTION_ENV" ]] || { echo "Missing production backend env file: $PRODUCTION_ENV" >&2; exit 1; }
  pnpm run wasm:build
  pnpm run verify:wasm-provenance
  ( cd "$FRONTEND_DIR"; npm run build; tar -C dist -czf "$FRONTEND_ARCHIVE" . )
  CARGO_TARGET_DIR="$ROOT_DIR/target" cargo build --release --manifest-path "$BACKEND_DIR/Cargo.toml"
  STAGING_PATH="$(ssh "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' RELEASE_ID='$RELEASE_ID' bash -s" <<'REMOTE_PREPARE'
set -euo pipefail
staging="$REMOTE_DIR/releases/.staging-$RELEASE_ID-$$"
final="$REMOTE_DIR/releases/$RELEASE_ID"
mkdir -p "$REMOTE_DIR/releases"
if ! mkdir "$staging"; then echo "release staging already exists: $staging" >&2; exit 1; fi
if [[ -e "$final" || -L "$final" ]]; then echo "release already exists: $RELEASE_ID" >&2; rm -rf "$staging"; exit 1; fi
printf '%s\n' "$staging"
REMOTE_PREPARE
)"
  [[ -n "$STAGING_PATH" ]] || { echo 'unable to locate exclusive release staging directory' >&2; exit 1; }
  scp "$FRONTEND_ARCHIVE" "$REMOTE_HOST:$STAGING_PATH/frontend.tar.gz"
  scp "$ROOT_DIR/target/release/ponswarp-signaling-rs" "$REMOTE_HOST:$STAGING_PATH/ponswarp-signaling-rs"
  scp "$ROOT_DIR/deploy/Dockerfile.ponswarp-signaling" "$REMOTE_HOST:$STAGING_PATH/Dockerfile.ponswarp-signaling"
  scp "$ROOT_DIR/deploy/nginx/warp.ponslink.com.conf" "$REMOTE_HOST:$STAGING_PATH/warp.ponslink.com.conf"
  scp "$PRODUCTION_ENV" "$REMOTE_HOST:$STAGING_PATH/.env.production"
fi
ssh "$REMOTE_HOST" "sudo -n env REMOTE_DIR='$REMOTE_DIR' STAGING_PATH='$STAGING_PATH' NETWORK='$REMOTE_NETWORK' PUBLIC_URL='$PUBLIC_URL' MODE='$MODE' RELEASE_ID='$RELEASE_ID' bash -s" <<'REMOTE'
set -euo pipefail
release="$REMOTE_DIR/releases/$RELEASE_ID"
current="$REMOTE_DIR/current"
old_current="$(readlink "$current" 2>/dev/null || true)"
activation=''
name="ponswarp-signaling-$RELEASE_ID"
old_port=''; new_port=''; swapped=0; final_created=0; image_built=0; committed_success=0; container_started=0
image_identity=''; image_tag=''
staging="${STAGING_PATH:-}"

smoke_public() {
  local headers_file rc status
  curl --fail --silent --show-error --max-time 10 "$PUBLIC_URL/" >/dev/null
  headers_file="$(mktemp)"; rc=0
  curl --silent --show-error --max-time 10 --http1.1 -D "$headers_file" -o /dev/null -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$PUBLIC_URL/ws" || rc=$?
  status="$(<"$headers_file")"; rm -f "$headers_file"
  [[ "$rc" -eq 0 || "$rc" -eq 28 ]] || return "$rc"
  status="${status%%$'\r\n'*}"; [[ "$status" == *' 101 '* ]]
}
restore_after_failure() {
  local original_rc="$1" restore_rc=0
  trap - EXIT ERR
  rm -f "$current.new"
  if [[ "$swapped" -eq 1 ]]; then
    if [[ -n "$old_current" ]]; then rm -f "$current.restore.new"; ln -s "$old_current" "$current.restore.new" && mv -Tf "$current.restore.new" "$current" || restore_rc=1
    else rm -f "$current" || restore_rc=1; fi
    if [[ "$restore_rc" -eq 0 ]]; then nginx -t && nginx -s reload || restore_rc=1; [[ -z "$old_current" ]] || smoke_public || restore_rc=1; fi
  fi
  [[ "$container_started" -eq 0 ]] || docker rm -f "$name" >/dev/null 2>&1 || true
  [[ -z "$activation" ]] || rm -rf "$activation"
  [[ -z "$staging" ]] || rm -rf "$staging"
  if [[ "$final_created" -eq 1 ]]; then rm -rf "$release"; fi
  if [[ "$image_built" -eq 1 ]]; then docker image rm "${image_identity:-ponswarp-signaling:$RELEASE_ID}" >/dev/null 2>&1 || true; fi
  [[ "$restore_rc" -eq 0 ]] || { echo 'deployment failed and restoration was not verified' >&2; exit "$restore_rc"; }
  exit "$original_rc"
}
on_exit() {
  local rc="$?"
  trap - EXIT ERR
  if [[ "$rc" -ne 0 || "$committed_success" -ne 1 ]]; then
    [[ "$rc" -ne 0 ]] || rc=1
    restore_after_failure "$rc"
  fi
  exit "$rc"
}
on_error() { restore_after_failure "$?"; }
trap on_exit EXIT
trap on_error ERR

if [[ "$MODE" == deploy ]]; then
  [[ -n "$staging" && -d "$staging" ]] || { echo "missing release staging for $RELEASE_ID" >&2; exit 1; }
  chmod +x "$staging/ponswarp-signaling-rs"; mkdir -p "$staging/static" /etc/nginx/ponswarp
  sed "s|__PONSWARP_REMOTE_DIR__|$REMOTE_DIR|g" "$staging/warp.ponslink.com.conf" > "$staging/warp.ponslink.com.conf.new"
  mv "$staging/warp.ponslink.com.conf.new" "$staging/warp.ponslink.com.conf"
  image_tag="ponswarp-signaling:$RELEASE_ID"
  if docker image inspect "$image_tag" >/dev/null 2>&1; then
    echo "release image tag already exists: $image_tag" >&2
    exit 1
  fi
  docker build -f "$staging/Dockerfile.ponswarp-signaling" -t "$image_tag" --build-arg "RELEASE_ID=$RELEASE_ID" "$staging"
  image_built=1
  image_identity="$(docker image inspect --format '{{.Id}}' "$image_tag")"
  [[ "$image_identity" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || { echo "unable to resolve immutable image ID for $RELEASE_ID" >&2; exit 1; }
  docker image inspect "$image_identity" >/dev/null
  docker run --rm -v "$staging/static:/target" -v "$staging/frontend.tar.gz:/tmp/frontend.tar.gz:ro" ubuntu:24.04 sh -c 'tar -xzf /tmp/frontend.tar.gz -C /target && chown -R 33:33 /target'
  printf 'IMAGE=%s\nRELEASE_ID=%s\n' "$image_identity" "$RELEASE_ID" > "$staging/release.env"
  [[ ! -e "$release" && ! -L "$release" ]] || { echo "release appeared during staging: $RELEASE_ID" >&2; exit 1; }
  mv -T "$staging" "$release"; final_created=1; staging=''
else
  [[ -d "$release" && -d "$release/static" && -f "$release/.env.production" && -f "$release/release.env" && -f "$release/ponswarp-signaling-rs" ]] || { echo "unknown or incomplete release: $RELEASE_ID" >&2; exit 1; }
  image_identity="$(awk -F= '$1 == "IMAGE" { print $2; exit }' "$release/release.env")"
  [[ "$image_identity" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || { echo "release has no immutable image ID: $RELEASE_ID" >&2; exit 1; }
  docker image inspect "$image_identity" >/dev/null || { echo "release image is unavailable: $RELEASE_ID" >&2; exit 1; }
  [[ -z "$old_current" || ! -f "$old_current/release.id" || "$(<"$old_current/release.id")" != "$RELEASE_ID" ]] || { echo "refusing same-release rollback: $RELEASE_ID" >&2; exit 2; }
fi

if [[ -n "$old_current" ]]; then old_port="$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$old_current/backend.inc")"; [[ "$old_port" == 5502 || "$old_port" == 5503 ]] || { echo 'invalid active backend port' >&2; exit 1; }
else old_port=5502; fi
if [[ "$old_port" == 5502 ]]; then new_port=5503; else new_port=5502; fi
[[ -z "$(docker ps -q --filter "publish=$new_port")" ]] || { echo "candidate port $new_port is already in use" >&2; exit 1; }
activation="$REMOTE_DIR/activations/${RELEASE_ID}-$(date -u +%Y%m%d%H%M%S)-$$"; mkdir -p "$activation"
ln -s "$release/static" "$activation/static"; printf '%s\n' "$RELEASE_ID" > "$activation/release.id"; printf 'set $ponswarp_backend http://127.0.0.1:%s;\n' "$new_port" > "$activation/backend.inc"
if docker container inspect "$name" >/dev/null 2>&1; then
  echo "backend container already exists: $name" >&2
  exit 1
fi
container_started=1
docker run -d --name "$name" --restart unless-stopped --network "$NETWORK" --env-file "$release/.env.production" -e PONSWARP_ENV=production -p "127.0.0.1:${new_port}:5502" "$image_identity" >/dev/null
for path in health ready; do for attempt in {1..30}; do curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${new_port}/$path" >/dev/null && break; sleep 1; done; curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${new_port}/$path" >/dev/null; done
rm -f "$current.new"; ln -s "$activation" "$current.new"; mv -Tf "$current.new" "$current"; swapped=1
nginx -t; nginx -s reload; smoke_public
if [[ -n "$old_current" ]]; then old_container="$(docker ps -q --filter "publish=$old_port")"; while IFS= read -r cid; do [[ -z "$cid" ]] || docker rm -f "$cid" >/dev/null 2>&1 || true; done <<< "$old_container"; fi
committed_success=1
if [[ "$MODE" == rollback ]]; then printf 'rolled back to %s\n' "$RELEASE_ID"; else printf 'deployed release %s on port %s\n' "$RELEASE_ID" "$new_port"; fi
REMOTE
echo "Production deployment completed: $RELEASE_ID"
