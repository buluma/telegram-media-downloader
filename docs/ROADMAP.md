# Engineering Roadmap

Eight improvements prioritised for implementation. Each is independent enough to ship
as its own PR but they build on each other — the recommended order is top to bottom.

---

## 1. Normalize the group config

**Problem:** Groups are stored as a JSON blob inside a single KV row (`config` key).
Every bulk update is a read-modify-write cycle with no row-level locking. There is no
schema validation, no FK enforcement, and adding a new per-group field requires touching
the blob parser, three default-value sites, and a migration script.

**Target schema:**

```sql
CREATE TABLE groups (
    id          TEXT PRIMARY KEY,          -- Telegram chat id (string to handle -100x)
    name        TEXT NOT NULL,
    type        TEXT,                      -- channel | group | dm
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE group_filters (
    group_id    TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    photos      INTEGER NOT NULL DEFAULT 1,
    videos      INTEGER NOT NULL DEFAULT 1,
    files       INTEGER NOT NULL DEFAULT 1,
    links       INTEGER NOT NULL DEFAULT 1,
    voice       INTEGER NOT NULL DEFAULT 1,
    audio       INTEGER NOT NULL DEFAULT 0,
    gifs        INTEGER NOT NULL DEFAULT 0,
    stickers    INTEGER NOT NULL DEFAULT 0,
    urls        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE group_forward (
    group_id            TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    enabled             INTEGER NOT NULL DEFAULT 0,
    destination         TEXT,
    account_id          TEXT,
    delete_after        INTEGER NOT NULL DEFAULT 1,
    keep_images         INTEGER NOT NULL DEFAULT 1,
    keep_videos         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE group_settings (
    group_id            TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    track_comments      INTEGER NOT NULL DEFAULT 1,
    rescue_mode         TEXT NOT NULL DEFAULT 'auto',  -- auto | on | off
    max_disk_mb         INTEGER,                       -- per-group ceiling, NULL = global
    topics_enabled      INTEGER NOT NULL DEFAULT 0,
    topic_ids           TEXT NOT NULL DEFAULT '[]'     -- JSON array
);
```

**Migration path:**
1. Add new tables (try/catch safe).
2. One-shot migration reads `kv.config.groups` JSON, inserts rows into new tables.
3. `loadConfig()` / `saveConfig()` switch to reading/writing the new tables.
4. KV blob kept for 1 release as read-only fallback, then dropped.

**Files:** `src/core/db.js`, `src/config/manager.js`, `src/web/routes/groups.js`,
`src/web/routes/dialogs.js`, `scripts/update-config.js`

---

## 2. Single source of group defaults

**Problem:** Default filter values and `autoForward` shapes are duplicated in at least
three places: `src/config/manager.js` (`DEFAULT_FILTERS`), `src/web/routes/dialogs.js`,
and `src/web/routes/groups.js`. They have diverged before (voice off in one, on in
another) and will again.

**Fix:** One canonical `GROUP_DEFAULTS` object exported from `src/config/manager.js`.
Every code path that creates or merges a group imports from that single location.

```js
// src/config/manager.js
export const GROUP_DEFAULTS = Object.freeze({
    filters: {
        photos: true, videos: true, files: true, links: true,
        voice: true, audio: false, gifs: false, stickers: false, urls: true,
    },
    trackComments: true,
    autoForward: {
        enabled: false, destination: null,
        deleteAfterForward: true, keepImages: true, keepVideos: true,
    },
    rescueMode: 'auto',
});
```

`dialogs.js` and `groups.js` import `GROUP_DEFAULTS` instead of hard-coding values.
`mergeConfig()` uses the same object for runtime merging.

**This is a prerequisite for item 1** — the table column defaults should match
`GROUP_DEFAULTS` so SQLite and the application agree.

**Files:** `src/config/manager.js`, `src/web/routes/dialogs.js`,
`src/web/routes/groups.js`

---

## 3. Fix the backup / delete-after-forward race

**Problem:** Both the GDrive mirror worker and the auto-forwarder listen on
`download_complete`. The forwarder runs synchronously and calls `deferDelete()`
before the async backup worker has had a chance to upload the file. Result:
`failed — file missing on disk` in the backup job log.

**Fix options (in order of correctness):**

**Option A — Backup enqueues synchronously before forward runs (recommended):**

In `_onDownloadComplete` (backup manager), write the queue row inside the same
synchronous tick as the event, before returning. The forwarder is registered later
on the same emitter so it fires after. The worker uploads asynchronously but the
DB row already exists, guaranteeing the file is present when the worker picks it up
as long as `deferDelete` uses a grace period.

**Option B — Forwarder checks for pending backup jobs:**

Before calling `deferDelete`, query `backup_queue WHERE status IN ('pending','uploading')
AND download_id = ?`. If any row exists, skip the delete and let the backup worker
clean up via a post-upload hook. More coupling but correct.

**Option C — Grace-period defer delete (pragmatic short-term fix):**

Increase `deferDelete` delay from ~0ms to 60s. Gives the backup worker time to
upload before the file disappears. Fragile under slow connections but zero
architectural change.

**Recommended:** Ship Option C immediately, then Option A in the same PR as item 1
(when the backup queue is already being refactored).

**Files:** `src/core/forwarder.js`, `src/core/backup/manager.js`,
`src/core/delete-queue.js`

---

## 4. Cloud-first storage model

**Problem:** Local disk is primary storage; cloud (GDrive) is a backup mirror. For a
media archive this is inverted — local disk fills up, GDrive has everything, manual
cleanup is required constantly.

**Target model:**
- New files: stream-upload to cloud immediately on `download_complete`
- Local disk: hot cache, bounded by the disk ceiling (currently 100 GB)
- Eviction: LRU — least-recently-accessed files evicted first when ceiling is
  approached, as long as the remote copy is confirmed uploaded
- Access: on gallery open, check local cache; if miss, stream from cloud on-demand

**Required pieces:**
1. `backup_queue` gains a `confirmed_at` column — set when provider ACKs upload.
2. Disk rotator checks `confirmed_at` before evicting — never delete a file whose
   cloud copy is unconfirmed.
3. New `GET /api/files/:id/stream` route: serve from local if present, else proxy
   from cloud provider.
4. `downloads` table gains `cache_evicted_at` column so the gallery can show a
   "cloud only" badge and stream on demand.

**This is the largest item.** Implement incrementally:
- Phase 1: `confirmed_at` + eviction guard (safe, no UX change)
- Phase 2: on-demand stream proxy
- Phase 3: "cloud only" gallery badges

**Files:** `src/core/backup/manager.js`, `src/core/backup/queue.js`,
`src/core/disk-rotator.js`, `src/web/routes/files.js`, `src/core/db.js`

---

## 5. Deploy from source (development mode)

**Problem:** Heimdal runs `ghcr.io/buluma/telegram-media-downloader:latest` — a
prebuilt image from GHCR. Every bug fix requires a full GitHub Actions release cycle
(tag, build, push, pull, restart) before it runs on the server. Today that took
multiple hours to unblock a face-scan timeout.

**Fix:** Add a `docker-compose.override.yml` to Heimdal that mounts source and runs
with nodemon/hot-reload instead of the baked image.

```yaml
# docker-compose.override.yml  (Heimdal only, not committed to main)
services:
  telegram-downloader:
    image: ""
    build: .
    volumes:
      - .:/app
      - /app/node_modules   # keep container node_modules isolated
    command: node --watch src/web/server.js
```

With this in place: `git pull && docker compose up --build -d` deploys any commit
instantly. The `docker-compose.override.yml` is gitignored so production installs
continue using the prebuilt image.

Add `.gitignore` entry: `docker-compose.override.yml`

**Files:** `.gitignore`, `Heimdal:/home/heimdal/.../docker-compose.override.yml`

---

## 7. TypeScript (or strict JSDoc)

**Problem:** The codebase has hundreds of `?.` null-guard chains because function
return shapes are implicit. New contributors (and future-self) can't tell what
`downloadInfo` contains, what `group` looks like, or whether `autoForward` is
`undefined` or `{ enabled: false }` without tracing the call stack.

**Pragmatic path — JSDoc types first, TypeScript later:**

Phase 1 (low friction): Add `@typedef` blocks to the 10 most-referenced shapes:
- `GroupConfig`, `GroupFilters`, `AutoForwardSettings`
- `DownloadInfo`, `DownloadRow`
- `BackupDestination`, `BackupJob`
- `ScanResult`, `MaintenanceJob`
- `AppConfig`

Phase 2: Enable `checkJs` in `jsconfig.json` — VS Code and the TypeScript language
server will flag shape mismatches without any build step.

Phase 3 (optional, post item 1): Migrate to `.ts` incrementally, starting with the
DB layer and config manager where the type pain is worst.

**No new build tooling required for phases 1–2.**

**Files:** `jsconfig.json` (new), `src/config/manager.js`, `src/core/db/downloads.js`,
`src/core/forwarder.js`, `src/core/backup/manager.js`

---

## 8. Proper migration runner

**Problem:** Schema changes use `try { db.exec('ALTER TABLE ...') } catch {}` blocks
scattered through `db.js`. There is no record of which migrations have run, no
ordering guarantee, and no way to test migrations in isolation. A failed migration
is silently swallowed.

**Fix:** Standard numbered migration table + runner.

```sql
CREATE TABLE IF NOT EXISTS _migrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    applied_at  INTEGER NOT NULL
);
```

```js
// src/core/db/migrations/index.js
const MIGRATIONS = [
    { name: '001_add_deleted_at',        up: db => db.exec('ALTER TABLE downloads ADD COLUMN deleted_at INTEGER') },
    { name: '002_add_delete_reason',     up: db => db.exec('ALTER TABLE downloads ADD COLUMN delete_reason TEXT') },
    { name: '003_groups_table',          up: db => { /* item 1 migration */ } },
    // ...
];

export function runMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
    )`);
    const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
    for (const m of MIGRATIONS) {
        if (applied.has(m.name)) continue;
        db.transaction(() => {
            m.up(db);
            db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
        })();
        console.log(`[db] migration applied: ${m.name}`);
    }
}
```

`runMigrations(db)` called once at startup in `initDb()`. Each migration runs in a
transaction — fails loudly instead of silently. Existing `try/catch` ALTER blocks
become the first numbered migrations and are removed from `db.js`.

**Files:** `src/core/db.js`, `src/core/db/migrations/` (new directory)

---

## 9. Universal stale job recovery

**Problem:** Stale lock recovery exists only for WD14 (`recoverStaleLocks()` called
at WD14 scan start). Faces and OCR scans that crash mid-batch leave `processing`
rows in `media_scan_state` and `running` rows in `maintenance_jobs` forever. These
phantom rows block retries and pollute the jobs history UI.

**Fix:** Generic `recoverStaleJobs()` called at server startup for all scanners.

```js
// src/core/ai/jobs.js
export function recoverStaleJobs(db, { staleAfterMs = 30 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - staleAfterMs;

    // Reset stale maintenance_jobs rows
    const jobs = db.prepare(`
        UPDATE maintenance_jobs
        SET status = 'failed', error = 'recovered: stale at startup',
            finished_at = ?
        WHERE status = 'running' AND started_at < ?
    `).run(Date.now(), cutoff);

    // Reset stale media_scan_state locks
    const locks = db.prepare(`
        UPDATE media_scan_state
        SET status = 'failed', last_error = 'recovered: stale lock at startup',
            updated_at = ?
        WHERE status = 'processing' AND updated_at < ?
    `).run(Date.now(), cutoff);

    if (jobs.changes > 0 || locks.changes > 0) {
        console.log(`[recovery] reset ${jobs.changes} stale jobs, ${locks.changes} stale scan locks`);
    }
}
```

Called once from `src/web/server.js` after `initDb()`.

Also add a `GET /api/ai/scan/stale` endpoint that surfaces currently-stale rows so
operators can see them without waiting for the next restart.

**Files:** `src/core/ai/jobs.js`, `src/web/server.js`, `src/web/routes/ai.js`

---

## Implementation order

| # | Item | Depends on | Estimated scope |
|---|---|---|---|
| 8 | Migration runner | — | Small |
| 2 | Single source of defaults | — | Small |
| 9 | Universal stale job recovery | — | Small |
| 3 | Backup/delete race fix (Option C) | — | Tiny |
| 7 | JSDoc types | 2 | Medium |
| 1 | Normalize group config | 2, 8 | Large |
| 5 | Deploy from source | — | Small (ops only) |
| 4 | Cloud-first storage | 1, 3 | Large |

Ship 8 → 2 → 9 → 3 first (all small, independent). Then 7 and 1 together.
Item 4 is the biggest architectural lift — tackle last once the foundation is solid.
