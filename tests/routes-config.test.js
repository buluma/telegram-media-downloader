// Route-level HTTP tests for /api/config. Mounts the real config router
// on a minimal Express app with auth bypassed, exercises the key GET/POST
// endpoints against an isolated temp DB.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-config-'));

let manager;
let dbApi;
let db;
let app;
let server;
let port;

function apiUrl(path) {
    return `http://127.0.0.1:${port}${path}`;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');

    const { createConfigRouter } = await import('../src/web/routes/config.js');

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createConfigRouter({
            broadcast: () => {},
            invalidateDialogsCache: () => {},
            invalidateShareConfigCache: () => {},
            refreshRateLimitConfig: () => {},
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
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    dbApi.kvDelete('config');
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
});

describe('GET /api/config', () => {
    it('returns the config with apiHash scrubbed', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '12345';
        cfg.telegram.apiHash = 'secret-hash';
        manager.saveConfig(cfg);

        const res = await fetch(apiUrl('/api/config'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.telegram.apiId).toBe('12345');
        expect(body.telegram.apiHash).toBeUndefined();
        expect(body.telegram.apiHashSet).toBe(true);
    });

    it('returns groups array', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100999', name: 'Test Group', enabled: true }];
        manager.saveConfig(cfg);

        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(Array.isArray(body.groups)).toBe(true);
        expect(body.groups.length).toBeGreaterThanOrEqual(1);
    });

    it('strips web.password and web.passwordHash', async () => {
        const cfg = manager.loadConfig();
        cfg.web = { enabled: true, password: 'raw', passwordHash: 'hashed' };
        manager.saveConfig(cfg);

        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.web.password).toBeUndefined();
        expect(body.web.passwordHash).toBeUndefined();
    });
});

describe('POST /api/config', () => {
    // NOTE: updating telegram.apiId via POST /api/config triggers an
    // _accountManager reference that is scoped to server.js, not config.js.
    // That path throws ReferenceError when the router is mounted standalone.
    // Filed as a known bug — test non-telegram paths instead.
    it('updates download settings via deep merge', async () => {
        const cfg = manager.loadConfig();
        cfg.download.concurrent = 5;
        cfg.download.path = './data/downloads';
        manager.saveConfig(cfg);

        const res = await fetch(apiUrl('/api/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ download: { concurrent: 20 } }),
        });
        expect(res.status).toBe(200);

        const reloaded = manager.loadConfig();
        expect(reloaded.download.concurrent).toBe(20);
        expect(reloaded.download.path).toBe('./data/downloads');
    });

    it('rejects password injection via config endpoint', async () => {
        const res = await fetch(apiUrl('/api/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ web: { password: 'sneaky' } }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/auth/i);
    });

    it('rejects passwordHash injection via config endpoint', async () => {
        const res = await fetch(apiUrl('/api/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ web: { passwordHash: 'sneaky' } }),
        });
        expect(res.status).toBe(400);
    });

    it('updates rescue settings via deep merge', async () => {
        const res = await fetch(apiUrl('/api/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rescue: { retentionHours: 72 } }),
        });
        expect(res.status).toBe(200);

        const reloaded = manager.loadConfig();
        expect(reloaded.rescue.retentionHours).toBe(72);
    });
});
