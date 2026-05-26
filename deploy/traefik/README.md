Place this folder under version control but do NOT commit private keys or ACME storage files with secrets.

Before starting Traefik, secure the ACME file:

```bash
chmod 600 deploy/traefik/acme.json
```

Edit the `docker-compose.yml` Traefik service and set a real email for ACME certificate registration (replace `you@example.com`).
