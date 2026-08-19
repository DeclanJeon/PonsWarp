#!/usr/bin/env bash
# Production deploy for warp.ponslink.com
#
# P0 hardening:
# - Backend secrets come from the HOST file (default: $REMOTE_DIR/secrets/env.production).
#   Repo ponswarp-signaling-rs/.env.production is NEVER copied as the runtime env
#   (avoids DB role/host mismatch that 502s production).
# - All remote ssh/scp share one ControlMaster session to reduce connection thrash.
#
# Env overrides:
#   PONSWARP_DEPLOY_HOST=ponslink
#   PONSWARP_DEPLOY_DIR=/home/declan/ponswarp-deploy
#   PONSWARP_HOST_ENV=/home/declan/ponswarp-deploy/secrets/env.production
#   PONSWARP_DOCKER_NETWORK=host
#   PONSWARP_PUBLIC_URL=https://warp.ponslink.com
#   PONSWARP_SKIP_PREFLIGHT=1
#   PONSWARP_RUN_PROD_TRANSFER_QA=1
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/PonsWarp"
BACKEND_DIR="$ROOT_DIR/ponswarp-signaling-rs"
REMOTE_HOST="${PONSWARP_DEPLOY_HOST:-ponslink}"
REMOTE_DIR="${PONSWARP_DEPLOY_DIR:-/home/declan/ponswarp-deploy}"
REMOTE_NETWORK="${PONSWARP_DOCKER_NETWORK:-host}"
PUBLIC_URL="${PONSWARP_PUBLIC_URL:-https://warp.ponslink.com}"
# Host-side secrets (canonical). Never use repo .env.production as runtime source.
HOST_ENV_PATH="${PONSWARP_HOST_ENV:-$REMOTE_DIR/secrets/env.production}"
# Optional local overlay for TURN URL preflight only (not uploaded as runtime env).
LOCAL_ENV_HINT="${PONSWARP_LOCAL_ENV_HINT:-$BACKEND_DIR/.env.production}"

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

# --- SSH ControlMaster: one TCP session for all ssh/scp ---
SSH_CM_DIR="${XDG_RUNTIME_DIR:-/tmp}/ponswarp-deploy-ssh"
mkdir -p "$SSH_CM_DIR"
SSH_CM_PATH="$SSH_CM_DIR/cm-%C"
SSH_BASE_OPTS=(
  -o "ControlMaster=auto"
  -o "ControlPath=$SSH_CM_PATH"
  -o "ControlPersist=300"
  -o "BatchMode=yes"
  -o "ConnectTimeout=20"
  -o "ConnectionAttempts=3"
  -o "ServerAliveInterval=15"
  -o "ServerAliveCountMax=4"
)

ssh_remote() {
  ssh "${SSH_BASE_OPTS[@]}" "$REMOTE_HOST" "$@"
}

scp_to() {
  # scp_to <local> <remote-absolute-path>
  scp "${SSH_BASE_OPTS[@]}" "$1" "$REMOTE_HOST:$2"
}

close_ssh_master() {
  ssh -O exit -o "ControlPath=$SSH_CM_PATH" "$REMOTE_HOST" >/dev/null 2>&1 || true
}

cleanup_local() {
  local rc=$?
  rm -f "$FRONTEND_ARCHIVE"
  if [[ -n "${STAGING_PATH:-}" ]]; then
    ssh_remote "rm -rf -- '$STAGING_PATH'" >/dev/null 2>&1 || true
  fi
  close_ssh_master
  return "$rc"
}
trap cleanup_local EXIT

echo "Opening SSH ControlMaster to $REMOTE_HOST..."
# Establish master connection early (fails fast if host unreachable).
ssh_remote -fN
ssh_remote "echo ok >/dev/null"

ensure_host_env() {
  # Ensure $HOST_ENV_PATH exists on remote. Bootstrap once from live container if needed.
  ssh_remote "sudo -n env REMOTE_DIR='$REMOTE_DIR' HOST_ENV_PATH='$HOST_ENV_PATH' bash -s" <<'ENSURE_ENV'
set -euo pipefail
mkdir -p "$(dirname "$HOST_ENV_PATH")"
if [[ -f "$HOST_ENV_PATH" ]]; then
  # Basic sanity
  grep -q '^DATABASE_URL=' "$HOST_ENV_PATH" || { echo "host env missing DATABASE_URL: $HOST_ENV_PATH" >&2; exit 1; }
  echo "host env present: $HOST_ENV_PATH"
  exit 0
fi

echo "host env missing; bootstrapping from live signaling container..."
cid=''
if [[ -f "$REMOTE_DIR/current/release.id" ]]; then
  rid="$(cat "$REMOTE_DIR/current/release.id")"
  if docker container inspect "ponswarp-signaling-$rid" >/dev/null 2>&1; then
    cid="ponswarp-signaling-$rid"
  fi
fi
if [[ -z "$cid" ]]; then
  cid="$(docker ps --filter name=ponswarp-signaling -q | head -1 || true)"
fi
if [[ -z "$cid" ]]; then
  echo "cannot bootstrap host env: no live ponswarp-signaling container and no $HOST_ENV_PATH" >&2
  exit 1
fi

tmp="$(mktemp)"
docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | awk -F= '
      NF < 2 { next }
      $1 ~ /^(PATH|HOME|HOSTNAME|TERM)$/ { next }
      $1 == "PORT" { next }
      $1 !~ /^[A-Z][A-Z0-9_]*$/ { next }
      { print }
    ' > "$tmp"
if ! grep -q '^DATABASE_URL=' "$tmp"; then
  rm -f "$tmp"
  echo "bootstrap failed: container $cid has no DATABASE_URL" >&2
  exit 1
fi
install -m 0600 "$tmp" "$HOST_ENV_PATH"
rm -f "$tmp"
chown root:root "$HOST_ENV_PATH" 2>/dev/null || true
echo "bootstrapped host env from container $cid -> $HOST_ENV_PATH"
ENSURE_ENV
}

validate_turn_on_host() {
  local turn_host
  turn_host="$(ssh_remote "sudo -n awk -F= '\$1==\"TURN_SERVER_URL\"{print \$2; exit}' '$HOST_ENV_PATH' 2>/dev/null || true")"
  turn_host="${turn_host#turn:}"
  turn_host="${turn_host#turns:}"
  turn_host="${turn_host#//}"
  turn_host="${turn_host%%\?*}"
  turn_host="${turn_host%%:*}"
  [[ "$turn_host" == 'turn.ponslink.com' ]] || {
    echo "Host env TURN_SERVER_URL must target turn.ponslink.com (got host: ${turn_host:-<empty>})" >&2
    echo "Edit $HOST_ENV_PATH on $REMOTE_HOST" >&2
    exit 1
  }
  echo "TURN origin OK: turn.ponslink.com (from host env)"
}

# Optional local hint check (does not affect runtime env).
if [[ -f "$LOCAL_ENV_HINT" ]]; then
  local_turn=''
  while IFS= read -r line; do
    case "$line" in
      TURN_SERVER_URL=*) local_turn="${line#TURN_SERVER_URL=}" ;;
    esac
  done < "$LOCAL_ENV_HINT"
  if [[ -n "$local_turn" ]]; then
    lt="${local_turn#turn:}"; lt="${lt#turns:}"; lt="${lt#//}"; lt="${lt%%\?*}"; lt="${lt%%:*}"
    if [[ "$lt" != 'turn.ponslink.com' ]]; then
      echo "WARNING: local $LOCAL_ENV_HINT TURN host is '$lt' (runtime uses host env, not this file)" >&2
    fi
  fi
fi

if [[ "$MODE" == deploy ]]; then
  # Fail-fast quality gates before packaging a release.
  if [[ "${PONSWARP_SKIP_PREFLIGHT:-}" != "1" ]]; then
    echo "Running deploy preflight (type-check + backend tests)..."
    pnpm --dir "$FRONTEND_DIR" type-check
    cargo test --manifest-path "$BACKEND_DIR/Cargo.toml" --locked
  else
    echo "Skipping deploy preflight (PONSWARP_SKIP_PREFLIGHT=1)"
  fi

  ensure_host_env
  validate_turn_on_host

  pnpm run wasm:build
  pnpm run verify:wasm-provenance
  ( cd "$FRONTEND_DIR"; npm run build; tar -C dist -czf "$FRONTEND_ARCHIVE" . )
  CARGO_TARGET_DIR="$ROOT_DIR/target" cargo build --release --manifest-path "$BACKEND_DIR/Cargo.toml"

  STAGING_PATH="$(ssh_remote "REMOTE_DIR='$REMOTE_DIR' RELEASE_ID='$RELEASE_ID' bash -s" <<'REMOTE_PREPARE'
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

  echo "Uploading artifacts via ControlMaster scp..."
  scp_to "$FRONTEND_ARCHIVE" "$STAGING_PATH/frontend.tar.gz"
  scp_to "$ROOT_DIR/target/release/ponswarp-signaling-rs" "$STAGING_PATH/ponswarp-signaling-rs"
  scp_to "$ROOT_DIR/deploy/Dockerfile.ponswarp-signaling" "$STAGING_PATH/Dockerfile.ponswarp-signaling"
  scp_to "$ROOT_DIR/deploy/nginx/warp.ponslink.com.conf" "$STAGING_PATH/warp.ponslink.com.conf"
  scp_to "$ROOT_DIR/deploy/nginx/ponswarp-limit-req.conf" "$STAGING_PATH/ponswarp-limit-req.conf"
  # NOTE: deliberately NOT uploading repo .env.production.
  # Runtime env is copied on-host from HOST_ENV_PATH inside the remote script.
fi

ssh_remote "sudo -n env REMOTE_DIR='$REMOTE_DIR' STAGING_PATH='$STAGING_PATH' NETWORK='$REMOTE_NETWORK' PUBLIC_URL='$PUBLIC_URL' MODE='$MODE' RELEASE_ID='$RELEASE_ID' HOST_ENV_PATH='$HOST_ENV_PATH' bash -s" <<'REMOTE'
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
  curl --fail --silent --show-error --max-time 10 "$PUBLIC_URL/health" >/dev/null
  curl --fail --silent --show-error --max-time 10 "$PUBLIC_URL/ready" >/dev/null
  headers_file="$(mktemp)"; rc=0
  # Origin is required by signaling CORS/origin policy; bare upgrade probes get 403.
  curl --silent --show-error --max-time 10 --http1.1 \
    -D "$headers_file" -o /dev/null \
    -H "Origin: $PUBLIC_URL" \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$PUBLIC_URL/ws" || rc=$?
  status="$(<"$headers_file")"; rm -f "$headers_file"
  [[ "$rc" -eq 0 || "$rc" -eq 28 || "$rc" -eq 52 ]] || return "$rc"
  status="${status%%$'\r\n'*}"
  [[ "$status" == *' 101 '* ]]
}

wait_http() {
  local url="$1"
  local max_tries="${2:-45}"
  local sleep_s="${3:-1}"
  local i=1
  echo "waiting for $url (tries=$max_tries interval=${sleep_s}s)"
  while (( i <= max_tries )); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then
      echo "ready: $url (try $i/$max_tries)"
      return 0
    fi
    sleep "$sleep_s"
    i=$((i + 1))
  done
  echo "timeout waiting for $url after ${max_tries} tries" >&2
  return 1
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
  if [[ "$container_started" -eq 1 ]]; then
    docker logs "$name" >&2 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
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

install_runtime_env_from_host() {
  # Canonical runtime secrets: host file only.
  [[ -f "$HOST_ENV_PATH" ]] || { echo "missing host env: $HOST_ENV_PATH" >&2; exit 1; }
  grep -q '^DATABASE_URL=' "$HOST_ENV_PATH" || { echo "host env missing DATABASE_URL" >&2; exit 1; }
  # Refuse obviously-wrong docker-compose style hosts if someone copied repo env by hand.
  if grep -E '^DATABASE_URL=.*@postgres[:/]' "$HOST_ENV_PATH" >/dev/null 2>&1; then
    echo "REFUSING host env DATABASE_URL that targets hostname 'postgres' (compose-only)." >&2
    echo "Fix $HOST_ENV_PATH to use the production DB host (usually 127.0.0.1)." >&2
    exit 1
  fi
  install -m 0600 "$HOST_ENV_PATH" "$1"
  echo "installed runtime env from host secrets -> $1"
}

if [[ "$MODE" == deploy ]]; then
  [[ -n "$staging" && -d "$staging" ]] || { echo "missing release staging for $RELEASE_ID" >&2; exit 1; }
  chmod +x "$staging/ponswarp-signaling-rs"; mkdir -p "$staging/static" /etc/nginx/ponswarp
  sed "s|__PONSWARP_REMOTE_DIR__|$REMOTE_DIR|g" "$staging/warp.ponslink.com.conf" > "$staging/warp.ponslink.com.conf.new"
  mv "$staging/warp.ponslink.com.conf.new" "$staging/warp.ponslink.com.conf"
  sed "s|__PONSWARP_REMOTE_DIR__|$REMOTE_DIR|g" "$staging/ponswarp-limit-req.conf" > "$staging/ponswarp-limit-req.conf.new"
  mv "$staging/ponswarp-limit-req.conf.new" "$staging/ponswarp-limit-req.conf"
  # Copy host secrets into staging BEFORE image/finalize (no repo env).
  install_runtime_env_from_host "$staging/.env.production"
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
  # Refresh rollback env from current host secrets when available (PORT rewritten below).
  if [[ -f "$HOST_ENV_PATH" ]]; then
    install_runtime_env_from_host "$release/.env.production"
  fi
fi

if [[ -n "$old_current" ]]; then
  old_backend_inc="$old_current/backend.inc"
  if [[ -f "$old_backend_inc" ]]; then
    old_port="$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$old_backend_inc")"
  else
    old_port=''
  fi
  [[ "$old_port" == 5502 || "$old_port" == 5503 ]] || { echo "invalid active backend port '$old_port' (missing backend.inc?)" >&2; exit 1; }
else old_port=5502; fi
if [[ "$old_port" == 5502 ]]; then new_port=5503; else new_port=5502; fi
if [[ "$NETWORK" == host ]]; then
  [[ -z "$(ss -H -ltn "sport = :$new_port")" ]] || { echo "candidate port $new_port is already in use" >&2; exit 1; }
else
  [[ -z "$(docker ps -q --filter "publish=$new_port")" ]] || { echo "candidate port $new_port is already in use" >&2; exit 1; }
fi
# Force candidate listen port into env-file so --env-file cannot pin the previous release port.
tmp_env="$release/.env.production.portfix"
awk -v port="$new_port" '
  BEGIN { done=0 }
  /^PORT=/ { if (!done) { print "PORT=" port; done=1 }; next }
  { print }
  END { if (!done) print "PORT=" port }
' "$release/.env.production" > "$tmp_env"
install -m 0600 "$tmp_env" "$release/.env.production"
rm -f "$tmp_env"
activation="$REMOTE_DIR/activations/${RELEASE_ID}-$(date -u +%Y%m%d%H%M%S)-$$"; mkdir -p "$activation"
ln -s "$release/static" "$activation/static"; printf '%s\n' "$RELEASE_ID" > "$activation/release.id"; printf 'set $ponswarp_backend http://127.0.0.1:%s;\n' "$new_port" > "$activation/backend.inc"
if docker container inspect "$name" >/dev/null 2>&1; then
  echo "backend container already exists: $name" >&2
  exit 1
fi
container_started=1
docker_args=(-d --name "$name" --restart unless-stopped --network "$NETWORK" --env-file "$release/.env.production" -e PONSWARP_ENV=production -e "PORT=$new_port")
if [[ "$NETWORK" == host ]]; then
  docker_args+=(--add-host postgres:127.0.0.1)
else
  docker_args+=(-p "127.0.0.1:${new_port}:5502")
fi
echo "starting backend $name on port $new_port"
docker run "${docker_args[@]}" "$image_identity" >/dev/null
wait_http "http://127.0.0.1:${new_port}/health" 45 1 || { docker logs "$name" >&2 || true; exit 1; }
wait_http "http://127.0.0.1:${new_port}/ready" 45 1 || { docker logs "$name" >&2 || true; exit 1; }
rm -f "$current.new"; ln -s "$activation" "$current.new"; mv -Tf "$current.new" "$current"; swapped=1
install -m 0644 "$release/warp.ponslink.com.conf" /etc/nginx/sites-available/warp.ponslink.com
ln -sfn /etc/nginx/sites-available/warp.ponslink.com /etc/nginx/sites-enabled/warp.ponslink.com
install -m 0644 "$release/ponswarp-limit-req.conf" /etc/nginx/conf.d/ponswarp-limit-req.conf
nginx -t; nginx -s reload; smoke_public
if [[ -n "$old_current" && -f "$old_current/release.id" ]]; then
  old_release_id="$(<"$old_current/release.id")"
  old_container_name="ponswarp-signaling-$old_release_id"
  docker rm -f "$old_container_name" >/dev/null 2>&1 || true
else
  docker rm -f ponswarp-signaling >/dev/null 2>&1 || true
fi
committed_success=1
if [[ "$MODE" == rollback ]]; then printf 'rolled back to %s\n' "$RELEASE_ID"; else printf 'deployed release %s on port %s\n' "$RELEASE_ID" "$new_port"; fi
REMOTE
echo "Production deployment completed: $RELEASE_ID"

# Optional networked transfer smoke against the just-deployed public URL.
# Opt-in only: keeps offline packaging deterministic.
if [[ "$MODE" == deploy && "${PONSWARP_RUN_PROD_TRANSFER_QA:-}" == "1" ]]; then
  echo "Running post-deploy production transfer QA (PONSWARP_RUN_PROD_TRANSFER_QA=1)..."
  (
    cd "$ROOT_DIR"
    PROD_URL="${PONSWARP_PUBLIC_URL:-$PUBLIC_URL}" pnpm run qa:prod-transfer
  ) || {
    echo "Production transfer QA failed after deploy $RELEASE_ID" >&2
    exit 1
  }
  echo "Production transfer QA passed for $RELEASE_ID"
fi
