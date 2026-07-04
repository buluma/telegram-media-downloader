// Route-level tests for POST /api/groups/bulk — multi-group config updates
// (enable/disable monitor, rescueMode, filters) applied in one atomic write.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-groups-bulk-'));

let manager;
let dbApi;
let app;
let server;
let port;
let broadcasts;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function postBulk(body) {
    const res = await fetch(apiUrl('/api/groups/bulk'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    manager = await import('../src/config/manager.js');

    const { createGroupsRouter } = await import('../src/web/routes/groups.js');
    broadcasts = [];
    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createGroupsRouter({
            broadcast: (m) => broadcasts.push(m),
            log: () => {},
            invalidateDialogsCache: () => {},
            getDialogsNameCache: async () => new Map(),
            dialogsTypeFor: () => null,
            dialogsHasPhotoFor: () => null,
            resolveEntityAcrossAccounts: async () => null,
            downloadProfilePhoto: async () => null,
            jobTrackers: {},
            getAccountManager: async () => ({ clients: new Map(), metadata: new Map() }),
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
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
    const cfg = manager.loadConfig();
    cfg.groups = [
        { id: '-100111', name: 'One', enabled: true, filters: { photos: true, videos: false } },
        { id: '-100222', name: 'Two', enabled: true, filters: { photos: true, videos: false } },
        { id: '-100333', name: 'Three', enabled: false, filters: { photos: true, videos: false } },
    ];
    await manager.saveConfig(cfg);
    broadcasts.length = 0;
});

describe('POST /api/groups/bulk', () => {
    it('disables monitoring on multiple groups at once', async () => {
        const { status, body } = await postBulk({
            ids: ['-100111', '-100222'],
            set: { enabled: false },
        });
        expect(status).toBe(200);
        expect(body.updated).toBe(2);
        const cfg = manager.loadConfig();
        expect(cfg.groups.find((g) => String(g.id) === '-100111').enabled).toBe(false);
        expect(cfg.groups.find((g) => String(g.id) === '-100222').enabled).toBe(false);
        expect(cfg.groups.find((g) => String(g.id) === '-100333').enabled).toBe(false);
        expect(broadcasts.some((b) => b.type === 'config_updated')).toBe(true);
    });

    it('sets rescueMode and merges filters', async () => {
        const { body } = await postBulk({
            ids: ['-100111', '-100333'],
            set: { rescueMode: 'on', filters: { videos: true } },
        });
        expect(body.updated).toBe(2);
        const cfg = manager.loadConfig();
        const g1 = cfg.groups.find((g) => String(g.id) === '-100111');
        expect(g1.rescueMode).toBe('on');
        expect(g1.filters.videos).toBe(true);
        expect(g1.filters.photos).toBe(true); // merge, not replace
    });

    it('clears rescueMode with "auto"', async () => {
        await postBulk({ ids: ['-100111'], set: { rescueMode: 'on' } });
        await postBulk({ ids: ['-100111'], set: { rescueMode: 'auto' } });
        const cfg = manager.loadConfig();
        const g1 = cfg.groups.find((g) => String(g.id) === '-100111');
        expect(g1.rescueMode).toBe('auto');
    });

    it('ignores unknown ids, reports skipped', async () => {
        const { body } = await postBulk({
            ids: ['-100111', '-999999'],
            set: { enabled: false },
        });
        expect(body.updated).toBe(1);
        expect(body.skipped).toEqual(['-999999']);
    });

    it('rejects empty ids or empty set', async () => {
        expect((await postBulk({ ids: [], set: { enabled: false } })).status).toBe(400);
        expect((await postBulk({ ids: ['-100111'], set: {} })).status).toBe(400);
        expect((await postBulk({ ids: ['-100111'] })).status).toBe(400);
    });

    it('rejects disallowed fields', async () => {
        const { status } = await postBulk({
            ids: ['-100111'],
            set: { monitorAccount: 'evil' },
        });
        expect(status).toBe(400);
    });

    it('caps ids at 500', async () => {
        const ids = Array.from({ length: 501 }, (_, i) => String(i));
        const { status } = await postBulk({ ids, set: { enabled: false } });
        expect(status).toBe(400);
    });
});
