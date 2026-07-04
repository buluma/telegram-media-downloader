// Route-level tests for group config presets — named snapshots of a group's
// filters/retention/forward settings, applied to other groups in bulk.
//
// Endpoints:
//   GET    /api/groups/presets              → { presets: [...] }
//   POST   /api/groups/presets              → save { name, fromGroupId } | { name, settings }
//   DELETE /api/groups/presets/:name        → remove
//   POST   /api/groups/presets/:name/apply  → { ids: [...] } apply to groups
//   POST   /api/groups/presets/import       → { presets: [...] } merge (export = GET)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-groups-presets-'));

let manager;
let dbApi;
let app;
let server;
let port;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function jpost(p, body) {
    const res = await fetch(apiUrl(p), {
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
    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createGroupsRouter({
            broadcast: () => {},
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
        {
            id: '-100111',
            name: 'Source',
            enabled: true,
            filters: { photos: true, videos: true, files: false },
            rescueMode: 'on',
            trackComments: false,
            autoForward: { enabled: true, destination: 'me', deleteAfterForward: false },
        },
        { id: '-100222', name: 'Target', enabled: false, filters: { photos: false } },
    ];
    cfg.groupPresets = [];
    await manager.saveConfig(cfg);
});

describe('group presets CRUD', () => {
    it('saves a preset snapshotted from a group', async () => {
        const { status, body } = await jpost('/api/groups/presets', {
            name: 'archive-mode',
            fromGroupId: '-100111',
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        const list = await (await fetch(apiUrl('/api/groups/presets'))).json();
        expect(list.presets.length).toBe(1);
        const p = list.presets[0];
        expect(p.name).toBe('archive-mode');
        expect(p.settings.filters.videos).toBe(true);
        expect(p.settings.rescueMode).toBe('on');
        expect(p.settings.trackComments).toBe(false);
        expect(p.settings.autoForward.destination).toBe('me');
        // No identity fields leak into the preset
        expect(p.settings.id).toBeUndefined();
        expect(p.settings.name).toBeUndefined();
        expect(p.settings.enabled).toBeUndefined();
    });

    it('saves a preset from explicit settings', async () => {
        const { status } = await jpost('/api/groups/presets', {
            name: 'photos-only',
            settings: { filters: { photos: true, videos: false }, rescueMode: 'off' },
        });
        expect(status).toBe(200);
        const list = await (await fetch(apiUrl('/api/groups/presets'))).json();
        expect(list.presets[0].settings.filters.photos).toBe(true);
    });

    it('overwrites a preset with the same name', async () => {
        await jpost('/api/groups/presets', {
            name: 'p1',
            settings: { rescueMode: 'on' },
        });
        await jpost('/api/groups/presets', {
            name: 'p1',
            settings: { rescueMode: 'off' },
        });
        const list = await (await fetch(apiUrl('/api/groups/presets'))).json();
        expect(list.presets.length).toBe(1);
        expect(list.presets[0].settings.rescueMode).toBe('off');
    });

    it('deletes a preset', async () => {
        await jpost('/api/groups/presets', { name: 'gone', settings: { rescueMode: 'on' } });
        const res = await fetch(apiUrl('/api/groups/presets/gone'), { method: 'DELETE' });
        expect(res.status).toBe(200);
        const list = await (await fetch(apiUrl('/api/groups/presets'))).json();
        expect(list.presets.length).toBe(0);
    });

    it('rejects invalid names and unknown source group', async () => {
        expect((await jpost('/api/groups/presets', { name: '', settings: {} })).status).toBe(400);
        expect(
            (await jpost('/api/groups/presets', { name: 'x', fromGroupId: '-999' })).status,
        ).toBe(404);
        expect((await jpost('/api/groups/presets', { name: 'x' })).status).toBe(400);
    });
});

describe('preset apply', () => {
    it('applies preset settings to listed groups', async () => {
        await jpost('/api/groups/presets', { name: 'archive-mode', fromGroupId: '-100111' });
        const { status, body } = await jpost('/api/groups/presets/archive-mode/apply', {
            ids: ['-100222'],
        });
        expect(status).toBe(200);
        expect(body.updated).toBe(1);
        const cfg = manager.loadConfig();
        const target = cfg.groups.find((g) => String(g.id) === '-100222');
        expect(target.filters.videos).toBe(true);
        expect(target.rescueMode).toBe('on');
        expect(target.autoForward.destination).toBe('me');
        // enabled untouched — presets never flip monitoring on/off
        expect(target.enabled).toBe(false);
        expect(target.name).toBe('Target');
    });

    it('404s on unknown preset', async () => {
        const { status } = await jpost('/api/groups/presets/nope/apply', { ids: ['-100222'] });
        expect(status).toBe(404);
    });
});

describe('preset import', () => {
    it('merges imported presets by name', async () => {
        await jpost('/api/groups/presets', { name: 'keep', settings: { rescueMode: 'on' } });
        const { status, body } = await jpost('/api/groups/presets/import', {
            presets: [
                { name: 'keep', settings: { rescueMode: 'off' } },
                { name: 'incoming', settings: { filters: { photos: true } } },
            ],
        });
        expect(status).toBe(200);
        expect(body.imported).toBe(2);
        const list = await (await fetch(apiUrl('/api/groups/presets'))).json();
        expect(list.presets.length).toBe(2);
        expect(list.presets.find((p) => p.name === 'keep').settings.rescueMode).toBe('off');
    });

    it('rejects malformed import payloads', async () => {
        expect((await jpost('/api/groups/presets/import', {})).status).toBe(400);
        expect(
            (await jpost('/api/groups/presets/import', { presets: [{ noName: true }] })).status,
        ).toBe(400);
    });
});
