// Route-level tests for /api/dialogs and its exported helpers, covering
// the parts tests/dialogs-route.test.js doesn't: getDialogsNameCache()/
// dialogsTypeFor()/dialogsHasPhotoFor() called directly, the legacy
// (non-multi-account) telegramClient merge path, the two distinct
// no-account-vs-not-connected 503 shapes, allowDM gating for DM
// dialogs, config-group field enrichment, and the response cache
// serving without ?fresh=1.
//
// dialogs-route.test.js already covers the full iterDialogs sweep
// (>500 dialogs), server-side search, and the capped-getDialogs
// fallback — not duplicated here.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-dialogs2-'));

let dialogsMod;
let app;
let server;
let port;
let getAccountManager;
let getTelegramClient;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function makeDialog(id, overrides = {}) {
    return {
        id,
        title: `Chat ${id}`,
        name: `Chat ${id}`,
        isGroup: true,
        isChannel: false,
        isUser: false,
        username: null,
        entity: { participantsCount: 3 },
        ...overrides,
    };
}

function makeFakeClient({ active = [], archived = [], connected = true } = {}) {
    return {
        connected,
        async *iterDialogs({ archived: wantArchived } = {}) {
            for (const d of wantArchived ? archived : active) yield d;
        },
        async getDialogs() {
            return [];
        },
    };
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dialogsMod = await import('../src/web/routes/dialogs.js');
    const manager = await import('../src/config/manager.js');
    const dbApi = await import('../src/core/db.js');

    app = express();
    app.use(express.json());
    app.use(
        '/api',
        dialogsMod.createDialogsRouter({
            getAccountManager: (...a) => getAccountManager(...a),
            getTelegramClient: (...a) => getTelegramClient?.(...a),
        }),
    );

    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });

    // Expose for beforeEach without re-importing every test.
    globalThis.__dialogsTestDeps = { manager, dbApi };
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    delete globalThis.__dialogsTestDeps;
});

beforeEach(() => {
    const { manager, dbApi } = globalThis.__dialogsTestDeps;
    dbApi.kvDelete('config');
    dbApi.getDb().prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
    dialogsMod.invalidateDialogsCache();
    dialogsMod._resetDialogsNameCache();
    getAccountManager = async () => ({ clients: new Map(), metadata: new Map() });
    getTelegramClient = () => null;
});

describe('getDialogsNameCache / dialogsTypeFor / dialogsHasPhotoFor', () => {
    it('returns an empty map with no account manager available', async () => {
        getAccountManager = async () => {
            throw new Error('not booted');
        };
        const byId = await dialogsMod.getDialogsNameCache();
        expect(byId.size).toBe(0);
    });

    it('warms the name/type/hasPhoto caches from connected clients', async () => {
        const client = makeFakeClient({
            active: [makeDialog('1', { title: 'Alpha', isChannel: true, entity: { photo: true } })],
        });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map(),
        });
        const byId = await dialogsMod.getDialogsNameCache();
        expect(byId.get('1')).toBe('Alpha');
        expect(dialogsMod.dialogsTypeFor('1')).toBe('channel');
        expect(dialogsMod.dialogsHasPhotoFor('1')).toBe(true);
    });

    it('dialogsTypeFor returns null for an unknown id', () => {
        expect(dialogsMod.dialogsTypeFor('never-seen')).toBeNull();
    });

    it('dialogsHasPhotoFor returns null (not false) for an id never seen', () => {
        expect(dialogsMod.dialogsHasPhotoFor('never-seen')).toBeNull();
    });

    it('skips disconnected clients entirely', async () => {
        const disconnected = makeFakeClient({
            active: [makeDialog('2')],
            connected: false,
        });
        getAccountManager = async () => ({
            clients: new Map([['acc1', disconnected]]),
            metadata: new Map(),
        });
        const byId = await dialogsMod.getDialogsNameCache();
        expect(byId.has('2')).toBe(false);
    });

    it('includes the legacy getTelegramClient() when not already in am.clients', async () => {
        const legacy = makeFakeClient({ active: [makeDialog('3', { title: 'Legacy Chat' })] });
        getTelegramClient = () => legacy;
        const byId = await dialogsMod.getDialogsNameCache();
        expect(byId.get('3')).toBe('Legacy Chat');
    });

    it('does not double-count the legacy client when it is also in am.clients', async () => {
        let sweepCount = 0;
        const shared = makeFakeClient({ active: [makeDialog('4', { title: 'Shared' })] });
        const original = shared.iterDialogs.bind(shared);
        shared.iterDialogs = async function* (...args) {
            sweepCount++;
            yield* original(...args);
        };
        getAccountManager = async () => ({
            clients: new Map([['acc1', shared]]),
            metadata: new Map(),
        });
        getTelegramClient = () => shared;
        const byId = await dialogsMod.getDialogsNameCache();
        expect(byId.get('4')).toBe('Shared');
        // active + archived per client, once per distinct client in the
        // sweep list — 2 calls confirms `shared` was only swept once,
        // not once via am.clients and again via the legacy slot.
        expect(sweepCount).toBe(2);
    });

    it('serves from cache within the TTL instead of re-sweeping', async () => {
        const client = makeFakeClient({ active: [makeDialog('5', { title: 'First' })] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map(),
        });
        await dialogsMod.getDialogsNameCache();
        // Swap in a client with different data — cache should still win.
        getAccountManager = async () => ({
            clients: new Map([['acc1', makeFakeClient({ active: [makeDialog('6')] })]]),
            metadata: new Map(),
        });
        const byId = await dialogsMod.getDialogsNameCache();
        expect(byId.has('5')).toBe(true);
        expect(byId.has('6')).toBe(false);
    });
});

describe('GET /api/dialogs — no connected clients', () => {
    it('503s with error:no_account when there is no session on disk', async () => {
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toBe('no_account');
    });

    it('503s with error:not_connected when a session exists but no client is connected', async () => {
        fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, 'sessions', 'acc1.enc'), '');
        try {
            const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
            expect(res.status).toBe(503);
            const body = await res.json();
            expect(body.error).toBe('not_connected');
        } finally {
            fs.rmSync(path.join(DATA_DIR, 'sessions'), { recursive: true, force: true });
        }
    });

    it('503s with not_connected when getAccountManager itself throws (no creds)', async () => {
        getAccountManager = async () => {
            throw new Error('no creds configured');
        };
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        expect(res.status).toBe(503);
    });
});

describe('GET /api/dialogs — DM gating', () => {
    it('excludes a DM (isUser) dialog when allowDmDownloads is not set', async () => {
        const { manager } = globalThis.__dialogsTestDeps;
        const client = makeFakeClient({
            active: [makeDialog('u1', { isGroup: false, isUser: true, entity: {} })],
        });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        expect(body.dialogs).toHaveLength(0);
    });

    it('includes a DM dialog when allowDmDownloads is true', async () => {
        const { manager } = globalThis.__dialogsTestDeps;
        const cfg = manager.loadConfig();
        cfg.allowDmDownloads = true;
        manager.saveConfig(cfg);
        const client = makeFakeClient({
            active: [makeDialog('u2', { isGroup: false, isUser: true, entity: {} })],
        });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        expect(body.dialogs).toHaveLength(1);
    });

    it('always includes channels regardless of allowDmDownloads', async () => {
        const client = makeFakeClient({
            active: [makeDialog('c1', { isGroup: false, isChannel: true })],
        });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        expect(body.dialogs).toHaveLength(1);
    });
});

describe('GET /api/dialogs — config-group enrichment', () => {
    it('enriches a dialog already present in config.groups', async () => {
        const { manager } = globalThis.__dialogsTestDeps;
        const cfg = manager.loadConfig();
        cfg.groups = [
            {
                id: 'g1',
                enabled: true,
                filters: { photos: false },
                trackComments: true,
                autoForward: { enabled: true },
            },
        ];
        manager.saveConfig(cfg);
        const client = makeFakeClient({ active: [makeDialog('g1')] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        const row = body.dialogs.find((d) => d.id === 'g1');
        expect(row.inConfig).toBe(true);
        expect(row.enabled).toBe(true);
        // loadConfig() heals a partial filters/autoForward object by
        // merging it with GROUP_DEFAULTS on read, so the override alone
        // isn't what comes back — the merged result is.
        expect(row.filters).toEqual({ ...manager.GROUP_DEFAULTS.filters, photos: false });
        expect(row.trackComments).toBe(true);
        expect(row.autoForward).toEqual({ ...manager.GROUP_DEFAULTS.autoForward, enabled: true });
    });

    it('uses GROUP_DEFAULTS for a dialog not present in config.groups', async () => {
        const client = makeFakeClient({ active: [makeDialog('g2')] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        const row = body.dialogs.find((d) => d.id === 'g2');
        const { manager } = globalThis.__dialogsTestDeps;
        expect(row.inConfig).toBe(false);
        expect(row.enabled).toBe(false);
        expect(row.filters).toEqual(manager.GROUP_DEFAULTS.filters);
        expect(row.trackComments).toBe(manager.GROUP_DEFAULTS.trackComments);
        expect(row.autoForward).toEqual(manager.GROUP_DEFAULTS.autoForward);
    });

    it('reports accountIds sorted and deduplicated when multiple accounts see the same chat', async () => {
        const clientB = makeFakeClient({ active: [makeDialog('shared-1')] });
        const clientA = makeFakeClient({ active: [makeDialog('shared-1')] });
        getAccountManager = async () => ({
            clients: new Map([
                ['zzz-acc', clientB],
                ['aaa-acc', clientA],
            ]),
            metadata: new Map([
                ['zzz-acc', { name: 'Z' }],
                ['aaa-acc', { name: 'A' }],
            ]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        const row = body.dialogs.find((d) => d.id === 'shared-1');
        expect(row.accountIds).toEqual(['aaa-acc', 'zzz-acc']);
    });

    it('includes the legacy client under an "legacy" pseudo-account when not in am.clients', async () => {
        const legacy = makeFakeClient({ active: [makeDialog('legacy-chat')] });
        getTelegramClient = () => legacy;
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        expect(body.accounts.some((a) => a.id === 'legacy')).toBe(true);
        const row = body.dialogs.find((d) => d.id === 'legacy-chat');
        expect(row.accountIds).toEqual(['legacy']);
    });
});

describe('GET /api/dialogs — response cache', () => {
    it('serves the cached body on a plain request (no ?fresh=1) within the TTL', async () => {
        const client1 = makeFakeClient({ active: [makeDialog('cache-1')] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client1]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        await fetch(apiUrl('/api/dialogs?fresh=1'));

        const client2 = makeFakeClient({ active: [makeDialog('cache-2')] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client2]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs'));
        const body = await res.json();
        expect(body.dialogs.some((d) => d.id === 'cache-1')).toBe(true);
        expect(body.dialogs.some((d) => d.id === 'cache-2')).toBe(false);
    });

    it('?fresh=1 bypasses the cache and re-sweeps', async () => {
        const client1 = makeFakeClient({ active: [makeDialog('cache-3')] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client1]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        await fetch(apiUrl('/api/dialogs?fresh=1'));

        const client2 = makeFakeClient({ active: [makeDialog('cache-4')] });
        getAccountManager = async () => ({
            clients: new Map([['acc1', client2]]),
            metadata: new Map([['acc1', { name: 'Acc' }]]),
        });
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        const body = await res.json();
        expect(body.dialogs.some((d) => d.id === 'cache-4')).toBe(true);
    });
});

// Note: no test forces the route's outer try/catch (500 path). loadConfig()
// wraps its entire body in one try/catch (plus an inner one around the
// normalized-groups overlay) and swallows failures internally rather than
// throwing, and every per-client sweep is independently guarded too — there
// is no realistic fault to inject here without fabricating a scenario that
// can't happen through the real dependencies.
