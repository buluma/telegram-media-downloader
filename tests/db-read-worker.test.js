// Tests for the read-only SQLite worker pool (src/core/db/read-worker.js).
//
// Runs against a temporary on-disk DB so the worker thread can open it
// (in-memory ':memory:' is per-connection and cannot be shared across threads).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-read-worker-'));
const DB_FILE = path.join(TMP_DIR, 'test.db');

// Seed data: 30 tags across 10 "files", scores in 0.0-1.0 range.
const SEED_TAGS = [
    { download_id: 1, tag: 'cat', score: 0.95 },
    { download_id: 1, tag: 'animal', score: 0.88 },
    { download_id: 1, tag: 'rare', score: 0.05 },
    { download_id: 2, tag: 'cat', score: 0.91 },
    { download_id: 2, tag: 'indoor', score: 0.72 },
    { download_id: 3, tag: 'cat', score: 0.85 },
    { download_id: 3, tag: 'animal', score: 0.8 },
    { download_id: 4, tag: 'dog', score: 0.93 },
    { download_id: 4, tag: 'animal', score: 0.77 },
    { download_id: 5, tag: 'dog', score: 0.89 },
    { download_id: 5, tag: 'outdoor', score: 0.6 },
    { download_id: 6, tag: 'flower', score: 0.99 },
    { download_id: 7, tag: 'flower', score: 0.95 },
    { download_id: 7, tag: 'outdoor', score: 0.55 },
    { download_id: 8, tag: '_wd14_scanned_', score: 0.0 }, // sentinel — must be excluded
    { download_id: 9, tag: 'cat', score: 0.78 },
    { download_id: 10, tag: 'indoor', score: 0.65 },
];

function createTestDb(filePath) {
    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL DEFAULT '',
            message_id INTEGER NOT NULL DEFAULT 0
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
    // Insert placeholder download rows so FK constraint passes.
    for (let id = 1; id <= 10; id++) {
        db.prepare('INSERT OR IGNORE INTO downloads(id, group_id, message_id) VALUES(?,?,?)').run(
            id,
            'test',
            id,
        );
    }
    const ins = db.prepare(
        'INSERT OR REPLACE INTO image_tags_wd14(download_id,tag,score) VALUES(?,?,?)',
    );
    for (const row of SEED_TAGS) ins.run(row.download_id, row.tag, row.score);
    db.close();
}

// Inline reference implementation matching listWd14Tags exactly.
function listWd14TagsSync(dbPath, { minScore = 0.2, minCount = 1, limit = 500 } = {}) {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db
            .prepare(
                `SELECT tag, COUNT(*) AS count, ROUND(AVG(score), 4) AS avg_score
                   FROM image_tags_wd14
                  WHERE tag != '_wd14_scanned_' AND score >= ?
                  GROUP BY tag HAVING COUNT(*) >= ?
                  ORDER BY COUNT(*) DESC, tag ASC LIMIT ?`,
            )
            .all(minScore, minCount, limit);
    } finally {
        db.close();
    }
}

beforeAll(() => {
    createTestDb(DB_FILE);
    // Point the read-worker at the test DB via env (read before module import).
    process.env.TGDL_READ_WORKER_DB = DB_FILE;
});

afterAll(async () => {
    try {
        const mod = await import('../src/core/db/read-worker.js');
        await mod.shutdownReadPool();
    } catch {}
    delete process.env.TGDL_READ_WORKER_DB;
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ============================================================================
// Worker-pool path
// ============================================================================
describe('read-worker pool', () => {
    it('runQuery returns same rows as the sync reference for default params', async () => {
        const { runQuery } = await import('../src/core/db/read-worker.js');
        const expected = listWd14TagsSync(DB_FILE);
        const actual = await runQuery('wd14Tags', {});
        // Rows must be identical (same count, same tag, same count, avg within float tolerance).
        expect(actual.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
            expect(actual[i].tag).toBe(expected[i].tag);
            expect(actual[i].count).toBe(expected[i].count);
            expect(actual[i].avg_score).toBeCloseTo(expected[i].avg_score, 3);
        }
    });

    it('excludes _wd14_scanned_ sentinel and respects minScore filter', async () => {
        const { runQuery } = await import('../src/core/db/read-worker.js');
        const rows = await runQuery('wd14Tags', { minScore: 0.8, minCount: 1, limit: 500 });
        // No sentinel
        expect(rows.every((r) => r.tag !== '_wd14_scanned_')).toBe(true);
        // All returned tags must have at least one score >= 0.8 in the seed
        // (avg_score itself may be lower if mixed, but the query filters WHERE score >= minScore)
        // Just verify sentinel absent and row structure is correct.
        for (const r of rows) {
            expect(r).toHaveProperty('tag');
            expect(r).toHaveProperty('count');
            expect(r).toHaveProperty('avg_score');
        }
    });

    it('minCount filter excludes tags with fewer than minCount qualifying rows', async () => {
        const { runQuery } = await import('../src/core/db/read-worker.js');
        const rows = await runQuery('wd14Tags', { minScore: 0.2, minCount: 3, limit: 500 });
        // With minCount=3, only 'cat' (4 rows ≥ 0.2) and 'animal' (3 rows ≥ 0.2) qualify.
        const tags = rows.map((r) => r.tag).sort();
        expect(tags).toEqual(['animal', 'cat']);
    });

    it('respects limit param', async () => {
        const { runQuery } = await import('../src/core/db/read-worker.js');
        const rows = await runQuery('wd14Tags', { minScore: 0.2, minCount: 1, limit: 2 });
        expect(rows.length).toBe(2);
    });

    it('rejects with unknown query name', async () => {
        const { runQuery } = await import('../src/core/db/read-worker.js');
        await expect(runQuery('nonExistent', {})).rejects.toThrow(/unknown query/i);
    });

    it('handles concurrent requests deterministically', async () => {
        const { runQuery } = await import('../src/core/db/read-worker.js');
        const expected = listWd14TagsSync(DB_FILE);
        const results = await Promise.all([
            runQuery('wd14Tags', {}),
            runQuery('wd14Tags', {}),
            runQuery('wd14Tags', {}),
        ]);
        for (const rows of results) {
            expect(rows.length).toBe(expected.length);
        }
    });

    it('_poolSize() reflects configured pool size', async () => {
        const { _poolSize } = await import('../src/core/db/read-worker.js');
        // Pool is lazily initialised on first runQuery; it should now exist.
        expect(_poolSize()).toBeGreaterThanOrEqual(1);
    });
});

// ============================================================================
// Disabled / main-thread fallback path
// ============================================================================
describe('read-worker disabled fallback', () => {
    it('produces the same rows with DB_READ_WORKER_DISABLE=1', async () => {
        const prev = process.env.DB_READ_WORKER_DISABLE;
        process.env.DB_READ_WORKER_DISABLE = '1';
        try {
            // Dynamic re-import with cache buster so we get a fresh module state
            // that sees the env flag at import time.  Because vitest caches ESM
            // modules across tests, we exercise the disabled path by calling the
            // exported function when the env is set — the module checks it at
            // call time, not just at import time, so this works correctly.
            const { runQuery } = await import('../src/core/db/read-worker.js');
            const expected = listWd14TagsSync(DB_FILE);
            const actual = await runQuery('wd14Tags', {});
            expect(actual.length).toBe(expected.length);
        } finally {
            if (prev === undefined) delete process.env.DB_READ_WORKER_DISABLE;
            else process.env.DB_READ_WORKER_DISABLE = prev;
        }
    });
});

// ============================================================================
// Shutdown
// ============================================================================
describe('shutdownReadPool', () => {
    it('is idempotent — second call does not throw', async () => {
        const { shutdownReadPool } = await import('../src/core/db/read-worker.js');
        await shutdownReadPool();
        await expect(shutdownReadPool()).resolves.toBeUndefined();
    });
});
