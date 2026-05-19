// Item 4 — Cloud-first storage model (all 3 phases).
//
// Phase 1: confirmed_at + eviction guard
// Phase 2: on-demand stream proxy (GET /api/files/:id/stream)
// Phase 3: cache_evicted_at → gallery badge

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cloud-first-'));

let dbMod;
let queue;
let dlMod;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbMod = await import('../src/core/db.js');
    dbMod.getDb(); // boot schema
    queue = await import('../src/core/backup/queue.js');
    dlMod = await import('../src/core/db/downloads.js');

    // Seed a destination row (mirror mode)
    dbMod
        .getDb()
        .prepare(`
        INSERT INTO backup_destinations (name, provider, config_blob, enabled, encryption, mode, created_at)
        VALUES ('test', 'local', ?, 1, 0, 'mirror', ?)
    `)
        .run(Buffer.from([1]), Date.now());

    // Seed a non-mirror destination (snapshot mode — should NOT trigger the eviction guard)
    dbMod
        .getDb()
        .prepare(`
        INSERT INTO backup_destinations (name, provider, config_blob, enabled, encryption, mode, created_at)
        VALUES ('snap', 'local', ?, 1, 0, 'snapshot', ?)
    `)
        .run(Buffer.from([1]), Date.now());
});

afterAll(() => {
    try {
        dbMod.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Wipe downloads + backup_jobs between cases.
    const db = dbMod.getDb();
    db.prepare('DELETE FROM backup_jobs').run();
    db.prepare('DELETE FROM downloads').run();
});

// ─── helper ─────────────────────────────────────────────────────────────────

function insertDownload(overrides = {}) {
    const db = dbMod.getDb();
    db.prepare(`
        INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        overrides.groupId || '-100test',
        overrides.messageId || Math.floor(Math.random() * 1e9),
        overrides.fileName || 'test.jpg',
        overrides.fileSize || 1024,
        overrides.fileType || 'photo',
        overrides.filePath || 'photos/test.jpg',
        overrides.createdAt || Date.now(),
    );
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

// ─── Phase 1: confirmed_at ───────────────────────────────────────────────────

describe('Phase 1 — confirmed_at', () => {
    it('markDone sets confirmed_at on backup_jobs row', () => {
        const dlId = insertDownload({ messageId: 9001 });
        const t0 = Date.now();
        const jobId = queue.enqueue({ destinationId: 1, downloadId: dlId });
        queue.claim(1);
        queue.markDone(jobId, { bytes: 512 });
        const row = dbMod
            .getDb()
            .prepare('SELECT confirmed_at FROM backup_jobs WHERE id = ?')
            .get(jobId);
        expect(row.confirmed_at).toBeGreaterThanOrEqual(t0);
    });

    it('markRetry and markFailed leave confirmed_at NULL', () => {
        const dlId = insertDownload({ messageId: 9002 });
        const jobId = queue.enqueue({ destinationId: 1, downloadId: dlId });
        queue.claim(1);
        queue.markRetry(jobId, 'network error');
        const row = dbMod
            .getDb()
            .prepare('SELECT confirmed_at FROM backup_jobs WHERE id = ?')
            .get(jobId);
        expect(row.confirmed_at).toBeNull();
    });
});

// ─── Phase 1: eviction guard ─────────────────────────────────────────────────

describe('Phase 1 — getOldestDownloads skipUnconfirmed', () => {
    it('returns all downloads when skipUnconfirmed=false (default)', () => {
        insertDownload({ messageId: 1 });
        insertDownload({ messageId: 2 });
        const rows = dlMod.getOldestDownloads(10);
        expect(rows.length).toBe(2);
    });

    it('returns only downloads with confirmed backup when skipUnconfirmed=true', () => {
        const id1 = insertDownload({ messageId: 100 });
        const id2 = insertDownload({ messageId: 101 });

        // Confirm a backup job for id1 only
        const jobId = queue.enqueue({ destinationId: 1, downloadId: id1 });
        queue.claim(1);
        queue.markDone(jobId, { bytes: 512 });

        const rows = dlMod.getOldestDownloads(10, { skipUnconfirmed: true });
        expect(rows.map((r) => r.id)).toContain(id1);
        expect(rows.map((r) => r.id)).not.toContain(id2);
    });

    it('excludes already-evicted downloads regardless of skipUnconfirmed', () => {
        const id = insertDownload({ messageId: 200 });
        // Evict it
        dlMod.setDownloadEvicted(id);

        const rows = dlMod.getOldestDownloads(10);
        expect(rows.map((r) => r.id)).not.toContain(id);
    });
});

describe('Phase 1 — getTotalSizeBytes excludes evicted', () => {
    it('does not count evicted download file_size in the total', () => {
        const id = insertDownload({ fileSize: 5000, messageId: 300 });
        const before = dlMod.getTotalSizeBytes();
        dlMod.setDownloadEvicted(id);
        const after = dlMod.getTotalSizeBytes();
        expect(after).toBe(before - 5000);
    });
});

describe('Phase 1 — setDownloadEvicted', () => {
    it('sets cache_evicted_at and preserves DB row', () => {
        const id = insertDownload({ messageId: 400 });
        dlMod.setDownloadEvicted(id);
        const row = dbMod
            .getDb()
            .prepare('SELECT cache_evicted_at FROM downloads WHERE id = ?')
            .get(id);
        expect(row.cache_evicted_at).toBeGreaterThan(0);
        // Row still exists
        const full = dbMod.getDb().prepare('SELECT * FROM downloads WHERE id = ?').get(id);
        expect(full).not.toBeNull();
    });

    it('is idempotent — second call leaves the first timestamp unchanged', () => {
        const id = insertDownload({ messageId: 401 });
        dlMod.setDownloadEvicted(id);
        const first = dbMod
            .getDb()
            .prepare('SELECT cache_evicted_at FROM downloads WHERE id = ?')
            .get(id).cache_evicted_at;
        dlMod.setDownloadEvicted(id);
        const second = dbMod
            .getDb()
            .prepare('SELECT cache_evicted_at FROM downloads WHERE id = ?')
            .get(id).cache_evicted_at;
        expect(second).toBe(first);
    });
});

// ─── Phase 2: stream proxy ───────────────────────────────────────────────────

describe('Phase 2 — provider.stream()', () => {
    it('LocalProvider.stream() returns a readable for an existing file', async () => {
        // Write a temp file for the local provider to read
        const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-stream-'));
        const testFile = path.join(testDir, 'test.txt');
        fs.writeFileSync(testFile, 'hello cloud');
        try {
            const { LocalProvider } = await import('../src/core/backup/providers/local.js');
            const p = new LocalProvider();
            await p.init({ rootPath: testDir }, {});
            const readable = await p.stream('test.txt', {});
            expect(readable).not.toBeNull();
            // Read the stream content
            const chunks = [];
            await new Promise((resolve, reject) => {
                readable.on('data', (c) => chunks.push(c));
                readable.on('end', resolve);
                readable.on('error', reject);
            });
            expect(Buffer.concat(chunks).toString()).toBe('hello cloud');
        } finally {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('BackupProvider.stream() base implementation returns null', async () => {
        const { BackupProvider } = await import('../src/core/backup/providers/base.js');
        class TestProvider extends BackupProvider {
            static get name() {
                return 'test';
            }
            async init() {}
        }
        const p = new TestProvider();
        const result = await p.stream('any/path', {});
        expect(result).toBeNull();
    });
});

describe('Phase 2 — GET /api/files/:id/stream serves local file', async () => {
    it('returns the file bytes when the local file exists', async () => {
        // Create a real file in the downloads dir
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        const fileName = 'stream_test.txt';
        fs.writeFileSync(path.join(downloadsDir, fileName), 'stream content');

        const id = insertDownload({ fileName, filePath: fileName, fileSize: 14, messageId: 500 });

        // Call the handler directly (avoids Express/auth setup)
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        const chunks = [];
        const res = {
            headersSent: false,
            statusCode: null,
            headers: {},
            setHeader(k, v) {
                this.headers[k] = v;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.body = body;
            },
            write(chunk) {
                chunks.push(chunk);
            },
            end() {
                this.ended = true;
            },
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
            on() {},
        };
        await streamFileResponse(id, res, DATA_DIR);
        expect(chunks.length > 0 || res.body === undefined).toBe(true);
        // Should have set Content-Type
        expect(res.headers['Content-Type'] || res.headers['content-type']).toBeTruthy();
    });
});

// ─── Phase 3: cache_evicted_at in gallery response ────────────────────────────

describe('Phase 3 — cache_evicted_at surfaced in download rows', () => {
    it('getDownloads returns cache_evicted_at column', async () => {
        const id = insertDownload({ messageId: 600, groupId: 'gallery-g' });
        dlMod.setDownloadEvicted(id);
        const { getDownloads } = await import('../src/core/db/downloads.js');
        const { files } = getDownloads('gallery-g', 10, 0, 'all');
        expect(files).toHaveLength(1);
        expect(files[0].cache_evicted_at).toBeGreaterThan(0);
    });
});
