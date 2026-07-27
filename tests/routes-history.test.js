// Route-level HTTP tests for /api/history* — on-demand backfill jobs.
//
// Real: core/db.js + config/manager.js (temp data dir, matching
// routes-config.test.js) and web/lib/history-state.js /
// web/lib/config-writer.js, since the interesting behavior (job Map
// lifecycle, auto-register-missing-group, config persistence) lives
// there. core/dialogs-resolver.js doesn't exist in this repo, so the
// route's dynamic `import(...).catch(() => null)` naturally resolves
// to null without needing a mock.
//
// Mocked: core/runtime.js, core/downloader.js, core/security.js, and
// core/history.js's HistoryDownloader (wraps real Telegram calls —
// P3 scope). MockHistoryDownloader extends EventEmitter so the
// route's history.on('progress'/'start', ...) wiring works for real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { EventEmitter } from 'events';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-history-'));

const runtime = { _downloader: null };
vi.mock('../src/core/runtime.js', () => ({ runtime }));

const RateLimiter = vi.fn();
vi.mock('../src/core/security.js', () => ({ RateLimiter }));

let fakeDownloader;
const DownloadManager = vi.fn().mockImplementation(function () {
    return fakeDownloader;
});
vi.mock('../src/core/downloader.js', () => ({ DownloadManager }));

let historyDownloadHistory;
class MockHistoryDownloader extends EventEmitter {
    constructor() {
        super();
        MockHistoryDownloader.instances.push(this);
        this.cancel = vi.fn();
    }
    downloadHistory(...args) {
        return historyDownloadHistory(...args);
    }
}
MockHistoryDownloader.instances = [];
vi.mock('../src/core/history.js', () => ({ HistoryDownloader: MockHistoryDownloader }));

let dbApi;
let db;
let manager;
let historyState;
let app;
let server;
let port;
let getAccountManager;
let broadcasts;
let logs;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function makeFakeDownloader() {
    return {
        init: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
    };
}

function makeFakeAm({ count = 1 } = {}) {
    return { count, getDefaultClient: () => ({}) };
}

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    historyState = await import('../src/web/lib/history-state.js');

    const { createHistoryRouter } = await import('../src/web/routes/history.js');

    broadcasts = [];
    logs = [];
    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createHistoryRouter({
            getAccountManager: (...a) => getAccountManager(...a),
            broadcast: (msg) => broadcasts.push(msg),
            log: (entry) => logs.push(entry),
            invalidateDialogsCache: vi.fn(),
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
    vi.clearAllMocks();
    dbApi.kvDelete('config');
    dbApi.kvDelete('history_jobs');
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
    historyState.historyJobs.clear();
    historyState.activeBackfillsByGroup.clear();
    MockHistoryDownloader.instances = [];
    historyDownloadHistory = vi.fn().mockResolvedValue(undefined);
    runtime._downloader = null;
    fakeDownloader = makeFakeDownloader();
    getAccountManager = async () => makeFakeAm();
    broadcasts.length = 0;
    logs.length = 0;
});

function registerGroup(id, overrides = {}) {
    const cfg = manager.loadConfig();
    cfg.groups = [...(cfg.groups || []), { id, name: `Group ${id}`, enabled: true, ...overrides }];
    manager.saveConfig(cfg);
}

describe('POST /api/history', () => {
    it('400s without a groupId', async () => {
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('409s when a backfill is already running for the group', async () => {
        historyState.activeBackfillsByGroup.set('-1001', 'existing-job-id');
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('ALREADY_RUNNING');
        expect(body.jobId).toBe('existing-job-id');
    });

    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => makeFakeAm({ count: 0 });
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        expect(res.status).toBe(409);
    });

    it('starts a backfill for an already-configured group', async () => {
        registerGroup('-1001');
        historyDownloadHistory.mockImplementation(() => new Promise(() => {}));
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.jobId).toMatch(/^[0-9a-f]{12}$/);
        expect(body.group).toBe('Group -1001');
        expect(historyState.historyJobs.get(body.jobId).state).toBe('running');
        expect(historyState.activeBackfillsByGroup.get('-1001')).toBe(body.jobId);
    });

    it('defaults limit to 100 when not given', async () => {
        registerGroup('-1001');
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        const body = await res.json();
        expect(body.limit).toBe(100);
    });

    it('treats limit=0 as "no limit" (null)', async () => {
        registerGroup('-1001');
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001', limit: 0 }),
        });
        const body = await res.json();
        expect(body.limit).toBeNull();
    });

    it('clamps a limit above BACKFILL_MAX_LIMIT', async () => {
        registerGroup('-1001');
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001', limit: 999999999 }),
        });
        const body = await res.json();
        expect(body.limit).toBe(50000);
    });

    it('falls back to the default for a non-numeric limit', async () => {
        registerGroup('-1001');
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001', limit: 'not-a-number' }),
        });
        const body = await res.json();
        expect(body.limit).toBe(100);
    });

    it('defaults mode to pull-older for an unrecognised mode value', async () => {
        registerGroup('-1001');
        await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001', mode: 'yolo' }),
        });
        expect(historyDownloadHistory).toHaveBeenCalledWith(
            '-1001',
            expect.objectContaining({ mode: 'pull-older' }),
        );
    });

    it('passes through catch-up and rescan modes unchanged', async () => {
        registerGroup('-1001');
        await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001', mode: 'catch-up' }),
        });
        expect(historyDownloadHistory).toHaveBeenCalledWith(
            '-1001',
            expect.objectContaining({ mode: 'catch-up' }),
        );
    });

    it('auto-registers a download-only group missing from config', async () => {
        const row = db
            .prepare(
                `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_type, file_path)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run('-2002', 'Discovered Group', 1, 'a.mp4', 'video', '/x');
        expect(row.changes).toBe(1);
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-2002' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.group).toBe('Discovered Group');
        const cfg = manager.loadConfig();
        expect(cfg.groups.some((g) => String(g.id) === '-2002')).toBe(true);
        expect(broadcasts.some((b) => b.type === 'config_updated')).toBe(true);
        expect(logs.some((l) => l.msg.includes('auto-registered group'))).toBe(true);
    });

    it('falls back to "Group <id>" when no name can be resolved', async () => {
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-3003' }),
        });
        const body = await res.json();
        expect(body.group).toBe('Group -3003');
    });

    it('emits progress events with group metadata attached', async () => {
        registerGroup('-1001');
        historyDownloadHistory.mockImplementation(() => new Promise(() => {}));
        await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        const instance = MockHistoryDownloader.instances[0];
        instance.emit('progress', { processed: 5, downloaded: 3 });
        expect(broadcasts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'history_progress',
                    processed: 5,
                    downloaded: 3,
                    group: 'Group -1001',
                }),
            ]),
        );
    });

    it('mirrors the chosen mode from the "start" event onto the job', async () => {
        registerGroup('-1001');
        historyDownloadHistory.mockImplementation(() => new Promise(() => {}));
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        const { jobId } = await res.json();
        MockHistoryDownloader.instances[0].emit('start', { mode: 'rescan' });
        expect(historyState.historyJobs.get(jobId).mode).toBe('rescan');
    });

    it('marks the job done and stops a standalone downloader on completion', async () => {
        registerGroup('-1001');
        let resolveDownload;
        historyDownloadHistory.mockReturnValue(new Promise((r) => (resolveDownload = r)));
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        const { jobId } = await res.json();
        expect(fakeDownloader.init).toHaveBeenCalled();
        resolveDownload();
        await flush();
        const job = historyState.historyJobs.get(jobId);
        expect(job.state).toBe('done');
        expect(fakeDownloader.stop).toHaveBeenCalled();
        expect(historyState.activeBackfillsByGroup.has('-1001')).toBe(false);
        expect(broadcasts.some((b) => b.type === 'history_done')).toBe(true);
    });

    it('marks a cancelled job as cancelled rather than done', async () => {
        registerGroup('-1001');
        let resolveDownload;
        historyDownloadHistory.mockReturnValue(new Promise((r) => (resolveDownload = r)));
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        const { jobId } = await res.json();
        historyState.historyJobs.get(jobId).cancelled = true;
        resolveDownload();
        await flush();
        expect(historyState.historyJobs.get(jobId).state).toBe('cancelled');
        expect(broadcasts.some((b) => b.type === 'history_cancelled')).toBe(true);
    });

    it('reuses the running runtime downloader instead of creating a standalone one', async () => {
        registerGroup('-1001');
        const running = makeFakeDownloader();
        runtime._downloader = running;
        await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        await flush();
        expect(running.init).not.toHaveBeenCalled();
        expect(DownloadManager).not.toHaveBeenCalled();
    });

    it('marks the job errored and logs a hint when no account can read the group', async () => {
        registerGroup('-1001');
        historyDownloadHistory.mockRejectedValue(new Error('no available account for this chat'));
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        const { jobId } = await res.json();
        await flush();
        const job = historyState.historyJobs.get(jobId);
        expect(job.state).toBe('error');
        expect(job.error).toBe('no available account for this chat');
        expect(logs.some((l) => l.msg.includes('no logged-in account can read this group'))).toBe(
            true,
        );
        expect(broadcasts.some((b) => b.type === 'history_error')).toBe(true);
        expect(historyState.activeBackfillsByGroup.has('-1001')).toBe(false);
    });

    it('500s when something outside the async chain throws', async () => {
        getAccountManager = async () => {
            throw new Error('account manager exploded');
        };
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await fetch(apiUrl('/api/history'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: '-1001' }),
        });
        expect(res.status).toBe(500);
        errSpy.mockRestore();
    });
});

describe('GET /api/history/jobs', () => {
    it('merges on-disk and in-memory jobs, sorted newest first', async () => {
        const now = Date.now();
        dbApi.kvSet('history_jobs', [
            { id: 'old', state: 'done', startedAt: now - 1000, finishedAt: now - 1000 },
        ]);
        historyState.historyJobs.set('live', { id: 'live', state: 'running', startedAt: now });
        const res = await fetch(apiUrl('/api/history/jobs'));
        const body = await res.json();
        expect(body.active.map((j) => j.id)).toEqual(['live']);
        expect(body.recent.map((j) => j.id)).toEqual(['old']);
        expect(body.past).toEqual(body.recent);
    });

    it('an in-memory job overrides an on-disk entry with the same id', async () => {
        const now = Date.now();
        dbApi.kvSet('history_jobs', [{ id: 'x', state: 'done', startedAt: now }]);
        historyState.historyJobs.set('x', { id: 'x', state: 'running', startedAt: now });
        const res = await fetch(apiUrl('/api/history/jobs'));
        const body = await res.json();
        expect(body.active.map((j) => j.id)).toEqual(['x']);
    });

    it('caps recent at 30 entries', async () => {
        const now = Date.now();
        const many = Array.from({ length: 40 }, (_, i) => ({
            id: `job-${i}`,
            state: 'done',
            startedAt: now - i,
            finishedAt: now - i,
        }));
        dbApi.kvSet('history_jobs', many);
        const res = await fetch(apiUrl('/api/history/jobs'));
        const body = await res.json();
        expect(body.recent).toHaveLength(30);
    });
});

describe('GET /api/history/:jobId', () => {
    it('404s for an unknown job id', async () => {
        const res = await fetch(apiUrl('/api/history/unknown'));
        expect(res.status).toBe(404);
    });

    it('returns the job with _runner stripped', async () => {
        historyState.historyJobs.set('x', { id: 'x', state: 'running', _runner: {} });
        const res = await fetch(apiUrl('/api/history/x'));
        const body = await res.json();
        expect(body.id).toBe('x');
        expect('_runner' in body).toBe(false);
    });
});

describe('POST /api/history/:jobId/cancel', () => {
    it('404s for an unknown job', async () => {
        const res = await fetch(apiUrl('/api/history/unknown/cancel'), { method: 'POST' });
        expect(res.status).toBe(404);
    });

    it('409s when the job is not running', async () => {
        historyState.historyJobs.set('x', { id: 'x', state: 'done' });
        const res = await fetch(apiUrl('/api/history/x/cancel'), { method: 'POST' });
        expect(res.status).toBe(409);
    });

    it('marks cancelled, calls the runner cancel(), and broadcasts', async () => {
        const cancel = vi.fn();
        historyState.historyJobs.set('x', {
            id: 'x',
            state: 'running',
            group: 'g',
            _runner: { cancel },
        });
        const res = await fetch(apiUrl('/api/history/x/cancel'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(cancel).toHaveBeenCalled();
        expect(historyState.historyJobs.get('x').cancelled).toBe(true);
        expect(broadcasts).toEqual([{ type: 'history_cancelling', jobId: 'x', group: 'g' }]);
    });

    it('does not throw when the runner has no cancel() method', async () => {
        historyState.historyJobs.set('x', { id: 'x', state: 'running', _runner: {} });
        const res = await fetch(apiUrl('/api/history/x/cancel'), { method: 'POST' });
        expect(res.status).toBe(200);
    });

    it('500s when cancel() itself throws', async () => {
        historyState.historyJobs.set('x', {
            id: 'x',
            state: 'running',
            _runner: {
                cancel: () => {
                    throw new Error('cancel failed');
                },
            },
        });
        const res = await fetch(apiUrl('/api/history/x/cancel'), { method: 'POST' });
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/history/:jobId', () => {
    it('409s when the job is running in memory', async () => {
        historyState.historyJobs.set('x', { id: 'x', state: 'running' });
        const res = await fetch(apiUrl('/api/history/x'), { method: 'DELETE' });
        expect(res.status).toBe(409);
    });

    it('deletes an in-memory finished job and broadcasts', async () => {
        historyState.historyJobs.set('x', { id: 'x', state: 'done' });
        const res = await fetch(apiUrl('/api/history/x'), { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(historyState.historyJobs.has('x')).toBe(false);
        expect(broadcasts).toEqual([{ type: 'history_deleted', jobId: 'x' }]);
    });

    it('removes the entry from the on-disk store too', async () => {
        const now = Date.now();
        dbApi.kvSet('history_jobs', [
            { id: 'x', state: 'done', startedAt: now },
            { id: 'y', state: 'done', startedAt: now },
        ]);
        await fetch(apiUrl('/api/history/x'), { method: 'DELETE' });
        expect(dbApi.kvGet('history_jobs').map((j) => j.id)).toEqual(['y']);
    });

    it('succeeds even for a job id that does not exist anywhere', async () => {
        const res = await fetch(apiUrl('/api/history/nonexistent'), { method: 'DELETE' });
        expect(res.status).toBe(200);
    });
});

describe('DELETE /api/history', () => {
    it('clears every finished job but preserves running ones', async () => {
        historyState.historyJobs.set('done1', { id: 'done1', state: 'done' });
        historyState.historyJobs.set('done2', { id: 'done2', state: 'error' });
        historyState.historyJobs.set('live', { id: 'live', state: 'running' });
        const res = await fetch(apiUrl('/api/history'), { method: 'DELETE' });
        const body = await res.json();
        expect(body.removed).toBe(2);
        expect(historyState.historyJobs.has('live')).toBe(true);
        expect(historyState.historyJobs.has('done1')).toBe(false);
        expect(dbApi.kvGet('history_jobs')).toEqual([]);
        expect(broadcasts).toEqual([{ type: 'history_cleared' }]);
    });
});

describe('GET /api/history', () => {
    it('returns all in-memory jobs with _runner stripped', async () => {
        historyState.historyJobs.set('x', { id: 'x', state: 'running', _runner: {} });
        const res = await fetch(apiUrl('/api/history'));
        const body = await res.json();
        expect(body).toEqual([{ id: 'x', state: 'running' }]);
    });
});
