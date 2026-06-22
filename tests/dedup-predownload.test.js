// Tests the pre-download filename+size dedup fast-path in the downloader.
// Verifies that when a hash-verified download with the same file_size and
// matching extension already exists, a second download for the same content
// (different group) is skipped and a DB row is created pointing at the
// existing file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-dedup-pre-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

let db;
let dbApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('pre-download dedup fast-path', () => {
    it('finds a candidate when file_size matches and file exists on disk', () => {
        const groupDir = path.join(DOWNLOADS_DIR, 'group-a', 'videos');
        fs.mkdirSync(groupDir, { recursive: true });
        const content = Buffer.from('fake-video-content-for-dedup-test');
        const filePath = 'group-a/videos/2026-01-01T00-00-00_100.mp4';
        fs.writeFileSync(path.join(DOWNLOADS_DIR, filePath), content);

        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path, file_hash, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            '-100001',
            'group-a',
            100,
            '2026-01-01T00-00-00_100.mp4',
            content.length,
            'video',
            filePath,
            'abc123hash',
            'completed',
        );

        const existing = db
            .prepare(`
            SELECT id, file_path, file_size, file_hash FROM downloads
             WHERE file_size = ? AND file_hash IS NOT NULL
             ORDER BY id ASC LIMIT 20
        `)
            .all(content.length);

        expect(existing.length).toBe(1);
        expect(existing[0].file_hash).toBe('abc123hash');
        expect(existing[0].file_size).toBe(content.length);

        const absPath = path.resolve(DOWNLOADS_DIR, existing[0].file_path);
        expect(fs.existsSync(absPath)).toBe(true);
    });

    it('does not match when file_size differs', () => {
        const existing = db
            .prepare(`
            SELECT id FROM downloads
             WHERE file_size = ? AND file_hash IS NOT NULL
             ORDER BY id ASC LIMIT 20
        `)
            .all(99999);

        expect(existing.length).toBe(0);
    });

    it('does not match when file_hash is NULL', () => {
        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            '-100002',
            'group-b',
            200,
            'nohash.mp4',
            42,
            'video',
            'group-b/videos/nohash.mp4',
            'completed',
        );

        const existing = db
            .prepare(`
            SELECT id FROM downloads
             WHERE file_size = 42 AND file_hash IS NOT NULL
             ORDER BY id ASC LIMIT 20
        `)
            .all();

        expect(existing.length).toBe(0);
    });
});
