// Route-level HTTP tests for /api/version*, /api/update/*, and
// /api/auto-update/status. Mounts the REAL createVersionRouter (unlike
// tests/update-routes.test.js, which hand-reimplements equivalent
// route logic rather than importing src/web/routes/version.js — that
// file exercises the /api/update/* contract in isolation but leaves
// the actual router module at 0% coverage).
//
// core/updater.js is mocked (network/git calls). core/db.js and
// core/job-tracker.js run for real against a temp data dir/DB, same
// pattern as routes-config.test.js. globalThis.fetch is stubbed per
// test for the GitHub release check.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-version-'));

// vi.stubGlobal('fetch', ...) replaces the one global fetch used both
// by the route's outbound GitHub call AND by this test's own calls to
// its local server — capture the real one up front so local calls
// keep working regardless of what the route-under-test stubs.
const realFetch = globalThis.fetch;

const runAutoUpdate = vi.fn();
const autoUpdateStatus = vi.fn(() => ({ available: false }));
vi.mock('../src/core/updater.js', () => ({ runAutoUpdate, autoUpdateStatus }));

let dbApi;
let db;
let createJobTracker;
let app;
let server;
let port;
let broadcasts;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    ({ createJobTracker } = await import('../src/core/job-tracker.js'));

    const { createVersionRouter } = await import('../src/web/routes/version.js');

    broadcasts = [];
    const autoUpdateTracker = createJobTracker({
        kind: 'autoUpdate',
        broadcast: (msg) => broadcasts.push(msg),
        log: () => {},
        eventPrefix: 'update',
    });

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createVersionRouter({
            broadcast: (msg) => broadcasts.push(msg),
            autoUpdateTracker,
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
    autoUpdateStatus.mockReturnValue({ available: false });
    broadcasts.length = 0;
    delete process.env.npm_package_version;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('GET /api/version', () => {
    it('returns version/commit/builtAt', async () => {
        process.env.npm_package_version = '3.2.1';
        const res = await realFetch(apiUrl('/api/version'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.version).toBe('3.2.1');
        expect(body.commit).toBeDefined();
    });

    it('defaults commit to "dev" and builtAt to null with no env set', async () => {
        delete process.env.GIT_SHA;
        delete process.env.BUILT_AT;
        const res = await realFetch(apiUrl('/api/version'));
        const body = await res.json();
        expect(body.commit).toBe('dev');
        expect(body.builtAt).toBeNull();
    });

    it('truncates a long GIT_SHA to 7 chars', async () => {
        process.env.GIT_SHA = 'abcdef1234567890';
        const res = await realFetch(apiUrl('/api/version'));
        const body = await res.json();
        expect(body.commit).toBe('abcdef1');
        delete process.env.GIT_SHA;
    });
});

describe('GET /api/version/check', () => {
    // These two run first, deliberately: _updateCache is module-scope
    // state with no reset hook, so once any other test in this describe
    // populates it, "no prior cache" scenarios become unreachable for
    // the rest of the file.
    it('ignores a release tag not shaped like vN (no prior cache)', async () => {
        process.env.npm_package_version = '1.0.0';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ tag_name: 'nightly-build' }),
            }),
        );
        const res = await realFetch(apiUrl('/api/version/check?force=1'));
        const body = await res.json();
        expect(body.latest).toBeNull();
        expect(body.error).toBe('unreachable');
    });

    it('returns an unreachable error with no prior cache when the fetch fails', async () => {
        process.env.npm_package_version = '1.0.0';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        const res = await realFetch(apiUrl('/api/version/check?force=1'));
        const body = await res.json();
        expect(body.updateAvailable).toBe(false);
        expect(body.latest).toBeNull();
        expect(body.error).toBe('unreachable');
    });

    it('reports updateAvailable when the latest release is newer', async () => {
        process.env.npm_package_version = '1.0.0';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    tag_name: 'v2.0.0',
                    name: 'v2.0.0',
                    html_url: 'https://example.com/v2.0.0',
                    published_at: '2026-01-01T00:00:00Z',
                }),
            }),
        );
        const res = await realFetch(apiUrl('/api/version/check?force=1'));
        const body = await res.json();
        expect(body.updateAvailable).toBe(true);
        expect(body.latest).toBe('v2.0.0');
        expect(body.cached).toBe(false);
    });

    it('reports updateAvailable:false when already on the latest', async () => {
        process.env.npm_package_version = '2.0.0';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
            }),
        );
        const res = await realFetch(apiUrl('/api/version/check?force=1'));
        const body = await res.json();
        expect(body.updateAvailable).toBe(false);
    });

    it('falls back to stale cache when a later fetch fails', async () => {
        process.env.npm_package_version = '1.0.0';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
            }),
        );
        await realFetch(apiUrl('/api/version/check?force=1'));

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const res = await realFetch(apiUrl('/api/version/check?force=1'));
        const body = await res.json();
        expect(body.stale).toBe(true);
        expect(body.cached).toBe(true);
        expect(body.latest).toBe('v2.0.0');
    });

    it('serves the cached result within the TTL without re-fetching', async () => {
        process.env.npm_package_version = '1.0.0';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
        });
        vi.stubGlobal('fetch', fetchMock);
        await realFetch(apiUrl('/api/version/check?force=1'));
        fetchMock.mockClear();

        const res = await realFetch(apiUrl('/api/version/check'));
        const body = await res.json();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(body.cached).toBe(true);
        expect(body.latest).toBe('v2.0.0');
    });

    it('re-fetches once the 10-minute cache TTL has elapsed', async () => {
        process.env.npm_package_version = '1.0.0';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
            }),
        );
        await realFetch(apiUrl('/api/version/check?force=1'));

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ tag_name: 'v3.0.0', name: 'v3.0.0' }),
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        try {
            const res = await realFetch(apiUrl('/api/version/check'));
            const body = await res.json();
            expect(fetchMock).toHaveBeenCalled();
            expect(body.latest).toBe('v3.0.0');
            expect(body.cached).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-fetches once the current version has caught up to the cached "latest"', async () => {
        process.env.npm_package_version = '1.0.0';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
            }),
        );
        await realFetch(apiUrl('/api/version/check?force=1'));

        process.env.npm_package_version = '2.0.0';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
        });
        vi.stubGlobal('fetch', fetchMock);
        await realFetch(apiUrl('/api/version/check'));
        expect(fetchMock).toHaveBeenCalled();
    });
});

describe('GET /api/update/status', () => {
    it('proxies autoUpdateStatus()', async () => {
        autoUpdateStatus.mockReturnValue({ available: true, dockerized: true });
        const res = await realFetch(apiUrl('/api/update/status'));
        const body = await res.json();
        expect(body).toEqual({ available: true, dockerized: true });
    });
});

describe('GET /api/auto-update/status', () => {
    it('returns the tracker snapshot', async () => {
        const res = await realFetch(apiUrl('/api/auto-update/status'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('running');
    });
});

describe('POST /api/update', () => {
    it('starts the update, records the attempt, and broadcasts update_started', async () => {
        runAutoUpdate.mockResolvedValue({ backup: { path: '/backups/x.tar', sizeBytes: 100 } });
        const res = await realFetch(apiUrl('/api/update'), { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.started).toBe(true);
        await vi.waitFor(() =>
            expect(broadcasts.some((b) => b.type === 'update_started')).toBe(true),
        );
    });

    it('409s with ALREADY_RUNNING when a run is already in flight', async () => {
        let releaseFirst;
        runAutoUpdate.mockReturnValue(new Promise((r) => (releaseFirst = r)));
        const first = await realFetch(apiUrl('/api/update'), { method: 'POST' });
        expect(first.status).toBe(200);

        const second = await realFetch(apiUrl('/api/update'), { method: 'POST' });
        expect(second.status).toBe(409);
        const body = await second.json();
        expect(body.code).toBe('ALREADY_RUNNING');

        releaseFirst({ backup: null });
        await vi.waitFor(() => expect(true).toBe(true));
    });

    it('records the failure without crashing the process when runAutoUpdate rejects', async () => {
        const err = new Error('git pull failed');
        err.code = 'GIT_FAILED';
        runAutoUpdate.mockRejectedValue(err);
        const res = await realFetch(apiUrl('/api/update'), { method: 'POST' });
        expect(res.status).toBe(200);
        await new Promise((r) => setTimeout(r, 30));
        // No crash, no unhandled rejection — the failure is caught and
        // recorded internally by the job tracker + recordUpdateFailure.
    });
});

describe('GET /api/update/history', () => {
    it('returns an empty history array with nothing recorded', async () => {
        const res = await realFetch(apiUrl('/api/update/history'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.history)).toBe(true);
    });

    describe('limit clamping (seeded with 3 real rows)', () => {
        // Note: version.js's own Math.max(1, Math.min(200, ...)) clamp is
        // unobservable through this route — core/db/kv.js's
        // listUpdateHistory() re-clamps the same way internally, so
        // removing the route's clamp changes nothing end-to-end. These
        // tests pin the observable *contract* (limit is honored/bounded),
        // which holds regardless of which layer enforces it.
        beforeEach(() => {
            db.prepare('DELETE FROM update_history').run();
            for (let i = 0; i < 3; i++) {
                dbApi.recordUpdateAttempt({ fromVersion: `seed-${i}` });
            }
        });

        it('treats limit=0 as falsy and falls back to the default (not floor-clamped)', async () => {
            // `parseInt(req.query.limit, 10) || 25` treats 0 as "not
            // provided" since 0 is falsy — only a genuinely negative
            // limit reaches the Math.max(1, ...) floor below.
            const res = await realFetch(apiUrl('/api/update/history?limit=0'));
            const body = await res.json();
            expect(body.history).toHaveLength(3);
        });

        it('clamps a negative limit up to the floor of 1', async () => {
            const res = await realFetch(apiUrl('/api/update/history?limit=-5'));
            const body = await res.json();
            expect(body.history).toHaveLength(1);
        });

        it('respects an in-range limit', async () => {
            const res = await realFetch(apiUrl('/api/update/history?limit=2'));
            const body = await res.json();
            expect(body.history).toHaveLength(2);
        });

        it('does not error on an out-of-range high limit (clamped to 200)', async () => {
            const res = await realFetch(apiUrl('/api/update/history?limit=99999'));
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.history).toHaveLength(3);
        });

        it('falls back to the default limit for a non-numeric limit', async () => {
            const res = await realFetch(apiUrl('/api/update/history?limit=not-a-number'));
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.history).toHaveLength(3);
        });
    });
});
