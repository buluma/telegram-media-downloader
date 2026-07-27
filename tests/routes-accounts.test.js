// Route-level HTTP tests for /api/accounts*. Mounts the real router
// against a temp DB/config and a temp sessions dir (fixed to respect
// TGDL_DATA_DIR — see the commit that added this, matching the same
// fix applied to monitor.js/stats.js earlier this session).
//
// getAccountManager is injected per test as a fake AccountManager;
// core/config/manager.js runs for real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-accounts-'));
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

let manager;
let dbApi;
let db;
let app;
let server;
let port;
let getAccountManager;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function makeFakeAm(overrides = {}) {
    return {
        beginPhoneAuth: vi.fn(),
        submitPhone: vi.fn(),
        submitCode: vi.fn(),
        submit2fa: vi.fn(),
        cancelAuth: vi.fn(),
        getAuthStatus: vi.fn(),
        metadata: new Map(),
        removeAccount: vi.fn(),
        ...overrides,
    };
}

function writeSessionFile(id, { mtimeOffsetMs = 0 } = {}) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const full = path.join(SESSIONS_DIR, `${id}.enc`);
    fs.writeFileSync(full, '');
    const t = new Date(Date.now() + mtimeOffsetMs);
    fs.utimesSync(full, t, t);
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');

    const { createAccountsRouter } = await import('../src/web/routes/accounts.js');

    app = express();
    app.use(express.json());
    app.use('/api', createAccountsRouter({ getAccountManager: (...a) => getAccountManager(...a) }));

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
    dbApi.kvDelete('config');
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
    fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
    getAccountManager = async () => makeFakeAm();
});

describe('GET /api/accounts', () => {
    it('returns an empty array when no sessions exist', async () => {
        const res = await fetch(apiUrl('/api/accounts'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    it('ignores non-.enc files in the sessions directory', async () => {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SESSIONS_DIR, 'readme.txt'), 'not a session');
        const res = await fetch(apiUrl('/api/accounts'));
        expect(await res.json()).toEqual([]);
    });

    it('lists accounts sorted oldest-first by mtime, marking the first as default', async () => {
        writeSessionFile('acc-b', { mtimeOffsetMs: 2000 });
        writeSessionFile('acc-a', { mtimeOffsetMs: 1000 });
        const res = await fetch(apiUrl('/api/accounts'));
        const body = await res.json();
        expect(body.map((a) => a.id)).toEqual(['acc-a', 'acc-b']);
        expect(body[0].isDefault).toBe(true);
        expect(body[1].isDefault).toBe(false);
    });

    it('merges name/username/phone from config.accounts by id', async () => {
        writeSessionFile('acc-1');
        const cfg = manager.loadConfig();
        cfg.accounts = [{ id: 'acc-1', name: 'Alice', username: 'alice_tg', phone: '+123' }];
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/accounts'));
        const body = await res.json();
        expect(body[0]).toEqual(
            expect.objectContaining({
                id: 'acc-1',
                name: 'Alice',
                username: 'alice_tg',
                phone: '+123',
            }),
        );
    });

    it('falls back to the id as the name, and empty strings for username/phone, with no config metadata', async () => {
        writeSessionFile('acc-2');
        const res = await fetch(apiUrl('/api/accounts'));
        const body = await res.json();
        expect(body[0]).toEqual({
            id: 'acc-2',
            name: 'acc-2',
            username: '',
            phone: '',
            isDefault: true,
        });
    });

    it('500s when a session file disappears between readdir and stat', async () => {
        // readdir failures are caught (`.catch(() => [])`) and loadConfig()
        // swallows its own errors internally, so the only realistic
        // uncaught-throw path is the per-file fs.stat() call racing a
        // deleted/permission-denied file. Simulated via a spy since a real
        // delete-mid-request race isn't reliably reproducible.
        writeSessionFile('acc-1');
        const statSpy = vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT: race'));
        try {
            const res = await fetch(apiUrl('/api/accounts'));
            expect(res.status).toBe(500);
        } finally {
            statSpy.mockRestore();
        }
    });
});

describe('POST /api/accounts/auth/begin', () => {
    it('forwards the label and returns the result', async () => {
        const am = makeFakeAm({
            beginPhoneAuth: vi.fn().mockResolvedValue({ sessionId: 'sid-1' }),
        });
        getAccountManager = async () => am;
        const res = await fetch(apiUrl('/api/accounts/auth/begin'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'Work phone' }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ sessionId: 'sid-1' });
        expect(am.beginPhoneAuth).toHaveBeenCalledWith('Work phone');
    });

    it('maps a NO_API_CREDS failure via tgAuthErrorBody', async () => {
        const err = new Error('no creds');
        err.code = 'NO_API_CREDS';
        getAccountManager = async () =>
            makeFakeAm({ beginPhoneAuth: vi.fn().mockRejectedValue(err) });
        const res = await fetch(apiUrl('/api/accounts/auth/begin'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('NO_API_CREDS');
    });

    it("maps a generic failure to 400 via tgAuthErrorBody's fallback", async () => {
        getAccountManager = async () =>
            makeFakeAm({ beginPhoneAuth: vi.fn().mockRejectedValue(new Error('boom')) });
        const res = await fetch(apiUrl('/api/accounts/auth/begin'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/accounts/auth/phone, /code, /2fa, /cancel', () => {
    const cases = [
        {
            path: '/api/accounts/auth/phone',
            method: 'submitPhone',
            body: { sessionId: 's1', phone: '+123' },
            argCheck: (am) => expect(am.submitPhone).toHaveBeenCalledWith('s1', '+123'),
        },
        {
            path: '/api/accounts/auth/code',
            method: 'submitCode',
            body: { sessionId: 's1', code: '12345' },
            argCheck: (am) => expect(am.submitCode).toHaveBeenCalledWith('s1', '12345'),
        },
        {
            path: '/api/accounts/auth/2fa',
            method: 'submit2fa',
            body: { sessionId: 's1', password: 'hunter2' },
            argCheck: (am) => expect(am.submit2fa).toHaveBeenCalledWith('s1', 'hunter2'),
        },
        {
            path: '/api/accounts/auth/cancel',
            method: 'cancelAuth',
            body: { sessionId: 's1' },
            argCheck: (am) => expect(am.cancelAuth).toHaveBeenCalledWith('s1'),
        },
    ];

    for (const { path: p, method, body, argCheck } of cases) {
        it(`${p} forwards args and returns the result`, async () => {
            const am = makeFakeAm({ [method]: vi.fn().mockResolvedValue({ ok: true }) });
            getAccountManager = async () => am;
            const res = await fetch(apiUrl(p), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true });
            argCheck(am);
        });

        it(`${p} 400s with the error message when it rejects (not tgAuthErrorBody)`, async () => {
            getAccountManager = async () =>
                makeFakeAm({ [method]: vi.fn().mockRejectedValue(new Error('rejected')) });
            const res = await fetch(apiUrl(p), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            expect(res.status).toBe(400);
            expect((await res.json()).error).toBe('rejected');
        });

        it(`${p} falls back to "Bad request" when the rejection has no message`, async () => {
            getAccountManager = async () => makeFakeAm({ [method]: vi.fn().mockRejectedValue({}) });
            const res = await fetch(apiUrl(p), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            expect(res.status).toBe(400);
            expect((await res.json()).error).toBe('Bad request');
        });
    }
});

describe('GET /api/accounts/auth/:sessionId', () => {
    it('returns the auth status', async () => {
        getAccountManager = async () =>
            makeFakeAm({ getAuthStatus: vi.fn().mockReturnValue({ step: 'code' }) });
        const res = await fetch(apiUrl('/api/accounts/auth/s1'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ step: 'code' });
    });

    it('404s when the auth session is not found', async () => {
        getAccountManager = async () =>
            makeFakeAm({ getAuthStatus: vi.fn().mockReturnValue(null) });
        const res = await fetch(apiUrl('/api/accounts/auth/unknown'));
        expect(res.status).toBe(404);
    });

    it('maps a NO_API_CREDS failure via tgAuthErrorBody', async () => {
        const err = new Error('no creds');
        err.code = 'NO_API_CREDS';
        getAccountManager = async () => {
            throw err;
        };
        const res = await fetch(apiUrl('/api/accounts/auth/s1'));
        expect(res.status).toBe(503);
    });
});

describe('DELETE /api/accounts/:id', () => {
    it('404s when the account is not in metadata', async () => {
        getAccountManager = async () => makeFakeAm({ metadata: new Map() });
        const res = await fetch(apiUrl('/api/accounts/unknown-id'), { method: 'DELETE' });
        expect(res.status).toBe(404);
    });

    it('removes the account and returns success', async () => {
        const am = makeFakeAm({ metadata: new Map([['acc-1', {}]]) });
        getAccountManager = async () => am;
        const res = await fetch(apiUrl('/api/accounts/acc-1'), { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(am.removeAccount).toHaveBeenCalledWith('acc-1');
    });

    it('maps a removeAccount failure via tgAuthErrorBody', async () => {
        const am = makeFakeAm({
            metadata: new Map([['acc-1', {}]]),
            removeAccount: vi.fn().mockRejectedValue(new Error('fs error')),
        });
        getAccountManager = async () => am;
        const res = await fetch(apiUrl('/api/accounts/acc-1'), { method: 'DELETE' });
        expect(res.status).toBe(400);
    });
});
