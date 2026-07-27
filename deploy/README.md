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