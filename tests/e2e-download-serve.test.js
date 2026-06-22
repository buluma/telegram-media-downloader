// Product-flow e2e: insert a download row → write a file on disk →
// serve it via streamFileResponse → verify the bytes match.
//
// Satisfies the CLAUDE.md e2e mandate for the core download → DB → serve path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Writable } from 'stream';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-e2e-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

let db;
let dbApi;
let streamFileResponse;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    const filesMod = await import('../src/web/routes/files.js');
    streamFileResponse = filesMod.streamFileResponse;
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function mockRes() {
    const chunks = [];
    const headers = {};
    let statusCode = 200;
    const res = new Writable({
        write(chunk, _enc, cb) {
            chunks.push(chunk);
            cb();
        },
    });
    res.setHeader = (k, v) => {
        headers[k.toLowerCase()] = v;
    };
    res.status = (code) => {
        statusCode = code;
        return res;
    };
    res.json = (body) => {
        res._json = body;
        res.end();
    };
    res.write = (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
        if (args[0]) chunks.push(Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0]));
        try {
            originalEnd();
        } catch {}
    };
    res._chunks = chunks;
    res._headers = headers;
    res._statusCode = () => statusCode;
    return res;
}

describe('e2e: download → DB → serve', () => {
    it('inserts a download, writes a file, and serves it back', async () => {
        const groupDir = path.join(DOWNLOADS_DIR, 'test-group', 'photos');
        fs.mkdirSync(groupDir, { recursive: true });
        const fileContent = Buffer.from('fake-jpeg-content-for-e2e-test');
        const filePath = 'test-group/photos/photo_001.jpg';
        fs.writeFileSync(path.join(DOWNLOADS_DIR, filePath), fileContent);

        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            '-100999',
            'test-group',
            1,
            'photo_001.jpg',
            fileContent.length,
            'photo',
            filePath,
            'completed',
        );

        const row = db
            .prepare('SELECT id FROM downloads WHERE group_id = ? AND message_id = ?')
            .get('-100999', 1);
        expect(row).toBeTruthy();

        const res = mockRes();
        await streamFileResponse(row.id, res, DATA_DIR);

        expect(res._statusCode()).toBe(200);
        expect(res._headers['content-type']).toBe('image/jpeg');
        expect(res._headers['content-length']).toBe(fileContent.length);
        const served = Buffer.concat(res._chunks);
        expect(served.equals(fileContent)).toBe(true);
    });

    it('returns 404 for a non-existent download id', async () => {
        const res = mockRes();
        await streamFileResponse(999999, res, DATA_DIR);
        expect(res._statusCode()).toBe(404);
        expect(res._json?.error).toBe('Not found');
    });

    it('rejects path traversal in file_path', async () => {
        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            '-100998',
            'evil-group',
            2,
            'evil.jpg',
            10,
            'photo',
            '../../../etc/passwd',
            'completed',
        );

        const row = db
            .prepare('SELECT id FROM downloads WHERE group_id = ? AND message_id = ?')
            .get('-100998', 2);
        const res = mockRes();
        await streamFileResponse(row.id, res, DATA_DIR);
        expect(res._statusCode()).toBe(400);
        expect(res._json?.error).toBe('Invalid file path');
    });

    it('returns 501 when file is missing from disk and no cloud backup', async () => {
        db.prepare(`
            INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            '-100997',
            'ghost-group',
            3,
            'gone.mp4',
            1000,
            'video',
            'ghost-group/videos/gone.mp4',
            'completed',
        );

        const row = db
            .prepare('SELECT id FROM downloads WHERE group_id = ? AND message_id = ?')
            .get('-100997', 3);
        const res = mockRes();
        await streamFileResponse(row.id, res, DATA_DIR);
        expect(res._statusCode()).toBe(501);
    });
});
