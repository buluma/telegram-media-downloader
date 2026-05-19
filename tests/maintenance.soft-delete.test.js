// Verifies that batch scanner queries exclude soft-deleted rows, and that
// the bulk-delete flow stamps deleted_at before removing rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-softdel-test-'));

let db;
let getUnindexedAiBatch, getUnscannedOcrBatch, getUnscannedWd14Batch, countUnscannedWd14;
let pageMissingSeekbarVideos;
let softDeleteDownloads;

function insertRow(overrides = {}) {
    const id = db
        .prepare(
            `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status)
             VALUES (?, ?, ?, ?, ?, 'completed')`,
        )
        .run(
            overrides.group_id ?? 'grp1',
            overrides.message_id ?? Math.floor(Math.random() * 1e9),
            overrides.file_type ?? 'photo',
            overrides.file_path ?? '/data/downloads/img.jpg',
            overrides.file_name ?? 'img.jpg',
        ).lastInsertRowid;
    return Number(id);
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    ({ getUnindexedAiBatch, getUnscannedOcrBatch } = await import('../src/core/db/faces.js'));
    ({ getUnscannedWd14Batch, countUnscannedWd14 } = await import('../src/core/db/faces.js'));
    ({ pageMissingSeekbarVideos } = await import('../src/core/db/seekbar.js'));
    ({ softDeleteDownloads } = await import('../src/core/db/downloads.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('deleted_at soft-delete — scanner batch queries', () => {
    it('downloads table has deleted_at column after migration', () => {
        const cols = db
            .prepare('PRAGMA table_info(downloads)')
            .all()
            .map((r) => r.name);
        expect(cols).toContain('deleted_at');
    });

    it('getUnindexedAiBatch excludes soft-deleted rows', () => {
        const id = insertRow({ file_type: 'photo', message_id: 1001 });
        softDeleteDownloads([id]);

        const batch = getUnindexedAiBatch({ fileTypes: ['photo'], limit: 500 });
        const ids = batch.map((r) => r.id);
        expect(ids).not.toContain(id);
    });

    it('getUnscannedOcrBatch excludes soft-deleted rows', () => {
        const id = insertRow({ file_type: 'photo', file_name: 'ocr.jpg', message_id: 1002 });
        softDeleteDownloads([id]);

        const batch = getUnscannedOcrBatch({ fileTypes: ['photo'], limit: 500 });
        const ids = batch.map((r) => r.id);
        expect(ids).not.toContain(id);
    });

    it('getUnscannedWd14Batch excludes soft-deleted rows', () => {
        const id = insertRow({ file_type: 'photo', file_name: 'wd14.jpg', message_id: 1003 });
        softDeleteDownloads([id]);

        const batch = getUnscannedWd14Batch({ fileTypes: ['photo'], limit: 500 });
        const ids = batch.map((r) => r.id);
        expect(ids).not.toContain(id);
    });

    it('pageMissingSeekbarVideos excludes soft-deleted rows', () => {
        const id = insertRow({ file_type: 'video', file_name: 'v.mp4', message_id: 1004 });
        softDeleteDownloads([id]);

        const rows = pageMissingSeekbarVideos({ beforeId: Number.MAX_SAFE_INTEGER, limit: 500 });
        const ids = rows.map((r) => r.id);
        expect(ids).not.toContain(id);
    });

    it('non-deleted rows still appear in batches', () => {
        const id = insertRow({ file_type: 'photo', file_name: 'live.jpg', message_id: 1005 });

        const batch = getUnindexedAiBatch({ fileTypes: ['photo'], limit: 500 });
        const ids = batch.map((r) => r.id);
        expect(ids).toContain(id);
    });

    it('softDeleteDownloads stamps deleted_at and is idempotent', () => {
        const id = insertRow({ message_id: 1006 });
        softDeleteDownloads([id]);
        softDeleteDownloads([id]); // second call must not throw

        const row = db.prepare('SELECT deleted_at FROM downloads WHERE id = ?').get(id);
        expect(row.deleted_at).toBeTruthy();
        expect(typeof row.deleted_at).toBe('number');
    });

    it('softDeleteDownloads is a no-op for empty array', () => {
        expect(() => softDeleteDownloads([])).not.toThrow();
    });
});
