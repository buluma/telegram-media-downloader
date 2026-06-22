// SFTP provider — mock-only test. We stub `ssh2-sftp-client` via vi.mock
// so a real SSH server isn't needed; the provider's path resolution,
// idempotent-delete tolerance, and abort-signal plumbing get exercised
// against the mock client.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = [];

class MockSftpClient {
    constructor() {
        this._connected = false;
    }
    async connect(opts) {
        calls.push(['connect', opts]);
        this._connected = true;
    }
    async mkdir(p, recursive) {
        calls.push(['mkdir', p, recursive]);
    }
    async put(stream, dest) {
        calls.push(['put', dest]);
        if (stream && typeof stream.on === 'function') {
            await new Promise((res) => {
                stream.on('data', () => {});
                stream.on('end', res);
                stream.on('error', res);
                stream.resume?.();
            });
        }
    }
    async stat(p) {
        calls.push(['stat', p]);
        if (p.includes('missing')) {
            const e = new Error('No such file');
            e.code = 2;
            throw e;
        }
        return { size: 42, modifyTime: 1700000000, isDirectory: p.endsWith('backup') };
    }
    async delete(p) {
        calls.push(['delete', p]);
        if (p.includes('already-gone')) {
            const e = new Error('No such file');
            e.code = 2;
            throw e;
        }
    }
    async list(dir) {
        calls.push(['list', dir]);
        if (dir.endsWith('/backup') || dir.endsWith('/backup/photos')) {
            return [
                { name: 'a.txt', type: '-', size: 42, modifyTime: 1700000000 },
                ...(dir.endsWith('/backup')
                    ? [{ name: 'photos', type: 'd', size: 0, modifyTime: 0 }]
                    : []),
            ];
        }
        return [];
    }
    async end() {
        calls.push(['end']);
        this._connected = false;
    }
}

vi.mock('ssh2-sftp-client', () => ({
    default: MockSftpClient,
}));

let SftpProvider;
const ctx = { destinationId: 1, log: () => {}, signal: new AbortController().signal };

beforeEach(async () => {
    calls.length = 0;
    const mod = await import('../src/core/backup/providers/sftp.js');
    SftpProvider = mod.SftpProvider;
});

describe('backup/providers/sftp (mocked)', () => {
    it('init connects + ensures the remote root', async () => {
        const p = new SftpProvider();
        await p.init(
            { host: 'nas.lan', username: 'tester', password: 'pw', remoteRoot: '/backup' },
            ctx,
        );
        const conn = calls.find((c) => c[0] === 'connect');
        expect(conn[1].host).toBe('nas.lan');
        expect(conn[1].username).toBe('tester');
        expect(conn[1].port).toBe(22);
        expect(calls.some((c) => c[0] === 'mkdir' && c[1] === '/backup')).toBe(true);
    });

    it('init rejects when host missing', async () => {
        const p = new SftpProvider();
        await expect(
            p.init({ username: 'u', password: 'pw', remoteRoot: '/r' }, ctx),
        ).rejects.toThrow(/host required/);
    });

    it('init rejects when username missing', async () => {
        const p = new SftpProvider();
        await expect(p.init({ host: 'h', password: 'pw', remoteRoot: '/r' }, ctx)).rejects.toThrow(
            /username required/,
        );
    });

    it('init rejects when remoteRoot missing', async () => {
        const p = new SftpProvider();
        await expect(p.init({ host: 'h', username: 'u', password: 'pw' }, ctx)).rejects.toThrow(
            /remoteRoot required/,
        );
    });

    it('init rejects relative remoteRoot', async () => {
        const p = new SftpProvider();
        await expect(
            p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: 'relative' }, ctx),
        ).rejects.toThrow(/absolute path/);
    });

    it('init rejects when neither password nor privateKey given', async () => {
        const p = new SftpProvider();
        await expect(p.init({ host: 'h', username: 'u', remoteRoot: '/r' }, ctx)).rejects.toThrow(
            /password or privateKey required/,
        );
    });

    it('refuses .. escape paths', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        expect(() => p._resolve('../escape.txt')).toThrow(/unsafe/);
    });

    it('stat returns size and mtime for existing files', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        const st = await p.stat('a.txt', ctx);
        expect(st).toBeTruthy();
        expect(st.size).toBe(42);
    });

    it('stat returns null for missing files', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        const st = await p.stat('missing.txt', ctx);
        expect(st).toBeNull();
    });

    it('delete is idempotent — "No such file" is swallowed', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        await expect(p.delete('already-gone.txt', ctx)).resolves.toBeUndefined();
        expect(calls.find((c) => c[0] === 'delete')[1]).toBe('/backup/already-gone.txt');
    });

    it('list yields files, recursing into dirs', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        const out = [];
        for await (const item of p.list('', ctx)) out.push(item);
        expect(out.length).toBeGreaterThanOrEqual(2);
        const names = out.map((i) => i.name).sort();
        expect(names).toContain('a.txt');
        expect(names).toContain('photos/a.txt');
    });

    it('testConnection returns ok when root stat succeeds', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        const r = await p.testConnection(ctx);
        expect(r.ok).toBe(true);
        expect(r.detail).toContain('h:22');
    });

    it('close calls end on the client', async () => {
        const p = new SftpProvider();
        await p.init({ host: 'h', username: 'u', password: 'pw', remoteRoot: '/backup' }, ctx);
        await p.close();
        expect(calls.some((c) => c[0] === 'end')).toBe(true);
        expect(p.client).toBeNull();
    });

    it('schema marks password and privateKey as secrets', () => {
        const fields = SftpProvider.configSchema;
        const password = fields.find((f) => f.name === 'password');
        const key = fields.find((f) => f.name === 'privateKey');
        expect(password?.secret).toBe(true);
        expect(key?.secret).toBe(true);
    });
});
