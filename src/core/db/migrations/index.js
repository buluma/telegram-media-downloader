/**
 * Numbered migration runner.
 *
 * MIGRATIONS is an append-only list of named schema changes. Each entry runs
 * exactly once per database; the _migrations table records which names have
 * been applied so re-runs on an existing DB are no-ops.
 *
 * On first run against a pre-runner database (bootstrapping), any migration
 * whose ALTER TABLE would fail with "duplicate column name" is silently
 * recorded as already-applied. All other errors bubble up loud and fail the
 * process, as intended.
 */

/* eslint-disable no-console */

const MIGRATIONS = [
    {
        name: '001_downloads_group_name',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN group_name TEXT'),
    },
    {
        name: '002_downloads_ttl_seconds',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN ttl_seconds INTEGER'),
    },
    {
        name: '003_downloads_file_hash',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN file_hash TEXT'),
    },
    {
        name: '004_downloads_pinned',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN pinned INTEGER DEFAULT 0'),
    },
    {
        name: '005_downloads_pending_until',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN pending_until INTEGER'),
    },
    {
        name: '006_downloads_rescued_at',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN rescued_at INTEGER'),
    },
    {
        name: '007_downloads_nsfw_score',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN nsfw_score REAL'),
    },
    {
        name: '008_downloads_nsfw_checked_at',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN nsfw_checked_at INTEGER'),
    },
    {
        name: '009_downloads_nsfw_whitelist',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN nsfw_whitelist INTEGER DEFAULT 0'),
    },
    {
        name: '010_downloads_deleted_at',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN deleted_at INTEGER'),
    },
    {
        name: '011_downloads_delete_reason',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN delete_reason TEXT'),
    },
    {
        name: '012_downloads_ai_indexed_at',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN ai_indexed_at INTEGER'),
    },
    {
        name: '013_backup_destinations_throttle_bps',
        up: (db) => db.exec('ALTER TABLE backup_destinations ADD COLUMN throttle_bps INTEGER'),
    },
    {
        name: '014_update_history_from_instance_id',
        up: (db) => db.exec('ALTER TABLE update_history ADD COLUMN from_instance_id TEXT'),
    },
    {
        name: '015_faces_quality_score',
        up: (db) => db.exec('ALTER TABLE faces ADD COLUMN quality_score REAL'),
    },
    {
        name: '016_downloads_owner_peer_id',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN owner_peer_id TEXT'),
    },
    {
        name: '017_peers_shared_secret',
        up: (db) => db.exec('ALTER TABLE peers ADD COLUMN shared_secret BLOB'),
    },
    {
        name: '018_peers_role',
        up: (db) => db.exec("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"),
    },
    {
        name: '019_peers_ws_last_seen',
        up: (db) => db.exec('ALTER TABLE peers ADD COLUMN ws_last_seen INTEGER'),
    },
    {
        // Timestamp set when the provider ACKs upload. Used by the eviction
        // guard to ensure files are never deleted before a cloud copy is
        // confirmed.
        name: '020_backup_jobs_confirmed_at',
        up: (db) => db.exec('ALTER TABLE backup_jobs ADD COLUMN confirmed_at INTEGER'),
    },
    {
        // Timestamp set when the disk-rotator removes the local file but
        // keeps the DB row so the gallery can show a "cloud only" badge
        // and stream on demand.
        name: '021_downloads_cache_evicted_at',
        up: (db) => db.exec('ALTER TABLE downloads ADD COLUMN cache_evicted_at INTEGER'),
    },
];

export function runMigrations(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            applied_at INTEGER NOT NULL
        )
    `);

    const applied = new Set(
        db
            .prepare('SELECT name FROM _migrations')
            .all()
            .map((r) => r.name),
    );
    const insert = db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)');

    for (const m of MIGRATIONS) {
        if (applied.has(m.name)) continue;
        try {
            db.transaction(() => {
                m.up(db);
                insert.run(m.name, Date.now());
            })();
            console.log(`[db] migration applied: ${m.name}`);
        } catch (e) {
            if (e.message?.includes('duplicate column name')) {
                // Column was added by pre-runner code on an existing database.
                // Record as applied so it is never attempted again.
                insert.run(m.name, 0);
            } else {
                throw e;
            }
        }
    }
}

export { MIGRATIONS };
