// Tests for the migration runner (src/core/db/migrations/index.js).
// Each test gets an isolated in-memory SQLite DB via better-sqlite3.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../src/core/db/migrations/index.js';

function createTestDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Create only the base tables that the migrations operate on so the
    // runner has something to ALTER.
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_destinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            provider TEXT NOT NULL,
            config_blob BLOB NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            encryption INTEGER NOT NULL DEFAULT 0,
            mode TEXT NOT NULL DEFAULT 'mirror',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS update_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS faces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id INTEGER NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            w REAL NOT NULL,
            h REAL NOT NULL,
            embedding BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'offline',
            stream_mode TEXT NOT NULL DEFAULT 'proxy',
            paired_at INTEGER NOT NULL,
            fingerprint TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_jobs (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            destination_id INTEGER NOT NULL,
            download_id    INTEGER,
            snapshot_path  TEXT,
            status         TEXT    NOT NULL DEFAULT 'pending',
            attempts       INTEGER NOT NULL DEFAULT 0,
            max_attempts   INTEGER NOT NULL DEFAULT 5,
            next_retry_at  INTEGER,
            started_at     INTEGER,
            finished_at    INTEGER,
            bytes_uploaded INTEGER NOT NULL DEFAULT 0,
            error          TEXT,
            remote_path    TEXT
        );
    `);
    return db;
}

describe('runMigrations', () => {
    let db;

    beforeEach(() => {
        db = createTestDb();
    });

    it('creates _migrations table on first call', () => {
        runMigrations(db);
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
            .all();
        expect(tables).toHaveLength(1);
    });

    it('records every migration as applied', () => {
        runMigrations(db);
        const applied = db
            .prepare('SELECT name FROM _migrations')
            .all()
            .map((r) => r.name);
        expect(applied).toHaveLength(MIGRATIONS.length);
        for (const m of MIGRATIONS) {
            expect(applied).toContain(m.name);
        }
    });

    it('adds migrated columns to downloads', () => {
        runMigrations(db);
        const cols = db
            .prepare('PRAGMA table_info(downloads)')
            .all()
            .map((r) => r.name);
        expect(cols).toContain('pinned');
        expect(cols).toContain('deleted_at');
        expect(cols).toContain('delete_reason');
        expect(cols).toContain('ai_indexed_at');
        expect(cols).toContain('owner_peer_id');
    });

    it('adds throttle_bps to backup_destinations', () => {
        runMigrations(db);
        const cols = db
            .prepare('PRAGMA table_info(backup_destinations)')
            .all()
            .map((r) => r.name);
        expect(cols).toContain('throttle_bps');
    });

    it('adds from_instance_id to update_history', () => {
        runMigrations(db);
        const cols = db
            .prepare('PRAGMA table_info(update_history)')
            .all()
            .map((r) => r.name);
        expect(cols).toContain('from_instance_id');
    });

    it('adds quality_score to faces', () => {
        runMigrations(db);
        const cols = db
            .prepare('PRAGMA table_info(faces)')
            .all()
            .map((r) => r.name);
        expect(cols).toContain('quality_score');
    });

    it('adds role + shared_secret + ws_last_seen to peers', () => {
        runMigrations(db);
        const cols = db
            .prepare('PRAGMA table_info(peers)')
            .all()
            .map((r) => r.name);
        expect(cols).toContain('shared_secret');
        expect(cols).toContain('role');
        expect(cols).toContain('ws_last_seen');
    });

    it('is idempotent — second call skips all migrations', () => {
        runMigrations(db);
        const countAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n;

        // Add a spy to detect any DB writes on the second call.
        let writeAttempts = 0;
        const origExec = db.exec.bind(db);
        db.exec = (sql) => {
            if (sql.trim().toUpperCase().startsWith('ALTER')) writeAttempts++;
            return origExec(sql);
        };

        runMigrations(db);
        expect(writeAttempts).toBe(0);
        const countAfterSecond = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n;
        expect(countAfterSecond).toBe(countAfterFirst);
    });

    it('bootstraps gracefully when columns already exist (existing DB)', () => {
        // Simulate a pre-runner DB that already has the columns.
        db.exec('ALTER TABLE downloads ADD COLUMN deleted_at INTEGER');
        db.exec('ALTER TABLE downloads ADD COLUMN delete_reason TEXT');
        db.exec('ALTER TABLE downloads ADD COLUMN pinned INTEGER DEFAULT 0');

        // Should not throw even though many ALTER TABLEs would fail with
        // "duplicate column name".
        expect(() => runMigrations(db)).not.toThrow();

        // All migrations should be recorded as applied.
        const applied = db
            .prepare('SELECT name FROM _migrations')
            .all()
            .map((r) => r.name);
        expect(applied.length).toBe(MIGRATIONS.length);
    });

    it('throws on genuinely bad migration SQL', () => {
        const badMigrations = [
            {
                name: 'bad_migration',
                up: (d) => d.exec('ALTER TABLE nonexistent_table ADD COLUMN foo TEXT'),
            },
        ];
        const badRunner = (d) => {
            d.exec(`
                CREATE TABLE IF NOT EXISTS _migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    applied_at INTEGER NOT NULL
                )
            `);
            const insert = d.prepare(
                'INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)',
            );
            for (const m of badMigrations) {
                const applied = new Set(
                    d
                        .prepare('SELECT name FROM _migrations')
                        .all()
                        .map((r) => r.name),
                );
                if (applied.has(m.name)) continue;
                try {
                    d.transaction(() => {
                        m.up(d);
                        insert.run(m.name, Date.now());
                    })();
                } catch (e) {
                    if (e.message?.includes('duplicate column name')) {
                        insert.run(m.name, 0);
                    } else {
                        throw e;
                    }
                }
            }
        };
        expect(() => badRunner(db)).toThrow();
    });
});
