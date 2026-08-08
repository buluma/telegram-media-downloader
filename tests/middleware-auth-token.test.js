// Covers the TGDL_API_TOKEN bearer-token path in web/middleware/auth.js's
// checkAuth() — scripted/API access as an alternative to the session
// cookie, for callers that can't do a browser login (SHA-147). Mounts
// checkAuth for real against a temp DB/config, same harness pattern as
// routes-auth.test.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Bypass the 2s config-cache TTL — see routes-auth.test.js for why.
import { vi } from 'vitest';
vi.mock('../src/web/lib/config-cache.js', () => ({
    readConfigSafe: async () => {
        const { loadConfig } = await import('../src/config/manager.js');
        return loadConfig();
    },
    invalidateConfigCache: () => {},
}));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-mw-auth-token-'));

let dbApi;
let db;
let manager;
let webAuth;
let app;
let server;
let port;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    webAuth = await import('../src/core/web-auth.js');
    const { checkAuth, cookieParser } = await import('../src/web/middleware/auth.js');

    app = express();
    app.set('trust proxy', true);
    app.use(cookieParser);
    app.use(checkAuth);
    app.get('/api/groups', (req, res) => res.json({ role: req.role }));

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
    db.prepare('DELETE FROM web_sessions').run();
    manager._resetConfigBus();
    const cfg = manager.loadConfig();
    cfg.web = { enabled: true, passwordHash: webAuth.hashPassword('correct-horse-battery') };
    manager.saveConfig(cfg);
});

afterEach(() => {
    delete process.env.TGDL_API_TOKEN;
});

describe('checkAuth — TGDL_API_TOKEN bearer path', () => {
    it('401s a protected route with no cookie and no token configured', async () => {
        const res = await fetch(apiUrl('/api/groups'));
        expect(res.status).toBe(401);
    });

    it('401s when TGDL_API_TOKEN is set but no Authorization header is sent', async () => {
        process.env.TGDL_API_TOKEN = 'secret-service-token';
        const res = await fetch(apiUrl('/api/groups'));
        expect(res.status).toBe(401);
    });

    it('401s when the bearer token is wrong', async () => {
        process.env.TGDL_API_TOKEN = 'secret-service-token';
        const res = await fetch(apiUrl('/api/groups'), {
            headers: { Authorization: 'Bearer wrong-token' },
        });
        expect(res.status).toBe(401);
    });

    it('grants admin role for a correct bearer token', async () => {
        process.env.TGDL_API_TOKEN = 'secret-service-token';
        const res = await fetch(apiUrl('/api/groups'), {
            headers: { Authorization: 'Bearer secret-service-token' },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.role).toBe('admin');
    });

    it('ignores a bearer token when TGDL_API_TOKEN is not set, even if it matches an old value', async () => {
        const res = await fetch(apiUrl('/api/groups'), {
            headers: { Authorization: 'Bearer secret-service-token' },
        });
        expect(res.status).toBe(401);
    });

    it('is case-insensitive on the "Bearer" scheme prefix', async () => {
        process.env.TGDL_API_TOKEN = 'secret-service-token';
        const res = await fetch(apiUrl('/api/groups'), {
            headers: { Authorization: 'bearer secret-service-token' },
        });
        expect(res.status).toBe(200);
    });

    it('still allows normal cookie-session auth when TGDL_API_TOKEN is unset', async () => {
        const loginRes = await fetch(apiUrl('/api/groups'), {
            headers: { Cookie: `tg_dl_session=${webAuth.issueSession({ role: 'admin' }).token}` },
        });
        expect(loginRes.status).toBe(200);
    });
});
