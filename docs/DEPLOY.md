# Deploying Conti for web, mobile and desktop

claude.ai (web and mobile apps) connects to remote MCP servers **from Anthropic's cloud**, so the server must be reachable on the public internet over HTTPS. Each person or household runs **their own instance**: there is no central Conti server and nobody else holds your data.

All options below use the same three settings:

| Setting | Value |
| --- | --- |
| `CONTI_TOKEN` | a long random secret: `npx conti-mcp --new-token` |
| `CONTI_DB` | libSQL database: a local file (`/data/conti.db`), a `file:` URL, or a Turso `libsql://…` URL |
| `CONTI_DB_AUTH_TOKEN` | auth token for a remote Turso database (also read from `TURSO_AUTH_TOKEN`) |
| Connector URL | `https://<your-host>/mcp/<CONTI_TOKEN>` |

Then in Claude: **Customize → Connectors → + → Add custom connector**, paste the URL, done. On Team/Enterprise plans an Owner adds it under **Organization settings → Connectors**.

For clients that support headers (Claude Code, Claude Desktop config, other MCP clients), you can use `https://<your-host>/mcp` with `Authorization: Bearer <CONTI_TOKEN>` instead.

## Render + Turso (free, all from the browser)

The simplest self-hosted setup: your data in Turso (managed libSQL), the server on Render's free tier. No local tools, no credit card. One person sets this up once per household; everyone then just adds one connector URL in Claude/ChatGPT.

**1 — Turso (the database).** In the [Turso dashboard](https://turso.tech) sign up, create a database (e.g. `conti`), and create a database **token**. Note the database **URL** (`libsql://conti-<you>.turso.io`) and the **token**.

**2 — Render (the server).** Use the **Deploy to Render** button in the [README](../README.md) (or Render → New → Blueprint → pick this repo). Render reads [`render.yaml`](../render.yaml) and asks for:
- `CONTI_DB` → the Turso URL
- `CONTI_DB_AUTH_TOKEN` → the Turso token

`CONTI_TOKEN` is generated automatically. After deploy, open the service → **Environment** and copy the generated `CONTI_TOKEN`. Your server is `https://<app>.onrender.com`.

**3 — Connect.** Check that `https://<app>.onrender.com/health` returns `{"ok":true,...}`, then add the custom connector:
- Claude: **Customize → Connectors → Add custom connector**
- ChatGPT: **Settings → Connectors → Advanced → Developer Mode → Add custom connector**

with the URL:

```
https://<app>.onrender.com/mcp/<CONTI_TOKEN>
```

The free instance sleeps after ~15 min idle (first request wakes it in ~1 min); the data lives in Turso, so nothing is lost. For an always-on server use a paid Render plan, Fly.io or Cloud Run — the same env vars apply.

## Turso (managed cloud database, free tier)

Store the data in Turso's managed libSQL instead of a local file. The server (Fly.io, Cloud Run, a home server…) stays stateless: no volume to back up, and the same database is reachable from every instance and every device.

```bash
# one-time: install the CLI and sign up (no credit card)
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup

# create the database and a token
turso db create conti
turso db show conti --url            # → libsql://conti-<you>.turso.io
turso db tokens create conti         # → the auth token
```

Then set two variables on the server, instead of a local `CONTI_DB` file:

```bash
CONTI_DB=libsql://conti-<you>.turso.io
CONTI_DB_AUTH_TOKEN=<the token from the command above>
```

The schema is created automatically on first start. To move existing data over: run `conti_export` on the old instance and `conti_import` on the Turso-backed one.

## Fly.io

```bash
fly launch --no-deploy --copy-config        # uses fly.toml from this repo
fly volumes create conti_data --size 1
fly secrets set CONTI_TOKEN=$(npx -y conti-mcp --new-token)
fly deploy
```

`fly.toml` keeps one machine with the volume mounted at `/data`. Connector URL: `https://<app>.fly.dev/mcp/<token>`.

## Railway / Render

Create a service from this repo (Dockerfile is detected), add a persistent volume mounted at `/data`, set `CONTI_TOKEN`. Use the public HTTPS domain the platform gives you.

## Home server or NAS + Cloudflare Tunnel (free, data at home)

```bash
docker compose up -d     # docker-compose.yml in this repo
cloudflared tunnel --url http://localhost:3333
```

For a stable hostname create a named tunnel in Cloudflare Zero Trust and point it at `http://localhost:3333`.

## VPS with Caddy

```bash
docker compose up -d
# /etc/caddy/Caddyfile
conti.example.com {
  reverse_proxy localhost:3333
}
```

Set `CONTI_ALLOWED_HOSTS=conti.example.com` to enable Host-header validation.

## Backups

With a local file the whole state is one SQLite file: copy it, or ask Claude for `conti_export` and keep the JSON. With Turso the database lives in the cloud (Turso keeps its own backups); `conti_export` still gives you a portable JSON copy. To move from local to cloud: export locally, then `conti_import` on the cloud instance.

## Security notes

- The token is the only credential. Anyone with the connector URL can read and change your data. Rotate it by changing `CONTI_TOKEN` and re-adding the connector.
- Without `CONTI_TOKEN` the server refuses to listen on anything but localhost.
- The dashboard runs in the host's sandboxed iframe and makes no network requests except Google Fonts.
