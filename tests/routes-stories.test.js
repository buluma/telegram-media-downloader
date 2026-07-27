// Route-level HTTP tests for /api/stories/*. Mounts the real stories
// router on a minimal Express app. core/stories.js, core/runtime.js,
// core/downloader.js and core/security.js are mocked — the download
// endpoint's actual enqueue/drain behavior belongs to core-level tests
// (P3), this only exercises the route's wiring and guards. The real
// `telegram` package is used for Api.stories.GetPeerStories since
// constructing it is side-effect-free.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';

const listUserStories = vi.fn();
const listAllStories = vi.fn();
const storyToJob = vi.fn((opts) => ({ ...opts, kind: 'story-job' }));
vi.mock('../src/core/stories.js', () => ({ listUserStories, listAllStories, storyToJob }));

const loadConfig = vi.fn(() => ({ rateLimits: {} }));
vi.mock('../src/config/manager.js', () => ({ loadConfig }));

const runtime = { _downloader: null };
vi.mock('../src/core/runtime.js', () => ({ runtime }));

const RateLimiter = vi.fn();
vi.mock('../src/core/security.js', () => ({ RateLimiter }));

let fakeDownloader;
const DownloadManager = vi.fn().mockImplementation(function () {
    return fakeDownloader;
});
vi.mock('../src/core/downloader.js', () => ({ DownloadManager }));

let app;
let server;
let port;
let getAccountManager;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function makeFakeAm({ count = 1, client = {} } = {}) {
    return {
        count,
        getDefaultClient: () => client,
        getIdForClient: () => 'acc-1',
        metadata: { get: () => ({ name: 'Test Account' }) },
    };
}

function makeFakeDownloader({ queueResult = true } = {}) {
    return {
        init: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
        enqueue: vi.fn().mockResolvedValue(queueResult),
        stop: vi.fn().mockResolvedValue(undefined),
        pendingCount: 0,
        active: new Set(),
    };
}

beforeAll(async () => {
    const { createStoriesRouter } = await import('../src/web/routes/stories.js');
    app = express();
    app.use(express.json());
    app.use('/api', createStoriesRouter({ getAccountManager: (...a) => getAccountManager(...a) }));
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
    runtime._downloader = null;
    fakeDownloader = makeFakeDownloader();
    getAccountManager = async () => makeFakeAm();
});

describe('POST /api/stories/user', () => {
    it('400s without a username', async () => {
        const res = await fetch(apiUrl('/api/stories/user'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => makeFakeAm({ count: 0 });
        const res = await fetch(apiUrl('/api/stories/user'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice' }),
        });
        expect(res.status).toBe(409);
    });

    it('returns the story list on success', async () => {
        listUserStories.mockResolvedValue({ stories: [{ id: 1 }] });
        const res = await fetch(apiUrl('/api/stories/user'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.stories).toEqual([{ id: 1 }]);
    });

    it('maps a NO_API_CREDS failure to 503', async () => {
        const err = new Error('no creds');
        err.code = 'NO_API_CREDS';
        listUserStories.mockRejectedValue(err);
        const res = await fetch(apiUrl('/api/stories/user'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice' }),
        });
        expect(res.status).toBe(503);
    });

    it("maps a generic failure to 502 (not tgAuthErrorBody's raw 400)", async () => {
        listUserStories.mockRejectedValue(new Error('flood wait'));
        const res = await fetch(apiUrl('/api/stories/user'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice' }),
        });
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.error).toBe('flood wait');
    });
});

describe('POST /api/stories/all', () => {
    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => makeFakeAm({ count: 0 });
        const res = await fetch(apiUrl('/api/stories/all'), { method: 'POST' });
        expect(res.status).toBe(409);
    });

    it('returns all stories on success', async () => {
        listAllStories.mockResolvedValue({ peers: [{ id: 'x' }] });
        const res = await fetch(apiUrl('/api/stories/all'), { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.peers).toEqual([{ id: 'x' }]);
    });

    it('maps a generic failure to 502', async () => {
        listAllStories.mockRejectedValue(new Error('down'));
        const res = await fetch(apiUrl('/api/stories/all'), { method: 'POST' });
        expect(res.status).toBe(502);
    });
});

describe('POST /api/stories/download', () => {
    function baseBody(overrides = {}) {
        return { username: 'alice', storyIds: [1, 2], ...overrides };
    }

    it('400s without a username', async () => {
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ username: undefined })),
        });
        expect(res.status).toBe(400);
    });

    it('400s when storyIds is not a non-empty array', async () => {
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [] })),
        });
        expect(res.status).toBe(400);
    });

    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => makeFakeAm({ count: 0 });
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody()),
        });
        expect(res.status).toBe(409);
    });

    it('queues matched stories and reports queued/requested counts', async () => {
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({
                stories: { stories: [{ id: 1 }, { id: 2 }, { id: 3 }] },
            }),
        };
        getAccountManager = async () => makeFakeAm({ client });
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1, 3] })),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.queued).toBe(2);
        expect(body.requested).toBe(2);
        expect(fakeDownloader.enqueue).toHaveBeenCalledTimes(2);
    });

    it('actually waits (polling every 1s) while jobs are still pending, then stops', async () => {
        vi.useFakeTimers();
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({ stories: { stories: [{ id: 1 }] } }),
        };
        getAccountManager = async () => makeFakeAm({ client });
        let pending = 1;
        Object.defineProperty(fakeDownloader, 'pendingCount', {
            get: () => pending,
        });
        const resPromise = fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1] })),
        });
        await vi.waitFor(() => expect(fakeDownloader.init).toHaveBeenCalled());
        expect(fakeDownloader.stop).not.toHaveBeenCalled();
        pending = 0;
        await vi.advanceTimersByTimeAsync(1000);
        expect(fakeDownloader.stop).toHaveBeenCalled();
        vi.useRealTimers();
        const res = await resPromise;
        expect(res.status).toBe(200);
    });

    it('creates a standalone downloader and drains it when runtime has none running', async () => {
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({ stories: { stories: [{ id: 1 }] } }),
        };
        getAccountManager = async () => makeFakeAm({ client });
        runtime._downloader = null;
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1] })),
        });
        expect(res.status).toBe(200);
        expect(fakeDownloader.init).toHaveBeenCalled();
        expect(fakeDownloader.start).toHaveBeenCalled();
        await new Promise((r) => setTimeout(r, 20));
        expect(fakeDownloader.stop).toHaveBeenCalled();
    });

    it('logs a warning instead of crashing when the standalone drain loop itself throws', async () => {
        // downloader.stop() failures are already swallowed inline
        // (`.catch(() => {})`), so the outer catch only fires for a
        // failure in the drain loop itself — simulated here via a
        // `.active` that throws on `.size` access, standing in for
        // whatever unexpected engine state would trip this in practice.
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({ stories: { stories: [{ id: 1 }] } }),
        };
        getAccountManager = async () => makeFakeAm({ client });
        fakeDownloader.pendingCount = 0;
        Object.defineProperty(fakeDownloader, 'active', {
            get() {
                throw new Error('engine state corrupted');
            },
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1] })),
        });
        expect(res.status).toBe(200);
        await new Promise((r) => setTimeout(r, 20));
        expect(warnSpy).toHaveBeenCalledWith(
            '[stories] standalone drain failed:',
            'engine state corrupted',
        );
        warnSpy.mockRestore();
    });

    it('reuses the running runtime downloader instead of creating a standalone one', async () => {
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({ stories: { stories: [{ id: 1 }] } }),
        };
        getAccountManager = async () => makeFakeAm({ client });
        const runningDownloader = makeFakeDownloader();
        runtime._downloader = runningDownloader;
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1] })),
        });
        expect(res.status).toBe(200);
        expect(runningDownloader.enqueue).toHaveBeenCalled();
        expect(runningDownloader.init).not.toHaveBeenCalled();
        expect(runningDownloader.start).not.toHaveBeenCalled();
        expect(runningDownloader.stop).not.toHaveBeenCalled();
        expect(DownloadManager).not.toHaveBeenCalled();
    });

    it('reports 0 queued when no story ids match', async () => {
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({ stories: { stories: [{ id: 99 }] } }),
        };
        getAccountManager = async () => makeFakeAm({ client });
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1] })),
        });
        const body = await res.json();
        expect(body.queued).toBe(0);
        expect(body.requested).toBe(1);
    });

    it('handles a response with no stories field at all', async () => {
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({}),
        };
        getAccountManager = async () => makeFakeAm({ client });
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody()),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.queued).toBe(0);
    });

    it('500s and logs when the client throws', async () => {
        const client = {
            getEntity: vi.fn().mockRejectedValue(new Error('peer not found')),
            invoke: vi.fn(),
        };
        getAccountManager = async () => makeFakeAm({ client });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody()),
        });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('peer not found');
        errSpy.mockRestore();
    });

    it('falls back to #accountId when no metadata name/username/phone is available', async () => {
        const client = {
            getEntity: vi.fn().mockResolvedValue({ username: 'alice' }),
            invoke: vi.fn().mockResolvedValue({ stories: { stories: [{ id: 1 }] } }),
        };
        getAccountManager = async () => ({
            count: 1,
            getDefaultClient: () => client,
            getIdForClient: () => 'acc-7',
            metadata: { get: () => null },
        });
        await fetch(apiUrl('/api/stories/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody({ storyIds: [1] })),
        });
        const [job] = fakeDownloader.enqueue.mock.calls[0];
        expect(job.accountName).toBe('#acc-7');
    });
});
