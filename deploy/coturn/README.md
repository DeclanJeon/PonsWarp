# Coturn (TURN) deployment notes

This directory holds the example configuration for a production Coturn TURN server.

## Apply path (host)

1. Copy the example:
   cp deploy/coturn/turnserver.conf.example /etc/turnserver.conf
2. Replace placeholders:
   - `external-ip`, `relay-ip` → host public IP(s)
   - `realm` → production realm
   - `static-auth-secret` → load via file/env (e.g., `/etc/turnserver/secret`); never store the real secret in git
3. Enable and start:
   systemctl enable coturn
   systemctl restart coturn
4. Verify:
   turnutils_uclient -u test -p test -r example.org turn.example.org

## Secrets

- Never commit a real TURN secret.
- Use a secrets file or environment injection outside the repository.
- The example file contains only placeholder values.

## Integration

PonsWarp clients discover TURN via `TURN_SERVER_URL` / `TURN_FALLBACK_SERVERS` environment variables (see deploy-production.sh merge logic). Coturn must be reachable on UDP 3478 (and TLS 5349 if enabled) from clients and the signaling backend.
