# Runbook (prototype)

1. Bring up stack for local testing:

```bash
docker compose up --build
```

2. Configure OAuth:
- Register a Google OAuth client and set redirect to `https://web-daemon.fus1on.host/auth/google/callback` (use HTTPS when certs are provisioned).
- Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `panel/backend/.env`.

3. Reverse proxy & same-origin:
- The stack uses Traefik as the gateway on host ports 80 and 443. Once DNS points `web-daemon.fus1on.host` to this host, Traefik will obtain certificates from Let's Encrypt automatically.

4. Traefik & Let's Encrypt (ACME):
- Edit `docker-compose.yml` and set a real email address for ACME in the `traefik` service command (replace `you@example.com`).
- Create and secure the ACME storage file before starting Traefik:

```bash
mkdir -p deploy/traefik
touch deploy/traefik/acme.json
chmod 600 deploy/traefik/acme.json
```

- Start Traefik and monitor logs for ACME activity. Certificates will be stored in `deploy/traefik/acme.json`.

5. Docker socket & daemon container management:
- The `daemon` service has access to the host Docker socket (`/var/run/docker.sock`) so it can create/start/stop containers. Mounting the socket grants significant privileges — use only on trusted hosts or provide an authorization layer.

6. Health checks:
- Daemon: GET https://web-daemon.fus1on.host/daemon/status
- Backend: GET https://web-daemon.fus1on.host/
- Frontend: https://web-daemon.fus1on.host/

7. Upgrades:
- Rebuild a single service: `docker compose up -d --build service-name`

8. Backups:
- Postgres volume is `db_data` — use `pg_dump` against `db` container to export.
