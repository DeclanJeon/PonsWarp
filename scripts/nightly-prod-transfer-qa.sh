#!/usr/bin/env bash
# Nightly / scheduled production transfer QA.
#
# Intended for cron or a remote scheduler — NOT default preflight (networked).
#
# Example crontab (daily 03:15 UTC):
#   15 3 * * * cd /path/to/ponswarp && bash scripts/nightly-prod-transfer-qa.sh >>artifacts/ops/qa/nightly.log 2>&1
#
# Env:
#   PROD_URL=https://warp.ponslink.com
#   PROD_QA_TIMEOUT_MS=180000
#   PROD_QA_RELAY=0|1
#   PROD_QA_ARTIFACT_DIR=artifacts/ops/qa
#   NIGHTLY_FAIL_ON_ERROR=1   # default 1; set 0 to always exit 0 after logging
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROD_URL="${PROD_URL:-https://warp.ponslink.com}"
PROD_QA_TIMEOUT_MS="${PROD_QA_TIMEOUT_MS:-180000}"
PROD_QA_ARTIFACT_DIR="${PROD_QA_ARTIFACT_DIR:-$ROOT_DIR/artifacts/ops/qa}"
NIGHTLY_FAIL_ON_ERROR="${NIGHTLY_FAIL_ON_ERROR:-1}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PROD_QA_ARTIFACT_DIR"

export PROD_URL PROD_QA_TIMEOUT_MS PROD_QA_ARTIFACT_DIR

echo "[nightly-prod-transfer-qa] start $STAMP url=$PROD_URL"

set +e
pnpm run qa:prod-transfer
RC=$?
set -e

SUMMARY_FILE="$PROD_QA_ARTIFACT_DIR/nightly-summary-$STAMP.json"
# Capture last JSON line from a companion log if callers tee stdout; always write status file.
printf '{"ok":%s,"rc":%s,"url":%s,"stamp":%s,"relay":%s}\n' \
  "$([[ "$RC" -eq 0 ]] && echo true || echo false)" \
  "$RC" \
  "$(printf '%s' "$PROD_URL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(printf '%s' "$STAMP" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$([[ "${PROD_QA_RELAY:-0}" == "1" ]] && echo true || echo false)" \
  > "$SUMMARY_FILE"

echo "[nightly-prod-transfer-qa] finished rc=$RC summary=$SUMMARY_FILE"

if [[ "$RC" -ne 0 && "$NIGHTLY_FAIL_ON_ERROR" == "1" ]]; then
  exit "$RC"
fi
exit 0
