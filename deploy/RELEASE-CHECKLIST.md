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
- Production backend env must use the **host** DB role/URL (not a mismatched repo copy).
- nginx conf placeholders (`__PONSWARP_REMOTE_DIR__`) are substituted by the deploy script.

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

## Rollback

```bash
PONSWARP_DEPLOY_HOST=ponslink bash deploy/deploy-production.sh rollback <release-id>
```
