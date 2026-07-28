// Covers src/core/monitor.js — the realtime watcher: per-group client
// selection, the synthetic `unknown:` group resolver, config hot-reload,
// the poll loop, event handling (filters, TTL fast-path, comment routing),
// delete/rescue handling, and the batched URL writer.
//
// gramJS is mocked — `telegram` and `telegram/events/index.js` only supply
// marker classes here. Everything with real logic stays real: core/db.js and
// config/manager.js against an isolated TGDL_DATA_DIR, core/monitor-spam.js,
// core/rescue.js, and downloader.js's sanitizeName (which decides the folder
// key the dialogs index is looked up by, so a stub would test itself).
//
// The RealtimeMonitor constructor subscribes to the config bus, so every
// instance a test builds must be stopped or unsubscribed — see `mk()`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A path that cannot be created, on every platform.
 *
 * Its parent is a regular file, so mkdir fails ENOTDIR immediately. Do NOT
 * reach for /proc here: it does not exist on macOS (so the call fails fast
 * and the test passes for the wrong reason) but does on Linux, where the
 * call stalls and the test times out instead.
 */
function unwritablePath() {
    const blocker = path.join(DATA_DIR, `not-a-dir-${process.pid}`);
    // Unconditional write, no existsSync guard: check-then-write is a
    // filesystem race (CodeQL js/file-system-race) and writeFileSync is
    // already idempotent here.
    fs.writeFileSync(blocker, 'x');
    return path.join(blocker, 'nested');
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-monitor-'));

vi.mock('telegram', () => ({
    Api: {
        UpdateDeleteChannelMessages: class {},
        UpdateDeleteMessages: class {},
        channels: { GetFullChannel: class {} },
    },
}));
vi.mock('telegram/events/index.js', () => ({
    NewMessage: class {
        constructor(opts) {
            this.opts = opts;
        }
    },
    Raw: class {
        constructor(opts) {
            this.opts = opts;
        }
    },
}));

let monitorMod;
let dbApi;
let downloadsApi;
let manager;
const _live = [];

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    manager = await import('../src/config/manager.js');
    monitorMod = await import('../src/core/monitor.js');
});

afterAll(() => {
    try {
        dbApi.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    dbApi.getDb().prepare('DELETE FROM downloads').run();
    manager._resetConfigBus();
});

afterEach(() => {
    // Drop every config-bus subscription this test created.
    for (const m of _live.splice(0)) {
        try {
            m._configWatcher?.close?.();
        } catch {
            /* already closed */
        }
    }
    vi.useRealTimers();
});

// ---- doubles ------------------------------------------------------------

class FakeDownloader extends EventEmitter {
    constructor({ accept = true } = {}) {
        super();
        this.enqueued = [];
        this.stopped = 0;
        this._accept = accept;
    }
    async enqueue(job, priority) {
        this.enqueued.push({ job, priority });
        return this._accept;
    }
    async stop() {
        this.stopped++;
    }
}

const GROUP = { id: '-1001234567890', name: 'My Group', enabled: true, filters: {} };

function baseConfig(overrides = {}) {
    return {
        groups: [structuredClone(GROUP)],
        pollingInterval: 10,
        download: { path: path.join(DATA_DIR, 'downloads') },
        ...overrides,
    };
}

/** Build a monitor and register it for teardown. */
function mk(config = baseConfig(), { client = null, downloader, accountManager = null } = {}) {
    const dl = downloader || new FakeDownloader();
    const m = new monitorMod.RealtimeMonitor(client, dl, config, accountManager);
    _live.push(m);
    return { m, dl };
}

function photoMsg(id, chatId, extra = {}) {
    return { id, chatId: { toString: () => String(chatId) }, photo: {}, ...extra };
}

// ---- client selection ---------------------------------------------------

describe('getClientForGroup', () => {
    it('prefers the explicitly configured monitorAccount', () => {
        const pinned = { tag: 'pinned' };
        const fallback = { tag: 'fallback' };
        const { m } = mk(baseConfig(), {
            client: fallback,
            accountManager: { getClient: () => pinned },
        });
        expect(m.getClientForGroup({ id: '1', monitorAccount: 'acct2' })).toBe(pinned);
    });

    it('falls back to the default client when the pinned account is gone', () => {
        const fallback = { tag: 'fallback' };
        const { m } = mk(baseConfig(), {
            client: fallback,
            accountManager: { getClient: () => null },
        });
        expect(m.getClientForGroup({ id: '1', monitorAccount: 'missing' })).toBe(fallback);
    });

    it('uses the auto-discovered cache when no account is pinned', () => {
        const cached = { tag: 'cached' };
        const { m } = mk(baseConfig(), { client: { tag: 'fallback' } });
        m.groupClientCache = new Map([['1', cached]]);
        expect(m.getClientForGroup({ id: '1' })).toBe(cached);
    });

    it('falls back to the constructor client with no manager and no cache', () => {
        const fallback = { tag: 'fallback' };
        const { m } = mk(baseConfig(), { client: fallback });
        expect(m.getClientForGroup({ id: '1' })).toBe(fallback);
    });
});

describe('_describeLoadedAccounts', () => {
    it('reports the empty case', () => {
        const { m } = mk();
        expect(m._describeLoadedAccounts()).toBe('<no accounts>');

        const { m: m2 } = mk(baseConfig(), { accountManager: { clients: new Map() } });
        expect(m2._describeLoadedAccounts()).toBe('<no accounts>');
    });

    it('names a single account by handle', () => {
        const { m } = mk(baseConfig(), {
            accountManager: {
                clients: new Map([['a', {}]]),
                metadata: new Map([['a', { username: 'ada' }]]),
            },
        });
        expect(m._describeLoadedAccounts()).toBe('@ada');
    });

    it('pluralises the overflow correctly', () => {
        const mkMgr = (n) => ({
            clients: new Map(Array.from({ length: n }, (_, i) => [`a${i}`, {}])),
            metadata: new Map(
                Array.from({ length: n }, (_, i) => [`a${i}`, { username: `u${i}` }]),
            ),
        });
        const two = mk(baseConfig(), { accountManager: mkMgr(2) }).m;
        const three = mk(baseConfig(), { accountManager: mkMgr(3) }).m;
        expect(two._describeLoadedAccounts()).toBe('@u0 + 1 other');
        expect(three._describeLoadedAccounts()).toBe('@u0 + 2 others');
    });

    it('falls back through name, phone and raw id', () => {
        const { m } = mk(baseConfig(), {
            accountManager: {
                clients: new Map([['a', {}]]),
                metadata: new Map([['a', { name: 'Ada' }]]),
            },
        });
        expect(m._describeLoadedAccounts()).toBe('Ada');

        const { m: m2 } = mk(baseConfig(), {
            accountManager: { clients: new Map([['acct-7', {}]]), metadata: new Map() },
        });
        expect(m2._describeLoadedAccounts()).toBe('acct-7');
    });
});

// ---- dialogs index + unknown-group resolver -----------------------------

describe('_buildDialogsIndex', () => {
    it('is empty without an AccountManager', async () => {
        const { m } = mk();
        expect((await m._buildDialogsIndex()).size).toBe(0);
    });

    it('skips clients that are not connected', async () => {
        const client = { connected: false, getDialogs: vi.fn() };
        const { m } = mk(baseConfig(), {
            accountManager: { clients: new Map([['a', client]]) },
        });
        expect((await m._buildDialogsIndex()).size).toBe(0);
        expect(client.getDialogs).not.toHaveBeenCalled();
    });

    it('indexes active and archived dialogs by sanitised title', async () => {
        const client = {
            connected: true,
            getDialogs: async ({ archived }) =>
                archived ? [{ id: 222, title: 'Archived Chat' }] : [{ id: 111, title: 'My Group' }],
        };
        const { m } = mk(baseConfig(), {
            accountManager: { clients: new Map([['a', client]]) },
        });

        const idx = await m._buildDialogsIndex();
        expect(idx.get('My_Group')).toMatchObject({ numericId: '111', title: 'My Group' });
        expect(idx.get('Archived_Chat')).toMatchObject({ numericId: '222' });
    });

    it('also indexes by @username', async () => {
        const client = {
            connected: true,
            getDialogs: async ({ archived }) =>
                archived ? [] : [{ id: 111, title: 'My Group', entity: { username: 'mygroup' } }],
        };
        const { m } = mk(baseConfig(), {
            accountManager: { clients: new Map([['a', client]]) },
        });
        const idx = await m._buildDialogsIndex();
        expect(idx.get('mygroup')).toMatchObject({ numericId: '111' });
    });

    it('builds a title from a DM entity name', async () => {
        const client = {
            connected: true,
            getDialogs: async ({ archived }) =>
                archived ? [] : [{ id: 5, entity: { firstName: 'Ada', lastName: 'Lovelace' } }],
        };
        const { m } = mk(baseConfig(), {
            accountManager: { clients: new Map([['a', client]]) },
        });
        expect((await m._buildDialogsIndex()).get('Ada_Lovelace')).toMatchObject({
            numericId: '5',
        });
    });

    it('is first-wins across accounts', async () => {
        const mkClient = (id) => ({
            connected: true,
            getDialogs: async ({ archived }) => (archived ? [] : [{ id, title: 'Same Name' }]),
        });
        const { m } = mk(baseConfig(), {
            accountManager: {
                clients: new Map([
                    ['a', mkClient(111)],
                    ['b', mkClient(222)],
                ]),
            },
        });
        expect((await m._buildDialogsIndex()).get('Same_Name').numericId).toBe('111');
    });

    it('tolerates a client whose getDialogs rejects', async () => {
        const bad = {
            connected: true,
            getDialogs: async () => {
                throw new Error('AUTH_KEY_UNREGISTERED');
            },
        };
        const good = {
            connected: true,
            getDialogs: async ({ archived }) => (archived ? [] : [{ id: 9, title: 'Good' }]),
        };
        const { m } = mk(baseConfig(), {
            accountManager: {
                clients: new Map([
                    ['a', bad],
                    ['b', good],
                ]),
            },
        });
        const idx = await m._buildDialogsIndex();
        expect(idx.get('Good')).toBeTruthy();
    });
});

describe('_resolveUnknownGroup', () => {
    function unknownGroup(folder = 'My Group') {
        return { id: `unknown:${folder}`, name: folder, enabled: true, filters: {} };
    }

    it('records empty_folder for a bare unknown: id', async () => {
        const { m } = mk();
        const g = { id: 'unknown:' };
        expect(await m._resolveUnknownGroup(g, new Map())).toBeNull();
        expect(m._lastResolveReason.get('unknown:')).toBe('empty_folder');
    });

    it('records index_miss when nothing matches', async () => {
        const { m } = mk();
        const g = unknownGroup();
        expect(await m._resolveUnknownGroup(g, new Map())).toBeNull();
        expect(m._lastResolveReason.get(g.id)).toBe('index_miss');
    });

    it('rewrites the group id in memory, in config and in the downloads table', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [unknownGroup()];
        manager.saveConfig(cfg);

        downloadsApi.insertDownload({
            groupId: 'unknown:My Group',
            groupName: 'My Group',
            messageId: 1,
            fileName: 'a.jpg',
            fileType: 'photos',
            filePath: 'My Group/photos/a.jpg',
        });

        const client = { getMessages: async () => [{ id: 1 }] };
        const { m } = mk(baseConfig({ groups: [unknownGroup()] }));
        const g = m.config.groups[0];

        const res = await m._resolveUnknownGroup(
            g,
            new Map([['My Group', { client, numericId: '999', title: 'Real Title' }]]),
        );

        expect(res).toEqual({ numericId: '999', client });
        expect(g.id).toBe('999');
        expect(g.name).toBe('Real Title');
        expect(manager.loadConfig().groups[0].id).toBe('999');

        const row = dbApi.getDb().prepare('SELECT group_id, group_name FROM downloads').get();
        expect(row.group_id).toBe('999');
        expect(row.group_name).toBe('Real Title');
    });

    it('keeps a user-set group name instead of overwriting it', async () => {
        const client = { getMessages: async () => [{ id: 1 }] };
        const g = { ...unknownGroup(), name: 'My Custom Label' };
        const { m } = mk(baseConfig({ groups: [g] }));
        await m._resolveUnknownGroup(
            g,
            new Map([['My Group', { client, numericId: '999', title: 'Real Title' }]]),
        );
        expect(g.name).toBe('My Custom Label');
    });

    it('falls back to a direct getEntity probe for a public @handle', async () => {
        const client = {
            getEntity: async () => ({ id: 777, title: 'Public Chan', username: 'pub' }),
            getMessages: async () => [{ id: 1 }],
        };
        const { m } = mk(baseConfig(), {
            accountManager: { clients: new Map([['a', client]]) },
        });
        const g = unknownGroup('pub');
        const res = await m._resolveUnknownGroup(g, new Map());
        expect(res.numericId).toBe('777');
    });

    it('records probe_empty when the matched dialog reads back nothing', async () => {
        const client = { getMessages: async () => null };
        const { m } = mk();
        const g = unknownGroup();
        expect(
            await m._resolveUnknownGroup(
                g,
                new Map([['My Group', { client, numericId: '999', title: 'T' }]]),
            ),
        ).toBeNull();
        expect(m._lastResolveReason.get(g.id)).toBe('probe_empty');
    });

    it('distinguishes a ban from a generic probe failure', async () => {
        const { m } = mk();
        const banned = unknownGroup('Banned');
        await m._resolveUnknownGroup(
            banned,
            new Map([
                [
                    'Banned',
                    {
                        client: {
                            getMessages: async () => {
                                throw Object.assign(new Error('x'), {
                                    errorMessage: 'CHANNEL_PRIVATE',
                                });
                            },
                        },
                        numericId: '1',
                        title: 'T',
                    },
                ],
            ]),
        );
        expect(m._lastResolveReason.get(banned.id)).toBe('banned:CHANNEL_PRIVATE');

        const broken = unknownGroup('Broken');
        await m._resolveUnknownGroup(
            broken,
            new Map([
                [
                    'Broken',
                    {
                        client: {
                            getMessages: async () => {
                                throw new Error('TIMEOUT');
                            },
                        },
                        numericId: '1',
                        title: 'T',
                    },
                ],
            ]),
        );
        expect(m._lastResolveReason.get(broken.id)).toBe('probe_failed:TIMEOUT');
    });
});

// ---- config reload ------------------------------------------------------

describe('reloadConfig', () => {
    it('swaps in the new tree and announces it', async () => {
        const { m } = mk();
        const seen = vi.fn();
        m.on('configReloaded', seen);

        const next = baseConfig({ groups: [{ ...GROUP, name: 'Renamed' }] });
        await m.reloadConfig(next);

        expect(m.config).toBe(next);
        expect(seen).toHaveBeenCalledWith(next);
    });

    it('re-reads from the store when handed nothing', async () => {
        const cfg = manager.loadConfig();
        cfg.pollingInterval = 42;
        manager.saveConfig(cfg);

        const { m } = mk();
        await m.reloadConfig();
        expect(m.config.pollingInterval).toBe(42);
    });

    it('survives a malformed tree without throwing', async () => {
        const { m } = mk();
        await expect(m.reloadConfig({ groups: null })).resolves.toBeUndefined();
    });

    it('re-runs the resolver for a newly added unknown: group', async () => {
        const client = {
            connected: true,
            getDialogs: async ({ archived }) => (archived ? [] : [{ id: 555, title: 'Found_It' }]),
            getMessages: async () => [{ id: 1 }],
        };
        const { m } = mk(baseConfig({ groups: [] }), {
            accountManager: { clients: new Map([['a', client]]) },
        });

        const added = { id: 'unknown:Found_It', name: 'Found_It', enabled: true, filters: {} };
        await m.reloadConfig(baseConfig({ groups: [added] }));

        expect(added.id).toBe('555');
    });

    it('leaves an unresolvable unknown: group alone', async () => {
        const client = {
            connected: true,
            getDialogs: async () => [],
            getEntity: async () => {
                throw new Error('nope');
            },
        };
        const { m } = mk(baseConfig({ groups: [] }), {
            accountManager: { clients: new Map([['a', client]]) },
        });

        const added = { id: 'unknown:Ghost', name: 'Ghost', enabled: true, filters: {} };
        await m.reloadConfig(baseConfig({ groups: [added] }));
        expect(added.id).toBe('unknown:Ghost');
    });

    it('fires automatically when the config bus commits', async () => {
        const { m } = mk();
        const seen = vi.fn();
        m.on('configReloaded', seen);

        const cfg = manager.loadConfig();
        cfg.pollingInterval = 77;
        manager.saveConfig(cfg);
        await new Promise((r) => setImmediate(r));

        expect(seen).toHaveBeenCalled();
    });
});

// ---- handleEvent --------------------------------------------------------

describe('handleEvent', () => {
    const CHAT = '1234567890'; // GROUP.id without the -100 prefix

    it('ignores an update with no message', async () => {
        const { m, dl } = mk();
        await m.handleEvent({});
        expect(dl.enqueued).toHaveLength(0);
        expect(m.stats.messages).toBe(0);
    });

    it('enqueues media from a monitored group at realtime priority', async () => {
        const { m, dl } = mk();
        await m.handleEvent({ message: photoMsg(1, CHAT) });

        expect(dl.enqueued).toHaveLength(1);
        expect(dl.enqueued[0].priority).toBe(1);
        expect(dl.enqueued[0].job.groupId).toBe(GROUP.id);
        expect(m.stats.downloaded).toBe(1);
    });

    it('normalises the -100 channel prefix when matching', async () => {
        const { m, dl } = mk();
        await m.handleEvent({ message: photoMsg(1, `-100${CHAT}`) });
        expect(dl.enqueued).toHaveLength(1);
    });

    it('falls back to peerId when chatId is absent', async () => {
        const { m, dl } = mk();
        await m.handleEvent({
            message: { id: 1, photo: {}, peerId: { channelId: { toString: () => CHAT } } },
        });
        expect(dl.enqueued).toHaveLength(1);
    });

    it('ignores a message from an unmonitored chat, logging it once', async () => {
        const { m, dl } = mk();
        await m.handleEvent({ message: photoMsg(1, '999999') });
        await m.handleEvent({ message: photoMsg(2, '999999') });
        expect(dl.enqueued).toHaveLength(0);
        expect(m._unknownGroups.size).toBe(1);
    });

    it('ignores a disabled group', async () => {
        const { m, dl } = mk(baseConfig({ groups: [{ ...GROUP, enabled: false }] }));
        await m.handleEvent({ message: photoMsg(1, CHAT) });
        expect(dl.enqueued).toHaveLength(0);
    });

    it('routes a linked-chat message under a namespaced comment id', async () => {
        const { m, dl } = mk();
        m.linkedChatMap = new Map([['555', { group: m.config.groups[0], rawId: '555' }]]);
        await m.handleEvent({ message: photoMsg(1, '555') });

        expect(dl.enqueued[0].job.groupId).toBe(`comment:${GROUP.id}`);
        expect(dl.enqueued[0].job.groupName).toBe('My Group (comments)');
    });

    it('fast-paths self-destructing media to the front of the queue', async () => {
        const { m, dl } = mk();
        const downloads = [];
        m.on('download', (d) => downloads.push(d));

        // hasMedia() inspects message.media's internals whenever that
        // property is present, so a TTL fixture has to be shaped the way
        // gramJS actually delivers one.
        await m.handleEvent({
            message: {
                id: 1,
                chatId: { toString: () => CHAT },
                photo: {},
                media: { className: 'MessageMediaPhoto', photo: {}, ttlSeconds: 30 },
            },
        });

        expect(dl.enqueued[0].priority).toBe(0);
        expect(dl.enqueued[0].job.ttlSeconds).toBe(30);
        expect(downloads[0]).toMatchObject({ type: 'ttl', ttl: 30 });
    });

    it('counts a rejected enqueue as skipped', async () => {
        const { m, dl } = mk(baseConfig(), { downloader: new FakeDownloader({ accept: false }) });
        await m.handleEvent({ message: photoMsg(1, CHAT) });
        expect(m.stats.downloaded).toBe(0);
        expect(m.stats.skipped).toBe(1);
        expect(dl.enqueued).toHaveLength(1);
    });

    it('respects a disabled media filter', async () => {
        const { m, dl } = mk(baseConfig({ groups: [{ ...GROUP, filters: { photos: false } }] }));
        await m.handleEvent({ message: photoMsg(1, CHAT) });
        expect(dl.enqueued).toHaveLength(0);
        expect(m.stats.skipped).toBe(1);
    });

    it('defaults stickers to off unless explicitly enabled', async () => {
        const { m, dl } = mk();
        await m.handleEvent({ message: { id: 1, chatId: { toString: () => CHAT }, sticker: {} } });
        expect(dl.enqueued).toHaveLength(0);

        const { m: m2, dl: dl2 } = mk(
            baseConfig({ groups: [{ ...GROUP, filters: { stickers: true } }] }),
        );
        await m2.handleEvent({ message: { id: 1, chatId: { toString: () => CHAT }, sticker: {} } });
        expect(dl2.enqueued).toHaveLength(1);
    });

    it('pins the client that surfaced the message onto the job', async () => {
        const { m, dl } = mk();
        const poller = { tag: 'poller' };
        await m.handleEvent({ message: photoMsg(1, CHAT), client: poller });
        expect(dl.enqueued[0].job.client).toBe(poller);
    });

    it('carries the caption through to the job', async () => {
        const { m, dl } = mk();
        await m.handleEvent({ message: photoMsg(1, CHAT, { message: 'a caption' }) });
        expect(dl.enqueued[0].job.caption).toBe('a caption');
    });

    it('emits error rather than throwing when the downloader blows up', async () => {
        const dl = new FakeDownloader();
        dl.enqueue = async () => {
            throw new Error('queue exploded');
        };
        const { m } = mk(baseConfig(), { downloader: dl });
        const errors = [];
        m.on('error', (e) => errors.push(e));

        await m.handleEvent({ message: photoMsg(1, CHAT) });
        expect(errors[0]).toEqual({ error: 'queue exploded' });
    });

    it('drops spam before any filter runs', async () => {
        const { m, dl } = mk();
        m.spamGuard = { isSpam: () => true };
        await m.handleEvent({ message: photoMsg(1, CHAT) });
        expect(dl.enqueued).toHaveLength(0);
        expect(m.stats.skipped).toBe(1);
    });
});

describe('_isBlockedByGlobalWebpRule', () => {
    it('only suppresses stickers, and only when the flag is on', () => {
        const { _isBlockedByGlobalWebpRule: rule } = monitorMod;
        expect(rule('stickers', { download: { blockWebp: true } })).toBe(true);
        expect(rule('stickers', { download: { blockWebp: false } })).toBe(false);
        expect(rule('photos', { download: { blockWebp: true } })).toBe(false);
        expect(rule('stickers', {})).toBe(false);
        expect(rule('stickers', null)).toBe(false);
    });

    it('overrides a group filter that would otherwise allow stickers', async () => {
        const { m, dl } = mk(
            baseConfig({
                groups: [{ ...GROUP, filters: { stickers: true } }],
                download: { blockWebp: true, path: path.join(DATA_DIR, 'downloads') },
            }),
        );
        await m.handleEvent({
            message: { id: 1, chatId: { toString: () => '1234567890' }, sticker: {} },
        });
        expect(dl.enqueued).toHaveLength(0);
    });
});

// ---- delete / rescue ----------------------------------------------------

describe('handleDeleteEvent', () => {
    function seedPending(groupId, messageId) {
        downloadsApi.insertDownload({
            groupId: String(groupId),
            groupName: 'My Group',
            messageId,
            fileName: `f${messageId}.jpg`,
            fileType: 'photos',
            filePath: `My Group/photos/f${messageId}.jpg`,
            pendingUntil: Date.now() + 60_000,
        });
    }

    it('ignores an update with no message ids', async () => {
        const { m } = mk();
        await expect(m.handleDeleteEvent({})).resolves.toBeUndefined();
        await expect(m.handleDeleteEvent({ messages: [] })).resolves.toBeUndefined();
    });

    it('rescues a channel delete and emits per rescued row', async () => {
        seedPending(GROUP.id, 42);
        const { m } = mk();
        const rescued = [];
        m.on('rescued', (r) => rescued.push(r));

        await m.handleDeleteEvent({
            className: 'UpdateDeleteChannelMessages',
            channelId: { toString: () => '1234567890' },
            messages: [42],
        });

        expect(rescued).toEqual([{ groupId: GROUP.id, messageId: 42 }]);
    });

    it('ignores a channel delete for an unmonitored channel', async () => {
        seedPending(GROUP.id, 42);
        const { m } = mk();
        const rescued = [];
        m.on('rescued', (r) => rescued.push(r));

        await m.handleDeleteEvent({
            className: 'UpdateDeleteChannelMessages',
            channelId: { toString: () => '999999' },
            messages: [42],
        });
        expect(rescued).toHaveLength(0);
    });

    it('sweeps every monitored group for a DM-style delete', async () => {
        seedPending(GROUP.id, 77);
        const { m } = mk();
        const rescued = [];
        m.on('rescued', (r) => rescued.push(r));

        await m.handleDeleteEvent({ className: 'UpdateDeleteMessages', messages: [77] });
        expect(rescued).toEqual([{ groupId: GROUP.id, messageId: 77 }]);
    });

    it('emits nothing when no row matches', async () => {
        const { m } = mk();
        const rescued = [];
        m.on('rescued', (r) => rescued.push(r));
        await m.handleDeleteEvent({ className: 'UpdateDeleteMessages', messages: [12345] });
        expect(rescued).toHaveLength(0);
    });
});

// ---- URL buffer ---------------------------------------------------------

describe('handleUrls / flushUrls', () => {
    it('buffers urls in memory and reports the count', async () => {
        const { m } = mk();
        const urlEvents = [];
        m.on('urls', (u) => urlEvents.push(u));

        await m.handleUrls({ message: 'see https://a.example and https://b.example' }, GROUP);

        expect(m.stats.urls).toBe(2);
        expect(m.urlBuffer.get(GROUP.id)).toHaveLength(2);
        expect(urlEvents[0]).toEqual({ group: 'My Group', count: 2 });
    });

    it('does nothing for text with no urls', async () => {
        const { m } = mk();
        await m.handleUrls({ message: 'nothing here' }, GROUP);
        expect(m.stats.urls).toBe(0);
    });

    it('truncates very long text before running the regex', async () => {
        // ReDoS guard: only the first 1000 chars are scanned, so a url
        // pushed past that boundary is deliberately not captured.
        const { m } = mk();
        await m.handleUrls({ message: 'x'.repeat(1200) + ' https://late.example' }, GROUP);
        expect(m.stats.urls).toBe(0);
    });

    it('writes the buffer to urls.txt under the sanitised group folder', async () => {
        const base = path.join(DATA_DIR, 'downloads');
        const { m } = mk(baseConfig({ download: { path: base } }));
        await m.handleUrls({ message: 'https://a.example' }, m.config.groups[0]);

        await m.flushUrls();

        const file = path.join(base, 'My_Group', 'urls.txt');
        expect(fs.readFileSync(file, 'utf8')).toMatch(/https:\/\/a\.example/);
        // Buffer drained so the next flush is a no-op.
        expect(m.urlBuffer.get(m.config.groups[0].id)).toHaveLength(0);
    });

    it('appends across flushes', async () => {
        const base = path.join(DATA_DIR, 'downloads-append');
        const { m } = mk(baseConfig({ download: { path: base } }));
        const g = m.config.groups[0];

        await m.handleUrls({ message: 'https://one.example' }, g);
        await m.flushUrls();
        await m.handleUrls({ message: 'https://two.example' }, g);
        await m.flushUrls();

        const lines = fs
            .readFileSync(path.join(base, 'My_Group', 'urls.txt'), 'utf8')
            .trim()
            .split('\n');
        expect(lines).toHaveLength(2);
    });

    it('is a no-op with an empty buffer', async () => {
        const { m } = mk();
        await expect(m.flushUrls()).resolves.toBeUndefined();
    });

    it('keeps the buffer for a retry when the write fails', async () => {
        const { m } = mk(baseConfig({ download: { path: unwritablePath() } }));
        const g = m.config.groups[0];
        await m.handleUrls({ message: 'https://a.example' }, g);
        await m.flushUrls();
        expect(m.urlBuffer.get(g.id)).toHaveLength(1);
    });
});

// ---- poll loop ----------------------------------------------------------

describe('poll', () => {
    it('does nothing when the monitor is not running', async () => {
        const { m, dl } = mk();
        m.running = false;
        await m.poll();
        expect(dl.enqueued).toHaveLength(0);
    });

    it('fetches messages newer than the last seen id and advances the cursor', async () => {
        const calls = [];
        const client = {
            getMessages: async (gid, opts) => {
                calls.push({ gid, opts });
                // gramJS returns newest-first; poll() reverses to process in
                // ascending order so the cursor lands on the newest id.
                return [photoMsg(12, '1234567890'), photoMsg(11, '1234567890')];
            },
        };
        const { m, dl } = mk(baseConfig(), { client });
        m.running = true;
        m.lastIds = new Map([[GROUP.id, 5]]);

        await m.poll();

        expect(calls[0].opts).toMatchObject({ minId: 5, limit: 10 });
        expect(m.lastIds.get(GROUP.id)).toBe(12);
        expect(dl.enqueued).toHaveLength(2);
    }, 15_000);

    // The cursor is written per message against the id captured before the
    // loop, not against a running maximum, so it lands on whichever message
    // is processed last. That is the newest one only because getMessages
    // returns newest-first and poll() reverses it. Pinned deliberately: if
    // Telegram ever returned ascending order the cursor would walk backwards
    // and every poll would re-handle messages it had already seen.
    it('depends on the newest-first fetch order for its cursor', async () => {
        const client = {
            getMessages: async () => [photoMsg(11, '1234567890'), photoMsg(12, '1234567890')],
        };
        const { m } = mk(baseConfig(), { client });
        m.running = true;
        m.lastIds = new Map([[GROUP.id, 5]]);

        await m.poll();

        expect(m.lastIds.get(GROUP.id)).toBe(11);
    }, 15_000);

    it('skips disabled groups', async () => {
        const client = { getMessages: vi.fn(async () => []) };
        const { m } = mk(baseConfig({ groups: [{ ...GROUP, enabled: false }] }), { client });
        m.running = true;
        m.lastIds = new Map();

        await m.poll();

        expect(client.getMessages).not.toHaveBeenCalled();
    });

    it('swallows a per-group fetch failure and keeps going', async () => {
        const second = { ...GROUP, id: '-1009999999999', name: 'Second' };
        let call = 0;
        const client = {
            getMessages: async () => {
                call++;
                if (call === 1) throw new Error('FLOOD_WAIT_30');
                return [photoMsg(3, '9999999999')];
            },
        };
        const { m, dl } = mk(baseConfig({ groups: [structuredClone(GROUP), second] }), { client });
        m.running = true;
        m.lastIds = new Map();

        await m.poll();

        expect(dl.enqueued).toHaveLength(1);
    });
});

describe('stop', () => {
    it('tears down timers, handlers and the downloader, then announces', async () => {
        const client = { removeEventHandler: vi.fn() };
        const { m, dl } = mk(baseConfig(), { client });
        m.running = true;
        m.handler = () => {};
        m.deleteHandler = () => {};
        m.handlerClients = [client];
        m.pollTimeout = setTimeout(() => {}, 60_000);
        m.urlFlushInterval = setInterval(() => {}, 60_000);

        const stopped = vi.fn();
        m.on('stopped', stopped);
        await m.stop();

        expect(m.running).toBe(false);
        expect(m.pollTimeout).toBeNull();
        expect(m.urlFlushInterval).toBeNull();
        expect(m._configWatcher).toBeNull();
        expect(client.removeEventHandler).toHaveBeenCalledTimes(2);
        expect(dl.stopped).toBe(1);
        expect(stopped).toHaveBeenCalledWith(m.stats);
    });

    it('flushes any buffered urls on the way out', async () => {
        const base = path.join(DATA_DIR, 'downloads-stop');
        const { m } = mk(baseConfig({ download: { path: base } }));
        await m.handleUrls({ message: 'https://last.example' }, m.config.groups[0]);
        m.urlFlushInterval = setInterval(() => {}, 60_000);

        await m.stop();
        expect(fs.readFileSync(path.join(base, 'My_Group', 'urls.txt'), 'utf8')).toMatch(
            /last\.example/,
        );
    });

    it('tolerates a client that refuses to unregister', async () => {
        const client = {
            removeEventHandler: () => {
                throw new Error('already disconnected');
            },
        };
        const { m } = mk(baseConfig(), { client });
        m.handler = () => {};
        m.handlerClients = [client];
        await expect(m.stop()).resolves.toBeUndefined();
    });
});
