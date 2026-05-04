# Deployment

The dashboard listens on `:3000` by default. Don't expose it directly to the public internet — put it behind a reverse proxy with TLS.

## Docker (recommended)

`docker-compose.yml` ships a production-ready setup:

```bash
docker compose up -d
# open http://localhost:3000
# 1. set the dashboard password (only allowed from localhost on first run)
# 2. Settings → Telegram API → enter apiId / apiHash from my.telegram.org
# 3. Settings → Telegram Accounts → "Add account" → phone / OTP / 2FA
# 4. Settings → Engine → Start monitor
```

The image is published to GHCR on every release: `ghcr.io/botnick/telegram-media-downloader:<version>`.

### Verify a deployment

After `docker compose up -d` (or any host install), run the diagnostics:

```bash
docker compose exec app npm run doctor      # inside the container
# or, for host installs:
npm run doctor
```

Reports Node + ABI, config load, SQLite open, `data/` writability, port availability, and `ffmpeg`. Exits non-zero on any blocking failure — wire it into your provisioning script or CI smoke-step.

### Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT`                          | `3000`              | HTTP port. |
| `NODE_ENV`                      | unset               | Set to `production` to enable `Secure` cookies (requires HTTPS). |
| `TZ`                            | `UTC`               | Container timezone. |
| `TGDL_RUN`                      | `monitor`           | Watchdog subcommand for `runner.js` / `runner.sh` / `watchdog.ps1`. |
| `TGDL_DEBUG`                    | unset               | Set to any truthy value to surface gramJS reconnect noise on stderr. |
| `TGDL_DATA_DIR`                 | `<repo>/data`       | Override the on-disk data root (`config.json`, `db.sqlite`, `downloads/`, sessions). Used by the test suite to point at an isolated tmpdir; also useful for Docker / multi-instance deploys that want the data on a different mount without symlinks. |
| `TRUST_PROXY`                   | unset               | `1`, `loopback`, or any value Express's `trust proxy` understands; needed for accurate IPs behind a reverse proxy. |
| `FFMPEG_PATH`                   | auto-detect         | Override the resolved ffmpeg binary used by `core/thumbs.js`. Resolver order: this var → `/usr/bin/ffmpeg` → `/usr/local/bin/ffmpeg` → `@ffmpeg-installer/ffmpeg` → bare `ffmpeg`. |
| `THUMBS_IMG_CONCURRENCY`        | `8`                 | Parallel image-thumb jobs. |
| `THUMBS_VID_CONCURRENCY`        | `3`                 | Parallel video-thumb jobs (ffmpeg pins a CPU core). |
| `WATCHTOWER_HTTP_API_TOKEN`     | unset               | Bearer token shared between the dashboard and the optional watchtower sidecar. Setting this + booting with the `auto-update` compose profile lights up the **Install update** button. |
| `WATCHTOWER_URL`                | `http://watchtower:8080` | Internal address of the watchtower sidecar. |
| `BACKUP_WORKERS_PER_DEST`       | `3`                 | Per-destination concurrent uploads for the backup subsystem. Keep modest — backups share the host's outbound bandwidth with everything else (including the realtime monitor). |

## One-click in-dashboard auto-update (opt-in)

The bundled `docker-compose.yml` ships a `watchtower` service under the `auto-update` profile. The dashboard never touches `/var/run/docker.sock` itself — it sends an authenticated HTTP request to the sidecar, which has a read-only socket mount and is scoped to the labeled container.

```bash
# 1. Generate a strong random token
openssl rand -hex 32 > .token
# 2. Put it in .env next to docker-compose.yml
echo "WATCHTOWER_HTTP_API_TOKEN=$(cat .token)" >> .env
rm .token
# 3. Boot with the profile enabled
docker compose --profile auto-update up -d
```

Once enabled, **Settings → Maintenance → Install update** pulls the latest image and recreates the container. The `data/` volume + `config.json` + sessions survive the swap; the SQLite database is snapshotted to `data/backups/` first.

Without the token (or without the profile), the **Install update** button stays disabled and the dashboard falls back to linking the GitHub release page.

## Reverse proxy

### Caddy (TLS automatic)

```caddyfile
tg.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote}
    }
}
```

### nginx

```nginx
server {
    server_name tg.example.com;
    listen 443 ssl http2;
    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # WebSocket upgrade
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

Behind a proxy, set `TRUST_PROXY=1` in the container env so the rate-limiter sees the real client IP.

### Force HTTPS (TLS lockdown)

Once the reverse proxy has a working TLS cert, lock the dashboard to HTTPS in **Settings → Privacy & Net → Dashboard security → Force HTTPS**. Effects:

- Every HTTP request 308-redirects to HTTPS (`localhost` excepted so the operator can always reach the dashboard from the host even if the proxy melts).
- A `Strict-Transport-Security: max-age=31536000; includeSubDomains` header attaches to every secure response — browsers cache the HTTPS-only verdict for a year.
- Non-GET / non-HEAD HTTP requests get a `403 HTTPS required` response instead of a redirect, so a misconfigured client can't silently retry a write on plain HTTP.

Pre-flight check before flipping the toggle:

1. **Cert reachable** — `curl -I https://tg.example.com/` returns 200 (or whatever HTTP code, just not a TLS error).
2. **`TRUST_PROXY=1`** is set in the dashboard container env so `req.secure` honours `X-Forwarded-Proto`. Without this, the dashboard sees every request as plain HTTP and 308-loops.
3. **Localhost recovery path** — keep SSH / docker exec access; you can flip the toggle back from the host even if the cert breaks (the localhost exemption keeps `127.0.0.1:3000` reachable from inside the container).

The setting persists in `data/config.json → web.forceHttps`. To roll back without the dashboard, edit the file and restart the container.

For HSTS preload (chrome global list), submit your domain at <https://hstspreload.org> after the header has been live for at least a few weeks. The dashboard does **not** add `preload` to the HSTS header automatically — preload is a one-way commitment that needs operator opt-in.

## systemd unit (bare-metal Node)

```ini
# /etc/systemd/system/telegram-downloader.service
[Unit]
Description=Telegram Media Downloader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tgdl
WorkingDirectory=/opt/telegram-media-downloader
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node src/web/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/telegram-media-downloader/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-downloader
journalctl -u telegram-downloader -f
```

## Backups

Back up `data/secret.key` and `data/sessions/*.enc` together — losing `secret.key` means none of the sessions decrypt and every account has to re-login. `data/db.sqlite` and the downloads tree are easy to recreate from Telegram if needed.

Pre-update DB snapshots land at `data/backups/db-pre-update-<utc-stamp>.sqlite` automatically when an in-dashboard update runs (last 5 kept). They're plain `.sqlite` files — to roll back, stop the container, swap one of them in for `data/db.sqlite`, and restart.

Rotate `config.web.shareSecret` to invalidate every outstanding share link in one move (edit the value or delete it; a fresh 32-byte secret regenerates on next boot).

## Watchdogs

For long-running headless monitor:

- **Linux/macOS:** `TGDL_RUN=monitor ./runner.sh`
- **Windows:** `pwsh ./watchdog.ps1` (defaults to `monitor`)
- **Docker:** the included compose file restarts the container on crash; the in-process runtime keeps the engine alive within it.
