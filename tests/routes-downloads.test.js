// Route-level tests for src/web/routes/downloads.js — real config/manager.js
// and real core/db.js against an isolated TGDL_DATA_DIR temp dir (same
// convention as groups-bulk.test.js / routes-groups.test.js), with real
// files on disk so the file-touching endpoints (bulk-delete, bulk-zip,
// DELETE /file, archive-list, purge/all, unpinned-videos) exercise their
// actual fs behaviour instead of being mocked away.
//
// Two real production bugs fixed alongside these tests — the same
// TGDL_DATA_DIR-ignoring pattern found earlier in monitor.js/stats.js/
// accounts.js/dialogs.js/groups.js, this time in two shared modules used
// by nearly every file-serving route:
//   - web/lib/resolve-download.js hardcoded DOWNLOADS_DIR to the in-repo
//     data/downloads, so safeResolveDownload() always resolved against
//     the real repo tree regardless of TGDL_DATA_DIR.
//   - core/delete-queue.js hardcoded DOWNLOADS_DIR/DELETED_DIR the same
//     way, so deferDelete() renamed files into the wrong .deleted dir.
// Both are used across cluster.js, downloads.js, and files.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-downloads-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

let manager;
let dbApi;
let downloadsApi;
let app;
let server;
let port;
let broadcasts;
let jobTrackers;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function get(p) {
    const res = await fetch(apiUrl(p));
    let body = null;
    try {
        body = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body, res };
}

async function post(p, body) {
    const res = await fetch(apiUrl(p), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    let parsed = null;
    try {
        parsed = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body: parsed, res };
}

async function del(p) {
    const res = await fetch(apiUrl(p), { method: 'DELETE' });
    let body = null;
    try {
        body = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body };
}

function writeFile(relPath, content = 'x') {
    const abs = path.join(DOWNLOADS_DIR, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    manager = await import('../src/config/manager.js');
    const { createJobTracker } = await import('../src/core/job-tracker.js');

    const { createDownloadsRouter } = await import('../src/web/routes/downloads.js');
    broadcasts = [];
    const broadcast = (m) => broadcasts.push(m);
    jobTrackers = {
        dedupDelete: createJobTracker({ kind: 'dedupDelete', broadcast }),
        purgeAll: createJobTracker({ kind: 'purgeAll', broadcast }),
        deleteUnpinnedVideos: createJobTracker({ kind: 'deleteUnpinnedVideos', broadcast }),
    };

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.role = 'admin';
        next();
    });
    app.use(
        '/api',
        createDownloadsRouter({
            broadcast,
            log: () => {},
            jobTrackers,
            getDialogsNameCache: async () => new Map(),
            dialogsTypeFor: () => null,
        }),
    );
    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
    try {
        dbApi.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
    const cfg = manager.loadConfig();
    cfg.groups = [];
    await manager.saveConfig(cfg);
    for (const table of ['downloads', 'backup_jobs']) {
        try {
            dbApi.getDb().prepare(`DELETE FROM ${table}`).run();
        } catch {
            /* table may not exist in older schemas */
        }
    }
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.rmSync(PHOTOS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    broadcasts.length = 0;
});

describe('GET /api/downloads', () => {
    it('summarises per-group counts and sizes', async () => {
        downloadsApi.insertDownload({
            groupId: '-100111',
            groupName: 'Grp',
            messageId: 1,
            fileSize: 100,
        });
        downloadsApi.insertDownload({
            groupId: '-100111',
            groupName: 'Grp',
            messageId: 2,
            fileSize: 200,
        });
        const { status, body } = await get('/api/downloads');
        expect(status).toBe(200);
        const row = body.find((r) => r.id === '-100111');
        expect(row.totalFiles).toBe(2);
        expect(row.totalSize).toBe(300);
    });

    it('renders comment: groups with a "(comments)" suffix derived from the parent', async () => {
        downloadsApi.insertDownload({
            groupId: 'comment:-100222',
            groupName: 'Parent',
            messageId: 1,
            fileSize: 50,
        });
        const { body } = await get('/api/downloads');
        const row = body.find((r) => r.id === 'comment:-100222');
        expect(row.name).toMatch(/\(comments\)$/);
    });
});

describe('GET /api/downloads/all', () => {
    beforeEach(() => {
        downloadsApi.insertDownload({
            groupId: '-100333',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'a.jpg',
            fileType: 'photo',
            fileSize: 10,
            filePath: 'Grp/images/a.jpg',
        });
        downloadsApi.insertDownload({
            groupId: '-100333',
            groupName: 'Grp',
            messageId: 2,
            fileName: 'b.mp4',
            fileType: 'video',
            fileSize: 20,
            filePath: 'Grp/videos/b.mp4',
        });
    });

    it('paginates across all groups', async () => {
        const { status, body } = await get('/api/downloads/all?limit=1&page=1');
        expect(status).toBe(200);
        expect(body.files).toHaveLength(1);
        expect(body.total).toBe(2);
        expect(body.totalPages).toBe(2);
    });

    it('filters by type', async () => {
        const { body } = await get('/api/downloads/all?type=videos');
        expect(body.files).toHaveLength(1);
        expect(body.files[0].type).toBe('videos');
    });

    it('filters to clips only via ?clipped=1', async () => {
        downloadsApi.insertDownload({
            groupId: '-100333',
            groupName: 'Grp',
            messageId: -1, // clips take negative, never-Telegram message_ids — see src/core/clip.js
            fileName: 'b.clip-0s-5s-abc123.mp4',
            fileType: 'video',
            fileSize: 5,
            filePath: 'Grp/videos/b.clip-0s-5s-abc123.mp4',
        });
        const { status, body } = await get('/api/downloads/all?clipped=1');
        expect(status).toBe(200);
        expect(body.files).toHaveLength(1);
        expect(body.files[0].name).toBe('b.clip-0s-5s-abc123.mp4');
    });

    it('forces federation scope to local for a guest role', async () => {
        const guestApp = express();
        guestApp.use(express.json());
        guestApp.use((req, _res, next) => {
            req.role = 'guest';
            next();
        });
        const { createDownloadsRouter } = await import('../src/web/routes/downloads.js');
        guestApp.use(
            '/api',
            createDownloadsRouter({
                broadcast: () => {},
                log: () => {},
                jobTrackers,
                getDialogsNameCache: async () => new Map(),
                dialogsTypeFor: () => null,
            }),
        );
        await new Promise((resolve) => {
            const s = guestApp.listen(0, '127.0.0.1', async () => {
                const p = s.address().port;
                const res = await fetch(`http://127.0.0.1:${p}/api/downloads/all?include=peers`);
                expect(res.status).toBe(200);
                s.close(resolve);
            });
        });
    });
});

describe('GET /api/downloads/:groupId', () => {
    it('lists files for a single group with a fallback folder derived from the name', async () => {
        downloadsApi.insertDownload({
            groupId: '-100444',
            groupName: 'MyGroup',
            messageId: 1,
            fileName: 'c.pdf',
            fileType: 'document',
            fileSize: 5,
        });
        const { status, body } = await get('/api/downloads/-100444');
        expect(status).toBe(200);
        expect(body.files).toHaveLength(1);
        expect(body.files[0].fullPath).toContain('documents/c.pdf');
    });

    it('falls through to the search route instead of matching :groupId', async () => {
        const { status, body } = await get('/api/downloads/search?q=');
        expect(status).toBe(200);
        expect(body.files).toEqual([]);
    });
});

describe('GET /api/downloads/search', () => {
    it('returns empty results for a blank query', async () => {
        const { body } = await get('/api/downloads/search?q=  ');
        expect(body).toEqual({ files: [], total: 0, page: 1, totalPages: 0 });
    });

    it('matches by file name', async () => {
        downloadsApi.insertDownload({
            groupId: '-100555',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'unique-name.jpg',
            fileType: 'photo',
            fileSize: 5,
        });
        const { body } = await get('/api/downloads/search?q=unique-name');
        expect(body.files).toHaveLength(1);
    });
});

describe('POST /api/downloads/bulk-delete', () => {
    it('400s without ids or paths', async () => {
        const { status } = await post('/api/downloads/bulk-delete', {});
        expect(status).toBe(400);
    });

    it('deletes matching rows and defers the on-disk file into .deleted', async () => {
        const abs = writeFile('Grp/images/d.jpg');
        const r = downloadsApi.insertDownload({
            groupId: '-100666',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'd.jpg',
            fileType: 'photo',
            fileSize: 1,
            filePath: 'Grp/images/d.jpg',
        });
        const { status, body } = await post('/api/downloads/bulk-delete', {
            ids: [r.lastInsertRowid],
        });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        for (let i = 0; i < 50; i++) {
            const st = jobTrackers.dedupDelete.getStatus();
            if (!st.running) break;
            await new Promise((res) => setTimeout(res, 20));
        }
        expect(fs.existsSync(abs)).toBe(false);
        const remaining = dbApi
            .getDb()
            .prepare('SELECT COUNT(*) AS n FROM downloads WHERE id = ?')
            .get(r.lastInsertRowid).n;
        expect(remaining).toBe(0);
    });
});

describe('POST /api/downloads/:id/pin', () => {
    it('400s for a non-numeric id', async () => {
        const { status } = await post('/api/downloads/abc/pin', { pinned: true });
        expect(status).toBe(400);
    });

    it('400s when pinned is not a boolean', async () => {
        const { status } = await post('/api/downloads/1/pin', {});
        expect(status).toBe(400);
    });

    it('404s for a nonexistent download', async () => {
        const { status } = await post('/api/downloads/999999/pin', { pinned: true });
        expect(status).toBe(404);
    });

    it('pins a download and broadcasts', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-100777',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'e.jpg',
        });
        const { status, body } = await post(`/api/downloads/${r.lastInsertRowid}/pin`, {
            pinned: true,
        });
        expect(status).toBe(200);
        expect(body.pinned).toBe(true);
        expect(broadcasts.some((b) => b.type === 'download_pinned')).toBe(true);
    });
});

describe('POST /api/downloads/:id/viewed', () => {
    it('400s for an invalid id', async () => {
        const { status } = await post('/api/downloads/0/viewed');
        expect(status).toBe(400);
    });

    it('stamps last_viewed_at', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-100888',
            groupName: 'Grp',
            messageId: 1,
        });
        const { status, body } = await post(`/api/downloads/${r.lastInsertRowid}/viewed`);
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        const row = dbApi
            .getDb()
            .prepare('SELECT last_viewed_at FROM downloads WHERE id = ?')
            .get(r.lastInsertRowid);
        expect(row.last_viewed_at).not.toBeNull();
    });
});

describe('GET /api/downloads/:id/backup-status', () => {
    it('404s for a nonexistent download', async () => {
        const { status } = await get('/api/downloads/999999/backup-status');
        expect(status).toBe(404);
    });

    it('reports false when no backup job exists', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-100999',
            groupName: 'Grp',
            messageId: 1,
        });
        const { body } = await get(`/api/downloads/${r.lastInsertRowid}/backup-status`);
        expect(body.backedUp).toBe(false);
    });
});

describe('POST /api/downloads/:id/backup', () => {
    it('404s for a download with no file_path', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-101000',
            groupName: 'Grp',
            messageId: 1,
        });
        const { status } = await post(`/api/downloads/${r.lastInsertRowid}/backup`);
        expect(status).toBe(404);
    });

    it('queues 0 jobs when no destinations are configured', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-101001',
            groupName: 'Grp',
            messageId: 1,
            filePath: 'Grp/images/f.jpg',
        });
        const { status, body } = await post(`/api/downloads/${r.lastInsertRowid}/backup`);
        expect(status).toBe(200);
        expect(body.queued).toBe(0);
    });
});

describe('POST /api/downloads/:id/playback-verify', () => {
    it('404s for a nonexistent download', async () => {
        const { status } = await post('/api/downloads/999999/playback-verify');
        expect(status).toBe(404);
    });

    it('404s when the on-disk file is missing', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-101002',
            groupName: 'Grp',
            messageId: 1,
            filePath: 'Grp/videos/missing.mp4',
        });
        const { status } = await post(`/api/downloads/${r.lastInsertRowid}/playback-verify`);
        expect(status).toBe(404);
    });

    it('reports ok:false via ffprobe for a file that is not actually a video', async () => {
        writeFile('Grp/videos/notreally.mp4', 'not a real video file');
        const r = downloadsApi.insertDownload({
            groupId: '-101003',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'notreally.mp4',
            filePath: 'Grp/videos/notreally.mp4',
        });
        const { status, body } = await post(`/api/downloads/${r.lastInsertRowid}/playback-verify`);
        expect(status).toBe(200);
        expect(body.probe.ok).toBe(false);
    });
});

describe('POST /api/downloads/:id/clip', () => {
    it('404s for a nonexistent download', async () => {
        const { status } = await post('/api/downloads/999999/clip', { startSec: 0, endSec: 1 });
        expect(status).toBe(404);
    });

    it('400s on an invalid range', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-101010',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'a.mp4',
            filePath: 'Grp/videos/a.mp4',
            fileType: 'video',
        });
        const { status, body } = await post(`/api/downloads/${r.lastInsertRowid}/clip`, {
            startSec: 5,
            endSec: 1,
        });
        expect(status).toBe(400);
        expect(body.error).toMatch(/range/i);
    });

    it('400s for a non-video row', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-101011',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'a.pdf',
            filePath: 'Grp/docs/a.pdf',
            fileType: 'document',
        });
        const { status, body } = await post(`/api/downloads/${r.lastInsertRowid}/clip`, {
            startSec: 0,
            endSec: 1,
        });
        expect(status).toBe(400);
        expect(body.error).toMatch(/video/i);
    });
});

describe('POST /api/downloads/bulk-pin', () => {
    it('400s without ids, without a boolean pinned, or over the batch cap', async () => {
        expect((await post('/api/downloads/bulk-pin', { pinned: true })).status).toBe(400);
        expect((await post('/api/downloads/bulk-pin', { ids: [1] })).status).toBe(400);
        expect(
            (
                await post('/api/downloads/bulk-pin', {
                    ids: Array.from({ length: 10001 }, (_, i) => i + 1),
                    pinned: true,
                })
            ).status,
        ).toBe(400);
    });

    it('bulk-pins matching rows', async () => {
        const r1 = downloadsApi.insertDownload({
            groupId: '-101004',
            groupName: 'G',
            messageId: 1,
        });
        const r2 = downloadsApi.insertDownload({
            groupId: '-101004',
            groupName: 'G',
            messageId: 2,
        });
        const { status, body } = await post('/api/downloads/bulk-pin', {
            ids: [r1.lastInsertRowid, r2.lastInsertRowid],
            pinned: true,
        });
        expect(status).toBe(200);
        expect(body.changed).toBe(2);
    });
});

describe('POST /api/downloads/bulk-zip', () => {
    it('400s without ids', async () => {
        const { status } = await post('/api/downloads/bulk-zip', {});
        expect(status).toBe(400);
    });

    it('404s when no rows match', async () => {
        const { status } = await post('/api/downloads/bulk-zip', { ids: [999999] });
        expect(status).toBe(404);
    });

    it('streams a real zip for matching, resolvable files', async () => {
        writeFile('Grp/images/z1.jpg', 'hello');
        const r = downloadsApi.insertDownload({
            groupId: '-101005',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'z1.jpg',
            fileType: 'photo',
            fileSize: 5,
            filePath: 'Grp/images/z1.jpg',
        });
        const res = await fetch(apiUrl('/api/downloads/bulk-zip'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [r.lastInsertRowid] }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/zip');
        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf.length).toBeGreaterThan(0);
        // Local file header signature.
        expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    });
});

describe('DELETE /api/file', () => {
    it('400s without a path', async () => {
        const { status } = await del('/api/file?');
        expect(status).toBe(400);
    });

    it('404s for a missing file', async () => {
        const { status } = await del('/api/file?path=Grp/images/nope.jpg');
        expect(status).toBe(404);
    });

    it('403s for a path-traversal attempt', async () => {
        const { status } = await del('/api/file?path=' + encodeURIComponent('../../etc/passwd'));
        expect(status).toBe(403);
    });

    it('deletes a real file and its DB rows, and purges thumbs', async () => {
        const abs = writeFile('Grp/images/g.jpg');
        downloadsApi.insertDownload({
            groupId: '-101006',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'g.jpg',
            fileType: 'photo',
            filePath: 'Grp/images/g.jpg',
        });
        const { status, body } = await del(
            '/api/file?path=' + encodeURIComponent('Grp/images/g.jpg'),
        );
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(fs.existsSync(abs)).toBe(false);
        const remaining = dbApi
            .getDb()
            .prepare("SELECT COUNT(*) AS n FROM downloads WHERE file_name = 'g.jpg'")
            .get().n;
        expect(remaining).toBe(0);
    });
});

describe('GET /api/files/archive-list', () => {
    it('400s without a path', async () => {
        const { status } = await get('/api/files/archive-list');
        expect(status).toBe(400);
    });

    it('404s for a missing archive', async () => {
        const { status } = await get(
            '/api/files/archive-list?path=' + encodeURIComponent('Grp/nope.zip'),
        );
        expect(status).toBe(404);
    });

    it('reports single-stream compression as unsupported', async () => {
        writeFile('Grp/plain.txt.gz', 'not really gzip');
        const { status, body } = await get(
            '/api/files/archive-list?path=' + encodeURIComponent('Grp/plain.txt.gz'),
        );
        expect(status).toBe(200);
        expect(body.supported).toBe(false);
        expect(body.reason).toBe('single_stream');
    });

    it('reports an unrecognised extension as unsupported', async () => {
        writeFile('Grp/data.bin', 'x');
        const { status, body } = await get(
            '/api/files/archive-list?path=' + encodeURIComponent('Grp/data.bin'),
        );
        expect(status).toBe(200);
        expect(body.supported).toBe(false);
        expect(body.reason).toBe('unknown_format');
    });

    it('lists real zip contents via unzip -l', async () => {
        const { ZipStream } = await import('../src/core/zip-stream.js');
        const abs = path.join(DOWNLOADS_DIR, 'Grp', 'archive.zip');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const inner = writeFile('Grp/_zipsrc/inner.txt', 'contents');
        await new Promise((resolve, reject) => {
            const zip = new ZipStream();
            const out = fs.createWriteStream(abs);
            zip.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            zip.addFile(inner, 'inner.txt').then(() => zip.finalize());
        });
        const { status, body } = await get(
            '/api/files/archive-list?path=' + encodeURIComponent('Grp/archive.zip'),
        );
        expect(status).toBe(200);
        expect(body.supported).toBe(true);
        expect(body.entries.some((e) => e.name === 'inner.txt')).toBe(true);
    });
});

describe('DELETE /api/purge/all', () => {
    it('409s when a scanner-type job is already running', async () => {
        jobTrackers.aiPeople = { isRunning: () => true };
        const { status, body } = await del('/api/purge/all');
        expect(status).toBe(409);
        expect(body.code).toBe('RESOURCE_BUSY');
        delete jobTrackers.aiPeople;
    });

    it('wipes files, DB rows, groups config, and photos', async () => {
        writeFile('SomeGroup/images/h.jpg');
        fs.writeFileSync(path.join(PHOTOS_DIR, 'x.jpg'), 'x');
        downloadsApi.insertDownload({ groupId: '-101007', groupName: 'SomeGroup', messageId: 1 });
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-101007', name: 'SomeGroup', enabled: true }];
        await manager.saveConfig(cfg);

        const { status, body } = await del('/api/purge/all');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        for (let i = 0; i < 100; i++) {
            const { body: st } = await get('/api/purge/all/status');
            if (!st.running) break;
            await new Promise((res) => setTimeout(res, 20));
        }
        expect(fs.existsSync(path.join(DOWNLOADS_DIR, 'SomeGroup'))).toBe(false);
        expect(fs.readdirSync(PHOTOS_DIR)).toHaveLength(0);
        const count = dbApi.getDb().prepare('SELECT COUNT(*) AS n FROM downloads').get().n;
        expect(count).toBe(0);
        const cfgAfter = manager.loadConfig();
        expect(cfgAfter.groups).toEqual([]);
    });
});

describe('DELETE /api/downloads/unpinned-videos', () => {
    it('409s when a scanner-type job is already running', async () => {
        jobTrackers.aiOcr = { isRunning: () => true };
        const { status } = await del('/api/downloads/unpinned-videos');
        expect(status).toBe(409);
        delete jobTrackers.aiOcr;
    });

    it('deletes unpinned videos but leaves pinned ones and non-videos alone', async () => {
        const unpinned = writeFile('Grp/videos/unpinned.mp4');
        const pinned = writeFile('Grp/videos/pinned.mp4');
        const rUnpinned = downloadsApi.insertDownload({
            groupId: '-101008',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'unpinned.mp4',
            fileType: 'video',
            filePath: 'Grp/videos/unpinned.mp4',
        });
        const rPinned = downloadsApi.insertDownload({
            groupId: '-101008',
            groupName: 'Grp',
            messageId: 2,
            fileName: 'pinned.mp4',
            fileType: 'video',
            filePath: 'Grp/videos/pinned.mp4',
        });
        downloadsApi.setDownloadPinned(rPinned.lastInsertRowid, true);

        const { status, body } = await del('/api/downloads/unpinned-videos');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        for (let i = 0; i < 100; i++) {
            const { body: st } = await get('/api/downloads/unpinned-videos/status');
            if (!st.running) break;
            await new Promise((res) => setTimeout(res, 20));
        }
        expect(fs.existsSync(unpinned)).toBe(false);
        expect(fs.existsSync(pinned)).toBe(true);
        const remaining = dbApi
            .getDb()
            .prepare('SELECT id FROM downloads WHERE id = ?')
            .get(rUnpinned.lastInsertRowid);
        expect(remaining).toBeUndefined();
        const kept = dbApi
            .getDb()
            .prepare('SELECT id FROM downloads WHERE id = ?')
            .get(rPinned.lastInsertRowid);
        expect(kept).toBeDefined();
    });
});
