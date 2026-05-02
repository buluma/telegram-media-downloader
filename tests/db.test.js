// Integration test for the DB layer. The module pins data/db.sqlite via its
// module-private `db` singleton; we point HOME-relative __dirname at a tmp
// directory by spawning the test in a copy of the repo isn't worth it, so
// instead we exercise insertDownload + searchDownloads against the actual
// data/db.sqlite created in CI's working tree (fresh, empty on each run).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

let db;
let downloadsApi;

beforeAll(async () => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Always start from a clean slate so the assertions are deterministic.
    for (const f of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']) {
        const p = path.join(DATA_DIR, f);
        if (fs.existsSync(p)) fs.rmSync(p);
    }
    downloadsApi = await import('../src/core/db.js');
    db = downloadsApi.getDb();
});

afterAll(() => {
    try { db.close(); } catch {}
    for (const f of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']) {
        const p = path.join(DATA_DIR, f);
        if (fs.existsSync(p)) fs.rmSync(p);
    }
});

describe('downloads schema', () => {
    it('has the expected columns after migrations', () => {
        const cols = db.prepare(`PRAGMA table_info(downloads)`).all().map(r => r.name);
        expect(cols).toEqual(expect.arrayContaining([
            'group_id', 'group_name', 'message_id', 'file_name', 'file_size',
            'file_type', 'file_path', 'ttl_seconds', 'file_hash',
        ]));
    });
});

describe('insertDownload + isDownloaded', () => {
    it('inserts a row and detects a duplicate by (group_id, message_id)', () => {
        const r1 = downloadsApi.insertDownload({
            groupId: '-100123', groupName: 'Test Group', messageId: 1,
            fileName: 'a.jpg', fileSize: 100, fileType: 'photo', filePath: 'Test_Group/images/a.jpg',
        });
        expect(r1.changes).toBe(1);
        expect(downloadsApi.isDownloaded('-100123', 1)).toBe(true);

        // Same (group, message) is a no-op
        const r2 = downloadsApi.insertDownload({
            groupId: '-100123', groupName: 'Test Group', messageId: 1,
            fileName: 'a.jpg', fileSize: 100, fileType: 'photo', filePath: 'Test_Group/images/a.jpg',
        });
        expect(r2.changes).toBe(0);
    });

    it('persists ttl_seconds for self-destructing media', () => {
        downloadsApi.insertDownload({
            groupId: '-100123', groupName: 'Test Group', messageId: 2,
            fileName: 'b.mp4', fileSize: 200, fileType: 'video',
            filePath: 'Test_Group/videos/b.mp4', ttlSeconds: 30,
        });
        const row = db.prepare('SELECT ttl_seconds FROM downloads WHERE message_id = 2').get();
        expect(row.ttl_seconds).toBe(30);
    });
});

describe('fileAlreadyStored', () => {
    it('matches by (group_id, file_name, file_size)', () => {
        downloadsApi.insertDownload({
            groupId: '-100999', groupName: 'g', messageId: 7,
            fileName: 'cat.jpg', fileSize: 4242, fileType: 'photo',
            filePath: 'g/images/cat.jpg',
        });
        expect(downloadsApi.fileAlreadyStored('-100999', 'cat.jpg', 4242)).toBe(true);
        expect(downloadsApi.fileAlreadyStored('-100999', 'cat.jpg', 9999)).toBe(false);
        expect(downloadsApi.fileAlreadyStored('-100888', 'cat.jpg', 4242)).toBe(false);
    });
});

describe('searchDownloads', () => {
    it('finds by file_name and group_name', () => {
        const result = downloadsApi.searchDownloads('cat');
        expect(result.total).toBeGreaterThan(0);
        expect(result.files.some(f => f.file_name.includes('cat'))).toBe(true);
    });
});
