// Route-level tests for src/web/routes/maintenance.js — the largest,
// most subsystem-heavy route file in the app (db integrity/vacuum, dedup
// scan/delete, thumbnails, seekbar sprites, faststart, NSFW review v1+v2,
// recovery cleanup, logs, session export/revoke).
//
// Heavy/ML/ffmpeg-backed subsystems are mocked wholesale (thumbs, seekbar/*,
// nsfw classifier, dedup file-hashing, integrity sweep/reindex, faststart,
// runtime). Pure-SQL collaborators (core/db/faces.js, core/db/nsfw.js,
// core/db/kv.js) and config/db themselves run for real against an isolated
// TGDL_DATA_DIR temp dir, matching the groups/downloads test convention —
// there's no ffmpeg/ML work hiding in those paths, just queries.
//
// Three real, previously-undocumented ReferenceError bugs fixed alongside
// these tests (found by reading the file to plan coverage):
//   - POST /maintenance/resync-dialogs referenced a bare `entityCache`
//     that was never imported (it's a private const in server.js) — always
//     threw, but the throw was inside a try/catch that swallows it, so the
//     "clear stale entity cache" step silently never ran. Fixed by adding
//     a `clearEntityCache` collaborator (exported from server.js) to the
//     factory's dependency-injection params, matching the existing
//     resolveEntityAcrossAccounts/downloadProfilePhoto pattern.
//   - POST /maintenance/session/export referenced a bare `_secureSession`
//     that didn't exist in this file at all — always 500'd. Fixed by
//     constructing an independent SecureSession instance the same way
//     core/accounts.js already does (SecureSession + getOrGenerateSecret).
//   - POST /maintenance/sessions/revoke-all referenced `SESSION_COOKIE_OPTS`,
//     which doesn't exist ANYWHERE in the codebase — always 500'd, even
//     though revokeAllSessions() had already run by that point (sessions
//     really were revoked; only the response failed). Fixed by exporting
//     the existing `sessionCookieOpts(req)` helper from routes/auth.js and
//     using it here, matching how auth.js itself sets/clears the cookie.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-maintenance-'));

const thumbsApi = {
    getOrCreateThumb: vi.fn(async () => null),
    purgeThumbsForDownload: vi.fn(async () => 0),
    hasCachedThumb: vi.fn(() => false),
    buildAllThumbnails: vi.fn(async () => ({ built: 0, skipped: 0, errored: 0, scanned: 0 })),
    purgeAllThumbs: vi.fn(async () => 0),
    getThumbsCacheStats: vi.fn(async () => ({ count: 0, bytes: 0 })),
    hasFfmpeg: vi.fn(() => true),
    probeHwaccel: vi.fn(async () => ({
        compiledIn: [],
        available: [],
        ffmpegPath: '/usr/bin/ffmpeg',
    })),
};
vi.mock('../src/core/thumbs.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...thumbsApi };
});

const scanRunnerApi = {
    buildAllSeekbar: vi.fn(async () => ({ built: 0, skipped: 0 })),
    purgeAllSeekbar: vi.fn(async () => 0),
};
vi.mock('../src/core/seekbar/scan-runner.js', () => scanRunnerApi);

const seekbarGenApi = {
    generateForDownload: vi.fn(async () => ({ generated: true })),
    getSpritePath: vi.fn((id) => `/tmp/seekbar-${id}.webp`),
};
vi.mock('../src/core/seekbar/generator.js', () => seekbarGenApi);

const seekbarIndexApi = {
    getSeekbarCacheStats: vi.fn(() => ({ count: 0 })),
    getMetaForDownload: vi.fn(async () => null),
};
vi.mock('../src/core/seekbar/index.js', () => seekbarIndexApi);

const seekbarSpawnApi = {
    getSidecarStatus: vi.fn(() => ({ ok: false })),
    refreshSidecar: vi.fn(async () => {}),
    SIDECAR_VERSION: 'test-1',
};
vi.mock('../src/core/seekbar/spawn.js', () => seekbarSpawnApi);

const seekbarClientApi = {
    probeHwaccel: vi.fn(async () => ({ available: [] })),
    stats: vi.fn(async () => ({ queued: 0, processing: 0, completed: 0, failed: 0 })),
};
vi.mock('../src/core/seekbar/client.js', () => seekbarClientApi);

const nsfwCoreApi = {
    NSFW_DEFAULTS: {
        model: 'test-model',
        threshold: 0.5,
        concurrency: 2,
        batchSize: 8,
        fileTypes: ['photo'],
        cacheDir: '/tmp/nsfw-cache',
    },
    startScan: vi.fn(async () => ({ started: true })),
    cancelScan: vi.fn(() => true),
    isScanRunning: vi.fn(() => false),
    getScanState: vi.fn(() => ({
        running: false,
        scanned: 0,
        total: 0,
        candidates: 0,
        keep: 0,
        whitelisted: 0,
        totalEligible: 0,
        lastCheckedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
    })),
    classifierReady: vi.fn(() => ({ ready: false })),
    preloadClassifier: vi.fn(async () => ({ ok: true })),
    clearClassifierCache: vi.fn(async () => ({ files: 0, bytes: 0 })),
};
vi.mock('../src/core/nsfw.js', () => nsfwCoreApi);

const dedupApi = {
    findDuplicates: vi.fn(async () => ({ scanned: 0, hashed: 0, duplicateSets: [] })),
    deleteByIds: vi.fn(async (ids) => ({ removed: ids.length, freedBytes: 0, missingFiles: 0 })),
};
vi.mock('../src/core/dedup.js', () => dedupApi);

const webAuthApi = {
    loginVerify: vi.fn(() => ({ ok: false })),
    isAuthConfigured: vi.fn(() => true),
    revokeAllSessions: vi.fn(() => {}),
};
vi.mock('../src/core/web-auth.js', () => webAuthApi);

const integrityApi = {
    sweep: vi.fn(async () => ({ removed: 0, scanned: 0 })),
    reindexFromDisk: vi.fn(async () => ({ added: 0, scanned: 0 })),
};
vi.mock('../src/core/integrity.js', () => integrityApi);

const faststartApi = {
    optimizeAll: vi.fn(async () => ({
        optimized: 0,
        already: 0,
        skipped: 0,
        errored: 0,
        scanned: 0,
    })),
    getStats: vi.fn(async () => ({ pending: 0, optimized: 0 })),
    getAutoStats: vi.fn(() => ({ optimized: 0, total: 0 })),
};
vi.mock('../src/core/faststart.js', () => faststartApi);

const durationApi = {
    backfillDurations: vi.fn(async () => ({ total: 0, processed: 0, updated: 0 })),
    getDurationStats: vi.fn(() => ({ total: 0, pending: 0, known: 0, ffmpegAvailable: true })),
};
vi.mock('../src/core/duration-backfill.js', () => durationApi);

const runtimeApi = {
    runtime: {
        state: 'stopped',
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        status: vi.fn(() => ({ state: 'stopped' })),
        _monitor: null,
    },
};
vi.mock('../src/core/runtime.js', () => runtimeApi);

let manager;
let dbApi;
let downloadsApi;
let facesApi;
let nsfwDbApi;
let app;
let server;
let port;
let broadcasts;
let jobTrackers;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function get(p) {
    const res = await fetch(apiUrl(p));
    let body = null;
    try {
        body = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body, res };
}

async function post(p, body) {
    const res = await fetch(apiUrl(p), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    let parsed = null;
    try {
        parsed = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body: parsed, res };
}

async function del(p) {
    const res = await fetch(apiUrl(p), { method: 'DELETE' });
    let body = null;
    try {
        body = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body };
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    facesApi = await import('../src/core/db/faces.js');
    nsfwDbApi = await import('../src/core/db/nsfw.js');
    manager = await import('../src/config/manager.js');
    const { createJobTracker } = await import('../src/core/job-tracker.js');

    const { createMaintenanceRouter } = await import('../src/web/routes/maintenance.js');
    broadcasts = [];
    const broadcast = (m) => broadcasts.push(m);
    const trackerKinds = [
        'resyncDialogs',
        'restartMonitor',
        'dbIntegrity',
        'filesVerify',
        'reindex',
        'dbVacuum',
        'dedupScan',
        'dedupDelete',
        'thumbsRebuild',
        'thumbsBuild',
        'seekbarBuild',
        'seekbarRebuild',
        'faststart',
        'durationBackfill',
        'nsfwBulk',
        'recoveryBulk',
    ];
    jobTrackers = {};
    for (const kind of trackerKinds) {
        jobTrackers[kind] = createJobTracker({ kind, broadcast });
    }

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createMaintenanceRouter({
            broadcast,
            log: () => {},
            jobTrackers,
            getAccountManager: async () => ({ count: 0, clients: new Map() }),
            resolveEntityAcrossAccounts: async () => null,
            downloadProfilePhoto: async () => null,
            clearEntityCache: () => {},
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
        dbApi.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function waitIdle(statusPath) {
    for (let i = 0; i < 100; i++) {
        const { body } = await get(statusPath);
        if (!body?.running) return body;
        await new Promise((r) => setTimeout(r, 20));
    }
    return get(statusPath).then((r) => r.body);
}

beforeEach(async () => {
    const cfg = manager.loadConfig();
    cfg.groups = [];
    await manager.saveConfig(cfg);
    for (const table of ['downloads', 'faces', 'people']) {
        try {
            dbApi.getDb().prepare(`DELETE FROM ${table}`).run();
        } catch {
            /* table may not exist */
        }
    }
    try {
        dbApi.getDb().prepare("DELETE FROM kv WHERE key != 'config'").run();
    } catch {
        /* ok */
    }
    broadcasts.length = 0;
    vi.clearAllMocks();
    webAuthApi.isAuthConfigured.mockReturnValue(true);
    webAuthApi.loginVerify.mockReturnValue({ ok: false });
    runtimeApi.runtime.state = 'stopped';
    runtimeApi.runtime._monitor = null;
});

describe('resync-dialogs', () => {
    it('409s when no Telegram accounts are loaded', async () => {
        const { status } = await post('/api/maintenance/resync-dialogs');
        expect(status).toBe(409);
    });

    it('runs to completion and calls clearEntityCache when accounts are loaded', async () => {
        const { createMaintenanceRouter } = await import('../src/web/routes/maintenance.js');
        const { createJobTracker } = await import('../src/core/job-tracker.js');
        const clearEntityCache = vi.fn();
        const localApp = express();
        localApp.use(express.json());
        const localTrackers = { resyncDialogs: createJobTracker({ kind: 'resyncDialogs' }) };
        localApp.use(
            '/api',
            createMaintenanceRouter({
                broadcast: () => {},
                log: () => {},
                jobTrackers: localTrackers,
                getAccountManager: async () => ({ count: 1 }),
                resolveEntityAcrossAccounts: async () => null,
                downloadProfilePhoto: async () => null,
                clearEntityCache,
            }),
        );
        await new Promise((resolve) => {
            const s = localApp.listen(0, '127.0.0.1', async () => {
                const p = s.address().port;
                const res = await fetch(`http://127.0.0.1:${p}/api/maintenance/resync-dialogs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                });
                expect(res.status).toBe(200);
                for (let i = 0; i < 50; i++) {
                    if (!localTrackers.resyncDialogs.getStatus().running) break;
                    await new Promise((r) => setTimeout(r, 20));
                }
                expect(clearEntityCache).toHaveBeenCalled();
                s.close(resolve);
            });
        });
    });
});

describe('restart-monitor', () => {
    it('400s without confirm', async () => {
        const { status } = await post('/api/maintenance/restart-monitor', {});
        expect(status).toBe(400);
    });

    it('reports nothing-to-restart when the monitor was not running', async () => {
        const { status, body } = await post('/api/maintenance/restart-monitor', { confirm: true });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitIdle('/api/maintenance/restart-monitor/status');
        expect(final.result.restarted).toBe(false);
    });

    it('restarts when the monitor was running and accounts are loaded', async () => {
        runtimeApi.runtime.state = 'running';
        const { createMaintenanceRouter } = await import('../src/web/routes/maintenance.js');
        const localApp = express();
        localApp.use(express.json());
        const { createJobTracker } = await import('../src/core/job-tracker.js');
        const localTrackers = { restartMonitor: createJobTracker({ kind: 'restartMonitor' }) };
        localApp.use(
            '/api',
            createMaintenanceRouter({
                broadcast: () => {},
                log: () => {},
                jobTrackers: localTrackers,
                getAccountManager: async () => ({ count: 1 }),
                resolveEntityAcrossAccounts: async () => null,
                downloadProfilePhoto: async () => null,
                clearEntityCache: () => {},
            }),
        );
        await new Promise((resolve) => {
            const s = localApp.listen(0, '127.0.0.1', async () => {
                const p = s.address().port;
                const res = await fetch(`http://127.0.0.1:${p}/api/maintenance/restart-monitor`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirm: true }),
                });
                expect(res.status).toBe(200);
                for (let i = 0; i < 50; i++) {
                    if (!localTrackers.restartMonitor.getStatus().running) break;
                    await new Promise((r) => setTimeout(r, 20));
                }
                expect(runtimeApi.runtime.start).toHaveBeenCalled();
                s.close(resolve);
            });
        });
    });
});

describe('db integrity + vacuum', () => {
    it('runs an integrity check and reports ok', async () => {
        const { status, body } = await post('/api/maintenance/db/integrity');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitIdle('/api/maintenance/db/integrity/status');
        expect(final.result.ok).toBe(true);
    });

    it('400s vacuum without confirm', async () => {
        const { status } = await post('/api/maintenance/db/vacuum', {});
        expect(status).toBe(400);
    });

    it('vacuums and reports reclaimed bytes', async () => {
        const { status, body } = await post('/api/maintenance/db/vacuum', { confirm: true });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitIdle('/api/maintenance/db/vacuum/status');
        expect(final.result).toHaveProperty('reclaimedBytes');
    });

    it('lists db backups', async () => {
        const { status, body } = await get('/api/maintenance/db/backups');
        expect(status).toBe(200);
        expect(Array.isArray(body.backups)).toBe(true);
    });
});

describe('files/verify + reindex', () => {
    it('runs a verify sweep and persists last-run stats', async () => {
        integrityApi.sweep.mockResolvedValue({ removed: 3, scanned: 10 });
        const { status } = await post('/api/maintenance/files/verify');
        expect(status).toBe(200);
        await waitIdle('/api/maintenance/files/verify/status');
        const { body } = await get('/api/maintenance/files/verify/stats');
        expect(body.lastRun.removed).toBe(3);
    });

    it('runs a reindex sweep and persists last-run stats', async () => {
        integrityApi.reindexFromDisk.mockResolvedValue({ added: 5, scanned: 20 });
        const { status } = await post('/api/maintenance/reindex');
        expect(status).toBe(200);
        await waitIdle('/api/maintenance/reindex/status');
        const { body } = await get('/api/maintenance/reindex/stats');
        expect(body.lastRun.added).toBe(5);
    });
});

describe('dedup scan/status/stats/delete', () => {
    it('reports totals with no rows', async () => {
        const { status, body } = await get('/api/maintenance/dedup/stats');
        expect(status).toBe(200);
        expect(body.totalFiles).toBe(0);
    });

    it('scans and persists a summary', async () => {
        dedupApi.findDuplicates.mockResolvedValue({
            scanned: 2,
            hashed: 2,
            duplicateSets: [{ count: 2, fileSize: 100 }],
        });
        const { status } = await post('/api/maintenance/dedup/scan');
        expect(status).toBe(200);
        await waitIdle('/api/maintenance/dedup/status');
        const { body } = await get('/api/maintenance/dedup/stats');
        expect(body.lastScan.duplicateSets).toBe(1);
        expect(body.lastScan.extraCopies).toBe(1);
    });

    it('cancels a scan (idempotent when nothing running)', async () => {
        const { status, body } = await post('/api/maintenance/dedup/scan/cancel');
        expect(status).toBe(200);
        expect(body.cancelled).toBe(false);
    });

    it('400s delete without ids', async () => {
        const { status } = await post('/api/maintenance/dedup/delete', {});
        expect(status).toBe(400);
    });

    it('deletes ids via the dedup path', async () => {
        const { status, body } = await post('/api/maintenance/dedup/delete', { ids: [1, 2] });
        expect(status).toBe(200);
        expect(body.queued).toBe(2);
        await waitIdle('/api/maintenance/dedup/delete/status');
        expect(dedupApi.deleteByIds).toHaveBeenCalled();
    });

    it('409s dedup/delete when a scanner job is already running', async () => {
        jobTrackers.aiPeople = { isRunning: () => true };
        const { status, body } = await post('/api/maintenance/dedup/delete', { ids: [1] });
        expect(status).toBe(409);
        expect(body.code).toBe('RESOURCE_BUSY');
        delete jobTrackers.aiPeople;
    });
});

describe('thumbnail maintenance', () => {
    it('serves 400 for a bad thumb id', async () => {
        const { status } = await get('/api/thumbs/abc');
        expect(status).toBe(400);
    });

    it('404s (no-store) when no thumb can be generated', async () => {
        const res = await fetch(apiUrl('/api/thumbs/1'));
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('rebuilds (wipes) the thumbnail cache', async () => {
        thumbsApi.purgeAllThumbs.mockResolvedValue(42);
        const { status, body } = await post('/api/maintenance/thumbs/rebuild', {});
        expect(status).toBe(200);
        expect(body.kind).toBe('all');
        const final = await waitIdle('/api/maintenance/thumbs/rebuild/status');
        expect(final.result.removed).toBe(42);
    });

    it('rebuild-one purges + re-warms a single tile', async () => {
        thumbsApi.purgeThumbsForDownload.mockResolvedValue(1);
        thumbsApi.hasCachedThumb.mockReturnValue(true);
        const { status, body } = await post('/api/maintenance/thumbs/rebuild-one/5');
        expect(status).toBe(200);
        expect(body.removed).toBe(1);
        expect(body.cached).toBe(true);
    });

    it('400s rebuild-one for a bad id', async () => {
        const { status } = await post('/api/maintenance/thumbs/rebuild-one/0');
        expect(status).toBe(400);
    });

    it('builds thumbnails for every row missing one', async () => {
        thumbsApi.buildAllThumbnails.mockResolvedValue({
            built: 3,
            skipped: 1,
            errored: 0,
            scanned: 4,
        });
        const { status } = await post('/api/maintenance/thumbs/build-all', {});
        expect(status).toBe(200);
        await waitIdle('/api/maintenance/thumbs/build/status');
        const { body } = await get('/api/maintenance/thumbs/build/stats');
        expect(body.lastRun.built).toBe(3);
    });

    it('cancels a thumb build (idempotent)', async () => {
        const { body } = await post('/api/maintenance/thumbs/build/cancel');
        expect(body.success).toBe(true);
    });

    it('lists thumbnails with cursor pagination', async () => {
        downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileName: 'a.jpg',
            fileType: 'photo',
            filePath: 'G/images/a.jpg',
        });
        const { status, body } = await get('/api/maintenance/thumbs/list');
        expect(status).toBe(200);
        expect(body.rows).toHaveLength(1);
        expect(body.total).toBe(1);
    });

    it('reports hwaccel probe results', async () => {
        const { status, body } = await get('/api/maintenance/thumbs/hwaccel-probe');
        expect(status).toBe(200);
        expect(body.ffmpegPath).toBe('/usr/bin/ffmpeg');
    });

    it('reports cache stats', async () => {
        thumbsApi.getThumbsCacheStats.mockResolvedValue({ count: 7, bytes: 1000 });
        const { status, body } = await get('/api/maintenance/thumbs/stats');
        expect(status).toBe(200);
        expect(body.count).toBe(7);
        expect(body.allowedWidths).toEqual([320]);
    });
});

describe('seekbar maintenance', () => {
    it('builds all seekbar sprites', async () => {
        scanRunnerApi.buildAllSeekbar.mockResolvedValue({ built: 2 });
        const { status } = await post('/api/maintenance/seekbar/build-all');
        expect(status).toBe(200);
        await waitIdle('/api/maintenance/seekbar/build/status');
        const { body } = await get('/api/maintenance/seekbar/build/stats');
        expect(body.lastBuild.built).toBe(2);
    });

    it('cancels a seekbar build', async () => {
        const { body } = await post('/api/maintenance/seekbar/build/cancel');
        expect(body.success).toBe(true);
    });

    it('rebuilds (wipe + regenerate) seekbar sprites', async () => {
        scanRunnerApi.purgeAllSeekbar.mockResolvedValue(9);
        scanRunnerApi.buildAllSeekbar.mockResolvedValue({ built: 1 });
        const { status } = await post('/api/maintenance/seekbar/rebuild');
        expect(status).toBe(200);
        const final = await waitIdle('/api/maintenance/seekbar/rebuild/status');
        expect(final.result.wiped).toBe(9);
    });

    it('400s regen for a bad id', async () => {
        const { status } = await post('/api/maintenance/seekbar/regen/0');
        expect(status).toBe(400);
    });

    it('404s regen for a nonexistent download', async () => {
        const { status } = await post('/api/maintenance/seekbar/regen/999999');
        expect(status).toBe(404);
    });

    it('400s regen for a non-video download', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileType: 'photo',
        });
        const { status } = await post(`/api/maintenance/seekbar/regen/${r.lastInsertRowid}`);
        expect(status).toBe(400);
    });

    it('regenerates a sprite for a video download', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 2,
            fileType: 'video',
        });
        const { status, body } = await post(`/api/maintenance/seekbar/regen/${r.lastInsertRowid}`);
        expect(status).toBe(200);
        expect(body.generated).toBe(true);
    });

    it('reports stats + queue stats + health', async () => {
        expect((await get('/api/maintenance/seekbar/stats')).status).toBe(200);
        expect((await get('/api/maintenance/seekbar/queue/stats')).status).toBe(200);
        expect((await get('/api/maintenance/seekbar/health')).status).toBe(200);
    });

    it('reports "sidecar not running" for hwaccel-probe when sidecar is down', async () => {
        const { status, body } = await get('/api/maintenance/seekbar/hwaccel-probe');
        expect(status).toBe(200);
        expect(body.error).toBe('sidecar not running');
    });

    it('restarts the sidecar', async () => {
        const { status, body } = await post('/api/maintenance/seekbar/sidecar/restart');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(seekbarSpawnApi.refreshSidecar).toHaveBeenCalled();
    });

    it('lists seekbar sprites', async () => {
        const { status, body } = await get('/api/maintenance/seekbar/list');
        expect(status).toBe(200);
        expect(body.rows).toEqual([]);
    });

    it('404s /seekbar/sprite/:id when no sprite row exists', async () => {
        const res = await fetch(apiUrl('/api/seekbar/sprite/1'));
        expect(res.status).toBe(404);
    });

    it('404s /seekbar/meta/:id when no meta exists', async () => {
        const res = await fetch(apiUrl('/api/seekbar/meta/1'));
        expect(res.status).toBe(404);
    });
});

describe('faststart maintenance', () => {
    it('scans and persists a summary', async () => {
        faststartApi.optimizeAll.mockResolvedValue({ optimized: 2, already: 1, scanned: 3 });
        const { status } = await post('/api/maintenance/faststart/scan');
        expect(status).toBe(200);
        await waitIdle('/api/maintenance/faststart/status');
        const { body } = await get('/api/maintenance/faststart/stats');
        expect(body.lastRun.optimized).toBe(2);
    });

    it('reports auto-optimise stats', async () => {
        faststartApi.getAutoStats.mockReturnValue({ optimized: 5, total: 10 });
        const { status, body } = await get('/api/maintenance/faststart/auto-stats');
        expect(status).toBe(200);
        expect(body.optimized).toBe(5);
    });
});

describe('duration backfill maintenance', () => {
    it('runs the backfill and exposes its result through status', async () => {
        durationApi.backfillDurations.mockResolvedValue({ total: 3, processed: 3, updated: 2 });
        const { status, body } = await post('/api/maintenance/duration/backfill');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitIdle('/api/maintenance/duration/status');
        expect(final.result).toMatchObject({ total: 3, updated: 2 });
    });

    it('409s while a run is already in flight', async () => {
        let release;
        durationApi.backfillDurations.mockImplementationOnce(
            () => new Promise((r) => (release = () => r({ total: 0 }))),
        );
        expect((await post('/api/maintenance/duration/backfill')).status).toBe(200);
        const second = await post('/api/maintenance/duration/backfill');
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('ALREADY_RUNNING');
        release();
        await waitIdle('/api/maintenance/duration/status');
    });

    it('reports pending counts', async () => {
        durationApi.getDurationStats.mockReturnValue({ total: 10, pending: 4, known: 6 });
        const { status, body } = await get('/api/maintenance/duration/stats');
        expect(status).toBe(200);
        expect(body).toMatchObject({ pending: 4, known: 6 });
    });
});

describe('NSFW v1', () => {
    it('reports disabled status by default', async () => {
        const { status, body } = await get('/api/maintenance/nsfw/status');
        expect(status).toBe(200);
        expect(body.enabled).toBe(false);
    });

    it('503s scan when NSFW review is disabled', async () => {
        const { status, body } = await post('/api/maintenance/nsfw/scan');
        expect(status).toBe(503);
        expect(body.code).toBe('NSFW_DISABLED');
    });

    it('scans when enabled via config', async () => {
        const cfg = manager.loadConfig();
        cfg.advanced = { ...cfg.advanced, nsfw: { enabled: true } };
        await manager.saveConfig(cfg);
        const { status, body } = await post('/api/maintenance/nsfw/scan');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(nsfwCoreApi.startScan).toHaveBeenCalled();
    });

    it('409s scan when already running', async () => {
        const cfg = manager.loadConfig();
        cfg.advanced = { ...cfg.advanced, nsfw: { enabled: true } };
        await manager.saveConfig(cfg);
        nsfwCoreApi.isScanRunning.mockReturnValue(true);
        const { status } = await post('/api/maintenance/nsfw/scan');
        expect(status).toBe(409);
    });

    it('cancels a scan', async () => {
        const { body } = await post('/api/maintenance/nsfw/scan/cancel');
        expect(body.cancelled).toBe(true);
    });

    it('preloads the classifier', async () => {
        const { status, body } = await post('/api/maintenance/nsfw/preload');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('reports model status', async () => {
        const { status } = await get('/api/maintenance/nsfw/model-status');
        expect(status).toBe(200);
    });

    it('reports + clears the hash blocklist', async () => {
        nsfwDbApi.addNsfwBlocklistHash('deadbeef', 'x.jpg', 'manual');
        let r = await get('/api/maintenance/nsfw/blocklist/stats');
        expect(r.body.count).toBe(1);
        r = await del('/api/maintenance/nsfw/blocklist');
        expect(r.body.removed).toBe(1);
    });

    it('clears the model cache', async () => {
        nsfwCoreApi.clearClassifierCache.mockResolvedValue({ files: 2, bytes: 500 });
        const { status, body } = await del('/api/maintenance/nsfw/cache');
        expect(status).toBe(200);
        expect(body.files).toBe(2);
    });

    it('lists delete candidates and deletes them', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileType: 'photo',
            fileHash: 'abc123',
        });
        facesApi.setNsfwResult(r.lastInsertRowid, 0.1);
        const results = await get('/api/maintenance/nsfw/results');
        expect(results.status).toBe(200);
        expect(results.body.success).toBe(true);

        const del1 = await post('/api/maintenance/nsfw/delete', { ids: [r.lastInsertRowid] });
        expect(del1.status).toBe(200);
        expect(dedupApi.deleteByIds).toHaveBeenCalledWith([r.lastInsertRowid]);
    });

    it('400s delete/whitelist without ids', async () => {
        expect((await post('/api/maintenance/nsfw/delete', {})).status).toBe(400);
        expect((await post('/api/maintenance/nsfw/whitelist', {})).status).toBe(400);
    });

    it('whitelists rows', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 2,
            fileType: 'photo',
        });
        facesApi.setNsfwResult(r.lastInsertRowid, 0.1);
        const { status, body } = await post('/api/maintenance/nsfw/whitelist', {
            ids: [r.lastInsertRowid],
        });
        expect(status).toBe(200);
        expect(body.updated).toBe(1);
    });
});

describe('NSFW v2', () => {
    it('exposes the tier metadata', async () => {
        const { status, body } = await get('/api/maintenance/nsfw/v2/tiers-meta');
        expect(status).toBe(200);
        expect(Array.isArray(body.tiers)).toBe(true);
    });

    it('reports tier counts', async () => {
        const { status, body } = await get('/api/maintenance/nsfw/v2/tiers');
        expect(status).toBe(200);
        expect(body).toHaveProperty('threshold');
    });

    it('reports a histogram', async () => {
        const { status } = await get('/api/maintenance/nsfw/v2/histogram?bins=10');
        expect(status).toBe(200);
    });

    it('lists rows by tier', async () => {
        const { status, body } = await get('/api/maintenance/nsfw/v2/list?kind=video');
        expect(status).toBe(200);
        expect(body.rows).toEqual([]);
    });

    it('bulk-deletes by explicit ids (confirm-gated)', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 3,
            fileType: 'photo',
        });
        expect(
            (await post('/api/maintenance/nsfw/v2/bulk-delete', { ids: [r.lastInsertRowid] }))
                .status,
        ).toBe(400);
        const { status, body } = await post('/api/maintenance/nsfw/v2/bulk-delete', {
            ids: [r.lastInsertRowid],
            confirm: true,
        });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitIdle('/api/maintenance/nsfw/v2/bulk/status');
        expect(final.result.op).toBe('delete');
        expect(final.result.deleted).toBe(1);
    });

    it('409s bulk-delete when a scanner job is running', async () => {
        jobTrackers.aiOcr = { isRunning: () => true };
        const { status } = await post('/api/maintenance/nsfw/v2/bulk-delete', {
            ids: [1],
            confirm: true,
        });
        expect(status).toBe(409);
        delete jobTrackers.aiOcr;
    });

    it('bulk-whitelists and unwhitelists by ids', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 4,
            fileType: 'photo',
        });
        facesApi.setNsfwResult(r.lastInsertRowid, 0.1);
        const w = await post('/api/maintenance/nsfw/v2/bulk-whitelist', {
            ids: [r.lastInsertRowid],
        });
        expect(w.status).toBe(200);
        await waitIdle('/api/maintenance/nsfw/v2/bulk/status');
        const uw = await post('/api/maintenance/nsfw/v2/unwhitelist', { ids: [r.lastInsertRowid] });
        expect(uw.status).toBe(200);
        await waitIdle('/api/maintenance/nsfw/v2/bulk/status');
    });

    it('reclassifies rows (clears score for re-scan)', async () => {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 5,
            fileType: 'photo',
        });
        facesApi.setNsfwResult(r.lastInsertRowid, 0.1);
        const { status } = await post('/api/maintenance/nsfw/v2/reclassify', {
            ids: [r.lastInsertRowid],
        });
        expect(status).toBe(200);
        const final = await waitIdle('/api/maintenance/nsfw/v2/bulk/status');
        expect(final.result.cleared).toBe(1);
    });
});

describe('recovery cleanup', () => {
    it('lists synthetic + resolve-failed groups only', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [
            { id: 'unknown:foo', name: 'Foo', enabled: true },
            { id: '-100111', name: 'Normal', enabled: true },
            { id: '-100222', name: 'Failed', enabled: true, _resolveFailedAt: Date.now() },
        ];
        await manager.saveConfig(cfg);
        const { status, body } = await get('/api/maintenance/recovery/list');
        expect(status).toBe(200);
        expect(body.items.map((i) => i.id).sort()).toEqual(['-100222', 'unknown:foo'].sort());
    });

    it('countOnly returns just a total', async () => {
        const { body } = await get('/api/maintenance/recovery/list?countOnly=1');
        expect(body).toEqual({ success: true, total: 0 });
    });

    it('400s resolve without ids', async () => {
        const { status } = await post('/api/maintenance/recovery/resolve', {});
        expect(status).toBe(400);
    });

    it('resolve reports "monitor not running" when there is no live monitor', async () => {
        const { status } = await post('/api/maintenance/recovery/resolve', {
            ids: ['unknown:foo'],
        });
        expect(status).toBe(200);
        const final = await waitIdle('/api/maintenance/recovery/status');
        expect(final.result.note).toBe('monitor not running');
    });

    it('400s disable/reassign without ids, 400s reassign without monitorAccount', async () => {
        expect((await post('/api/maintenance/recovery/disable', {})).status).toBe(400);
        expect((await post('/api/maintenance/recovery/reassign', { ids: ['x'] })).status).toBe(400);
    });

    it('disables the given groups', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100333', name: 'X', enabled: true }];
        await manager.saveConfig(cfg);
        const { status, body } = await post('/api/maintenance/recovery/disable', {
            ids: ['-100333'],
        });
        expect(status).toBe(200);
        expect(body.disabled).toBe(1);
        expect(manager.loadConfig().groups[0].enabled).toBe(false);
    });

    it('reassigns groups to a new monitor account and clears the failure marker', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100444', name: 'X', enabled: true, _resolveFailedAt: Date.now() }];
        await manager.saveConfig(cfg);
        const { status, body } = await post('/api/maintenance/recovery/reassign', {
            ids: ['-100444'],
            monitorAccount: 'acct-2',
        });
        expect(status).toBe(200);
        expect(body.reassigned).toBe(1);
        const g = manager.loadConfig().groups[0];
        expect(g.monitorAccount).toBe('acct-2');
        expect(g._resolveFailedAt).toBeUndefined();
    });

    it('deletes groups from config, optionally purging downloads', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100555', name: 'X', enabled: true }];
        await manager.saveConfig(cfg);
        downloadsApi.insertDownload({ groupId: '-100555', groupName: 'X', messageId: 1 });
        const { status, body } = await post('/api/maintenance/recovery/delete', {
            ids: ['-100555'],
            purgeDownloads: true,
        });
        expect(status).toBe(200);
        expect(body.removed).toBe(1);
        expect(body.totalRows).toBe(1);
        expect(manager.loadConfig().groups).toHaveLength(0);
    });
});

describe('logs', () => {
    it('lists no logs when the logs dir does not exist', async () => {
        const { status, body } = await get('/api/maintenance/logs');
        expect(status).toBe(200);
        expect(body.files).toEqual([]);
    });

    it('lists + downloads a real log file, tailed to the requested line count (min floor 10)', async () => {
        const logsDir = path.join(DATA_DIR, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const allLines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
        fs.writeFileSync(path.join(logsDir, 'app.log'), allLines.join('\n') + '\n');
        const list = await get('/api/maintenance/logs');
        expect(list.body.files.some((f) => f.name === 'app.log')).toBe(true);

        const res = await fetch(apiUrl('/api/maintenance/logs/download?name=app.log&lines=2'));
        expect(res.status).toBe(200);
        const text = await res.text();
        // `lines` is clamped to a floor of 10 server-side, so a request for
        // 2 still returns the last 10 of the file's raw newline-split lines
        // (which includes a trailing '' from the file's final newline).
        expect(text.split('\n')).toEqual([...allLines, ''].slice(-10));
    });

    it('400s an invalid log name (path traversal attempt)', async () => {
        const { status } = await get(
            '/api/maintenance/logs/download?name=' + encodeURIComponent('../../etc/passwd'),
        );
        expect(status).toBe(400);
    });

    it('404s a well-formed but missing log name', async () => {
        const { status } = await get('/api/maintenance/logs/download?name=missing.log');
        expect(status).toBe(404);
    });
});

describe('session export + revoke-all (now-fixed ReferenceError bugs)', () => {
    it('400s export without confirm/password', async () => {
        expect((await post('/api/maintenance/session/export', {})).status).toBe(400);
        expect((await post('/api/maintenance/session/export', { confirm: true })).status).toBe(400);
    });

    it('403s export with a wrong password', async () => {
        webAuthApi.loginVerify.mockReturnValue({ ok: false });
        const { status } = await post('/api/maintenance/session/export', {
            confirm: true,
            password: 'wrong',
            accountId: 'acct1',
        });
        expect(status).toBe(403);
    });

    it('404s export for an account with no session file on disk', async () => {
        webAuthApi.loginVerify.mockReturnValue({ ok: true });
        const { status } = await post('/api/maintenance/session/export', {
            confirm: true,
            password: 'right',
            accountId: 'nonexistent',
        });
        expect(status).toBe(404);
    });

    it('400s export for a path-traversal accountId', async () => {
        webAuthApi.loginVerify.mockReturnValue({ ok: true });
        const { status } = await post('/api/maintenance/session/export', {
            confirm: true,
            password: 'right',
            accountId: '../evil',
        });
        expect(status).toBe(400);
    });

    it('exports (decrypts) a real on-disk session file', async () => {
        webAuthApi.loginVerify.mockReturnValue({ ok: true });
        const { SecureSession } = await import('../src/core/security.js');
        const { getOrGenerateSecret } = await import('../src/core/secret.js');
        const secure = new SecureSession(getOrGenerateSecret());
        const encrypted = secure.encrypt('my-secret-session-string');
        const sessionsDir = path.join(DATA_DIR, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, 'acct1.enc'), JSON.stringify(encrypted));
        const { status, body } = await post('/api/maintenance/session/export', {
            confirm: true,
            password: 'right',
            accountId: 'acct1',
        });
        expect(status).toBe(200);
        expect(body.session).toBe('my-secret-session-string');
    });

    it('revokes all sessions and clears the cookie without 500ing', async () => {
        webAuthApi.loginVerify.mockReturnValue({ ok: true });
        const res = await fetch(apiUrl('/api/maintenance/sessions/revoke-all'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true, password: 'right' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(webAuthApi.revokeAllSessions).toHaveBeenCalled();
        expect(res.headers.get('set-cookie') || '').toMatch(/tg_dl_session=;/);
        expect(broadcasts.some((b) => b.type === 'sessions_revoked')).toBe(true);
    });
});

describe('config/raw', () => {
    it('redacts secrets from the raw config dump', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram = { ...cfg.telegram, apiHash: 'realsecret' };
        cfg.web = { ...cfg.web, passwordHash: 'realhash' };
        await manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/maintenance/config/raw'));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain('realsecret');
        expect(text).not.toContain('realhash');
        expect(text).toContain('redacted');
    });
});
