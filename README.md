# Custom Daemon & Panel (prototype)

This workspace contains a minimal prototype for a web-hosting daemon and admin panel using `docker-compose`.

Quick start (requires Docker & Docker Compose):

```bash
docker compose up --build
```

Services:
- `daemon` - lightweight API to manage sites (stubbed for prototype) on port 3000.
- `panel-backend` - Express backend with Google OAuth skeleton on port 4000.
- `panel-frontend` - static frontend served by nginx on port 8080.
- `db` - Postgres for panel persistence (example only).

Gateway:
- `reverse` - NGINX reverse proxy on host port 8080. It provides same-origin routing so OAuth and cookies work from the panel.

Before running:
- Copy `panel/backend/.env.example` to `panel/backend/.env` and fill `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

- The `daemon` service requires access to Docker. Docker socket is mounted read-only into the container; the host must allow this.

Security:
- This is a prototype. Do not expose secrets or use in production without securing sessions, HTTPS, and proper credential handling.
