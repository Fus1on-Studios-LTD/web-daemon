# Custom Daemon & Panel (prototype)

This workspace contains a minimal prototype for a web-hosting daemon and admin panel using `docker-compose`.

Quick start (requires Docker & Docker Compose):

```bash
docker compose up --build
```

Services:
- `daemon` - lightweight API to manage sites (stubbed for prototype) on port 3008.
- `panel-backend` - Express backend with Google OAuth skeleton on port 4000.
- `panel-frontend` - static frontend served by nginx on port 8080.
 - `panel-frontend` - static frontend served by nginx (proxied by the `reverse` gateway).
- `db` - Postgres for panel persistence (example only).

 Gateway:
 - `reverse` - NGINX reverse proxy on host ports 80 and 443. It provides same-origin routing so OAuth and cookies work from the panel and serves TLS for `web-daemon.fus1on.host` when certificates are provided.
 
 Before running:
 - Copy `panel/backend/.env.example` to `panel/backend/.env` and fill `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and local admin credentials (`ADMIN_USERNAME`, `ADMIN_PASSWORD`).
 - Use the default admin credentials only in development. For production, set a strong `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`.
 - Point DNS A record for `web-daemon.fus1on.host` to the host running this stack.
 - Obtain certificates using `certbot` on the host and copy them into `deploy/nginx/certs/` named `fullchain.pem` and `privkey.pem`.
 	Example layout:

 ```
 deploy/nginx/certs/fullchain.pem
 deploy/nginx/certs/privkey.pem
 ```

 - Example certbot steps (run on the host):
 ```bash
 sudo certbot certonly --standalone -d web-daemon.fus1on.host
 sudo mkdir -p deploy/nginx/certs
 sudo cp /etc/letsencrypt/live/web-daemon.fus1on.host/fullchain.pem deploy/nginx/certs/
 sudo cp /etc/letsencrypt/live/web-daemon.fus1on.host/privkey.pem deploy/nginx/certs/
 sudo chown $(id -u):$(id -g) deploy/nginx/certs/*
 ```

 - Alternatively, terminate TLS at a managed load balancer or use an external ACME client.
Security:
- This is a prototype. Do not expose secrets or use in production without securing sessions, HTTPS, and proper credential handling.
