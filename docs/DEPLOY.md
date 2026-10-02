# Deploying Conti for web, mobile and desktop

claude.ai (web and mobile apps) connects to remote MCP servers **from Anthropic's cloud**, so the server must be reachable on the public internet over HTTPS. Each person or household runs **their own instance**: there is no central Conti server and nobody else holds your data.

All options below use the same three settings:

| Setting | Value |
| --- | --- |
| `CONTI_TOKEN` | a long random secret: `npx conti-mcp --new-token` |
| `CONTI_DB` | where the SQLite file lives, on persistent storage (`/data/conti.db` in Docker) |
| Connector URL | `https://<your-host>/mcp/<CONTI_TOKEN>` |

Then in Claude: **Customize → Connectors → + → Add custom connector**, paste the URL, done. On Team/Enterprise plans an Owner adds it under **Organization settings → Connectors**.

For clients that support headers (Claude Code, Claude Desktop config, other MCP clients), you can use `https://<your-host>/mcp` with `Authorization: Bearer <CONTI_TOKEN>` instead.

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

The whole state is one SQLite file. Copy it, or ask Claude for `conti_export` and keep the JSON. To move from local to cloud: export locally, then `conti_import` on the cloud instance.

## Security notes

- The token is the only credential. Anyone with the connector URL can read and change your data. Rotate it by changing `CONTI_TOKEN` and re-adding the connector.
- Without `CONTI_TOKEN` the server refuses to listen on anything but localhost.
- The dashboard runs in the host's sandboxed iframe and makes no network requests except Google Fonts.
