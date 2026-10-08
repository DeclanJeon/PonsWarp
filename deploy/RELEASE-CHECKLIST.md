# PonsWarp Release Checklist

Use this before/after every production cutover to `warp.ponslink.com`.

## Pre-deploy (local)

```bash
pnpm run preflight                 # type-check + frontend tests + cargo tests
pnpm run frontend:build
# optional offline packaging only:
# PONSWARP_SKIP_PREFLIGHT=1 is discouraged for real releases
```

## Deploy

```bash
PONSWARP_DEPLOY_HOST=ponslink bash deploy/deploy-production.sh
```

Notes:

- Canonical UI is `PonsWarp/` only.
- Do **not** reintroduce dead TURN fallback `43.156.100.135`.
- **Runtime env is host-only:** `$PONSWARP_DEPLOY_DIR/secrets/env.production`
  (default `/home/declan/ponswarp-deploy/secrets/env.production`).
  Repo `ponswarp-signaling-rs/.env.production` is **not** uploaded.
- Deploy opens one SSH ControlMaster session for all scp/ssh hops.
- nginx conf placeholders (`__PONSWARP_REMOTE_DIR__`) are substituted by the deploy script.

## Cloudflare cache purge credentials

Every production deploy or rollback purges only `https://warp.ponslink.com/` and
`https://warp.ponslink.com/index.html`, then verifies the public HTML references
the active entry bundle before any optional transfer QA. Deploys and rollbacks
fail before SSH if the credential pair is unavailable.

Create a zone-scoped Cloudflare API token with **Cache Purge** permission and
store it outside the repository on the deployment runner:

```bash
install -d -m 700 "$HOME/.config/ponswarp"
umask 077
cat > "$HOME/.config/ponswarp/cloudflare.env" <<'EOF'
CLOUDFLARE_API_TOKEN=replace-with-cache-purge-token
CLOUDFLARE_ZONE_ID=replace-with-zone-id
EOF
chmod 600 "$HOME/.config/ponswarp/cloudflare.env"
```

The deploy script reads this file by default. Override its location with
`PONSWARP_CLOUDFLARE_ENV_FILE`. Do not commit or paste the API token into chat.
The helper verifies the purge response, confirms the public document is not an
edge `HIT`, and checks that the expected release bundle is served.

## Post-deploy smoke (required)

```bash
curl -fsS https://warp.ponslink.com/health
curl -fsS https://warp.ponslink.com/ready
# optional Cloud Drop create (origin required by CORS):
curl -fsS -X POST https://warp.ponslink.com/api/cloud-share \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://warp.ponslink.com' \
  -d '{"rootName":"qa.bin","files":[{"name":"qa.bin","path":"qa.bin","size":32,"contentType":"application/octet-stream"}]}'
```

## Production transfer QA (release gate)

Networked Playwright smoke against live prod. **Not** part of default `preflight`
(so offline CI stays deterministic). **Required** for human release sign-off and
available as an optional deploy gate.

```bash
# Direct path (default)
pnpm run qa:prod-transfer

# Force-relay path
PROD_QA_RELAY=1 pnpm run qa:prod-transfer

# Custom URL / artifacts
PROD_URL=https://warp.ponslink.com \
PROD_QA_ARTIFACT_DIR=artifacts/ops/qa \
pnpm run qa:prod-transfer
```

Optional automatic post-deploy gate (opt-in; may flake under headless ICE/NAT):

```bash
PONSWARP_DEPLOY_HOST=ponslink \
PONSWARP_RUN_PROD_TRANSFER_QA=1 \
bash deploy/deploy-production.sh
```

If automated Playwright transfer flakes (headless ICE constraints), fall back to
manual two-browser smoke on the same checklist and store screenshots under
`artifacts/ops/qa/`.

PASS criteria:

- Automated: process exit code `0` and JSON summary `"ok":true`
- Or manual smoke documented with screenshots under `artifacts/ops/qa/`
- No dead TURN IP (`43.156.100.135`) in the served frontend bundle

## Nightly / release-habit transfer QA

Networked smoke is **not** in default `preflight`. Habit options:

```bash
# Local / cron wrapper (writes artifacts/ops/qa/nightly-summary-*.json)
pnpm run qa:prod-transfer:nightly

# Template: deploy/github-workflows/nightly-prod-transfer-qa.yml
# Copy to .github/workflows/ (git push needs `workflow` OAuth scope)
# - schedule: 03:15 UTC daily
# - workflow_dispatch for manual release habit runs
```

Crontab example:

```cron
15 3 * * * cd /path/to/ponswarp && pnpm run qa:prod-transfer:nightly >>artifacts/ops/qa/nightly.log 2>&1
```

## Rollback

```bash
PONSWARP_DEPLOY_HOST=ponslink bash deploy/deploy-production.sh rollback <release-id>
```
