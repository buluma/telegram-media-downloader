# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All scripts run from the repo root. Node >= 18 (ES Modules, native `fetch`).

| Purpose | Command |
|---|---|
| First-run setup / interactive main menu | `npm start` (= `node src/index.js`) |
| Headless real-time monitor (servers) | `npm run monitor` |
| Batch download history with filters | `npm run history` |
| List Telegram dialogs (groups/channels + IDs) | `npm run dialogs` |
| Web dashboard on `:3000` | `npm run web` |
| Watchdog-managed production process | `npm run prod` (= `node runner.js`, runs `history` with restart-backoff) |
| Toggle web auth password | `npm run auth` |
| Migrate legacy JSON download logs into SQLite | `npm run migrate` |
| Subcommands without npm scripts | `node src/index.js {config,settings,viewer,purge}` |

There is no test suite, linter, or build step — changes ship as-is. Verify by running the relevant subcommand or hitting the affected REST endpoint in the dashboard.

The CLI hard-requires a TTY (`process.stdin.isTTY`); piping input or running without an interactive terminal exits with an error. For Docker, use `docker-compose run telegram-downloader npm start` for the first-run login.

## Runtime data layout

Everything user-specific lives under `data/` and is gitignored. The app creates this directory on first run:

- `data/config.json` — the single source of truth for settings (telegram creds, groups, filters, download/rateLimits/diskManagement, web auth). Self-healing: `loadConfig()` deep-merges defaults into stored config and writes back if shape changed.
- `data/db.sqlite` — `downloads` (dedup by `UNIQUE(group_id, message_id)`) and `queue` tables. WAL mode.
- `data/sessions/*.enc` — per-account AES-256-GCM-encrypted `StringSession` blobs (multi-account).
- `data/session.enc` — legacy single-session file, auto-migrated on first multi-account load.
- `data/secret.key` — AES key generated on first launch. **Without this, sessions cannot be decrypted** — back it up if moving installations.
- `data/downloads/<sanitized-group-name>/{images,videos,documents,audio,stickers}/` — `sanitizeName()` from `core/downloader.js` is the canonical folder-name normalizer; on monitor start it migrates pre-sanitization folder names.
- `data/photos/` — cached profile photos served by the web UI.
- `data/logs/protection_log.txt` — written by `runner.js` / `watchdog.ps1` on crashes.

## Architecture

This is a Telegram **user-API** (MTProto via GramJS) downloader, not a bot. Two top-level entry points share state through `data/`:

1. **CLI process** (`src/index.js`) — interactive menus, monitor, history, config tools.
2. **Web server** (`src/web/server.js`) — Express + WebSocket on `:3000`, serves SPA from `src/web/public/`, exposes REST API and live download events.

Both load the same `data/config.json` and `data/db.sqlite`. **Only one process should write the SQLite DB at a time** — `database locked` errors mean two instances are running.

### Multi-account routing (the non-obvious core)

`AccountManager` (`src/core/accounts.js`) maintains a `Map<accountId, TelegramClient>`. Each session file in `data/sessions/` becomes one connected client. On monitor start, `RealtimeMonitor.discoverClientForGroup()` (`src/core/monitor.js`) probes every client against each enabled group with `getMessages(groupId, {limit:1})` and caches the first one that succeeds in `groupClientCache`. A group can also pin an explicit account via `group.monitorAccount` in config — that wins over auto-discovery. The fallback is the default client.

When editing monitor/forwarder code, never assume `this.client` is the right client for a given group — always go through `getClientForGroup(group)`.

### Monitor pipeline

`RealtimeMonitor` runs a **hybrid** strategy: a `NewMessage` event handler for push notifications **and** a polling loop (`startPollingLoop`) using `lastIds` per group. Polling is the fallback when GramJS update streams stall. The monitor watches `data/config.json` directly (`fs.watch` with debounce) so toggles from the Web UI take effect without restart — see `reloadConfig()`.

`Downloader` (`src/core/downloader.js`) handles concurrency, retries, FloodWait, disk-cap checks, and writes to both disk and the `downloads` SQLite table. Dedup is enforced at insertion via `INSERT OR IGNORE` on `(group_id, message_id)` — checking `dbIsDownloaded()` before doing the network work is the optimization.

`Forwarder` (`src/core/forwarder.js`) consumes completed downloads and forwards to the configured destination (`"me"`, channel ID, or null for a default storage channel).

### Resilience and noise suppression

GramJS emits a lot of recoverable internal errors (`TIMEOUT`, `Not connected`, `Connection closed`, `CHANNEL_INVALID`, reconnect chatter). `src/index.js` installs a **global `console.error` filter** at startup and a custom logger factory in `accounts.js` (`createLogger`) does the same per-client. **When debugging "missing" error output, check those filters** — they may be swallowing a message you care about. The `unhandledRejection` handler in `src/index.js` also drops these by message.

`Resilience` (`src/core/resilience.js`) is the global trap installed via `resilience.init()`. It classifies errors into `FLOOD_WAIT` / network / `AUTH_KEY_UNREGISTERED` and returns `{ action, ... }` directives — callers must honor those rather than rethrow blindly.

### Web server specifics

`src/web/server.js` is large (~34KB) and self-contained. Auth lives in `src/core/web-auth.js`:

- Passwords are stored as `web.passwordHash` (`{algo:'scrypt', salt, hash, N, r, p, keylen}`); legacy plaintext `web.password` is auto-rehashed on first successful login.
- The cookie `tg_dl_session` carries a random 64-char hex token; the underlying mapping lives in `data/web-sessions.json`. Cookie flags: `httpOnly`, `sameSite: 'strict'`, `secure` only when `NODE_ENV === 'production'`.
- The auth middleware **fails closed**: if no password is configured, every API call returns 503 and every page redirects to `/setup-needed.html`. There is no "open access if no password" path anymore.
- `/api/login` is rate-limited (10/15min/IP) and uses `crypto.timingSafeEqual` via `web-auth.loginVerify`.
- The WebSocket upgrade handshake validates the same cookie before `wss.handleUpgrade` is called — unauth'd connections get a 401 and the socket is destroyed.

WebSocket clients are tracked in a `Set` and broadcast download events (`download_progress`, `download_complete`, `file_deleted`, `group_purged`, `purge_all`).

API responses strip secrets aggressively. `GET /api/config` removes `telegram.apiHash`, `telegram.apiId`, `web.password`, `web.passwordHash`, and per-group `monitorAccount` / `forwardAccount` (those are surfaced as boolean `hasMonitorAccount` / `hasForwardAccount` instead).

### Path safety

Both `DELETE /api/file?path=…` and `GET /files/<path>` route through `safeResolveDownload(userPath)` in `src/web/server.js`. It rejects NUL bytes and absolute paths, normalizes, then `fs.realpath`s — so a symlink inside `data/downloads/` cannot escape the root. `/files/*` also sets `Content-Disposition: attachment` by default; the SPA passes `?inline=1` for thumbnails and the viewer to opt back into inline rendering.

### Logger noise

gramJS surfaces a steady stream of recoverable internal errors during reconnects (`TIMEOUT`, `Not connected`, `Connection closed`, `CHANNEL_INVALID`, `Reconnect`). The previous codebase silently dropped these via a global `console.error` override that also swallowed real errors with the same words. The current code uses `src/core/logger.js`'s `suppressNoise()` / `wrapConsoleMethod()` which **always logs to `data/logs/network.log`** and only echoes to stderr in `DEBUG` / `TGDL_DEBUG` / `CLAUDE_DEBUG` modes. When debugging "missing" error output, set `TGDL_DEBUG=1` and re-run.

## Conventions

- ES Modules throughout (`"type": "module"`). Use `fileURLToPath(import.meta.url)` to resolve `__dirname`.
- File naming: `{ISO-timestamp-with-colons-replaced}_{messageId}.{ext}`.
- Folder names are always run through `sanitizeName()` before disk I/O — bypassing it creates duplicate folders that the migration scan then has to merge.
- `loadConfig()` is the only correct way to read config — it backfills missing keys. Don't `JSON.parse(readFileSync(...))` directly except for one-off scripts.
- Group IDs are stored and compared as strings (`String(g.id)`) because Telegram IDs exceed `Number.MAX_SAFE_INTEGER` precision in some flows.
