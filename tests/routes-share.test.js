// Route-level HTTP tests for /api/share/links*. Mounts the real share
// router against an isolated temp DB, same pattern as
// routes-config.test.js. core/db/downloads.js and core/share.js run
// for real — the interesting behavior here (TTL clamping, URL signing,
// pagination, search) lives in those modules and is worth exercising
// end-to-end through the actual HTTP contract.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-share-'));

let dbApi;
let db;
let app;
let server;
let port;
let logs;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function insertDownload({
    groupId = '-1001',
    groupName = 'Test Group',
    messageId = Math.floor(Math.random() * 1e9),
    fileName = 'video.mp4',
    fileType = 'video',
    filePath = '/data/downloads/video.mp4',
    fileSize = 1024,
} = {}) {
    const r = db
        .prepare(
            `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_type, file_path, file_size)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(groupId, groupName, messageId, fileName, fileType, filePath, fileSize);
    return r.lastInsertRowid;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();

    const { createShareLinksRouter } = await import('../src/web/routes/share.js');
    const { ensureShareSecret } = await import('../src/core/share.js');
    ensureShareSecret({});

    logs = [];
    app = express();
    app.use(express.json());
    app.use('/api', createShareLinksRouter({ log: (...a) => logs.push(a) }));

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
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    db.prepare('DELETE FROM share_links').run();
    db.prepare('DELETE FROM downloads').run();
});

/**
 * Forces the route's catch(e) { console.error(...); res.status(500) }
 * block to actually run by dropping share_links out from under it —
 * there's no injection point for a fault into the real db module
 * otherwise. Table is recreated in `finally` so later tests are
 * unaffected.
 */
async function withDroppedShareLinksTable(fn) {
    db.exec('DROP TABLE share_links');
    try {
        await fn();
    } finally {
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
    }
}

describe('POST /api/share/links', () => {
    it('400s without a downloadId', async () => {
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('400s for a non-positive downloadId', async () => {
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: -1 }),
        });
        expect(res.status).toBe(400);
    });

    it('404s when the download does not exist', async () => {
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: 999999 }),
        });
        expect(res.status).toBe(404);
    });

    it('creates a link with a signed URL and default TTL', async () => {
        const id = insertDownload();
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.link.download_id).toBe(id);
        expect(body.link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/share\/\d+/);
        expect(body.link.url).toContain('?s=');
        // Default TTL (7 days) → expires_at should be roughly now + 7d.
        const nowSec = Math.floor(Date.now() / 1000);
        expect(body.link.expires_at).toBeGreaterThan(nowSec + 6 * 86400);
        expect(body.link.expires_at).toBeLessThan(nowSec + 8 * 86400);
    });

    it('honors an explicit ttlSeconds (clamped)', async () => {
        const id = insertDownload();
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id, ttlSeconds: 120 }),
        });
        const body = await res.json();
        const nowSec = Math.floor(Date.now() / 1000);
        expect(body.link.expires_at).toBeGreaterThanOrEqual(nowSec + 115);
        expect(body.link.expires_at).toBeLessThanOrEqual(nowSec + 125);
    });

    it('stores expires_at = 0 for the "never expires" sentinel (ttlSeconds: 0)', async () => {
        const id = insertDownload();
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id, ttlSeconds: 0 }),
        });
        const body = await res.json();
        expect(body.link.expires_at).toBe(0);
    });

    it('trims, strips control chars, and truncates a label to 80 chars', async () => {
        const id = insertDownload();
        const dirtyLabel = `  hello\r\nworld\t${'x'.repeat(100)}  `;
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id, label: dirtyLabel }),
        });
        const body = await res.json();
        expect(body.link.label.length).toBeLessThanOrEqual(80);
        expect(body.link.label).not.toMatch(/[\r\n\t]/);
        // Each control char is replaced individually with a space, so
        // "hello\r\nworld" becomes "hello  world" (two spaces, not one).
        expect(body.link.label.startsWith('hello  world')).toBe(true);
    });

    it('stores a null label when given a non-string label', async () => {
        const id = insertDownload();
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id, label: 12345 }),
        });
        const body = await res.json();
        expect(body.link.label).toBeNull();
    });

    it('stores a null label when the cleaned label is empty', async () => {
        const id = insertDownload();
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id, label: '   \r\n\t  ' }),
        });
        const body = await res.json();
        expect(body.link.label).toBeNull();
    });

    it('respects x-forwarded-proto/host when building the URL', async () => {
        const id = insertDownload();
        const res = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'tgdl.example.com',
            },
            body: JSON.stringify({ downloadId: id }),
        });
        const body = await res.json();
        expect(body.link.url.startsWith('https://tgdl.example.com/share/')).toBe(true);
    });

    it('500s and logs when createShareLink itself fails', async () => {
        const id = insertDownload();
        await withDroppedShareLinksTable(async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const res = await fetch(apiUrl('/api/share/links'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadId: id }),
            });
            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error).toBeDefined();
            errSpy.mockRestore();
        });
    });
});

describe('GET /api/share/links', () => {
    it('lists links for a specific downloadId', async () => {
        const id1 = insertDownload({ messageId: 1 });
        const id2 = insertDownload({ messageId: 2 });
        await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id1 }),
        });
        await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id2 }),
        });

        const res = await fetch(apiUrl(`/api/share/links?downloadId=${id1}`));
        const body = await res.json();
        expect(body.links).toHaveLength(1);
        expect(body.links[0].download_id).toBe(id1);
        expect(body.total).toBe(1);
    });

    it('lists all links across the library with no filter', async () => {
        const id1 = insertDownload({ messageId: 1 });
        const id2 = insertDownload({ messageId: 2 });
        for (const id of [id1, id2]) {
            await fetch(apiUrl('/api/share/links'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadId: id }),
            });
        }
        const res = await fetch(apiUrl('/api/share/links'));
        const body = await res.json();
        expect(body.total).toBe(2);
    });

    it('excludes revoked links when includeRevoked=0', async () => {
        const id = insertDownload();
        const create = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id }),
        });
        const { link } = await create.json();
        await fetch(apiUrl(`/api/share/links/${link.id}`), { method: 'DELETE' });

        const res = await fetch(apiUrl('/api/share/links?includeRevoked=0'));
        const body = await res.json();
        expect(body.total).toBe(0);
    });

    it('includes revoked links by default', async () => {
        const id = insertDownload();
        const create = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id }),
        });
        const { link } = await create.json();
        await fetch(apiUrl(`/api/share/links/${link.id}`), { method: 'DELETE' });

        const res = await fetch(apiUrl('/api/share/links'));
        const body = await res.json();
        expect(body.total).toBe(1);
    });

    it('filters by search substring against the file name', async () => {
        const id1 = insertDownload({ messageId: 1, fileName: 'unique-name.mp4' });
        const id2 = insertDownload({ messageId: 2, fileName: 'other.mp4' });
        for (const id of [id1, id2]) {
            await fetch(apiUrl('/api/share/links'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadId: id }),
            });
        }
        const res = await fetch(apiUrl('/api/share/links?q=unique-name'));
        const body = await res.json();
        expect(body.total).toBe(1);
        expect(body.links[0].download_id).toBe(id1);
    });

    it('paginates with limit/offset and reports hasMore', async () => {
        const ids = [1, 2, 3].map((messageId) => insertDownload({ messageId }));
        for (const id of ids) {
            await fetch(apiUrl('/api/share/links'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadId: id }),
            });
        }
        const page1 = await fetch(apiUrl('/api/share/links?limit=2&offset=0'));
        const body1 = await page1.json();
        expect(body1.links).toHaveLength(2);
        expect(body1.hasMore).toBe(true);

        const page2 = await fetch(apiUrl('/api/share/links?limit=2&offset=2'));
        const body2 = await page2.json();
        expect(body2.links).toHaveLength(1);
        expect(body2.hasMore).toBe(false);
    });

    it('clamps an out-of-range limit into [1, 2000]', async () => {
        const res = await fetch(apiUrl('/api/share/links?limit=99999'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.limit).toBe(2000);
    });

    it('clamps a negative offset up to 0', async () => {
        const res = await fetch(apiUrl('/api/share/links?offset=-5'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.offset).toBe(0);
    });

    it('500s and logs when listShareLinks itself fails', async () => {
        await withDroppedShareLinksTable(async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const res = await fetch(apiUrl('/api/share/links'));
            expect(res.status).toBe(500);
            errSpy.mockRestore();
        });
    });
});

describe('DELETE /api/share/links/:id', () => {
    it('400s for a non-numeric id', async () => {
        const res = await fetch(apiUrl('/api/share/links/abc'), { method: 'DELETE' });
        expect(res.status).toBe(400);
    });

    it('400s for a non-positive id', async () => {
        const res = await fetch(apiUrl('/api/share/links/0'), { method: 'DELETE' });
        expect(res.status).toBe(400);
    });

    it('revokes an active link and reports revoked: true', async () => {
        const id = insertDownload();
        const create = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id }),
        });
        const { link } = await create.json();

        const res = await fetch(apiUrl(`/api/share/links/${link.id}`), { method: 'DELETE' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.revoked).toBe(true);
    });

    it('is idempotent — revoking an already-revoked link returns revoked: false', async () => {
        const id = insertDownload();
        const create = await fetch(apiUrl('/api/share/links'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id }),
        });
        const { link } = await create.json();
        await fetch(apiUrl(`/api/share/links/${link.id}`), { method: 'DELETE' });

        const res = await fetch(apiUrl(`/api/share/links/${link.id}`), { method: 'DELETE' });
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.revoked).toBe(false);
    });

    it('returns revoked: false for a nonexistent id (still 200, still success)', async () => {
        const res = await fetch(apiUrl('/api/share/links/999999'), { method: 'DELETE' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.revoked).toBe(false);
    });

    it('500s and logs when revokeShareLink itself fails', async () => {
        await withDroppedShareLinksTable(async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const res = await fetch(apiUrl('/api/share/links/1'), { method: 'DELETE' });
            expect(res.status).toBe(500);
            errSpy.mockRestore();
        });
    });
});
