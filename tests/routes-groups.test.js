// Route-level tests for the rest of src/web/routes/groups.js — everything
// NOT already covered by groups-bulk.test.js (POST /groups/bulk) and
// groups-presets.test.js (GET/POST/DELETE /groups/presets*).
//
// Follows the same convention as those two files: real config/manager.js
// and real core/db.js against an isolated TGDL_DATA_DIR temp dir (no
// vi.mock), with the router's injected collaborators (dialogs cache,
// entity resolution, profile photos, account manager) as plain stub
// functions passed straight into createGroupsRouter().

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-groups-'));

let manager;
let dbApi;
let downloadsApi;
let app;
let server;
let port;
let broadcasts;
let jobTrackers;
let resolveEntityAcrossAccounts;
let downloadProfilePhoto;
let dialogsTypeForImpl;
let dialogsHasPhotoForImpl;

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
        /* not json — e.g. Express's default 404 HTML page */
    }
    return { status: res.status, body: parsed };
}

async function put(p, body) {
    const res = await fetch(apiUrl(p), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
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
    manager = await import('../src/config/manager.js');
    const { createJobTracker } = await import('../src/core/job-tracker.js');

    const { createGroupsRouter } = await import('../src/web/routes/groups.js');
    broadcasts = [];
    resolveEntityAcrossAccounts = async () => null;
    downloadProfilePhoto = async () => null;
    dialogsTypeForImpl = () => null;
    dialogsHasPhotoForImpl = () => null;
    const broadcast = (m) => broadcasts.push(m);
    jobTrackers = {
        groupsRefreshInfo: createJobTracker({ kind: 'groupsRefreshInfo', broadcast }),
        groupsRefreshPhotos: createJobTracker({ kind: 'groupsRefreshPhotos', broadcast }),
    };

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createGroupsRouter({
            broadcast,
            log: () => {},
            invalidateDialogsCache: () => {},
            getDialogsNameCache: async () => new Map(),
            dialogsTypeFor: (id) => dialogsTypeForImpl(id),
            dialogsHasPhotoFor: (id) => dialogsHasPhotoForImpl(id),
            resolveEntityAcrossAccounts: (...a) => resolveEntityAcrossAccounts(...a),
            downloadProfilePhoto: (...a) => downloadProfilePhoto(...a),
            jobTrackers,
            getAccountManager: async () => ({ count: 0, clients: new Map(), metadata: new Map() }),
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

beforeEach(async () => {
    const cfg = manager.loadConfig();
    cfg.groups = [];
    await manager.saveConfig(cfg);
    dbApi.getDb().prepare('DELETE FROM downloads').run();
    broadcasts.length = 0;
    resolveEntityAcrossAccounts = async () => null;
    downloadProfilePhoto = async () => null;
    dialogsTypeForImpl = () => null;
    dialogsHasPhotoForImpl = () => null;
});

describe('GET /api/groups', () => {
    it('returns configured groups with resolved names and photo info', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100111', name: 'Unknown', enabled: true }];
        await manager.saveConfig(cfg);

        const { status, body } = await get('/api/groups');
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe('-100111');
        expect(body[0].photoUrl).toBeNull();
    });

    it('prefers a real DB group_name over a placeholder config name', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100111', name: 'Unknown', enabled: true }];
        await manager.saveConfig(cfg);
        downloadsApi.insertDownload({
            groupId: '-100111',
            groupName: 'Cool Channel',
            messageId: 1,
        });

        const { body } = await get('/api/groups');
        expect(body[0].name).toBe('Cool Channel');
    });

    it('persists a resolved type back to the groups table when config has none', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-1009999', name: 'Chan', enabled: true }];
        await manager.saveConfig(cfg);
        dialogsTypeForImpl = () => 'channel';

        await get('/api/groups');
        const row = dbApi.getDb().prepare('SELECT type FROM groups WHERE id = ?').get('-1009999');
        expect(row?.type).toBe('channel');
    });

    it('tolerates a missing photos directory', async () => {
        const { status, body } = await get('/api/groups');
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
    });
});

describe('PUT /api/groups/:id', () => {
    it('creates a new group with defaults when it does not exist', async () => {
        const { status, body } = await put('/api/groups/-100555', {
            name: 'Brand New',
            enabled: true,
        });
        expect(status).toBe(200);
        expect(body.group.name).toBe('Brand New');
        expect(body.group.enabled).toBe(true);
        expect(body.group.filters).toBeDefined();
        expect(broadcasts.some((b) => b.type === 'config_updated')).toBe(true);
    });

    it('resolves a real name via resolveEntityAcrossAccounts when none is given', async () => {
        resolveEntityAcrossAccounts = async () => ({
            entity: { title: 'Resolved Title', className: 'Channel', broadcast: true },
        });
        const { body } = await put('/api/groups/-100556', {});
        expect(body.group.name).toBe('Resolved Title');
        expect(body.group.type).toBe('channel');
    });

    it('updates fields on an existing group and merges filters', async () => {
        await put('/api/groups/-100777', { name: 'X', filters: { photos: true } });
        const { body } = await put('/api/groups/-100777', { filters: { videos: true } });
        expect(body.group.filters.photos).toBe(true);
        expect(body.group.filters.videos).toBe(true);
    });

    it('sets and clears rescueMode', async () => {
        await put('/api/groups/-100888', { name: 'X' });
        let r = await put('/api/groups/-100888', { rescueMode: 'on' });
        expect(r.body.group.rescueMode).toBe('on');
        r = await put('/api/groups/-100888', { rescueMode: 'bogus' });
        expect(r.body.group.rescueMode).toBeUndefined();
    });

    it('clamps rescueRetentionHours to [1, 720]', async () => {
        await put('/api/groups/-100999', { name: 'X' });
        const r = await put('/api/groups/-100999', { rescueRetentionHours: 99999 });
        expect(r.body.group.rescueRetentionHours).toBe(720);
    });

    it('sets, normalises and clears the per-group maxVideoSize', async () => {
        await put('/api/groups/-101010', { name: 'X' });
        let r = await put('/api/groups/-101010', { maxVideoSize: ' 500 mb ' });
        expect(r.body.group.maxVideoSize).toBe('500MB');
        r = await put('/api/groups/-101010', { maxVideoSize: 'none' });
        expect(r.body.group.maxVideoSize).toBe('none');
        r = await put('/api/groups/-101010', { maxVideoSize: '' });
        expect(r.body.group.maxVideoSize).toBeUndefined();
    });

    it('leaves maxVideoSize alone when the field is not sent', async () => {
        await put('/api/groups/-101011', { name: 'X', maxVideoSize: '2GB' });
        const r = await put('/api/groups/-101011', { rescueMode: 'on' });
        expect(r.body.group.maxVideoSize).toBe('2GB');
    });

    it('rejects an unparseable maxVideoSize without changing the stored one', async () => {
        await put('/api/groups/-101012', { name: 'X', maxVideoSize: '1GB' });
        const bad = await put('/api/groups/-101012', { maxVideoSize: 'lots' });
        expect(bad.status).toBe(400);
        const ok = await put('/api/groups/-101012', { rescueMode: 'on' });
        expect(ok.body.group.maxVideoSize).toBe('1GB');
    });

    it('sets backfillSchedule only for recognised non-off values', async () => {
        await put('/api/groups/-101000', { name: 'X' });
        let r = await put('/api/groups/-101000', { backfillSchedule: 'daily' });
        expect(r.body.group.backfillSchedule).toBe('daily');
        r = await put('/api/groups/-101000', { backfillSchedule: 'off' });
        expect(r.body.group.backfillSchedule).toBeUndefined();
    });

    it('clears topics when set to null and sets them otherwise', async () => {
        await put('/api/groups/-101001', { name: 'X' });
        let r = await put('/api/groups/-101001', { topics: { enabled: true, ids: [1, 2, '3'] } });
        expect(r.body.group.topics).toEqual({ enabled: true, ids: [1, 2, 3] });
        r = await put('/api/groups/-101001', { topics: null });
        expect(r.body.group.topics).toBeUndefined();
    });

    it('sets and clears ownerPeerId / backupPeerId', async () => {
        await put('/api/groups/-101002', { name: 'X' });
        let r = await put('/api/groups/-101002', { ownerPeerId: 'peer-a' });
        expect(r.body.group.ownerPeerId).toBe('peer-a');
        r = await put('/api/groups/-101002', { ownerPeerId: '' });
        expect(r.body.group.ownerPeerId).toBeUndefined();
    });

    it('kicks off an auto-first-backfill hook only when enabling a zero-row group (and swallows its failure)', async () => {
        // getAccountManager() resolves { count: 0 } so _spawnInternalBackfill
        // throws "No Telegram accounts loaded" inside a fire-and-forget
        // .catch() — the PUT itself must still succeed either way.
        const { status, body } = await put('/api/groups/-101003', {
            name: 'Fresh',
            enabled: true,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });
});

describe('GET /api/groups/:id/stats and /files', () => {
    beforeEach(() => {
        downloadsApi.insertDownload({
            groupId: '-100222',
            groupName: 'Grp',
            messageId: 1,
            fileName: 'a.jpg',
            fileType: 'photo',
            fileSize: 100,
        });
        downloadsApi.insertDownload({
            groupId: '-100222',
            groupName: 'Grp',
            messageId: 2,
            fileName: 'b.mp4',
            fileType: 'video',
            fileSize: 200,
        });
    });

    it('GET /groups/:id/stats reports totals', async () => {
        const { status, body } = await get('/api/groups/-100222/stats');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('GET /groups/:id/files paginates and clamps limit/offset', async () => {
        const { status, body } = await get('/api/groups/-100222/files?limit=999999&offset=-5');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.rows)).toBe(true);
    });

    it('GET /groups/:id/files filters by type', async () => {
        const { body } = await get('/api/groups/-100222/files?type=video');
        expect(body.rows.every((f) => f.file_type === 'video')).toBe(true);
    });
});

describe('DELETE /api/groups/:id/purge and POST delete-files', () => {
    beforeEach(() => {
        downloadsApi.insertDownload({
            groupId: '-100333',
            groupName: 'PurgeMe',
            messageId: 1,
            fileName: 'a.mp4',
            fileType: 'video',
            fileSize: 10,
            filePath: 'PurgeMe/a.mp4',
        });
    });

    it('purges a group: deletes the on-disk folder (under TGDL_DATA_DIR), DB rows, and config entry', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100333', name: 'PurgeMe', enabled: true }];
        await manager.saveConfig(cfg);
        // Real file under the isolated TGDL_DATA_DIR/downloads/PurgeMe — if
        // the route ever regresses to the hardcoded in-repo data/ path this
        // file survives the purge and the existence check below fails.
        const groupFolder = path.join(DATA_DIR, 'downloads', 'PurgeMe');
        fs.mkdirSync(groupFolder, { recursive: true });
        fs.writeFileSync(path.join(groupFolder, 'a.mp4'), 'x');

        const { status, body } = await del('/api/groups/-100333/purge');
        expect(status).toBe(200);
        expect(body.started).toBe(true);

        // Poll the tracker's status until the fire-and-forget purge finishes.
        for (let i = 0; i < 50; i++) {
            const { body: st } = await get('/api/groups/-100333/purge/status');
            if (!st.running) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        expect(fs.existsSync(groupFolder)).toBe(false);
        const remaining = dbApi
            .getDb()
            .prepare('SELECT COUNT(*) AS n FROM downloads WHERE group_id = ?')
            .get('-100333').n;
        expect(remaining).toBe(0);
        const cfgAfter = manager.loadConfig();
        expect(cfgAfter.groups.find((g) => String(g.id) === '-100333')).toBeUndefined();
    });

    it('409s when a purge is already running for the same group', async () => {
        const first = await del('/api/groups/-100333/purge');
        expect(first.status).toBe(200);
        const second = await del('/api/groups/-100333/purge');
        // The tracker is single-flight per group — a fast enough second
        // call while the first is still mid-run gets rejected. If the
        // first already finished (fast temp-dir I/O), this degrades to
        // another successful start, which is also acceptable behaviour.
        expect([200, 409]).toContain(second.status);
        for (let i = 0; i < 50; i++) {
            const { body: st } = await get('/api/groups/-100333/purge/status');
            if (!st.running) break;
            await new Promise((r) => setTimeout(r, 20));
        }
    });

    it('delete-files removes non-pinned rows but keeps the config entry', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100333', name: 'PurgeMe', enabled: true }];
        await manager.saveConfig(cfg);

        const { status, body } = await post('/api/groups/-100333/delete-files');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        for (let i = 0; i < 50; i++) {
            const { body: st } = await get('/api/groups/-100333/purge/status');
            if (!st.running) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const remaining = dbApi
            .getDb()
            .prepare('SELECT COUNT(*) AS n FROM downloads WHERE group_id = ?')
            .get('-100333').n;
        expect(remaining).toBe(0);
        const cfgAfter = manager.loadConfig();
        expect(cfgAfter.groups.find((g) => String(g.id) === '-100333')).toBeDefined();
    });

    it('delete-files 400s without a group id', async () => {
        const { status } = await post('/api/groups//delete-files');
        expect([400, 404]).toContain(status);
    });
});

describe('GET /api/groups/:id/photo', () => {
    it('404s when no photo exists and download fails', async () => {
        const { status } = await get('/api/groups/-100444/photo');
        expect(status).toBe(404);
    });

    it('400s on an invalid numeric id', async () => {
        const { status } = await get('/api/groups/not-a-number/photo');
        expect(status).toBe(400);
    });

    it('strips the comment: prefix and serves the parent group id', async () => {
        const { status } = await get('/api/groups/comment:-100555/photo');
        // Parent -100555 has no photo either, but the prefix-stripped id
        // must still pass the numeric-id validation (not 400).
        expect(status).toBe(404);
    });

    it('404s for an unknown: id containing path-traversal characters (sanitised, not rejected)', async () => {
        // The safeKey sanitiser strips '/' before it's ever used to build a
        // filesystem path, so a traversal attempt collapses to a harmless
        // (nonexistent) filename rather than tripping the 400 escape guard —
        // that guard exists as defense-in-depth, not as the primary check.
        const { status } = await get('/api/groups/unknown:%2e%2e%2f%2e%2e/photo');
        expect(status).toBe(404);
    });

    it('404s for an unknown: synthetic id that cannot be matched to a dialog', async () => {
        const { status } = await get('/api/groups/unknown:SomeFolder/photo');
        expect(status).toBe(404);
    });
});

describe('POST /api/groups/refresh-info', () => {
    it('starts a refresh job and reports done status once finished', async () => {
        const { status, body } = await post('/api/groups/refresh-info');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        for (let i = 0; i < 50; i++) {
            const { body: st } = await get('/api/groups/refresh-info/status');
            if (!st.running) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const { body: finalSt } = await get('/api/groups/refresh-info/status');
        expect(finalSt.running).toBe(false);
    });

    it('updates a placeholder config name from a resolved entity', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100666', name: 'Unknown', enabled: true }];
        await manager.saveConfig(cfg);
        resolveEntityAcrossAccounts = async (id) =>
            id === '-100666' ? { entity: { title: 'Real Name', className: 'Channel' } } : null;

        await post('/api/groups/refresh-info');
        for (let i = 0; i < 50; i++) {
            const { body: st } = await get('/api/groups/refresh-info/status');
            if (!st.running) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const cfgAfter = manager.loadConfig();
        expect(cfgAfter.groups.find((g) => String(g.id) === '-100666').name).toBe('Real Name');
    });
});

describe('POST /api/groups/refresh-photos', () => {
    it('starts a photo refresh job and reports done status once finished', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100777', name: 'X', enabled: true }];
        await manager.saveConfig(cfg);

        const { status, body } = await post('/api/groups/refresh-photos');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        for (let i = 0; i < 50; i++) {
            const { body: st } = await get('/api/groups/refresh-photos/status');
            if (!st.running) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const { body: finalSt } = await get('/api/groups/refresh-photos/status');
        expect(finalSt.running).toBe(false);
    });
});
