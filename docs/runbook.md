# Runbook (prototype)

1. Bring up stack for local testing:

```bash
docker compose up --build
```

2. Configure authentication:
- Register a Google OAuth client and set redirect to `https://web-daemon.fus1on.host/auth/google/callback` (use HTTPS when certs are provisioned).
- Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `panel/backend/.env`.
- Set default admin credentials in `panel/backend/.env` using `ADMIN_USERNAME` and `ADMIN_PASSWORD`, or provide a bcrypt hash with `ADMIN_PASSWORD_HASH`.

3. Reverse proxy & same-origin:
- The stack uses an NGINX reverse proxy (service `reverse`) on host ports 80 and 443. Once DNS points `web-daemon.fus1on.host` to this host and TLS certificates are in place, the panel is available at `https://web-daemon.fus1on.host`.

4. TLS certificate provisioning (Certbot on host):
- Obtain certificates for `web-daemon.fus1on.host` using certbot on the host and place them under `deploy/nginx/certs/` as `fullchain.pem` and `privkey.pem`.

Example using certbot on the host:

```bash
sudo certbot certonly --standalone -d web-daemon.fus1on.host
sudo mkdir -p deploy/nginx/certs
sudo cp /etc/letsencrypt/live/web-daemon.fus1on.host/fullchain.pem deploy/nginx/certs/
sudo cp /etc/letsencrypt/live/web-daemon.fus1on.host/privkey.pem deploy/nginx/certs/
sudo chown $(id -u):$(id -g) deploy/nginx/certs/*
```

5. Hosted apps and volumes:
- The daemon creates site containers with host port mappings and bind mounts defined in `daemon/index.js`.
- Example host paths:
  - `/srv/web-hosting/sites/example-node`
  - `/srv/web-hosting/sites/example-php`
  - `/srv/web-hosting/sites/example-static`
- These sites are exposed directly on host ports (`4001`, `4002`, `4003`) and also proxied through NGINX at `https://web-daemon.fus1on.host/site/<site-id>/`.
- Change the `volumes` and `hostPort` values in `daemon/index.js` to point at your app directories and desired external ports.

6. Docker socket & daemon container management:
- The `daemon` service has access to the host Docker socket (`/var/run/docker.sock`) so it can create/start/stop containers. Mounting the socket grants significant privileges — use only on trusted hosts or provide an authorization layer.

7. Health checks:
- Daemon: GET https://web-daemon.fus1on.host/daemon/status
- Backend: GET https://web-daemon.fus1on.host/
- Frontend: https://web-daemon.fus1on.host/

8. Upgrades:
- Rebuild a single service: `docker compose up -d --build service-name`

9. Backups:
- Postgres volume is `db_data` — use `pg_dump` against `db` container to export.
