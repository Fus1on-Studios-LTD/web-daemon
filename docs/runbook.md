# Runbook (prototype)

1. Bring up stack for local testing:

```bash
docker compose up --build
```

2. Configure OAuth:
- Register a Google OAuth client and set redirect to `http://localhost:4000/auth/google/callback`.
- Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `panel/backend/.env`.

3. Reverse proxy & same-origin:
- The stack exposes the app via the `reverse` service on `http://localhost:8080` which proxies to the frontend and backend. Use that URL when configuring OAuth redirect URIs.

4. Docker socket & daemon container management:
- The `daemon` service is granted read access to the host Docker socket (`/var/run/docker.sock`) so it can create/start/stop containers. Be cautious: mounting the Docker socket has security implications. Consider running the daemon on a dedicated host or use proper ACLs/authorization.

5. Health checks:
- Daemon: GET http://localhost:8080/daemon/status
- Backend: GET http://localhost:8080/
- Frontend: http://localhost:8080/

6. Upgrades:
- Rebuild a single service: `docker compose up -d --build service-name`

7. Backups:
- Postgres volume is `db_data` — use `pg_dump` against `db` container to export.

3. Health checks:
- Daemon: GET http://localhost:3000/status
- Backend: GET http://localhost:4000/
- Frontend: http://localhost:8080/

4. Upgrades:
- Rebuild a single service: `docker compose up -d --build service-name`

5. Backups:
- Postgres volume is `db_data` — use `pg_dump` against `db` container to export.
