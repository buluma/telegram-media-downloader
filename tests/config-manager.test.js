// Tests the kv-backed config manager: load/save round-trip, deep-merge,
// self-heal write-back, and the EventEmitter-based watchConfig.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-config-manager-'));

let manager;
let dbApi;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    // Import db.js first so its singleton picks up the temp dir, then the
    // manager — manager imports kvGet/kvSet from db.js.
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Clear the kv['config'] row + normalized group tables + drain any
    // listeners between tests so each case starts from a clean DEFAULT_CONFIG.
    dbApi.kvDelete('config');
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
});

describe('config manager (kv-backed)', () => {
    it('seeds DEFAULT_CONFIG on first load', () => {
        const cfg = manager.loadConfig();
        expect(cfg.telegram.apiId).toBe('');
        expect(cfg.download.concurrent).toBe(10);
        // Row was written so subsequent reads skip the seed branch.
        expect(dbApi.kvGet('config')).toBeTruthy();
    });

    it('saveConfig + loadConfig round-trips a full tree', () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '99999';
        cfg.download.concurrent = 5;
        manager.saveConfig(cfg);

        const reloaded = manager.loadConfig();
        expect(reloaded.telegram.apiId).toBe('99999');
        expect(reloaded.download.concurrent).toBe(5);
    });

    it('deep-merges new defaults onto a partial stored tree', () => {
        // Plant an old-style config that's missing the advanced.* block.
        dbApi.kvSet('config', { telegram: { apiId: 'x', apiHash: 'y' } });
        const cfg = manager.loadConfig();
        // Defaults filled in:
        expect(cfg.advanced).toBeTruthy();
        expect(cfg.advanced.downloader.maxConcurrency).toBe(20);
        expect(cfg.advanced.history.shortBreakEveryN).toBe(100);
        expect(cfg.rescue.retentionHours).toBe(48);
        // User values preserved:
        expect(cfg.telegram.apiId).toBe('x');
        expect(cfg.telegram.apiHash).toBe('y');
    });

    it('self-heals (writes back) when merge surfaced new keys', () => {
        dbApi.kvSet('config', { telegram: { apiId: 'x', apiHash: 'y' } });
        manager.loadConfig();
        const stored = dbApi.kvGet('config');
        // After load, the stored tree should be the merged shape.
        expect(stored.advanced).toBeTruthy();
        expect(stored.rescue).toBeTruthy();
    });

    it('addGroup upserts and persists', () => {
        const cfg = manager.loadConfig();
        manager.addGroup(cfg, { id: 1, name: 'first' });
        manager.addGroup(cfg, { id: 2, name: 'second' });
        manager.addGroup(cfg, { id: 1, name: 'first-renamed' });

        const reloaded = manager.loadConfig();
        expect(reloaded.groups).toHaveLength(2);
        // Normalized tables store ids as TEXT; use string comparison.
        expect(reloaded.groups.find((g) => String(g.id) === '1').name).toBe('first-renamed');
    });

    it('watchConfig fires synchronously on saveConfig', () => {
        const fired = [];
        const unsub = manager.watchConfig((cfg) => fired.push(cfg.telegram.apiId));

        const cfg = manager.loadConfig();
        cfg.telegram.apiId = 'abc';
        manager.saveConfig(cfg);

        cfg.telegram.apiId = 'xyz';
        manager.saveConfig(cfg);

        expect(fired).toEqual(['abc', 'xyz']);
        unsub();
    });

    it('watchConfig unsubscriber stops further deliveries', () => {
        const fired = [];
        const unsub = manager.watchConfig((cfg) => fired.push(cfg.telegram.apiId));
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = 'before';
        manager.saveConfig(cfg);
        unsub();
        cfg.telegram.apiId = 'after';
        manager.saveConfig(cfg);
        expect(fired).toEqual(['before']);
    });

    it('seeds the advanced.ai.faces sub-block with sensible defaults', () => {
        const cfg = manager.loadConfig();
        const f = cfg.advanced.ai.faces;
        expect(f).toBeTruthy();
        expect(f.backend).toBe('sidecar');
        expect(f.autoDownload).toBe(true);
        expect(f.detSize).toBe(640);
        expect(f.providers).toBe('auto');
        expect(f.epsilon).toBeCloseTo(1.05, 5);
        expect(f.minPoints).toBe(2);
        expect(f.detectorModel).toBe('buffalo_l');
        expect(f.portRange).toEqual([41000, 49999]);
        expect(f.downloadMirrors).toEqual([]);
        expect(f.federate).toBe(false);
        expect(f.embedDim).toBe(512);
        expect(f.arRange).toEqual([0.5, 2.0]);
    });

    it('migrates legacy flat keys into advanced.ai.faces.*', () => {
        // Old install — operator had tuned facesEpsilon + facesServiceUrl
        // + federateFaces before the rewrite. Loading should surface those
        // values in both the new path AND keep the flat alias for
        // backward compat.
        dbApi.kvSet('config', {
            advanced: {
                ai: {
                    facesEpsilon: 0.7,
                    facesMinPoints: 5,
                    facesServiceUrl: 'http://other:8011',
                    facesDetector: 'ssd',
                    facesLabelMatchEps: 0.4,
                    federateFaces: true,
                },
            },
        });
        const cfg = manager.loadConfig();
        const f = cfg.advanced.ai.faces;
        expect(f.epsilon).toBe(0.7);
        expect(f.minPoints).toBe(5);
        expect(f.sidecarUrl).toBe('http://other:8011');
        expect(f.detector).toBe('ssd');
        expect(f.labelMatchEps).toBe(0.4);
        expect(f.federate).toBe(true);
        // Flat aliases preserved so legacy readers (server.js, scan-
        // runner, downloader) keep working without a coordinated rewrite.
        expect(cfg.advanced.ai.facesEpsilon).toBe(0.7);
        expect(cfg.advanced.ai.facesMinPoints).toBe(5);
        expect(cfg.advanced.ai.facesServiceUrl).toBe('http://other:8011');
        expect(cfg.advanced.ai.facesDetector).toBe('ssd');
        expect(cfg.advanced.ai.facesLabelMatchEps).toBe(0.4);
        expect(cfg.advanced.ai.federateFaces).toBe(true);
    });

    it('explicit advanced.ai.faces.* wins over legacy flat alias', () => {
        // Operator set BOTH. The new path is authoritative.
        dbApi.kvSet('config', {
            advanced: {
                ai: {
                    facesEpsilon: 0.7,
                    faces: { epsilon: 0.45 },
                },
            },
        });
        const cfg = manager.loadConfig();
        expect(cfg.advanced.ai.faces.epsilon).toBe(0.45);
        // Flat alias reflects the resolved value.
        expect(cfg.advanced.ai.facesEpsilon).toBe(0.45);
    });

    it('GROUP_DEFAULTS is exported and frozen', () => {
        expect(manager.GROUP_DEFAULTS).toBeTruthy();
        expect(Object.isFrozen(manager.GROUP_DEFAULTS)).toBe(true);
        expect(Object.isFrozen(manager.GROUP_DEFAULTS.filters)).toBe(true);
        expect(Object.isFrozen(manager.GROUP_DEFAULTS.autoForward)).toBe(true);
    });

    it('GROUP_DEFAULTS has expected filter values', () => {
        const { filters } = manager.GROUP_DEFAULTS;
        expect(filters.photos).toBe(true);
        expect(filters.videos).toBe(false);
        expect(filters.voice).toBe(true);
        expect(filters.audio).toBe(false);
        expect(filters.gifs).toBe(false);
        expect(filters.stickers).toBe(false);
    });

    it('GROUP_DEFAULTS autoForward matches groups.js defaults', () => {
        const af = manager.GROUP_DEFAULTS.autoForward;
        expect(af.enabled).toBe(false);
        expect(af.destination).toBeNull();
        expect(af.deleteAfterForward).toBe(true);
        expect(af.keepImages).toBe(true);
        expect(af.keepVideos).toBe(false);
    });

    it('loadConfig dedupes groups that share the same id', () => {
        // Plant a stored tree with two entries for the same Telegram id but
        // different display names — what the dashboard sees when the same
        // group was added twice through different code paths (CLI add +
        // dashboard add, or sanitised vs raw name).
        dbApi.kvSet('config', {
            groups: [
                { id: '-100123', name: 'orig name' },
                { id: '-100456', name: 'unique' },
                { id: '-100123', name: 'renamed', enabled: true },
            ],
        });
        const cfg = manager.loadConfig();
        expect(cfg.groups).toHaveLength(2);
        const merged = cfg.groups.find((g) => String(g.id) === '-100123');
        // Last-writer-wins on the colliding fields (name, enabled), order of
        // first appearance preserved.
        expect(merged.name).toBe('renamed');
        expect(merged.enabled).toBe(true);
        expect(cfg.groups[0].id).toBe('-100123');
    });

    it('saveConfig syncs groups to normalized tables', () => {
        const cfg = manager.loadConfig();
        cfg.groups = [
            {
                id: '-100999',
                name: 'Sync Test',
                enabled: true,
                filters: {
                    photos: true,
                    videos: true,
                    files: false,
                    links: false,
                    voice: false,
                    audio: false,
                    gifs: false,
                    stickers: false,
                    urls: false,
                },
                trackComments: false,
                autoForward: {
                    enabled: false,
                    destination: null,
                    deleteAfterForward: true,
                    keepImages: true,
                    keepVideos: false,
                },
            },
        ];
        manager.saveConfig(cfg);

        const rows = db.prepare('SELECT * FROM groups').all();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('-100999');
        expect(rows[0].name).toBe('Sync Test');

        const filters = db.prepare('SELECT * FROM group_filters WHERE group_id = ?').get('-100999');
        expect(filters.photos).toBe(1);
        expect(filters.videos).toBe(1);
        expect(filters.files).toBe(0);
    });

    it('loadConfig reads groups from normalized tables when populated', () => {
        // Pre-populate normalized tables (simulates post-migration state)
        dbApi.kvSet('config', {
            groups: [{ id: 'kv_group', name: 'From KV', enabled: true }],
        });
        // Also put data in normalized tables — should win over KV
        dbApi.getAllGroupConfigs; // ensure tables exist
        db.prepare(
            `INSERT INTO groups (id, name, enabled, created_at, updated_at) VALUES ('db_group', 'From DB', 1, 1, 1)`,
        ).run();
        db.prepare(`INSERT INTO group_filters (group_id) VALUES ('db_group')`).run();
        db.prepare(`INSERT INTO group_forward (group_id) VALUES ('db_group')`).run();
        db.prepare(`INSERT INTO group_settings (group_id) VALUES ('db_group')`).run();

        const cfg = manager.loadConfig();
        // DB table wins when populated
        expect(cfg.groups).toHaveLength(1);
        expect(cfg.groups[0].id).toBe('db_group');
        expect(cfg.groups[0].name).toBe('From DB');
    });
});

// The catch path is the other place loadConfig() can hand back DEFAULT_CONFIG.
// It had the same aliasing bug the fresh-install branch was fixed for: a kv
// read that throws (locked / corrupt db during first-run setup) returned the
// shared singleton, and POST /api/auth/setup mutates what it gets back in
// place — permanently poisoning DEFAULT_CONFIG for the rest of the process.
describe('loadConfig — kv read failure', () => {
    async function loadWithBrokenKv() {
        vi.resetModules();
        vi.doMock('../src/core/db.js', () => ({
            kvGet: () => {
                throw new Error('database is locked');
            },
            kvSet: () => {},
            getAllGroupConfigs: () => [],
            syncGroupConfigs: () => {},
        }));
        return await import('../src/config/manager.js');
    }

    afterEach(() => {
        vi.doUnmock('../src/core/db.js');
        vi.resetModules();
    });

    it('falls back to defaults instead of throwing', async () => {
        const broken = await loadWithBrokenKv();
        const cfg = broken.loadConfig();
        expect(cfg.download.concurrent).toBe(10);
        expect(cfg.telegram.apiId).toBe('');
    });

    it('hands out a fresh clone, so callers cannot poison the defaults', async () => {
        const broken = await loadWithBrokenKv();

        const first = broken.loadConfig();
        first.web = { ...(first.web || {}), passwordHash: 'leaked-from-setup' };
        first.telegram.apiId = '12345';
        first.groups.push({ id: 'ghost' });

        const second = broken.loadConfig();
        expect(second).not.toBe(first);
        expect(second.web?.passwordHash).toBeUndefined();
        expect(second.telegram.apiId).toBe('');
        expect(second.groups).toEqual([]);
    });
});
