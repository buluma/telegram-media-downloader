// Route-level HTTP tests for /api/monitor/*. Mounts the real monitor
// router on a minimal Express app against an isolated temp DB/config,
// with core/runtime.js mocked (it owns the real monitor/downloader/
// forwarder wiring — out of scope here, exercised in core tests).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-monitor-'));

const runtime = {
    status: vi.fn(() => ({ state: 'stopped', accounts: 0 })),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../src/core/runtime.js', () => ({ runtime }));

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

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');

    const { createMonitorRouter } = await import('../src/web/routes/monitor.js');

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createMonitorRouter({ getAccountManager: (...args) => getAccountManager(...args) }),
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
    vi.clearAllMocks();
    runtime.status.mockReturnValue({ state: 'stopped', accounts: 0 });
    runtime.start.mockResolvedValue(undefined);
    runtime.stop.mockResolvedValue(undefined);
    runtime.restart.mockResolvedValue(undefined);
    getAccountManager = async () => ({ count: 0 });
});

describe('GET /api/monitor/status', () => {
    it('returns the runtime status snapshot', async () => {
        runtime.status.mockReturnValue({ state: 'running', accounts: 2 });
        const res = await fetch(apiUrl('/api/monitor/status'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.state).toBe('running');
        expect(body.accounts).toBe(2);
    });

    it('fills accounts from getAccountManager when the runtime reports 0', async () => {
        runtime.status.mockReturnValue({ state: 'stopped', accounts: 0 });
        getAccountManager = async () => ({ count: 3 });
        const res = await fetch(apiUrl('/api/monitor/status'));
        const body = await res.json();
        expect(body.accounts).toBe(3);
    });

    it('falls back to counting .enc session files when getAccountManager throws', async () => {
        runtime.status.mockReturnValue({ state: 'stopped', accounts: 0 });
        getAccountManager = async () => {
            throw new Error('not booted yet');
        };
        const sessionsDir = path.join(DATA_DIR, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, 'acc1.enc'), '');
        fs.writeFileSync(path.join(sessionsDir, 'acc2.enc'), '');
        fs.writeFileSync(path.join(sessionsDir, 'not-a-session.txt'), '');
        try {
            const res = await fetch(apiUrl('/api/monitor/status'));
            const body = await res.json();
            expect(body.accounts).toBe(2);
        } finally {
            fs.rmSync(sessionsDir, { recursive: true, force: true });
        }
    });

    it('hints configure-api when telegram creds are missing', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '';
        cfg.telegram.apiHash = '';
        manager.saveConfig(cfg);
        runtime.status.mockReturnValue({ state: 'stopped', accounts: 0 });
        getAccountManager = async () => ({ count: 0 });
        const res = await fetch(apiUrl('/api/monitor/status'));
        const body = await res.json();
        expect(body.hint).toBe('configure-api');
    });

    it('hints add-account when creds exist but no accounts are loaded', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '12345';
        cfg.telegram.apiHash = 'hash';
        manager.saveConfig(cfg);
        runtime.status.mockReturnValue({ state: 'stopped', accounts: 0 });
        getAccountManager = async () => ({ count: 0 });
        const res = await fetch(apiUrl('/api/monitor/status'));
        const body = await res.json();
        expect(body.hint).toBe('add-account');
    });

    it('hints enable-group when accounts exist but no group is enabled', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '12345';
        cfg.telegram.apiHash = 'hash';
        cfg.groups = [{ id: '-1001', name: 'g', enabled: false }];
        manager.saveConfig(cfg);
        runtime.status.mockReturnValue({ state: 'stopped', accounts: 1 });
        const res = await fetch(apiUrl('/api/monitor/status'));
        const body = await res.json();
        expect(body.hint).toBe('enable-group');
    });

    it('hint is null once creds, accounts and an enabled group all exist', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '12345';
        cfg.telegram.apiHash = 'hash';
        cfg.groups = [{ id: '-1001', name: 'g', enabled: true }];
        manager.saveConfig(cfg);
        runtime.status.mockReturnValue({ state: 'running', accounts: 1 });
        const res = await fetch(apiUrl('/api/monitor/status'));
        const body = await res.json();
        expect(body.hint).toBeNull();
    });
});

describe('POST /api/monitor/start', () => {
    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => ({ count: 0 });
        const res = await fetch(apiUrl('/api/monitor/start'), { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toMatch(/no telegram accounts/i);
    });

    it('starts the runtime and returns its status when accounts exist', async () => {
        getAccountManager = async () => ({ count: 1 });
        runtime.status.mockReturnValue({ state: 'running', accounts: 1 });
        const res = await fetch(apiUrl('/api/monitor/start'), { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(runtime.start).toHaveBeenCalled();
        expect(body.status.state).toBe('running');
    });

    it('maps a NO_API_CREDS error to 503 with its code', async () => {
        getAccountManager = async () => ({ count: 1 });
        const err = new Error('no creds');
        err.code = 'NO_API_CREDS';
        runtime.start.mockRejectedValue(err);
        const res = await fetch(apiUrl('/api/monitor/start'), { method: 'POST' });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.code).toBe('NO_API_CREDS');
    });

    it('maps a generic runtime.start() failure to 500', async () => {
        getAccountManager = async () => ({ count: 1 });
        runtime.start.mockRejectedValue(new Error('boom'));
        const res = await fetch(apiUrl('/api/monitor/start'), { method: 'POST' });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('boom');
    });

    it('maps an "already running" 400-shaped error to 500 (never surfaces raw 400)', async () => {
        // tgAuthErrorBody's fallback branch always returns status 400 for
        // any non-NO_API_CREDS error (e.g. Runtime's own "already running"
        // guard) — the route deliberately remaps that to 500 so a client
        // retry/backoff policy keyed on 5xx still applies.
        getAccountManager = async () => ({ count: 1 });
        runtime.start.mockRejectedValue(new Error('Runtime already running'));
        const res = await fetch(apiUrl('/api/monitor/start'), { method: 'POST' });
        expect(res.status).toBe(500);
    });
});

describe('POST /api/monitor/stop', () => {
    it('stops the runtime and returns its status', async () => {
        runtime.status.mockReturnValue({ state: 'stopped', accounts: 1 });
        const res = await fetch(apiUrl('/api/monitor/stop'), { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(runtime.stop).toHaveBeenCalled();
        expect(body.status.state).toBe('stopped');
    });

    it('maps a stop failure to 500', async () => {
        runtime.stop.mockRejectedValue(new Error('cannot stop'));
        const res = await fetch(apiUrl('/api/monitor/stop'), { method: 'POST' });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('cannot stop');
    });
});

describe('POST /api/monitor/restart', () => {
    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => ({ count: 0 });
        const res = await fetch(apiUrl('/api/monitor/restart'), { method: 'POST' });
        expect(res.status).toBe(409);
    });

    it('restarts the runtime and returns its status when accounts exist', async () => {
        getAccountManager = async () => ({ count: 1 });
        runtime.status.mockReturnValue({ state: 'running', accounts: 1 });
        const res = await fetch(apiUrl('/api/monitor/restart'), { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(runtime.restart).toHaveBeenCalled();
    });

    it('maps a NO_API_CREDS restart failure to 503', async () => {
        getAccountManager = async () => ({ count: 1 });
        const err = new Error('no creds');
        err.code = 'NO_API_CREDS';
        runtime.restart.mockRejectedValue(err);
        const res = await fetch(apiUrl('/api/monitor/restart'), { method: 'POST' });
        expect(res.status).toBe(503);
    });

    it('maps a generic restart failure to 500', async () => {
        getAccountManager = async () => ({ count: 1 });
        runtime.restart.mockRejectedValue(new Error('boom'));
        const res = await fetch(apiUrl('/api/monitor/restart'), { method: 'POST' });
        expect(res.status).toBe(500);
    });
});
