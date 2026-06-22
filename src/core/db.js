import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runStateMigration } from './state-migration.js';
import { runMigrations } from './db/migrations/index.js';
import {
    kvGet,
    kvSet,
    insertSession,
    listSessions,
    pushQueueBacklog,
    _rotateBootInstanceId,
    finalisePendingUpdates,
    getBootInstanceId,
} from './db/kv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `TGDL_DATA_DIR` overrides the on-disk data root. Used by the test suite to
// point at an isolated tmpdir so vitest never touches the user's real
// db.sqlite. Docker / multi-instance deploys can also override the location
// without symlinks. Default stays the in-repo `data/` so first-run UX is
// unchanged.
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

// Singleton connection
let db;
// Run the JSON→SQLite state migration exactly once per process. Cheap to
// re-check (idempotent), but we'd still rather skip the fs.existsSync calls
// on every getDb() once we've done it.
let _stateMigrationRan = false;

export function getDataDir() {
    return DATA_DIR;
}

export function getDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    try {
        db = new Database(DB_PATH);
    } catch (e) {
        if (/NODE_MODULE_VERSION/.test(e?.message)) {
            const match = e.message.match(
                /compiled against.*NODE_MODULE_VERSION (\d+).*requires.*NODE_MODULE_VERSION (\d+)/,
            );
            const hint = match
                ? `\n  Module was built for ABI ${match[1]}, but this Node uses ABI ${match[2]}.`
                : '';
            console.error(
                `\n[db] Native module ABI mismatch — better-sqlite3 was compiled for a different Node version.${hint}` +
                    '\n  Fix: run "npm rebuild better-sqlite3" (make sure you\'re on the correct Node version).\n',
            );
        }
        throw e;
    }
    try {
        sqliteVec.load(db);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[db] sqlite-vec failed to load, AI features will be unavailable:', e.message);
    }

    // Performance tuning
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // Without busy_timeout, a long write (sweeper bulk delete) makes
    // concurrent readers fail INSTANTLY with SQLITE_BUSY instead of
    // waiting. 5 s gives us plenty of headroom for the longest write
    // we currently issue (rescue sweeper batches 5000 rows).
    db.pragma('busy_timeout = 5000');
    // Tame WAL growth on sustained writes — checkpoint every ~1000 pages.
    db.pragma('wal_autocheckpoint = 1000');
    // Per-connection FK enforcement — required for ON DELETE CASCADE on
    // share_links (and any future FK we add). Set BEFORE initSchema so the
    // first row insert / migration honors it.
    db.pragma('foreign_keys = ON');
    // 64 MB page cache (negative = KiB) — cuts I/O on hot gallery + AI queries.
    db.pragma('cache_size = -65536');
    // Temp tables/indexes in RAM — avoids write amplification from temp B-trees
    // during complex ORDER BY / GROUP BY scans.
    db.pragma('temp_store = MEMORY');

    initSchema();

    // Import any legacy JSON state files (config.json / disk_usage.json /
    // web-sessions.json) into the kv + web_sessions tables. Runs once per
    // process, synchronously before we hand the connection back, so the
    // very first kvGet() call sees the migrated rows.
    if (!_stateMigrationRan) {
        _stateMigrationRan = true;
        try {
            runStateMigration({
                db,
                kvGet,
                kvSet,
                insertSession,
                listSessions,
                pushQueueBacklog,
            });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[state-migration] failed:', e.message);
        }

        // Boot instance ID rotation. A per-process UUIDv4 stamped into
        // kv['boot_instance_id'] on every getDb() bootstrap and snapshotted
        // into update_history rows at click time. Lets the finaliser detect
        // a successful watchtower swap even when the new image carries the
        // same semver as the old one (rebuilt `:latest`, hash-pinned tag) —
        // the instance_id is guaranteed to differ across container recreates.
        try {
            _rotateBootInstanceId();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[boot-instance-id] rotation failed:', e?.message || e);
        }

        // Auto-update audit finalisation. Walks every `triggered` row and
        // either promotes it to `success` (the running container reports a
        // different version OR a different boot_instance_id than the row's
        // from_* fields → swap landed) or marks it `stalled` (still on the
        // same version + same instance_id, row older than the stall window
        // → watchtower acked but never recreated us). Idempotent; runs
        // once per process boot AND lazily on every status/history GET.
        try {
            const cur = _readPackageVersion();
            const inst = getBootInstanceId();
            const r = finalisePendingUpdates(cur, inst);
            if (r.promoted > 0 || r.stalled > 0) {
                // eslint-disable-next-line no-console
                console.log(
                    `[update-history] finalised ${r.promoted} → success, ${r.stalled} → stalled`,
                );
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[update-history] finalisation failed:', e?.message || e);
        }
    }

    return db;
}

// Resolve the running package version without pulling server.js (would be
// a circular import). Mirrors `_readCurrentVersion` in server.js.
function _readPackageVersion() {
    if (process.env.npm_package_version) return process.env.npm_package_version;
    try {
        const pkgPath = path.join(__dirname, '..', '..', 'package.json');
        return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
    } catch {
        return null;
    }
}

function initSchema() {
    // Downloads Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            group_name TEXT,
            message_id INTEGER NOT NULL,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT, -- photo, video, document
            file_path TEXT,
            status TEXT DEFAULT 'completed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_id ON downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_created_at ON downloads(created_at);
    `);

    // v2.15 — AI subsystem re-add (semantic search + auto-tags + face
    // clustering). Tables are opt-in; rows only land here once the operator
    // turns a capability on in `config.advanced.ai` and runs a scan. Every
    // statement is idempotent so a fresh boot, a v2.13/2.14 → v2.15 upgrade,
    // and an already-migrated DB all converge on the same shape.
    db.exec(`
        CREATE TABLE IF NOT EXISTS image_embeddings (
            download_id INTEGER PRIMARY KEY,
            embedding   BLOB    NOT NULL,
            model       TEXT    NOT NULL,
            indexed_at  INTEGER NOT NULL,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS image_tags (
            download_id INTEGER NOT NULL,
            tag         TEXT    NOT NULL,
            score       REAL    NOT NULL,
            PRIMARY KEY (download_id, tag),
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tags_tag_score ON image_tags(tag, score DESC);
        CREATE TABLE IF NOT EXISTS image_text (
            download_id INTEGER NOT NULL,
            text        TEXT    NOT NULL,
            language    TEXT,
            confidence  REAL,
            scanned_at  INTEGER NOT NULL,
            PRIMARY KEY (download_id),
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS people (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            label              TEXT,
            embedding_centroid BLOB    NOT NULL,
            face_count         INTEGER NOT NULL DEFAULT 0,
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS faces (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id INTEGER NOT NULL,
            x           REAL    NOT NULL,
            y           REAL    NOT NULL,
            w           REAL    NOT NULL,
            h           REAL    NOT NULL,
            embedding   BLOB    NOT NULL,
            person_id   INTEGER,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id)   REFERENCES people(id)    ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_faces_download ON faces(download_id);
        CREATE INDEX IF NOT EXISTS idx_faces_person   ON faces(person_id);
        CREATE TABLE IF NOT EXISTS text_embeddings (
            download_id INTEGER PRIMARY KEY,
            embedding   BLOB    NOT NULL,
            model       TEXT    NOT NULL,
            indexed_at  INTEGER NOT NULL,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS image_tags_wd14 (
            download_id INTEGER NOT NULL,
            tag         TEXT    NOT NULL,
            score       REAL    NOT NULL,
            PRIMARY KEY (download_id, tag),
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_wd14_tags_tag ON image_tags_wd14(tag);
    `);
    // v2.16 Phase 4 — peer_face_centroids. Stores the
    // average-of-cluster face vectors that paired peers push to us.
    // The label sync flow uses this to match an incoming "Bob" centroid
    // against local clusters within `eps` and propagate the label.
    // Opt-in via `config.advanced.ai.federateFaces`; table is created
    // unconditionally so a future toggle-on doesn't need a migration.
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_face_centroids (
            peer_id          TEXT    NOT NULL,
            remote_person_id INTEGER NOT NULL,
            centroid         BLOB    NOT NULL,
            label            TEXT,
            face_count       INTEGER NOT NULL DEFAULT 0,
            updated_at       INTEGER NOT NULL,
            PRIMARY KEY (peer_id, remote_person_id)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_face_centroids_label
            ON peer_face_centroids(label) WHERE label IS NOT NULL;
    `);

    // Seekbar sprite cache (v2.17). One row per indexed video; sprite +
    // JSON metadata live on disk under data/seekbar/. Opt-in via
    // config.advanced.seekbar.enabled; rows only appear once the
    // operator turns the feature on and either downloads a new video
    // (auto-pregenerate hook) or runs "Scan now" from the maintenance
    // page. ON DELETE CASCADE so purging a download row removes its
    // sprite metadata in lockstep.
    db.exec(`
        CREATE TABLE IF NOT EXISTS seekbar_sprites (
            download_id   INTEGER PRIMARY KEY,
            sprite_path   TEXT NOT NULL,
            meta_path     TEXT NOT NULL,
            duration_sec  REAL,
            frames        INTEGER,
            cols          INTEGER,
            rows          INTEGER,
            tile_w        INTEGER,
            tile_h        INTEGER,
            interval_sec  REAL,
            format        TEXT,
            bytes         INTEGER,
            source_size   INTEGER,
            source_mtime  INTEGER,
            generated_at  INTEGER NOT NULL,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_seekbar_generated_at ON seekbar_sprites(generated_at);
    `);

    // v2.18 — Smart Albums (rule-based saved collections).
    //
    // v1 supports one rule type: `tags_contains` with payload:
    //   { type:'tags_contains', tag:'cat', minScore:0.0..1.0 }.
    // `smart_album_items` is materialized so gallery reads are fast.
    db.exec(`
        CREATE TABLE IF NOT EXISTS smart_albums (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            rule_json  TEXT    NOT NULL,
            enabled    INTEGER NOT NULL DEFAULT 1,
            sort_key   TEXT    NOT NULL DEFAULT 'created_at_desc',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_smart_albums_updated ON smart_albums(updated_at DESC);
        CREATE TABLE IF NOT EXISTS smart_album_items (
            album_id    INTEGER NOT NULL,
            download_id INTEGER NOT NULL,
            matched_at  INTEGER NOT NULL,
            PRIMARY KEY (album_id, download_id),
            FOREIGN KEY (album_id) REFERENCES smart_albums(id) ON DELETE CASCADE,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_smart_album_items_album ON smart_album_items(album_id, matched_at DESC);
        CREATE INDEX IF NOT EXISTS idx_smart_album_items_download ON smart_album_items(download_id);
    `);

    // v2.19 — Durable job model. `maintenance_jobs` persists scan state
    // across restarts so a crash mid-scan doesn't lose progress tracking.
    // `media_scan_state` tracks per-download, per-scanner processing so we
    // can retry failures, detect stale locks, and avoid the `_scanned_` / `_wd14_scanned_`
    // sentinel tag approach.
    db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_jobs (
            id              TEXT    PRIMARY KEY,
            type            TEXT    NOT NULL,
            feature         TEXT,
            status          TEXT    NOT NULL DEFAULT 'pending',
            resources       TEXT,
            requested_by    TEXT,
            request_json    TEXT,
            total           INTEGER NOT NULL DEFAULT 0,
            processed       INTEGER NOT NULL DEFAULT 0,
            skipped         INTEGER NOT NULL DEFAULT 0,
            failed          INTEGER NOT NULL DEFAULT 0,
            error           TEXT,
            started_at      INTEGER NOT NULL,
            finished_at     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_status ON maintenance_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_feature ON maintenance_jobs(feature, started_at DESC);

        CREATE TABLE IF NOT EXISTS media_scan_state (
            download_id     INTEGER NOT NULL,
            scanner         TEXT    NOT NULL,
            status          TEXT    NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            locked_by       TEXT,
            locked_at       INTEGER,
            last_error      TEXT,
            last_error_code TEXT,
            updated_at      INTEGER NOT NULL,
            completed_at    INTEGER,
            PRIMARY KEY (download_id, scanner),
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scan_state_scanner ON media_scan_state(scanner, status);
        CREATE INDEX IF NOT EXISTS idx_scan_state_stale  ON media_scan_state(locked_at) WHERE locked_by IS NOT NULL;
    `);

    // Queue/Pending Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            meta TEXT, -- JSON payload
            priority INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending', -- pending, processing, failed
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Share Links — admin-issued tokens that let a non-user (e.g. friend
    // with the URL) stream/download a single download without logging in.
    // The HMAC-signed URL is the cryptographic gate; this table is what
    // makes per-link revocation + audit possible (the row is the source
    // of truth for revoked_at, and the access counters surface usage in
    // the admin "Active share links" sheet).
    //
    // ON DELETE CASCADE on download_id means deleting/purging a file
    // automatically kills every outstanding share link for that file —
    // critical so a revoked file doesn't keep streaming bytes from disk.
    db.exec(`
        CREATE TABLE IF NOT EXISTS share_links (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id      INTEGER NOT NULL,
            created_at       INTEGER NOT NULL,
            expires_at       INTEGER NOT NULL,
            revoked_at       INTEGER,
            label            TEXT,
            last_accessed_at INTEGER,
            access_count     INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_share_links_download ON share_links(download_id);
        CREATE INDEX IF NOT EXISTS idx_share_links_expiry ON share_links(expires_at);
    `);

    // Backup destinations + per-destination job queue. The destination row
    // owns provider config (encrypted at rest by core/backup/credentials.js
    // — config_blob is opaque ciphertext, never plaintext on disk) and the
    // optional encryption salt for client-side AES-256-GCM uploads. Jobs
    // are append-only rows the per-destination worker drains; status flips
    // pending → uploading → done|failed|skipped.
    db.exec(`
        CREATE TABLE IF NOT EXISTS backup_destinations (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT    NOT NULL,
            provider        TEXT    NOT NULL,
            config_blob     BLOB    NOT NULL,
            enabled         INTEGER NOT NULL DEFAULT 1,
            encryption      INTEGER NOT NULL DEFAULT 0,
            encryption_salt BLOB,
            mode            TEXT    NOT NULL DEFAULT 'mirror',
            cron            TEXT,
            retain_count    INTEGER DEFAULT 7,
            last_success_at INTEGER,
            last_failure_at INTEGER,
            last_error      TEXT,
            total_bytes     INTEGER NOT NULL DEFAULT 0,
            total_files     INTEGER NOT NULL DEFAULT 0,
            throttle_bps    INTEGER,
            created_at      INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_jobs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            destination_id  INTEGER NOT NULL,
            download_id     INTEGER,
            snapshot_path   TEXT,
            status          TEXT    NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            max_attempts    INTEGER NOT NULL DEFAULT 5,
            next_retry_at   INTEGER,
            started_at      INTEGER,
            finished_at     INTEGER,
            bytes_uploaded  INTEGER NOT NULL DEFAULT 0,
            error           TEXT,
            remote_path     TEXT,
            FOREIGN KEY (destination_id) REFERENCES backup_destinations(id) ON DELETE CASCADE,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_backup_jobs_pending ON backup_jobs(destination_id, status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_backup_jobs_download ON backup_jobs(download_id);
    `);

    // Generic KV blob store. Holds runtime state that used to live in
    // standalone JSON files (config.json, disk_usage.json) — single source
    // of truth, atomic writes via SQLite transactions, no fs.watch needed.
    // Keys are arbitrary strings; values are JSON-encoded text.
    db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
            key        TEXT    PRIMARY KEY,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    // Dashboard session tokens. Replaces data/web-sessions.json so the GC
    // sweep can use an indexed expires_at scan instead of rewriting the
    // whole file every login/logout. Role is constrained — anything other
    // than 'admin' / 'guest' is a programming error and should fail loud.
    db.exec(`
        CREATE TABLE IF NOT EXISTS web_sessions (
            token      TEXT    PRIMARY KEY,
            role       TEXT    NOT NULL CHECK(role IN ('admin','guest')),
            issued_at  INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            last_seen  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_web_sessions_role    ON web_sessions(role);
    `);

    // Spilled-queue rows. Replaces data/logs/queue_backlog.jsonl so a hard
    // crash mid-spill can't tear a JSON line, and rehydrate is an indexed
    // SELECT + DELETE instead of a full-file rewrite. Worker pulls FIFO via
    // `ORDER BY id ASC LIMIT N`, deletes the popped rows in the same tx.
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue_backlog (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            job        TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);

    // Auto-update audit log. One row per /api/update click. The row is
    // INSERTed when the route hands off to watchtower (status='triggered')
    // and finalised by the new container's boot path once the swap lands
    // — `to_version` is whatever the new container reports as its package
    // version, so the row records the actual transition observed, not
    // just what was requested. Pre-flight failures land directly as
    // status='failed' with the structured error code.
    db.exec(`
        CREATE TABLE IF NOT EXISTS update_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            from_version TEXT,
            to_version   TEXT,
            started_at   INTEGER NOT NULL,
            finished_at  INTEGER,
            status       TEXT    NOT NULL DEFAULT 'pending',
            error_code   TEXT,
            error_msg    TEXT,
            backup_path  TEXT,
            backup_bytes INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_update_history_status ON update_history(status, started_at);
    `);

    // Cluster mode (v2.9): peer registry + cached catalogs from remote peers
    // + audit log for cross-peer signed requests. Identity (peer_id,
    // cluster_token, peer_name) lives in `kv` and is bootstrapped on first
    // boot by core/cluster/identity.js.
    //
    // peers — one row per *remote* peer this instance has paired with. The
    //   self peer is NOT in this table (its identity is in `kv`).
    //   `peer_id` is a UUIDv4 generated by the remote peer; `fingerprint`
    //   is hex(sha256(cluster_token + remote_peer_id)) and lets the UI
    //   detect token-mismatch on revisit. `stream_mode` selects how the
    //   bridge serves remote files (proxy-through-self vs 302-direct).
    //
    // peer_downloads — cached mirror of a remote peer's downloads table.
    //   Drives the merged gallery + cross-peer dedup hash lookup. The
    //   sync engine refills it incrementally; cached_at gates staleness.
    //
    // peer_groups / peer_accounts / peer_history — opaque JSON blobs of
    //   the remote peer's tables. We don't query columns inside them, so a
    //   single payload column keeps the schema generic across version
    //   skews between paired peers.
    //
    // cluster_audit — one row per signed request (inbound or outbound)
    //   plus handshake / sweep / dedup-hit lifecycle events. Used by the
    //   Cluster tab to surface auth failures + drift.
    db.exec(`
        CREATE TABLE IF NOT EXISTS peers (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id      TEXT    NOT NULL UNIQUE,
            name         TEXT    NOT NULL,
            url          TEXT    NOT NULL,
            status       TEXT    NOT NULL DEFAULT 'offline',
            stream_mode  TEXT    NOT NULL DEFAULT 'proxy',
            last_seen_at INTEGER,
            paired_at    INTEGER NOT NULL,
            fingerprint  TEXT    NOT NULL,
            version      TEXT,
            notes        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status);

        CREATE TABLE IF NOT EXISTS peer_downloads (
            peer_id     TEXT    NOT NULL,
            remote_id   INTEGER NOT NULL,
            file_path   TEXT    NOT NULL,
            file_name   TEXT,
            file_size   INTEGER,
            file_type   TEXT,
            file_hash   TEXT,
            group_id    TEXT,
            group_name  TEXT,
            message_id  INTEGER,
            created_at  INTEGER,
            status      TEXT,
            nsfw_score  REAL,
            cached_at   INTEGER NOT NULL,
            PRIMARY KEY (peer_id, remote_id)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_downloads_hash    ON peer_downloads(file_hash, file_size);
        CREATE INDEX IF NOT EXISTS idx_peer_downloads_group   ON peer_downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_peer_downloads_created ON peer_downloads(created_at DESC);

        CREATE TABLE IF NOT EXISTS peer_groups (
            peer_id    TEXT    PRIMARY KEY,
            payload    TEXT    NOT NULL,
            cached_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peer_accounts (
            peer_id    TEXT    PRIMARY KEY,
            payload    TEXT    NOT NULL,
            cached_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peer_history (
            peer_id    TEXT    PRIMARY KEY,
            payload    TEXT    NOT NULL,
            cached_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cluster_audit (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            peer_id TEXT,
            kind    TEXT    NOT NULL,
            detail  TEXT,
            ok      INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_cluster_audit_ts ON cluster_audit(ts DESC);
    `);
    // Reserved owner column on downloads — null = self peer.

    // v2.10 cluster tables — per-peer tokens, failover audit,
    // cross-peer-delete jobs, LAN-discovery cache, egress accounting.
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_failover_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id     TEXT    NOT NULL,
            from_peer_id TEXT    NOT NULL,
            to_peer_id   TEXT    NOT NULL,
            reason       TEXT,
            ts           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_failover_ts ON peer_failover_log(ts DESC);

        CREATE TABLE IF NOT EXISTS peer_delete_jobs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id      TEXT    NOT NULL,
            remote_id    INTEGER NOT NULL,
            reason       TEXT,
            status       TEXT    NOT NULL DEFAULT 'pending',
            attempts     INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            finished_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pdj_pending ON peer_delete_jobs(status, peer_id);

        CREATE TABLE IF NOT EXISTS peer_discoveries (
            peer_id    TEXT    PRIMARY KEY,
            url        TEXT    NOT NULL,
            name       TEXT,
            version    TEXT,
            source     TEXT    NOT NULL DEFAULT 'broadcast',
            seen_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cluster_egress_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id     TEXT,
            bytes       INTEGER NOT NULL,
            served_at   INTEGER NOT NULL,
            from_cache  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_cluster_egress_time ON cluster_egress_log(served_at);
    `);

    // Normalized group config tables (v3.0). Replaces the `groups` JSON blob
    // stored in kv['config'] with a proper relational layout so individual
    // group settings can be queried and updated without deserialising the
    // entire config. The child tables (group_filters, group_forward,
    // group_settings) use ON DELETE CASCADE so deleting a group row prunes
    // all its settings atomically. Overflow fields that don't fit a typed
    // column (trackUsers, monitorAccount, etc.) are packed into meta_json.
    db.exec(`
        CREATE TABLE IF NOT EXISTS groups (
            id          TEXT    PRIMARY KEY,
            name        TEXT    NOT NULL,
            type        TEXT,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_filters (
            group_id    TEXT    PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
            photos      INTEGER NOT NULL DEFAULT 1,
            videos      INTEGER NOT NULL DEFAULT 0,
            files       INTEGER NOT NULL DEFAULT 1,
            links       INTEGER NOT NULL DEFAULT 1,
            voice       INTEGER NOT NULL DEFAULT 1,
            audio       INTEGER NOT NULL DEFAULT 0,
            gifs        INTEGER NOT NULL DEFAULT 0,
            stickers    INTEGER NOT NULL DEFAULT 0,
            urls        INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS group_forward (
            group_id     TEXT    PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
            enabled      INTEGER NOT NULL DEFAULT 0,
            destination  TEXT,
            account_id   TEXT,
            delete_after INTEGER NOT NULL DEFAULT 1,
            keep_images  INTEGER NOT NULL DEFAULT 1,
            keep_videos  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS group_settings (
            group_id        TEXT    PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
            track_comments  INTEGER NOT NULL DEFAULT 1,
            rescue_mode     TEXT    NOT NULL DEFAULT 'auto',
            max_disk_mb     INTEGER,
            topics_enabled  INTEGER NOT NULL DEFAULT 0,
            topic_ids       TEXT    NOT NULL DEFAULT '[]',
            meta_json       TEXT    NOT NULL DEFAULT '{}'
        );
    `);

    // Run numbered migrations. All CREATE TABLE IF NOT EXISTS statements above
    // have completed, so every target table is guaranteed to exist.
    runMigrations(db);

    // Populate vec0 tables from existing data if they are empty
    try {
        const imageEmbRow = db.prepare('SELECT embedding FROM image_embeddings LIMIT 1').get();
        if (imageEmbRow && imageEmbRow.embedding) {
            const dim = imageEmbRow.embedding.byteLength / 4;
            db.exec(
                `CREATE VIRTUAL TABLE IF NOT EXISTS vec_image_embeddings USING vec0(download_id INTEGER PRIMARY KEY, embedding float[${dim}])`,
            );
            const vecImageCount = db
                .prepare('SELECT COUNT(*) AS c FROM vec_image_embeddings')
                .get().c;
            if (vecImageCount === 0) {
                db.exec(
                    `INSERT INTO vec_image_embeddings(download_id, embedding) SELECT download_id, embedding FROM image_embeddings WHERE length(embedding) = ${dim * 4}`,
                );
            }
        }
        const textEmbRow = db.prepare('SELECT embedding FROM text_embeddings LIMIT 1').get();
        if (textEmbRow && textEmbRow.embedding) {
            const dim = textEmbRow.embedding.byteLength / 4;
            db.exec(
                `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text_embeddings USING vec0(download_id INTEGER PRIMARY KEY, embedding float[${dim}])`,
            );
            const vecTextCount = db
                .prepare('SELECT COUNT(*) AS c FROM vec_text_embeddings')
                .get().c;
            if (vecTextCount === 0) {
                db.exec(
                    `INSERT INTO vec_text_embeddings(download_id, embedding) SELECT download_id, embedding FROM text_embeddings WHERE length(embedding) = ${dim * 4}`,
                );
            }
        }
    } catch (e) {
        console.warn('[db] vec0 migration failed (non-fatal):', e.message);
    }

    // One-shot data migration: read groups from kv['config'] JSON blob and
    // populate the normalized group tables. Skips if groups table already
    // has rows (idempotent). Runs after runMigrations so the kv table exists.
    try {
        const count = db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
        if (count === 0) {
            const stored = kvGet('config');
            const kvGroups = stored?.groups;
            if (Array.isArray(kvGroups) && kvGroups.length > 0) {
                const now = Date.now();
                const insGroup = db.prepare(`
                    INSERT OR IGNORE INTO groups (id, name, type, enabled, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)`);
                const insFilters = db.prepare(`
                    INSERT OR IGNORE INTO group_filters (group_id, photos, videos, files, links, voice, audio, gifs, stickers, urls)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                const insForward = db.prepare(`
                    INSERT OR IGNORE INTO group_forward (group_id, enabled, destination, account_id, delete_after, keep_images, keep_videos)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`);
                const insSettings = db.prepare(`
                    INSERT OR IGNORE INTO group_settings (group_id, track_comments, rescue_mode, max_disk_mb, topics_enabled, topic_ids, meta_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`);
                db.transaction(() => {
                    for (const g of kvGroups) {
                        const gid = String(g.id);
                        const f = g.filters || {};
                        const af = g.autoForward || {};
                        const topics = g.topics || {};
                        const meta = {};
                        const metaFields = [
                            'trackUsers',
                            'monitorAccount',
                            'ownerPeerId',
                            'forwardAccount',
                            'backupPeerId',
                            'failoverAt',
                        ];
                        for (const k of metaFields) {
                            if (g[k] !== undefined) meta[k] = g[k];
                        }
                        insGroup.run(
                            gid,
                            g.name || '',
                            g.type || null,
                            g.enabled ? 1 : 0,
                            now,
                            now,
                        );
                        // Use defaults matching GROUP_DEFAULTS.filters: photos/files/links/voice/urls default true
                        const fb = (v, d) => (v !== undefined ? (v ? 1 : 0) : d);
                        insFilters.run(
                            gid,
                            fb(f.photos, 1),
                            fb(f.videos, 0),
                            fb(f.files, 1),
                            fb(f.links, 1),
                            fb(f.voice, 1),
                            fb(f.audio, 0),
                            fb(f.gifs, 0),
                            fb(f.stickers, 0),
                            fb(f.urls, 1),
                        );
                        insForward.run(
                            gid,
                            af.enabled ? 1 : 0,
                            af.destination || null,
                            af.account_id || null,
                            af.deleteAfterForward !== false ? 1 : 0,
                            af.keepImages !== false ? 1 : 0,
                            af.keepVideos ? 1 : 0,
                        );
                        insSettings.run(
                            gid,
                            g.trackComments !== false ? 1 : 0,
                            g.rescueMode || 'auto',
                            g.maxDiskMb || null,
                            topics.enabled ? 1 : 0,
                            JSON.stringify(topics.ids || []),
                            JSON.stringify(meta),
                        );
                    }
                })();
                // eslint-disable-next-line no-console
                console.log(`[db] migrated ${kvGroups.length} groups from kv to normalized tables`);
            }
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[db] group kv migration failed (non-fatal):', e.message);
    }

    // Indexes on migration-added columns. All run after runMigrations() so the
    // target columns are guaranteed to exist. CREATE INDEX IF NOT EXISTS is
    // idempotent — safe to call on every boot.
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_filename_size
            ON downloads(group_id, file_name, file_size);
        CREATE INDEX IF NOT EXISTS idx_downloads_deleted
            ON downloads(deleted_at) WHERE deleted_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_pending_until
            ON downloads(pending_until) WHERE pending_until IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_group_message
            ON downloads(group_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_nsfw_unscanned
            ON downloads(file_type, nsfw_checked_at) WHERE nsfw_checked_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_nsfw_review
            ON downloads(nsfw_score, nsfw_whitelist) WHERE nsfw_score IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_nsfw_tier
            ON downloads(file_type, nsfw_whitelist, nsfw_score) WHERE nsfw_score IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_ai_unindexed
            ON downloads(file_type, ai_indexed_at) WHERE ai_indexed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_gallery_group_date
            ON downloads(group_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_gallery_group_type_date
            ON downloads(group_id, file_type, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_gallery_type_date
            ON downloads(file_type, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_gallery_pinned_date
            ON downloads(pinned, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_video_filepath
            ON downloads(file_type, id DESC) WHERE file_type = 'video' AND file_path IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_file_hash
            ON downloads(file_hash) WHERE file_hash IS NOT NULL;
        DROP INDEX IF EXISTS idx_created_at;
    `);

    try {
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS downloads_fts USING fts5(
                file_name, group_name,
                content='downloads',
                content_rowid='id'
            );
        `);
        const ftsCount = Number(
            db.prepare('SELECT COUNT(*) AS n FROM downloads_fts').get()?.n || 0,
        );
        if (ftsCount === 0) {
            const dlCount = Number(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()?.n || 0);
            if (dlCount > 0) {
                db.exec(`
                    INSERT INTO downloads_fts(rowid, file_name, group_name)
                    SELECT id, COALESCE(file_name, ''), COALESCE(group_name, '') FROM downloads;
                `);
            }
        }
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS downloads_fts_insert AFTER INSERT ON downloads BEGIN
                INSERT INTO downloads_fts(rowid, file_name, group_name)
                VALUES (new.id, COALESCE(new.file_name, ''), COALESCE(new.group_name, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS downloads_fts_delete AFTER DELETE ON downloads BEGIN
                INSERT INTO downloads_fts(downloads_fts, rowid, file_name, group_name)
                VALUES ('delete', old.id, COALESCE(old.file_name, ''), COALESCE(old.group_name, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS downloads_fts_update AFTER UPDATE OF file_name, group_name ON downloads BEGIN
                INSERT INTO downloads_fts(downloads_fts, rowid, file_name, group_name)
                VALUES ('delete', old.id, COALESCE(old.file_name, ''), COALESCE(old.group_name, ''));
                INSERT INTO downloads_fts(rowid, file_name, group_name)
                VALUES (new.id, COALESCE(new.file_name, ''), COALESCE(new.group_name, ''));
            END;
        `);
    } catch {}

    // Smoke-test every column the rest of the code path depends on so a
    // failed migration or CREATE TABLE surfaces at boot, not mid-request.
    try {
        db.prepare(
            'SELECT pinned, pending_until, rescued_at, ttl_seconds, file_hash, nsfw_score, nsfw_checked_at, nsfw_whitelist, ai_indexed_at, deleted_at, delete_reason, owner_peer_id FROM downloads LIMIT 0',
        ).all();
        db.prepare('SELECT key, value, updated_at FROM kv LIMIT 0').all();
        db.prepare(
            'SELECT token, role, issued_at, expires_at, last_seen FROM web_sessions LIMIT 0',
        ).all();
        db.prepare('SELECT id, job, created_at FROM queue_backlog LIMIT 0').all();
        db.prepare(
            'SELECT id, from_version, to_version, started_at, finished_at, status, error_code, error_msg, backup_path, backup_bytes, from_instance_id FROM update_history LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, group_id, from_peer_id, to_peer_id, reason, ts FROM peer_failover_log LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, peer_id, remote_id, reason, status, attempts, created_at, finished_at FROM peer_delete_jobs LIMIT 0',
        ).all();
        db.prepare(
            'SELECT peer_id, url, name, version, source, seen_at FROM peer_discoveries LIMIT 0',
        ).all();
        db.prepare(
            'SELECT id, peer_id, bytes, served_at, from_cache FROM cluster_egress_log LIMIT 0',
        ).all();
        db.prepare(
            'SELECT peer_id, remote_id, file_path, file_name, file_size, file_type, file_hash, group_id, group_name, message_id, created_at, status, nsfw_score, cached_at FROM peer_downloads LIMIT 0',
        ).all();
        db.prepare('SELECT peer_id, payload, cached_at FROM peer_groups LIMIT 0').all();
        db.prepare('SELECT id, ts, peer_id, kind, detail, ok FROM cluster_audit LIMIT 0').all();
        db.prepare('SELECT id, throttle_bps FROM backup_destinations LIMIT 0').all();
        db.prepare('SELECT id, quality_score FROM faces LIMIT 0').all();
        db.prepare(
            'SELECT id, name, type, enabled, created_at, updated_at FROM groups LIMIT 0',
        ).all();
        db.prepare(
            'SELECT group_id, photos, videos, files, links, voice, audio, gifs, stickers, urls FROM group_filters LIMIT 0',
        ).all();
        db.prepare(
            'SELECT group_id, enabled, destination, account_id, delete_after, keep_images, keep_videos FROM group_forward LIMIT 0',
        ).all();
        db.prepare(
            'SELECT group_id, track_comments, rescue_mode, max_disk_mb, topics_enabled, topic_ids, meta_json FROM group_settings LIMIT 0',
        ).all();
    } catch (e) {
        throw new Error(
            `DB schema incomplete — column or table missing after migrations: ${e.message}. Inspect data/db.sqlite or restore from backup.`,
        );
    }

    // NSFW hash blocklist — stores SHA-256 fingerprints of files deleted via
    // NSFW review so re-downloads can be auto-deleted without rescanning.
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS nsfw_hash_blocklist (
                file_hash  TEXT    PRIMARY KEY,
                file_name  TEXT,
                deleted_at INTEGER NOT NULL,
                source     TEXT    DEFAULT 'manual'
            )
        `);
    } catch {}

    // FK enforcement is per-connection in SQLite — flip it on once we know
    // the table exists. Without this, ON DELETE CASCADE silently no-ops.
    try {
        db.pragma('foreign_keys = ON');
    } catch {}
}

// ---- Domain module barrel exports -----------------------------------------
//
// All business logic lives in the domain modules below. Importing from
// `core/db.js` continues to work for every existing caller — the barrel
// re-exports flatten the split into a single public surface.

export * from './db/downloads.js';
export * from './db/groups.js';
export * from './db/faces.js';
export * from './db/kv.js';
export * from './db/cluster.js';
export * from './db/seekbar.js';
export * from './db/nsfw.js';
