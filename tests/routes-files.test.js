// Tests for src/web/routes/files.js — both streamFileResponse() called
// directly (it accepts an overridable dataDir specifically so tests
// don't need a full Express server) and the thin router wrapper for
// id validation + top-level error handling.
//
// core/db/downloads.js and core/backup/manager.js are mocked; real fs
// is used to write/stream actual temp files under a throwaway dataDir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

const getDownloadById = vi.fn();
vi.mock('../src/core/db/downloads.js', () => ({
    getDownloadById: (...a) => getDownloadById(...a),
}));

const getCloudStream = vi.fn();
vi.mock('../src/core/backup/manager.js', () => ({
    getCloudStream: (...a) => getCloudStream(...a),
}));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-files-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

function makeFakeRes() {
    const chunks = [];
    const headers = {};
    return {
        statusCode: null,
        headersSent: false,
        chunks,
        headers,
        jsonBody: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.jsonBody = body;
            this.headersSent = true;
            return this;
        },
        setHeader(k, v) {
            headers[k] = v;
        },
        write(chunk) {
            chunks.push(chunk);
        },
        end() {
            this.headersSent = true;
        },
    };
}

async function waitForListeners(emitter, event) {
    for (let i = 0; i < 50; i++) {
        if (emitter.listenerCount(event) > 0) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no '${event}' listener attached after waiting`);
}

function writeFile(relPath, content) {
    const full = path.join(DOWNLOADS_DIR, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

beforeEach(() => {
    vi.resetAllMocks();
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
});

describe('streamFileResponse', () => {
    it('404s when the download row does not exist', async () => {
        getDownloadById.mockReturnValue(null);
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.statusCode).toBe(404);
    });

    it('streams a local file with the guessed content type and length', async () => {
        writeFile('a.jpg', Buffer.from('fake-jpeg-bytes'));
        getDownloadById.mockReturnValue({ file_path: 'a.jpg', file_name: 'a.jpg' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.headers['Content-Type']).toBe('image/jpeg');
        expect(res.headers['Content-Length']).toBe(15);
        expect(Buffer.concat(res.chunks).toString()).toBe('fake-jpeg-bytes');
        expect(res.headersSent).toBe(true);
    });

    it('falls back to application/octet-stream for an unknown extension', async () => {
        writeFile('b.xyz', 'hi');
        getDownloadById.mockReturnValue({ file_path: 'b.xyz' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.headers['Content-Type']).toBe('application/octet-stream');
    });

    it('resolves nested subdirectory paths', async () => {
        writeFile(path.join('sub', 'dir', 'c.png'), 'png-bytes');
        getDownloadById.mockReturnValue({ file_path: 'sub/dir/c.png' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.headers['Content-Type']).toBe('image/png');
        expect(Buffer.concat(res.chunks).toString()).toBe('png-bytes');
    });

    it('falls back to file_name when file_path is empty', async () => {
        writeFile('d.mp4', 'video-bytes');
        getDownloadById.mockReturnValue({ file_path: '', file_name: 'd.mp4' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.headers['Content-Type']).toBe('video/mp4');
    });

    it('400s on a path-traversal attempt via ".."', async () => {
        getDownloadById.mockReturnValue({ file_path: '../../../etc/passwd' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.statusCode).toBe(400);
    });

    it('400s on an absolute posix path', async () => {
        getDownloadById.mockReturnValue({ file_path: '/etc/passwd' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.statusCode).toBe(400);
    });

    it('404s when the resolved local path is a directory, not a file', async () => {
        fs.mkdirSync(path.join(DOWNLOADS_DIR, 'a-directory'));
        getDownloadById.mockReturnValue({ file_path: 'a-directory' });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.statusCode).toBe(404);
    });

    it('falls back to the cloud stream when the local file is absent (evicted)', async () => {
        getDownloadById.mockReturnValue({ file_path: 'evicted.mp4', file_name: 'evicted.mp4' });
        const stream = new EventEmitter();
        const provider = { close: vi.fn().mockResolvedValue(undefined) };
        getCloudStream.mockResolvedValue({ stream, size: 42, provider });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        const p = streamFileResponse(1, res, DATA_DIR);
        await waitForListeners(stream, 'end');
        stream.emit('data', Buffer.from('cloud-bytes'));
        stream.emit('end');
        await p;
        expect(res.headers['Content-Type']).toBe('video/mp4');
        expect(res.headers['Content-Length']).toBe(42);
        expect(Buffer.concat(res.chunks).toString()).toBe('cloud-bytes');
        expect(provider.close).toHaveBeenCalled();
    });

    it('omits Content-Length when the cloud stream reports no size', async () => {
        getDownloadById.mockReturnValue({ file_path: 'evicted.mp4' });
        const stream = new EventEmitter();
        const provider = { close: vi.fn().mockResolvedValue(undefined) };
        getCloudStream.mockResolvedValue({ stream, size: 0, provider });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        const p = streamFileResponse(1, res, DATA_DIR);
        await waitForListeners(stream, 'end');
        stream.emit('end');
        await p;
        expect('Content-Length' in res.headers).toBe(false);
    });

    it('501s when there is no local file and no cloud stream available', async () => {
        getDownloadById.mockReturnValue({ file_path: 'evicted.mp4' });
        getCloudStream.mockResolvedValue(null);
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.statusCode).toBe(501);
    });

    it('501s (not throws) when getCloudStream itself rejects', async () => {
        getDownloadById.mockReturnValue({ file_path: 'evicted.mp4' });
        getCloudStream.mockRejectedValue(new Error('provider init failed'));
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        await streamFileResponse(1, res, DATA_DIR);
        expect(res.statusCode).toBe(501);
    });

    it('still closes the provider even when the cloud stream errors mid-transfer', async () => {
        getDownloadById.mockReturnValue({ file_path: 'evicted.mp4' });
        const stream = new EventEmitter();
        const provider = { close: vi.fn().mockResolvedValue(undefined) };
        getCloudStream.mockResolvedValue({ stream, size: 10, provider });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        const p = streamFileResponse(1, res, DATA_DIR);
        const failure = expect(p).rejects.toThrow('stream broke');
        await waitForListeners(stream, 'error');
        stream.emit('error', new Error('stream broke'));
        await failure;
        expect(provider.close).toHaveBeenCalled();
    });

    it('swallows a provider.close() failure without throwing', async () => {
        getDownloadById.mockReturnValue({ file_path: 'evicted.mp4' });
        const stream = new EventEmitter();
        const provider = { close: vi.fn().mockRejectedValue(new Error('close failed')) };
        getCloudStream.mockResolvedValue({ stream, size: 10, provider });
        const res = makeFakeRes();
        const { streamFileResponse } = await import('../src/web/routes/files.js');
        const p = streamFileResponse(1, res, DATA_DIR);
        await waitForListeners(stream, 'end');
        stream.emit('end');
        await expect(p).resolves.toBeUndefined();
    });
});

describe('GET /api/files/:id/stream (router)', () => {
    let app, server, port;

    async function apiUrl(p) {
        return `http://127.0.0.1:${port}${p}`;
    }

    beforeEach(async () => {
        const { createFilesRouter } = await import('../src/web/routes/files.js');
        app = express();
        app.use('/api', createFilesRouter());
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    it('400s for a non-numeric id', async () => {
        const res = await fetch(await apiUrl('/api/files/abc/stream'));
        expect(res.status).toBe(400);
    });

    it('400s for a non-positive id', async () => {
        const res = await fetch(await apiUrl('/api/files/0/stream'));
        expect(res.status).toBe(400);
    });

    it('delegates a valid id to streamFileResponse using the default data dir', async () => {
        // The router always calls streamFileResponse(id, res) with no
        // dataDir override, so it resolves against the module's real
        // DEFAULT_DATA_DIR — not our temp dir — and neither the local
        // file nor a cloud stream exist here, landing on 501. The actual
        // streaming logic against an overridable dataDir is covered by
        // the direct-call tests above; this only pins that the router
        // wires id validation through to the real function correctly.
        getDownloadById.mockReturnValue({ file_path: 'router-test.txt' });
        const res = await fetch(await apiUrl('/api/files/1/stream'));
        expect(res.status).toBe(501);
    });

    it('500s (without double-sending headers) when streamFileResponse throws before headers are sent', async () => {
        getDownloadById.mockImplementation(() => {
            throw new Error('db exploded');
        });
        const res = await fetch(await apiUrl('/api/files/1/stream'));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('db exploded');
    });
});
