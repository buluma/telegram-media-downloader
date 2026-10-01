// Route-level HTTP tests for /api/config, /api/rescue/stats, and
// /api/alerts/test — the parts tests/routes-config.test.js doesn't
// cover (GET response scrubbing, POST's deep-merge behavior across
// every top-level section, the advanced.* clamp/allow-list logic, and
// the various "restart X on config change" side effects).
//
// Heavy engine dependencies (rescue sweeper, disk rotator, integrity
// sweeper, auto-backfill scheduler, seekbar sidecar, ntfy sender,
// core/ai's auto-cluster) are mocked — their internals are P3 scope,
// this only verifies the route calls them at the right time.
//
// Known gap (not fixed here, already documented in
// routes-config.test.js): POST /api/config with a `telegram` field
// throws a ReferenceError because `_accountManager` is referenced but
// never declared in this module — one test below pins that documented
// behavior rather than silently avoiding it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-config-full-'));

const sendNtfy = vi.fn().mockResolvedValue(true);
vi.mock('../src/core/alerts.js', () => ({ sendNtfy: (...a) => sendNtfy(...a) }));

const getRescueStats = vi.fn(() => ({ pending: 0, retained: 0 }));
vi.mock('../src/core/db/downloads.js', () => ({ getRescueStats: (...a) => getRescueStats(...a) }));

const rescueSweeper = { restart: vi.fn() };
const getRescueSweeper = vi.fn(() => rescueSweeper);
vi.mock('../src/core/rescue.js', () => ({ getRescueSweeper: (...a) => getRescueSweeper(...a) }));

const backfillScheduler = { restart: vi.fn() };
const getAutoBackfillScheduler = vi.fn(() => backfillScheduler);
vi.mock('../src/core/auto-backfill.js', () => ({
    getAutoBackfillScheduler: (...a) => getAutoBackfillScheduler(...a),
}));

const applyShareLimits = vi.fn();
vi.mock('../src/core/share.js', () => ({ applyShareLimits: (...a) => applyShareLimits(...a) }));

const diskRotator = { restart: vi.fn() };
const getDiskRotator = vi.fn(() => diskRotator);
vi.mock('../src/core/disk-rotator.js', () => ({ getDiskRotator: (...a) => getDiskRotator(...a) }));

const integrityStart = vi.fn();
vi.mock('../src/core/integrity.js', () => ({ start: (...a) => integrityStart(...a) }));

const refreshSeekbarSidecar = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/core/seekbar/spawn.js', () => ({
    refreshSidecar: (...a) => refreshSeekbarSidecar(...a),
}));

const startAutoCluster = vi.fn();
vi.mock('../src/core/ai/index.js', () => ({ startAutoCluster: (...a) => startAutoCluster(...a) }));

let dbApi;
let db;
let manager;
let app;
let server;
let port;
let broadcast;
let invalidateDialogsCache;
let invalidateShareConfigCache;
let refreshRateLimitConfig;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function post(pathname, body) {
    return fetch(apiUrl(pathname), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');

    const { createConfigRouter } = await import('../src/web/routes/config.js');

    broadcast = vi.fn();
    invalidateDialogsCache = vi.fn();
    invalidateShareConfigCache = vi.fn();
    refreshRateLimitConfig = vi.fn();

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createConfigRouter({
            broadcast,
            invalidateDialogsCache,
            invalidateShareConfigCache,
            refreshRateLimitConfig,
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
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
    sendNtfy.mockResolvedValue(true);
});

describe('GET /api/config', () => {
    it('replaces apiHash with an apiHashSet boolean flag', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '12345';
        cfg.telegram.apiHash = 'secret';
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.telegram.apiHash).toBeUndefined();
        expect(body.telegram.apiHashSet).toBe(true);
    });

    it('reports apiHashSet:false with no hash configured', async () => {
        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.telegram.apiHashSet).toBe(false);
    });

    it('strips web.password and web.passwordHash', async () => {
        const cfg = manager.loadConfig();
        cfg.web = { enabled: true, password: 'raw', passwordHash: { algo: 'scrypt' } };
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.web.password).toBeUndefined();
        expect(body.web.passwordHash).toBeUndefined();
        expect(body.web.enabled).toBe(true);
    });

    it('trims each account down to id/name/username', async () => {
        const cfg = manager.loadConfig();
        cfg.accounts = [
            { id: 'a1', name: 'Alice', username: 'alice', phone: '+1', secretStuff: 'x' },
        ];
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.accounts).toEqual([{ id: 'a1', name: 'Alice', username: 'alice' }]);
    });

    it('replaces monitorAccount/forwardAccount with boolean has* flags on each group', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: 'g1', monitorAccount: 'acc1', forwardAccount: 'acc2' }];
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.groups[0].monitorAccount).toBeUndefined();
        expect(body.groups[0].forwardAccount).toBeUndefined();
        expect(body.groups[0].hasMonitorAccount).toBe(true);
        expect(body.groups[0].hasForwardAccount).toBe(true);
    });

    it('omits has* flags for a group with neither account assignment', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: 'g2' }];
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/config'));
        const body = await res.json();
        expect(body.groups[0].hasMonitorAccount).toBeUndefined();
        expect(body.groups[0].hasForwardAccount).toBeUndefined();
    });
});

describe('GET /api/rescue/stats', () => {
    it('returns getRescueStats() directly', async () => {
        getRescueStats.mockReturnValue({ pending: 3, retained: 7 });
        const res = await fetch(apiUrl('/api/rescue/stats'));
        expect(await res.json()).toEqual({ pending: 3, retained: 7 });
    });

    it('500s when getRescueStats throws', async () => {
        getRescueStats.mockImplementation(() => {
            throw new Error('db error');
        });
        const res = await fetch(apiUrl('/api/rescue/stats'));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/config — auth-injection guard', () => {
    it('rejects a web.password field', async () => {
        const res = await post('/api/config', { web: { password: 'sneaky' } });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/auth\/setup/);
    });

    it('rejects a web.passwordHash field', async () => {
        const res = await post('/api/config', { web: { passwordHash: 'sneaky' } });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/config — prototype pollution guard', () => {
    it('strips __proto__/constructor/prototype keys before merging', async () => {
        const res = await fetch(apiUrl('/api/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // JSON.parse itself drops a literal "__proto__" key in most
            // engines, so smuggle it in via a nested, differently-shaped
            // object the sanitizer still has to walk.
            body: JSON.stringify({ download: { constructor: { evil: true }, concurrent: 5 } }),
        });
        expect(res.status).toBe(200);
        const cfg = manager.loadConfig();
        expect(cfg.download.concurrent).toBe(5);
        expect(cfg.download.constructor).not.toEqual({ evil: true });
    });
});

describe('POST /api/config — known gap: telegram field throws (documented, not fixed here)', () => {
    it('500s because _accountManager is referenced but never declared in this module', async () => {
        const res = await post('/api/config', { telegram: { apiId: '999' } });
        expect(res.status).toBe(500);
    });
});

describe('POST /api/config — deep merges', () => {
    it('merges download without wiping untouched fields', async () => {
        const cfg = manager.loadConfig();
        cfg.download.path = './data/downloads';
        cfg.download.concurrent = 5;
        manager.saveConfig(cfg);
        await post('/api/config', { download: { concurrent: 20 } });
        const reloaded = manager.loadConfig();
        expect(reloaded.download.concurrent).toBe(20);
        expect(reloaded.download.path).toBe('./data/downloads');
    });

    it('merges rateLimits partially', async () => {
        await post('/api/config', { rateLimits: { requestsPerMinute: 30 } });
        const reloaded = manager.loadConfig();
        expect(reloaded.rateLimits.requestsPerMinute).toBe(30);
        expect(reloaded.rateLimits.delayMs).toBeDefined();
    });

    it('merges diskManagement partially', async () => {
        await post('/api/config', { diskManagement: { enabled: true } });
        const reloaded = manager.loadConfig();
        expect(reloaded.diskManagement.enabled).toBe(true);
    });

    it('merges rescue partially', async () => {
        await post('/api/config', { rescue: { retentionHours: 72 } });
        const reloaded = manager.loadConfig();
        expect(reloaded.rescue.retentionHours).toBe(72);
    });

    it('merges alerts and deep-merges the nested ntfy object', async () => {
        await post('/api/config', { alerts: { enabled: true, ntfy: { topic: 'x' } } });
        await post('/api/config', { alerts: { ntfy: { url: 'https://ntfy.example.com' } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.alerts.enabled).toBe(true);
        expect(reloaded.alerts.ntfy.topic).toBe('x');
        expect(reloaded.alerts.ntfy.url).toBe('https://ntfy.example.com');
    });

    it('clears proxy entirely with an explicit null', async () => {
        await post('/api/config', { proxy: { host: 'p.example.com', port: 1080 } });
        await post('/api/config', { proxy: null });
        const reloaded = manager.loadConfig();
        expect(reloaded.proxy).toBeNull();
    });

    it('deep-merges proxy fields, preserving unspecified ones', async () => {
        await post('/api/config', { proxy: { host: 'p.example.com', port: 1080 } });
        await post('/api/config', { proxy: { port: 1081 } });
        const reloaded = manager.loadConfig();
        expect(reloaded.proxy.host).toBe('p.example.com');
        expect(reloaded.proxy.port).toBe(1081);
    });

    it('removes a proxy field when explicitly set to null', async () => {
        await post('/api/config', { proxy: { host: 'p.example.com', password: 'pw' } });
        await post('/api/config', { proxy: { password: null } });
        const reloaded = manager.loadConfig();
        expect(reloaded.proxy.host).toBe('p.example.com');
        expect('password' in reloaded.proxy).toBe(false);
    });

    it('web merge: allows toggling enabled without touching passwordHash', async () => {
        const cfg = manager.loadConfig();
        cfg.web = { enabled: false, passwordHash: { algo: 'scrypt', hash: 'abc' } };
        manager.saveConfig(cfg);
        await post('/api/config', { web: { enabled: true } });
        const reloaded = manager.loadConfig();
        expect(reloaded.web.enabled).toBe(true);
        expect(reloaded.web.passwordHash).toEqual({ algo: 'scrypt', hash: 'abc' });
    });

    it('web merge: never persists a smuggled password even after the injection guard', async () => {
        // The route's own web.password/passwordHash guard 400s first, so
        // this exercises the belt-and-suspenders delete inside the merge
        // itself via a body that only has `password` set to a falsy value
        // (guard checks truthiness) alongside other real web fields.
        await post('/api/config', { web: { enabled: true, password: '' } });
        const reloaded = manager.loadConfig();
        expect(reloaded.web.password).toBeUndefined();
    });

    it('cluster merge: two-level deep merge preserves untouched replicate keys', async () => {
        await post('/api/config', {
            cluster: { replicate: { downloads: true, groups: false } },
        });
        await post('/api/config', { cluster: { replicate: { groups: true } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.cluster.replicate).toEqual({ downloads: true, groups: true });
    });

    it('range validation: 400s on download.concurrent out of [1,50]', async () => {
        const res = await post('/api/config', { download: { concurrent: 0 } });
        expect(res.status).toBe(400);
    });

    it('range validation: 400s on download.retries out of [0,50]', async () => {
        const res = await post('/api/config', { download: { retries: 100 } });
        expect(res.status).toBe(400);
    });

    it('range validation: 400s on pollingInterval < 1', async () => {
        const res = await post('/api/config', { pollingInterval: 0 });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/config — advanced.* clamping', () => {
    it('swaps maxConcurrency up to minConcurrency when max < min', async () => {
        await post('/api/config', {
            advanced: { downloader: { minConcurrency: 10, maxConcurrency: 5 } },
        });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.downloader.maxConcurrency).toBe(10);
    });

    it('clamps an out-of-range numeric to its floor/ceiling default rather than 400ing', async () => {
        const res = await post('/api/config', {
            advanced: { downloader: { minConcurrency: 99999 } },
        });
        expect(res.status).toBe(200);
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.downloader.minConcurrency).toBe(100);
    });

    it('falls back to the default for a non-numeric clamp input', async () => {
        await post('/api/config', { advanced: { downloader: { minConcurrency: 'not-a-number' } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.downloader.minConcurrency).toBe(3);
    });

    it('clamps advanced.history.autoCatchUpLimit and defaults it to 0 (automatic)', async () => {
        await post('/api/config', { advanced: { history: { autoCatchUpLimit: 100 } } });
        expect(manager.loadConfig().advanced.history.autoCatchUpLimit).toBe(100);
        await post('/api/config', { advanced: { history: { autoCatchUpLimit: -5 } } });
        expect(manager.loadConfig().advanced.history.autoCatchUpLimit).toBe(0);
        await post('/api/config', { advanced: { history: { autoCatchUpLimit: 99999999 } } });
        expect(manager.loadConfig().advanced.history.autoCatchUpLimit).toBe(50000);
        await post('/api/config', { advanced: { history: { autoCatchUpLimit: 'many' } } });
        expect(manager.loadConfig().advanced.history.autoCatchUpLimit).toBe(0);
    });

    it('deep-merges advanced.ai.faces so a partial patch keeps sibling fields', async () => {
        await post('/api/config', {
            advanced: { ai: { faces: { providers: 'cuda', epsilon: 1.2 } } },
        });
        await post('/api/config', { advanced: { ai: { faces: { epsilon: 0.9 } } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.ai.faces.providers).toBe('cuda');
        expect(reloaded.advanced.ai.faces.epsilon).toBe(0.9);
    });

    it('migrates a legacy boolean semanticSearch to the object shape', async () => {
        await post('/api/config', { advanced: { ai: { semanticSearch: true } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.ai.semanticSearch).toEqual({
            enabled: true,
            embedOnDownload: false,
            batchSize: 32,
        });
    });

    it('allow-lists advanced.thumbs.hwaccel, falling back to CPU on an invalid value', async () => {
        await post('/api/config', { advanced: { thumbs: { hwaccel: 'not-a-real-backend' } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.thumbs.hwaccel).toBe('');
    });

    it('accepts a valid advanced.thumbs.hwaccel value case-insensitively', async () => {
        await post('/api/config', { advanced: { thumbs: { hwaccel: 'CUDA' } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.thumbs.hwaccel).toBe('cuda');
    });

    it('clamps nsfw.threshold into range and rounds to 3 decimal places', async () => {
        await post('/api/config', { advanced: { nsfw: { threshold: 1.5 } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.nsfw.threshold).toBe(0.99);
    });

    it('allow-lists nsfw.dtype, falling back to the default on an invalid value', async () => {
        await post('/api/config', { advanced: { nsfw: { dtype: 'bogus' } } });
        const reloaded = manager.loadConfig();
        expect(['q8', 'fp16', 'fp32', 'q4']).toContain(reloaded.advanced.nsfw.dtype);
    });

    it('filters nsfw.fileTypes down to the allow-list, falling back to defaults if empty', async () => {
        await post('/api/config', {
            advanced: { nsfw: { fileTypes: ['photo', 'not-a-type', 'VIDEO'] } },
        });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.nsfw.fileTypes).toEqual(['photo', 'video']);
    });

    it('clamps share.ttlMaxSec to be no less than ttlMinSec', async () => {
        await post('/api/config', {
            advanced: { share: { ttlMinSec: 5000, ttlMaxSec: 100 } },
        });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.share.ttlMaxSec).toBeGreaterThanOrEqual(5000);
    });

    it('allow-lists seekbar.format and .overwrite', async () => {
        await post('/api/config', {
            advanced: { seekbar: { format: 'bogus', overwrite: 'bogus' } },
        });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.seekbar.format).toBe('webp');
        expect(reloaded.advanced.seekbar.overwrite).toBe('if-changed');
    });

    it('normalizes an empty seekbar.hwaccel to null, not empty string', async () => {
        await post('/api/config', { advanced: { seekbar: { hwaccel: '' } } });
        const reloaded = manager.loadConfig();
        expect(reloaded.advanced.seekbar.hwaccel).toBeNull();
    });
});

describe('POST /api/config — side effects', () => {
    it('always broadcasts config_updated and invalidates the dialogs cache', async () => {
        await post('/api/config', { pollingInterval: 15 });
        expect(broadcast).toHaveBeenCalledWith({ type: 'config_updated' });
        expect(invalidateDialogsCache).toHaveBeenCalled();
    });

    it('applies share limits and invalidates the share config cache on every save', async () => {
        await post('/api/config', { pollingInterval: 15 });
        expect(applyShareLimits).toHaveBeenCalled();
        expect(invalidateShareConfigCache).toHaveBeenCalled();
    });

    it('refreshes rate-limit config only when web.rateLimit is present', async () => {
        await post('/api/config', { web: { rateLimit: { enabled: true } } });
        expect(refreshRateLimitConfig).toHaveBeenCalled();
    });

    it('does not refresh rate-limit config for an unrelated save', async () => {
        await post('/api/config', { pollingInterval: 15 });
        expect(refreshRateLimitConfig).not.toHaveBeenCalled();
    });

    it('restarts the disk rotator when diskManagement changes', async () => {
        await post('/api/config', { diskManagement: { enabled: true } });
        expect(diskRotator.restart).toHaveBeenCalled();
    });

    it('restarts the disk rotator when advanced.diskRotator changes', async () => {
        await post('/api/config', { advanced: { diskRotator: { sweepBatch: 10 } } });
        expect(diskRotator.restart).toHaveBeenCalled();
    });

    it('restarts the rescue sweeper when rescue changes', async () => {
        await post('/api/config', { rescue: { retentionHours: 24 } });
        expect(rescueSweeper.restart).toHaveBeenCalled();
    });

    it('restarts the auto-backfill scheduler when groups change', async () => {
        await post('/api/config', { groups: [] });
        expect(backfillScheduler.restart).toHaveBeenCalled();
    });

    it('re-arms the integrity sweeper when advanced.integrity changes', async () => {
        await post('/api/config', { advanced: { integrity: { intervalMin: 30 } } });
        expect(integrityStart).toHaveBeenCalledWith(
            expect.objectContaining({ intervalMin: 30, batchSize: 64 }),
        );
    });

    it('re-arms the auto-cluster timer when advanced.ai changes', async () => {
        await post('/api/config', { advanced: { ai: { autoClusterIntervalMin: 45 } } });
        expect(startAutoCluster).toHaveBeenCalledWith({ intervalMin: 45 });
    });

    it('refreshes the seekbar sidecar and broadcasts when advanced.seekbar changes', async () => {
        await post('/api/config', { advanced: { seekbar: { tileWidth: 200 } } });
        expect(refreshSeekbarSidecar).toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith({ type: 'seekbar_config_changed' });
    });

    it('does not restart any subsystem for an unrelated save', async () => {
        await post('/api/config', { pollingInterval: 20 });
        expect(diskRotator.restart).not.toHaveBeenCalled();
        expect(rescueSweeper.restart).not.toHaveBeenCalled();
        expect(backfillScheduler.restart).not.toHaveBeenCalled();
        expect(integrityStart).not.toHaveBeenCalled();
        expect(startAutoCluster).not.toHaveBeenCalled();
        expect(refreshSeekbarSidecar).not.toHaveBeenCalled();
    });
});

describe('POST /api/alerts/test', () => {
    it('uses the request-body ntfy config when provided', async () => {
        const res = await post('/api/alerts/test', { ntfy: { url: 'https://x', topic: 'y' } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(sendNtfy).toHaveBeenCalledWith(
            { url: 'https://x', topic: 'y' },
            expect.objectContaining({ title: expect.any(String) }),
        );
    });

    it('falls back to the saved config ntfy settings with no body override', async () => {
        const cfg = manager.loadConfig();
        cfg.alerts = { enabled: true, ntfy: { url: 'https://saved', topic: 'saved-topic' } };
        manager.saveConfig(cfg);
        await post('/api/alerts/test', {});
        expect(sendNtfy).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://saved', topic: 'saved-topic' }),
            expect.any(Object),
        );
    });

    it('reports ok:false when sendNtfy resolves false', async () => {
        sendNtfy.mockResolvedValue(false);
        const res = await post('/api/alerts/test', { ntfy: { url: 'x' } });
        const body = await res.json();
        expect(body.ok).toBe(false);
    });

    it('500s with ok:false when sendNtfy rejects', async () => {
        sendNtfy.mockRejectedValue(new Error('network down'));
        const res = await post('/api/alerts/test', { ntfy: { url: 'x' } });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe('network down');
    });
});
