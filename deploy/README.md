# Deploy notes

This directory contains production deployment artifacts and configuration examples.

## Nginx

- `nginx/warp.ponslink.com.conf` is the canonical server block for warp.ponslink.com.
- `deploy-production.sh` performs a sed substitution on `__PONSWARP_REMOTE_DIR__` and installs the resulting file under the release directory; nginx include path is `/etc/nginx/ponswarp`.
- SSL certificates are managed by certbot/Let's Encrypt on the host (paths under `/etc/letsencrypt/live/warp.ponslink.com`).

## Coturn (TURN)

- `coturn/turnserver.conf.example` provides production-aligned settings (ports, fingerprint, lt-cred-mech, denied-peer ranges, channel lifetime, etc.).
- Copy to host `/etc/turnserver.conf`, inject secrets via file/env (never commit real values), then `systemctl restart coturn`.
- See `coturn/README.md` for the exact apply steps.

## Production deploy script

`deploy-production.sh` handles frontend/backend releases, nginx config templating, health checks, and rollback. It does not manage Coturn; Coturn runs as a host service.

### Host secrets (required)

Runtime backend env is **never** taken from the git-tracked
`ponswarp-signaling-rs/.env.production` (that file often has compose-only DB hosts
and will 502 production).

Canonical path on the deploy host:

```text
$PONSWARP_DEPLOY_DIR/secrets/env.production
# default: /home/declan/ponswarp-deploy/secrets/env.production
```

- First deploy bootstraps this file from the live signaling container if missing.
- Override with `PONSWARP_HOST_ENV=/absolute/path`.
- Mode `0600`; contains `DATABASE_URL`, TURN secrets, Cloud keys, etc.
- Script refuses `DATABASE_URL` values that target hostname `postgres` (compose-only).

### SSH ControlMaster

All `ssh`/`scp` calls share one ControlMaster session (`ControlPersist=300`) under
`$XDG_RUNTIME_DIR/ponswarp-deploy-ssh/` to avoid multi-connection rate limits.

### Deploy

```bash
PONSWARP_DEPLOY_HOST=ponslink bash deploy/deploy-production.sh
```

## Release checklist & transfer QA

- Full checklist: `RELEASE-CHECKLIST.md`
- Post-deploy transfer smoke: `pnpm run qa:prod-transfer` from repo root
- Optional deploy gate (after public health smoke):

```bash
PONSWARP_DEPLOY_HOST=ponslink \
PONSWARP_RUN_PROD_TRANSFER_QA=1 \
bash deploy/deploy-production.sh
```