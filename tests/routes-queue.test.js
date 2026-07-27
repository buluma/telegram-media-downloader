// Route-level HTTP tests for /api/queue/*. core/runtime.js and
// ../lib/queue-state.js are mocked — the downloader itself (snapshot,
// pauseJob, retryJob, etc.) is core/P3 scope; this only exercises the
// route's requireDownloader gate, key decoding, batch-action dispatch,
// and WS broadcast payloads.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';

const runtime = { _downloader: null, state: 'stopped' };
vi.mock('../src/core/runtime.js', () => ({ runtime }));

const getHistory = vi.fn(() => []);
const clearHistory = vi.fn();
const flushSoon = vi.fn();
let failedJobMeta;
vi.mock('../src/web/lib/queue-state.js', () => ({
    getHistory: (...a) => getHistory(...a),
    clearHistory: (...a) => clearHistory(...a),
    flushSoon: (...a) => flushSoon(...a),
    get failedJobMeta() {
        return failedJobMeta;
    },
    QUEUE_HISTORY_CAP: 100,
}));

function makeFakeDl() {
    return {
        snapshot: vi.fn(() => ({
            active: [],
            queued: [],
            globalPaused: false,
            pausedCount: 0,
            workers: 1,
            pending: 0,
        })),
        pauseAll: vi.fn(),
        resumeAll: vi.fn(),
        cancelAllQueued: vi.fn(() => 3),
        pauseJob: vi.fn(() => true),
        resumeJob: vi.fn(() => true),
        cancelJob: vi.fn(() => true),
        retryJob: vi.fn(),
        config: { download: { maxSpeed: 5000 } },
    };
}

let app;
let server;
let port;
let broadcasts;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

beforeAll(async () => {
    const { createQueueRouter } = await import('../src/web/routes/queue.js');
    broadcasts = [];
    app = express();
    app.use(express.json());
    app.use('/api', createQueueRouter({ broadcast: (msg) => broadcasts.push(msg) }));
    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
});

beforeEach(() => {
    vi.clearAllMocks();
    broadcasts.length = 0;
    runtime._downloader = null;
    runtime.state = 'stopped';
    failedJobMeta = new Map();
});

describe('GET /api/queue/snapshot', () => {
    it('returns an empty default snapshot when no downloader is running', async () => {
        const res = await fetch(apiUrl('/api/queue/snapshot'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.active).toEqual([]);
        expect(body.workers).toBe(0);
        expect(body.maxSpeed).toBeNull();
        expect(body.engineRunning).toBe(false);
    });

    it('returns the live downloader snapshot when running', async () => {
        runtime._downloader = makeFakeDl();
        runtime.state = 'running';
        const res = await fetch(apiUrl('/api/queue/snapshot'));
        const body = await res.json();
        expect(body.workers).toBe(1);
        expect(body.maxSpeed).toBe(5000);
        expect(body.engineRunning).toBe(true);
    });

    it('includes recent history capped by QUEUE_HISTORY_CAP', async () => {
        getHistory.mockReturnValue(Array.from({ length: 150 }, (_, i) => ({ key: `job-${i}` })));
        const res = await fetch(apiUrl('/api/queue/snapshot'));
        const body = await res.json();
        expect(body.recent).toHaveLength(100);
    });

    it('500s when the snapshot call itself throws', async () => {
        runtime._downloader = {
            snapshot: () => {
                throw new Error('engine crashed');
            },
        };
        const res = await fetch(apiUrl('/api/queue/snapshot'));
        expect(res.status).toBe(500);
    });
});

describe('requireDownloader gate (shared across most routes)', () => {
    const cases = [
        { method: 'POST', path: '/api/queue/pause-all' },
        { method: 'POST', path: '/api/queue/resume-all' },
        { method: 'POST', path: '/api/queue/cancel-all' },
        { method: 'POST', path: '/api/queue/some-key/pause' },
        { method: 'POST', path: '/api/queue/some-key/resume' },
        { method: 'POST', path: '/api/queue/some-key/cancel' },
        { method: 'POST', path: '/api/queue/some-key/retry' },
        { method: 'POST', path: '/api/queue/retry-all' },
        { method: 'POST', path: '/api/queue/batch' },
    ];

    for (const { method, path } of cases) {
        it(`${method} ${path} 409s when the engine is not running`, async () => {
            const res = await fetch(apiUrl(path), {
                method,
                headers: { 'Content-Type': 'application/json' },
                body:
                    method === 'POST'
                        ? JSON.stringify({ keys: ['x'], action: 'pause' })
                        : undefined,
            });
            expect(res.status).toBe(409);
            const body = await res.json();
            expect(body.error).toMatch(/engine is not running/i);
        });
    }
});

describe('POST /api/queue/pause-all, /resume-all, /cancel-all', () => {
    it('pauses all and broadcasts', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/pause-all'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(dl.pauseAll).toHaveBeenCalled();
        expect(broadcasts).toEqual([{ type: 'queue_changed', payload: { op: 'pause-all' } }]);
    });

    it('resumes all and broadcasts', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        await fetch(apiUrl('/api/queue/resume-all'), { method: 'POST' });
        expect(dl.resumeAll).toHaveBeenCalled();
        expect(broadcasts[0].payload.op).toBe('resume-all');
    });

    it('cancels all and reports the removed count', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/cancel-all'), { method: 'POST' });
        const body = await res.json();
        expect(body.removed).toBe(3);
        expect(broadcasts[0].payload).toEqual({ op: 'cancel-all', removed: 3 });
    });
});

describe('POST /api/queue/clear-finished', () => {
    it('does not require a running downloader', async () => {
        const res = await fetch(apiUrl('/api/queue/clear-finished'), { method: 'POST' });
        expect(res.status).toBe(200);
    });

    it('clears history, flushes, clears failedJobMeta, and broadcasts', async () => {
        failedJobMeta.set('a', {});
        const res = await fetch(apiUrl('/api/queue/clear-finished'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(clearHistory).toHaveBeenCalled();
        expect(flushSoon).toHaveBeenCalled();
        expect(failedJobMeta.size).toBe(0);
        expect(broadcasts[0].payload.op).toBe('clear-finished');
    });
});

describe('per-row routes', () => {
    it('decodes a URL-encoded key before calling pauseJob', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        await fetch(apiUrl(`/api/queue/${encodeURIComponent('123_456')}/pause`), {
            method: 'POST',
        });
        expect(dl.pauseJob).toHaveBeenCalledWith('123_456');
    });

    it('resume reports success:false when resumeJob fails', async () => {
        const dl = makeFakeDl();
        dl.resumeJob.mockReturnValue(false);
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/x/resume'), { method: 'POST' });
        const body = await res.json();
        expect(body.success).toBe(false);
    });

    it('cancel also deletes any cached failedJobMeta entry for the key', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        failedJobMeta.set('x', { some: 'meta' });
        await fetch(apiUrl('/api/queue/x/cancel'), { method: 'POST' });
        expect(failedJobMeta.has('x')).toBe(false);
    });

    it("cancel reports success based on cancelJob's return value", async () => {
        const dl = makeFakeDl();
        dl.cancelJob.mockReturnValue(false);
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/x/cancel'), { method: 'POST' });
        const body = await res.json();
        expect(body.success).toBe(false);
    });

    it('retry 404s when there is no cached failedJobMeta for the key', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/unknown-key/retry'), { method: 'POST' });
        expect(res.status).toBe(404);
    });

    it('retry calls dl.retryJob with the cached meta and broadcasts', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const meta = { groupId: 'g1' };
        failedJobMeta.set('x', meta);
        const res = await fetch(apiUrl('/api/queue/x/retry'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(dl.retryJob).toHaveBeenCalledWith(meta);
        expect(broadcasts[0].payload.op).toBe('retry');
    });
});

describe('POST /api/queue/retry-all', () => {
    it('retries every cached job and reports 0 skipped', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        failedJobMeta.set('a', { id: 1 });
        failedJobMeta.set('b', { id: 2 });
        const res = await fetch(apiUrl('/api/queue/retry-all'), { method: 'POST' });
        const body = await res.json();
        expect(body.retried).toBe(2);
        expect(body.skipped).toBe(0);
        expect(dl.retryJob).toHaveBeenCalledTimes(2);
    });

    it('skips entries with a falsy meta without calling retryJob', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        failedJobMeta.set('a', null);
        const res = await fetch(apiUrl('/api/queue/retry-all'), { method: 'POST' });
        const body = await res.json();
        expect(body.retried).toBe(0);
        expect(body.skipped).toBe(1);
        expect(dl.retryJob).not.toHaveBeenCalled();
    });

    it('counts a retryJob throw as skipped rather than aborting the loop', async () => {
        const dl = makeFakeDl();
        dl.retryJob.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        runtime._downloader = dl;
        failedJobMeta.set('a', { id: 1 });
        failedJobMeta.set('b', { id: 2 });
        const res = await fetch(apiUrl('/api/queue/retry-all'), { method: 'POST' });
        const body = await res.json();
        expect(body.retried).toBe(1);
        expect(body.skipped).toBe(1);
    });
});

describe('POST /api/queue/batch', () => {
    it('400s when keys is missing or empty', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: [], action: 'pause' }),
        });
        expect(res.status).toBe(400);
    });

    it('400s for an unrecognised action', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'nuke' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('action must be one of');
    });

    it('skips an empty-string key with a reason', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['', null], action: 'pause' }),
        });
        const body = await res.json();
        expect(body.ok).toBe(0);
        expect(body.failed).toEqual([
            { key: '', reason: 'empty key' },
            { key: null, reason: 'empty key' },
        ]);
    });

    it('pause: counts a false pauseJob as failed with "not pausable"', async () => {
        const dl = makeFakeDl();
        dl.pauseJob.mockReturnValue(false);
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'pause' }),
        });
        const body = await res.json();
        expect(body.ok).toBe(0);
        expect(body.failed).toEqual([{ key: 'a', reason: 'not pausable' }]);
    });

    it('resume: counts a false resumeJob as failed with "not paused"', async () => {
        const dl = makeFakeDl();
        dl.resumeJob.mockReturnValue(false);
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'resume' }),
        });
        const body = await res.json();
        expect(body.failed).toEqual([{ key: 'a', reason: 'not paused' }]);
    });

    it('cancel: always counts as ok and deletes failedJobMeta', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        failedJobMeta.set('a', {});
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'cancel' }),
        });
        const body = await res.json();
        expect(body.ok).toBe(1);
        expect(failedJobMeta.has('a')).toBe(false);
    });

    it('retry: fails with "meta evicted" when no cached meta exists', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'retry' }),
        });
        const body = await res.json();
        expect(body.failed).toEqual([{ key: 'a', reason: 'meta evicted' }]);
    });

    it('retry: succeeds when cached meta exists', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        failedJobMeta.set('a', { id: 1 });
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'retry' }),
        });
        const body = await res.json();
        expect(body.ok).toBe(1);
        expect(dl.retryJob).toHaveBeenCalledWith({ id: 1 });
    });

    it('dismiss: always counts as ok and deletes failedJobMeta without touching the downloader', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        failedJobMeta.set('a', {});
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'dismiss' }),
        });
        const body = await res.json();
        expect(body.ok).toBe(1);
        expect(failedJobMeta.has('a')).toBe(false);
        expect(dl.cancelJob).not.toHaveBeenCalled();
    });

    it('isolates a per-key throw from the rest of the batch', async () => {
        const dl = makeFakeDl();
        dl.pauseJob.mockImplementation((key) => {
            if (key === 'bad') throw new Error('exploded');
            return true;
        });
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['good', 'bad'], action: 'pause' }),
        });
        const body = await res.json();
        expect(body.ok).toBe(1);
        expect(body.failed).toEqual([{ key: 'bad', reason: 'exploded' }]);
    });

    it('falls back to "unknown" reason when a throw has no message', async () => {
        const dl = makeFakeDl();
        dl.pauseJob.mockImplementation(() => {
            throw {};
        });
        runtime._downloader = dl;
        const res = await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a'], action: 'pause' }),
        });
        const body = await res.json();
        expect(body.failed[0].reason).toBe('unknown');
    });

    it('broadcasts one coalesced queue_changed frame for the whole batch', async () => {
        const dl = makeFakeDl();
        runtime._downloader = dl;
        await fetch(apiUrl('/api/queue/batch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['a', 'b'], action: 'cancel' }),
        });
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0]).toEqual({
            type: 'queue_changed',
            payload: { op: 'batch', action: 'cancel', ok: 2, failed: 0 },
        });
    });
});
