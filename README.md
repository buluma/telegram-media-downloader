# Telegram Media Downloader

[![CI](https://github.com/botnick/telegram-media-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/botnick/telegram-media-downloader/actions/workflows/ci.yml)
[![CodeQL](https://github.com/botnick/telegram-media-downloader/actions/workflows/codeql.yml/badge.svg)](https://github.com/botnick/telegram-media-downloader/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/botnick/telegram-media-downloader/pkgs/container/telegram-media-downloader)

**Self-hosted Telegram media downloader. CLI + web dashboard. MIT.**

Bulk-download from channels and groups, paste a `t.me/` link to grab a single message, capture self-destructing media before it expires, archive Stories from any user, and forward downloads to another chat — all from a browser, with a CLI for headless servers.

Built with [GramJS](https://github.com/gram-js/gramjs) (Telegram User API), Express + WebSocket, SQLite, and a vanilla-ES-module SPA (no bundler, no build step).

> [Quick start](#quick-start) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Deploy](docs/DEPLOY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Audit](docs/AUDIT.md)

---

## Features

**Engine**
- Real-time monitor across many channels / groups / supergroups / forum topics
- Bulk history backfill with date / count filters
- Multi-account routing — engine auto-discovers which account can read each chat
- Smart dual-lane queue: realtime jobs never starve behind backfill
- Self-destructing (TTL) media is fast-pathed to the front of the queue
- Auto-forward downloads to any chat (or Saved Messages)
- Persistent dedup, atomic downloads, FloodWait-aware retries

**Web dashboard** (`:3000`)
- Add Telegram accounts in-browser (phone → OTP → 2FA)
- Set / change dashboard password from the browser; **fail-closed by default**
- Light / dark / auto theme
- Paste a `t.me/` link to download just that message
- Download Stories from any username
- Live engine status, queue, multi-select gallery, search, bulk delete
- Browser notifications, sticky status bar
- WebSocket-driven realtime updates with auto-reconnect

**Operations**
- Encrypted account sessions (AES-256-GCM, per-blob random scrypt salt)
- Optional SOCKS4/5 + MTProxy
- DM downloads opt-in (off by default)
- Helmet, CSRF-resistant cookies, login rate-limit, NUL-byte/symlink-safe path serving
- Docker image with non-root user + healthcheck

---

## Requirements

- **Node.js 20+** (or Docker)
- A Telegram **API ID** + **API hash** from <https://my.telegram.org> (free)
- Roughly the disk space your media will take

---

## Quick start

### Docker

```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
docker compose up -d
```

Open `http://localhost:3000`:

1. Set the dashboard password (only allowed from localhost on first run).
2. **Settings → Telegram API** — paste your `apiId` + `apiHash`.
3. **Settings → Telegram Accounts → Add account** — phone, OTP, optional 2FA.
4. **Settings → Engine → Start monitor**, or just paste a `t.me/` link in the top bar.

### Node

```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
npm ci
npm run web        # dashboard
# OR
npm start          # interactive CLI menu
```

A long-running monitor under a watchdog (Linux/macOS):

```bash
TGDL_RUN=monitor ./runner.sh
```

Windows: `pwsh ./watchdog.ps1` (defaults to `monitor`).

---

## CLI cheatsheet

| Command | What it does |
| --- | --- |
| `npm start` | Interactive main menu — config, monitor, history, accounts, viewer, purge. |
| `npm run web` | Web dashboard on `:3000`. |
| `npm run monitor` | Headless real-time monitor for servers. |
| `npm run history` | Batch backfill an existing group with date / count filters. |
| `npm run dialogs` | List every chat your account can see + its Telegram ID. |
| `npm run auth` | Set / change the dashboard password. |
| `npm run prod` | Watchdog-managed long-running process (`runner.js`, env `TGDL_RUN`). |
| `node src/index.js purge` | Delete one group's data, or factory-reset. |

Set `TGDL_DEBUG=1` to surface gramJS reconnect chatter on stderr.

---

## Configuration

Everything lives in `data/config.json`. The dashboard's Settings page is the canonical editor — direct edits work too, but keep it valid JSON.

Highlights of the schema (the file self-heals to defaults on load):

```jsonc
{
    "telegram":   { "apiId": "...", "apiHash": "..." },
    "accounts":   [ /* populated by the wizard */ ],
    "groups":     [ /* {id, name, enabled, filters, autoForward, topics, monitorAccount?, forwardAccount?} */ ],
    "download":   { "concurrent": 5, "retries": 5, "maxSpeed": 0, "path": "./data/downloads" },
    "rateLimits": { "requestsPerMinute": 15, "delayMs": { "min": 100, "max": 300 } },
    "diskManagement": { "maxTotalSize": "50GB", "maxVideoSize": null, "maxImageSize": null },
    "proxy":      { "type": "socks5", "host": "...", "port": 1080 },
    "allowDmDownloads": false,
    "web":        { "enabled": true, "passwordHash": { "algo": "scrypt", "..." : "..." } }
}
```

Full per-field reference: see [`docs/DEPLOY.md`](docs/DEPLOY.md) and the audit-validated endpoints in [`docs/API.md`](docs/API.md).

---

## File layout

Downloads land under `data/downloads/<sanitised-group-name>/{images,videos,documents,audio,stickers}/`.

```
data/
├── config.json
├── db.sqlite              (WAL mode)
├── secret.key             (back this up)
├── web-sessions.json
├── sessions/<id>.enc      (per-account, AES-256-GCM)
├── photos/<id>.jpg
├── downloads/...
└── logs/network.log
```

`data/secret.key` decrypts every saved session. Lose it and every account has to re-login.

---

## Security & privacy

- The dashboard fails closed when no password is configured — no "open access" by default. First-run setup is local-only.
- Cookies are `httpOnly + sameSite=strict` (and `Secure` when `NODE_ENV=production`).
- Login is rate-limited (10 attempts / 15 min / IP).
- File serving uses `fs.realpath` so a symlink in `data/downloads/` cannot escape the root.
- WebSocket authenticates at the upgrade handshake — unauthenticated connections are dropped.
- Don't expose `:3000` directly. Put it behind a reverse proxy with TLS (Caddy / nginx examples in [`docs/DEPLOY.md`](docs/DEPLOY.md)).
- Vulnerability reports → [`SECURITY.md`](SECURITY.md).

---

## Contributing

```bash
npm ci
npm run lint
npm test
```

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch / commit / testing conventions.

---

## License

[MIT](LICENSE).

This software uses the Telegram MTProto User API via GramJS. It is not affiliated with, endorsed by, or sponsored by Telegram. Users are responsible for complying with the Telegram Terms of Service and any laws in their jurisdiction.
