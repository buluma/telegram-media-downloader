// Covers src/core/history.js — the batch backfill downloader: client
// discovery across accounts, the scan counters, smart-resume offset
// selection, the backpressure governor, comment backfill, per-message
// filtering and URL harvesting.
//
// gramJS is mocked (only `Api.*` message filters and the client interface are
// used, and both are trivially fakeable). core/db.js runs for real against an
// isolated TGDL_DATA_DIR — getMessageIdRange() is what drives smart resume, so
// a mocked DB would let the mode selection assert against itself.
//
// The client and downloader are already constructor-injected, so no seam had
// to be added to test this file.

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-history-'));

// gramJS message filters are marker objects — the code only ever passes them
// straight back to getMessages(), so identity is all that matters.
class FilterBase {
    constructor() {
        this.kind = this.constructor.name;
    }
}
vi.mock('telegram', () => ({
    Api: {
        InputMessagesFilterPhotos: class extends FilterBase {},
        InputMessagesFilterVideo: class extends FilterBase {},
        InputMessagesFilterDocument: class extends FilterBase {},
        InputMessagesFilterUrl: class extends FilterBase {},
        InputMessagesFilterVoice: class extends FilterBase {},
        InputMessagesFilterGif: class extends FilterBase {},
        channels: {
            GetFullChannel: class {
                constructor(args) {
                    Object.assign(this, args);
                }
            },
        },
    },
}));

let HistoryDownloader;
let dbApi;
let downloadsApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    ({ HistoryDownloader } = await import('../src/core/history.js'));
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
});

afterEach(() => {
    vi.useRealTimers();
});

// ---- doubles ------------------------------------------------------------

/** Minimal downloader: records enqueues, exposes the pendingCount the
 *  backpressure governor reads. */
class FakeDownloader extends EventEmitter {
    constructor({ pendingCount = 0, accept = true } = {}) {
        super();
        this.pendingCount = pendingCount;
        this.enqueued = [];
        this.started = 0;
        this._accept = accept;
    }
    start() {
        this.started++;
    }
    async enqueue(job, priority) {
        this.enqueued.push({ job, priority });
        return typeof this._accept === 'function' ? this._accept(job) : this._accept;
    }
}

function fakeClient({ messages = [], total = 0, getMessagesError = null, linkedId = null } = {}) {
    return {
        iterCalls: [],
        async getMessages(_gid, opts) {
            if (getMessagesError) throw getMessagesError;
            return Object.assign([], { total });
        },
        async *iterMessages(gid, opts) {
            this.iterCalls.push({ gid, opts });
            const list = typeof messages === 'function' ? messages(gid) : messages;
            for (const m of list) yield m;
        },
        async invoke() {
            return { fullChat: { linkedChatId: linkedId } };
        },
    };
}

const GROUP = {
    id: '-100123',
    name: 'My Group',
    filters: {},
};

function makeConfig(overrides = {}) {
    return {
        groups: [GROUP],
        download: { path: path.join(DATA_DIR, 'downloads') },
        // Disable the human-like breaks by default — they are covered
        // explicitly and would otherwise add real seconds to every test.
        advanced: { history: { shortBreakEveryN: 0, longBreakEveryN: 0 } },
        ...overrides,
    };
}

function photoMsg(id, extra = {}) {
    return { id, photo: {}, date: 1700000000, ...extra };
}

// ---- client discovery ---------------------------------------------------

describe('discoverClientForGroup', () => {
    it('returns the constructor client when no AccountManager is wired', async () => {
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());
        expect(await h.discoverClientForGroup('-100123')).toBe(client);
    });

    it('returns the first account that can read the group', async () => {
        const bad = { getMessages: async () => throwIt('CHANNEL_PRIVATE') };
        const good = fakeClient();
        const accountManager = {
            clients: new Map([
                ['a', bad],
                ['b', good],
            ]),
        };
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig(), accountManager);
        expect(await h.discoverClientForGroup('-100123')).toBe(good);
    });

    it('returns null when no account can read the group', async () => {
        const bad = () => ({ getMessages: async () => throwIt('CHANNEL_PRIVATE') });
        const accountManager = {
            clients: new Map([
                ['a', bad()],
                ['b', bad()],
            ]),
        };
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig(), accountManager);
        expect(await h.discoverClientForGroup('-100123')).toBeNull();
    });
});

function throwIt(msg) {
    throw new Error(msg);
}

// ---- _describeAccount ---------------------------------------------------

describe('_describeAccount', () => {
    it('returns nulls when no AccountManager is wired', () => {
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig());
        expect(h._describeAccount({})).toEqual({ accountId: null, accountName: null });
    });

    it('prefers name, then username, then phone, then #id', () => {
        const client = {};
        const mk = (meta) =>
            new HistoryDownloader(null, new FakeDownloader(), makeConfig(), {
                getIdForClient: () => 'acc1',
                metadata: new Map([['acc1', meta]]),
            });

        expect(mk({ name: 'Ada', username: 'ada', phone: '+1' })._describeAccount(client)).toEqual({
            accountId: 'acc1',
            accountName: 'Ada',
        });
        expect(mk({ username: 'ada', phone: '+1' })._describeAccount(client).accountName).toBe(
            'ada',
        );
        expect(mk({ phone: '+1' })._describeAccount(client).accountName).toBe('+1');
        expect(mk({})._describeAccount(client).accountName).toBe('#acc1');
    });

    it('returns nulls when the client is not in the registry', () => {
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig(), {
            getIdForClient: () => null,
            metadata: new Map(),
        });
        expect(h._describeAccount({})).toEqual({ accountId: null, accountName: null });
    });
});

// ---- scan ---------------------------------------------------------------

describe('scan', () => {
    it('counts each media class and totals them', async () => {
        const client = fakeClient({ total: 7 });
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());
        const counts = await h.scan('-100123');

        expect(counts.photos).toBe(7);
        expect(counts.videos).toBe(7);
        expect(counts.files).toBe(7);
        expect(counts.links).toBe(7);
        expect(counts.voice).toBe(7);
        expect(counts.gifs).toBe(7);
        expect(counts.total).toBe(42);
    });

    it('counts a failing filter as zero rather than failing the scan', async () => {
        let call = 0;
        const client = {
            async getMessages() {
                call++;
                if (call === 2) throw new Error('FILTER_UNSUPPORTED');
                return Object.assign([], { total: 3 });
            },
        };
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());
        const counts = await h.scan('-100123');
        expect(counts.total).toBe(15); // five filters at 3, one at 0
    });

    it('returns zeroes when no account can reach the group', async () => {
        const accountManager = { clients: new Map() };
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig(), accountManager);
        const counts = await h.scan('-100123');
        expect(counts).toEqual({
            photos: 0,
            videos: 0,
            files: 0,
            links: 0,
            voice: 0,
            gifs: 0,
            total: 0,
        });
    });
});

// ---- smart resume -------------------------------------------------------

describe('downloadHistory — smart resume offsets', () => {
    function seedRows(groupId, ids) {
        for (const id of ids) {
            downloadsApi.insertDownload({
                groupId: String(groupId),
                groupName: 'My Group',
                messageId: id,
                fileName: `f${id}.jpg`,
                fileType: 'photos',
                filePath: `My Group/photos/f${id}.jpg`,
            });
        }
    }

    it('pull-older walks strictly older than the oldest stored id', async () => {
        seedRows('-100123', [500, 900]);
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());

        const start = vi.fn();
        h.on('start', start);
        await h.downloadHistory('-100123');

        expect(client.iterCalls[0].opts.maxId).toBe(500);
        expect(client.iterCalls[0].opts.minId).toBeUndefined();
        expect(start.mock.calls[0][0].mode).toBe('pull-older');
    });

    it('catch-up walks strictly newer than the newest stored id', async () => {
        seedRows('-100123', [500, 900]);
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());

        await h.downloadHistory('-100123', { mode: 'catch-up' });

        expect(client.iterCalls[0].opts.minId).toBe(900);
        expect(client.iterCalls[0].opts.maxId).toBeUndefined();
    });

    it('a first-time backfill passes no offset at all', async () => {
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());

        const start = vi.fn();
        h.on('start', start);
        await h.downloadHistory('-100123');

        expect(client.iterCalls[0].opts.maxId).toBeUndefined();
        expect(client.iterCalls[0].opts.minId).toBeUndefined();
        expect(start.mock.calls[0][0].offsetId).toBe(0);
    });

    it('an explicit offsetId forces rescan mode and is passed verbatim', async () => {
        seedRows('-100123', [500, 900]);
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());

        const start = vi.fn();
        h.on('start', start);
        await h.downloadHistory('-100123', { offsetId: 777 });

        expect(start.mock.calls[0][0].mode).toBe('rescan');
        expect(client.iterCalls[0].opts.maxId).toBe(777);
        expect(client.iterCalls[0].opts.offsetId).toBe(777);
    });

    it('mode=rescan without an offset ignores the stored range', async () => {
        seedRows('-100123', [500, 900]);
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());

        await h.downloadHistory('-100123', { mode: 'rescan' });

        expect(client.iterCalls[0].opts.maxId).toBeUndefined();
        expect(client.iterCalls[0].opts.minId).toBeUndefined();
    });

    it("reports limit as 'all' when unlimited, and iterates with limit undefined", async () => {
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());

        const start = vi.fn();
        h.on('start', start);
        await h.downloadHistory('-100123', { limit: 0 });

        expect(start.mock.calls[0][0].limit).toBe('all');
        expect(client.iterCalls[0].opts.limit).toBeUndefined();
    });

    it('passes a positive limit straight through', async () => {
        const client = fakeClient();
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());
        await h.downloadHistory('-100123', { limit: 25 });
        expect(client.iterCalls[0].opts.limit).toBe(25);
    });
});

// ---- downloadHistory lifecycle -----------------------------------------

describe('downloadHistory — lifecycle', () => {
    it('throws when the group has no config entry', async () => {
        const h = new HistoryDownloader(fakeClient(), new FakeDownloader(), makeConfig());
        await expect(h.downloadHistory('-100999')).rejects.toThrow(/group config not found/i);
    });

    it('starts the downloader workers and emits complete with the last id', async () => {
        const dl = new FakeDownloader();
        const client = fakeClient({ messages: [photoMsg(11), photoMsg(12)] });
        const h = new HistoryDownloader(client, dl, makeConfig());

        const complete = vi.fn();
        h.on('complete', complete);
        await h.downloadHistory('-100123');

        expect(dl.started).toBe(1);
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                processed: 2,
                downloaded: 2,
                lastMessageId: 12,
                cancelled: false,
            }),
        );
        expect(h.running).toBe(false);
    });

    it('re-throws so the caller’s promise rejects, and still emits complete', async () => {
        // Regression: the dashboard used to flash a green "Done" pill on
        // failure because this path emitted `error` but returned normally.
        const accountManager = { clients: new Map() };
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig(), accountManager);

        const onError = vi.fn();
        const onComplete = vi.fn();
        h.on('error', onError);
        h.on('complete', onComplete);

        await expect(h.downloadHistory('-100123')).rejects.toThrow(/no available account/i);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(h.running).toBe(false);
    });

    it('cancel() stops mid-iteration and marks the run cancelled', async () => {
        const dl = new FakeDownloader();
        const many = Array.from({ length: 50 }, (_, i) => photoMsg(i + 1));
        const client = fakeClient({ messages: many });
        const h = new HistoryDownloader(client, dl, makeConfig());

        h.on('progress', (s) => {
            if (s.processed === 3) h.cancel();
        });

        const complete = vi.fn();
        h.on('complete', complete);
        await h.downloadHistory('-100123');

        expect(complete.mock.calls[0][0].cancelled).toBe(true);
        expect(complete.mock.calls[0][0].processed).toBeLessThan(50);
    });

    it('cancel() emits a log line and is idempotent', () => {
        const h = new HistoryDownloader(fakeClient(), new FakeDownloader(), makeConfig());
        const log = vi.fn();
        h.on('log', log);
        h.cancel();
        h.cancel();
        expect(h.cancelFlag).toBe(true);
        expect(h.running).toBe(false);
        expect(log).toHaveBeenCalledTimes(2);
    });

    it('resets stats between runs', async () => {
        const client = fakeClient({ messages: [photoMsg(1)] });
        const h = new HistoryDownloader(client, new FakeDownloader(), makeConfig());
        await h.downloadHistory('-100123');
        expect(h.stats.processed).toBe(1);
        await h.downloadHistory('-100123');
        expect(h.stats.processed).toBe(1);
    });
});

// ---- backpressure -------------------------------------------------------

describe('downloadHistory — backpressure governor', () => {
    it('waits while the queue is over cap, and resumes once it drains', async () => {
        vi.useFakeTimers();
        const dl = new FakeDownloader({ pendingCount: 100 });
        const client = fakeClient({ messages: [photoMsg(1), photoMsg(2)] });
        const cfg = makeConfig({
            advanced: {
                history: { backpressureCap: 10, shortBreakEveryN: 0, longBreakEveryN: 0 },
            },
        });
        const h = new HistoryDownloader(client, dl, cfg);

        const run = h.downloadHistory('-100123');
        await vi.advanceTimersByTimeAsync(3000);
        expect(dl.enqueued).toHaveLength(0); // still parked

        dl.pendingCount = 0;
        await vi.advanceTimersByTimeAsync(2000);
        await run;

        expect(dl.enqueued).toHaveLength(2);
    });

    it('emits `stalled` at the halfway mark when nothing drains', async () => {
        vi.useFakeTimers();
        const dl = new FakeDownloader({ pendingCount: 100 });
        const client = fakeClient({ messages: [photoMsg(1)] });
        const cfg = makeConfig({
            advanced: {
                history: {
                    backpressureCap: 10,
                    backpressureMaxWaitMs: 10_000,
                    shortBreakEveryN: 0,
                    longBreakEveryN: 0,
                },
            },
        });
        const h = new HistoryDownloader(client, dl, cfg);
        const stalled = vi.fn();
        h.on('stalled', stalled);
        h.on('error', () => {});

        const run = h.downloadHistory('-100123').catch(() => {});
        await vi.advanceTimersByTimeAsync(6000);

        expect(stalled).toHaveBeenCalledWith(expect.objectContaining({ pending: 100, cap: 10 }));
        await vi.advanceTimersByTimeAsync(10_000);
        await run;
    });

    it('aborts the run when no progress happens inside the window', async () => {
        vi.useFakeTimers();
        const dl = new FakeDownloader({ pendingCount: 100 });
        const client = fakeClient({ messages: [photoMsg(1)] });
        const cfg = makeConfig({
            advanced: {
                history: {
                    backpressureCap: 10,
                    backpressureMaxWaitMs: 5000,
                    shortBreakEveryN: 0,
                    longBreakEveryN: 0,
                },
            },
        });
        const h = new HistoryDownloader(client, dl, cfg);
        h.on('error', () => {});

        const run = h.downloadHistory('-100123');
        const assertion = expect(run).rejects.toThrow(/made no progress/i);
        await vi.advanceTimersByTimeAsync(20_000);
        await assertion;
    });

    it('a `complete` event from the downloader counts as forward progress', async () => {
        vi.useFakeTimers();
        const dl = new FakeDownloader({ pendingCount: 100 });
        const client = fakeClient({ messages: [photoMsg(1)] });
        const cfg = makeConfig({
            advanced: {
                history: {
                    backpressureCap: 10,
                    backpressureMaxWaitMs: 5000,
                    shortBreakEveryN: 0,
                    longBreakEveryN: 0,
                },
            },
        });
        const h = new HistoryDownloader(client, dl, cfg);
        h.on('error', () => {});

        const run = h.downloadHistory('-100123');
        // Keep nudging the progress clock so the abort never fires.
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(3000);
            dl.emit('complete');
        }
        dl.pendingCount = 0;
        await vi.advanceTimersByTimeAsync(2000);
        await run;

        expect(dl.enqueued).toHaveLength(1);
    });

    it('a cancel breaks out of the backpressure wait', async () => {
        vi.useFakeTimers();
        const dl = new FakeDownloader({ pendingCount: 100 });
        const client = fakeClient({ messages: [photoMsg(1), photoMsg(2)] });
        const cfg = makeConfig({
            advanced: {
                history: { backpressureCap: 10, shortBreakEveryN: 0, longBreakEveryN: 0 },
            },
        });
        const h = new HistoryDownloader(client, dl, cfg);

        const run = h.downloadHistory('-100123');
        await vi.advanceTimersByTimeAsync(2000);
        h.cancel();
        await vi.advanceTimersByTimeAsync(2000);
        await run;

        expect(h.stats.processed).toBeLessThan(2);
    });
});

// ---- comment backfill ---------------------------------------------------

describe('downloadHistory — comment backfill', () => {
    it('walks the linked discussion chat under a namespaced group id', async () => {
        const dl = new FakeDownloader();
        const client = {
            iterCalls: [],
            async *iterMessages(gid, opts) {
                this.iterCalls.push({ gid, opts });
                if (gid === '-100123') yield photoMsg(1);
                else yield photoMsg(90);
            },
            async invoke() {
                return { fullChat: { linkedChatId: '-100999' } };
            },
        };
        const cfg = makeConfig({ groups: [{ ...GROUP, trackComments: true }] });
        const h = new HistoryDownloader(client, dl, cfg);

        await h.downloadHistory('-100123');

        expect(client.iterCalls.map((c) => c.gid)).toEqual(['-100123', '-100999']);
        expect(dl.enqueued.map((e) => e.job.groupId)).toEqual(['-100123', 'comment:-100123']);
        expect(dl.enqueued[1].job.groupName).toBe('My Group (comments)');
    });

    it('is skipped entirely when trackComments is off', async () => {
        const dl = new FakeDownloader();
        const client = fakeClient({ messages: [photoMsg(1)], linkedId: '-100999' });
        const h = new HistoryDownloader(client, dl, makeConfig());
        await h.downloadHistory('-100123');
        expect(client.iterCalls).toHaveLength(1);
    });

    it('tolerates a group with no linked chat', async () => {
        const dl = new FakeDownloader();
        const client = fakeClient({ messages: [photoMsg(1)], linkedId: null });
        const cfg = makeConfig({ groups: [{ ...GROUP, trackComments: true }] });
        const h = new HistoryDownloader(client, dl, cfg);
        await expect(h.downloadHistory('-100123')).resolves.toBeUndefined();
    });

    it('tolerates GetFullChannel throwing', async () => {
        const dl = new FakeDownloader();
        const client = {
            iterCalls: [],
            async *iterMessages(gid, opts) {
                this.iterCalls.push({ gid, opts });
                yield photoMsg(1);
            },
            async invoke() {
                throw new Error('CHANNEL_INVALID');
            },
        };
        const cfg = makeConfig({ groups: [{ ...GROUP, trackComments: true }] });
        const h = new HistoryDownloader(client, dl, cfg);
        await expect(h.downloadHistory('-100123')).resolves.toBeUndefined();
    });

    it('is skipped when the main pass was cancelled', async () => {
        const dl = new FakeDownloader();
        const client = {
            iterCalls: [],
            async *iterMessages(gid) {
                this.iterCalls.push({ gid });
                yield photoMsg(1);
                yield photoMsg(2);
            },
            async invoke() {
                return { fullChat: { linkedChatId: '-100999' } };
            },
        };
        const cfg = makeConfig({ groups: [{ ...GROUP, trackComments: true }] });
        const h = new HistoryDownloader(client, dl, cfg);
        h.on('progress', () => h.cancel());

        await h.downloadHistory('-100123');
        expect(client.iterCalls.map((c) => c.gid)).toEqual(['-100123']);
    });
});

// ---- processMessage -----------------------------------------------------

describe('processMessage', () => {
    function mk(groupOverrides = {}, dl = new FakeDownloader()) {
        const h = new HistoryDownloader(fakeClient(), dl, makeConfig());
        return { h, dl, group: { ...GROUP, ...groupOverrides } };
    }

    it('enqueues media at priority 2, below realtime', async () => {
        const { h, dl, group } = mk();
        await h.processMessage(photoMsg(1), group);
        expect(dl.enqueued).toHaveLength(1);
        expect(dl.enqueued[0].priority).toBe(2);
        expect(h.stats.downloaded).toBe(1);
    });

    it('counts a rejected enqueue as skipped, not downloaded', async () => {
        const dl = new FakeDownloader({ accept: false });
        const { h, group } = mk({}, dl);
        await h.processMessage(photoMsg(1), group);
        expect(h.stats.downloaded).toBe(0);
        expect(h.stats.skipped).toBe(1);
    });

    it('skips a media type the group filter disables', async () => {
        const { h, dl, group } = mk({ filters: { photos: false } });
        await h.processMessage(photoMsg(1), group);
        expect(dl.enqueued).toHaveLength(0);
        expect(h.stats.skipped).toBe(1);
    });

    it('treats an undefined filter as allowed', async () => {
        const { h, dl, group } = mk({ filters: { videos: false } });
        await h.processMessage(photoMsg(1), group);
        expect(dl.enqueued).toHaveLength(1);
    });

    it('ignores a message with no media', async () => {
        const { h, dl, group } = mk();
        await h.processMessage({ id: 1, message: 'just text' }, group);
        expect(dl.enqueued).toHaveLength(0);
        expect(h.stats.skipped).toBe(0);
    });

    it('pins the walking client onto the job so bytes flow through one session', async () => {
        const { h, dl, group } = mk();
        const walker = { tag: 'walker' };
        await h.processMessage(photoMsg(1), group, walker);
        expect(dl.enqueued[0].job.client).toBe(walker);
    });

    it('falls back to the message client when none is passed', async () => {
        const { h, dl, group } = mk();
        const owner = { tag: 'owner' };
        await h.processMessage({ ...photoMsg(1), _client: owner }, group);
        expect(dl.enqueued[0].job.client).toBe(owner);
    });
});

// ---- filters ------------------------------------------------------------

describe('passUserFilter', () => {
    const h = () => new HistoryDownloader(null, new FakeDownloader(), makeConfig());

    it('passes everything when tracking is disabled or mode is all', () => {
        expect(h().passUserFilter({ senderId: 5 }, { trackUsers: { enabled: false } })).toBe(true);
        expect(
            h().passUserFilter({ senderId: 5 }, { trackUsers: { enabled: true, mode: 'all' } }),
        ).toBe(true);
    });

    it('whitelist admits tracked senders only', () => {
        const group = {
            trackUsers: { enabled: true, mode: 'whitelist', users: [{ id: 7 }] },
        };
        expect(h().passUserFilter({ senderId: 7 }, group)).toBe(true);
        expect(h().passUserFilter({ senderId: 8 }, group)).toBe(false);
    });

    it('blacklist rejects tracked senders only', () => {
        const group = {
            trackUsers: { enabled: true, mode: 'blacklist', users: [{ id: 7 }] },
        };
        expect(h().passUserFilter({ senderId: 7 }, group)).toBe(false);
        expect(h().passUserFilter({ senderId: 8 }, group)).toBe(true);
    });

    it('matches on username as well as id', () => {
        const group = {
            trackUsers: { enabled: true, mode: 'whitelist', users: [{ username: 'ada' }] },
        };
        expect(h().passUserFilter({ senderId: 1, sender: { username: 'ada' } }, group)).toBe(true);
    });

    it('honours the global tracked-user list', () => {
        const hh = new HistoryDownloader(
            null,
            new FakeDownloader(),
            makeConfig({ globalTrackedUsers: [{ id: 9 }] }),
        );
        const group = { trackUsers: { enabled: true, mode: 'whitelist', users: [] } };
        expect(hh.passUserFilter({ senderId: 9 }, group)).toBe(true);
    });

    it('passes for an unknown mode', () => {
        const group = { trackUsers: { enabled: true, mode: 'weird', users: [] } };
        expect(h().passUserFilter({ senderId: 1 }, group)).toBe(true);
    });
});

describe('passTopicFilter', () => {
    const h = () => new HistoryDownloader(null, new FakeDownloader(), makeConfig());

    it('passes when topics are disabled or the message is not in a topic', () => {
        expect(h().passTopicFilter({}, { topics: { enabled: false } })).toBe(true);
        expect(h().passTopicFilter({}, { topics: { enabled: true, ids: [] } })).toBe(true);
        expect(
            h().passTopicFilter({ replyTo: { forumTopic: false } }, { topics: { enabled: true } }),
        ).toBe(true);
    });

    it('whitelist admits only listed topics', () => {
        const group = { topics: { enabled: true, mode: 'whitelist', ids: [5] } };
        const inTopic = (id) => ({ replyTo: { forumTopic: true, replyToMsgId: id } });
        expect(h().passTopicFilter(inTopic(5), group)).toBe(true);
        expect(h().passTopicFilter(inTopic(6), group)).toBe(false);
    });

    it('blacklist rejects only listed topics', () => {
        const group = { topics: { enabled: true, mode: 'blacklist', ids: [5] } };
        const inTopic = (id) => ({ replyTo: { forumTopic: true, replyToMsgId: id } });
        expect(h().passTopicFilter(inTopic(5), group)).toBe(false);
        expect(h().passTopicFilter(inTopic(6), group)).toBe(true);
    });
});

describe('hasMedia / getMediaType', () => {
    const h = () => new HistoryDownloader(null, new FakeDownloader(), makeConfig());

    it('detects every media carrier', () => {
        for (const key of [
            'photo',
            'video',
            'document',
            'audio',
            'voice',
            'sticker',
            'videoNote',
            'gif',
        ]) {
            expect(h().hasMedia({ [key]: {} }), key).toBe(true);
        }
        expect(h().hasMedia({ message: 'text' })).toBe(false);
    });

    it('classifies by carrier first', () => {
        expect(h().getMediaType({ photo: {} })).toBe('photos');
        expect(h().getMediaType({ video: {} })).toBe('videos');
        expect(h().getMediaType({ videoNote: {} })).toBe('videos');
        expect(h().getMediaType({ voice: {} })).toBe('voice');
        expect(h().getMediaType({ audio: {} })).toBe('audio');
    });

    it('treats an animated video as a gif', () => {
        expect(h().getMediaType({ video: {}, gif: {} })).toBe('gifs');
        expect(h().getMediaType({ video: {}, document: { mimeType: 'image/gif' } })).toBe('gifs');
    });

    it('falls back to the document mime type', () => {
        const t = (mimeType) => h().getMediaType({ document: { mimeType } });
        expect(t('image/gif')).toBe('gifs');
        expect(t('video/mp4')).toBe('videos');
        expect(t('image/png')).toBe('photos');
        expect(t('audio/mpeg')).toBe('audio');
        expect(t('application/pdf')).toBe('files');
        expect(t(undefined)).toBe('files');
    });

    it('defaults to files for anything unrecognised', () => {
        expect(h().getMediaType({ sticker: {} })).toBe('files');
    });
});

// ---- URL harvesting -----------------------------------------------------

describe('handleUrls', () => {
    function mk() {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-urls-'));
        const h = new HistoryDownloader(
            null,
            new FakeDownloader(),
            makeConfig({ download: { path: base } }),
        );
        return { h, base };
    }

    it('appends every url with the message date, and counts them', async () => {
        const { h, base } = mk();
        await h.handleUrls(
            { message: 'see https://a.example and http://b.example/x', date: 1700000000 },
            GROUP,
        );

        const file = path.join(base, 'My Group', 'urls.txt');
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^\[2023-11-14\] https:\/\/a\.example$/);
        expect(h.stats.urls).toBe(2);
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('appends across calls rather than overwriting', async () => {
        const { h, base } = mk();
        const msg = (u) => ({ message: u, date: 1700000000 });
        await h.handleUrls(msg('https://one.example'), GROUP);
        await h.handleUrls(msg('https://two.example'), GROUP);

        const file = path.join(base, 'My Group', 'urls.txt');
        expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('does nothing for a message with no urls', async () => {
        const { h, base } = mk();
        await h.handleUrls({ message: 'no links here', date: 1700000000 }, GROUP);
        expect(fs.existsSync(path.join(base, 'My Group'))).toBe(false);
        expect(h.stats.urls).toBe(0);
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('is skipped when the group disables url capture', async () => {
        const { h, base } = mk();
        await h.processMessage(
            { id: 1, message: 'https://a.example', date: 1700000000 },
            { ...GROUP, filters: { urls: false } },
        );
        expect(h.stats.urls).toBe(0);
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('swallows a write failure instead of failing the backfill', async () => {
        const h = new HistoryDownloader(
            null,
            new FakeDownloader(),
            makeConfig({ download: { path: unwritablePath() } }),
        );
        await expect(
            h.handleUrls({ message: 'https://a.example', date: 1700000000 }, GROUP),
        ).resolves.toBeUndefined();
        expect(h.stats.urls).toBe(0);
    });
});

describe('sanitize', () => {
    it('strips path-hostile characters and caps the length', () => {
        const h = new HistoryDownloader(null, new FakeDownloader(), makeConfig());
        expect(h.sanitize('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
        expect(h.sanitize('x'.repeat(200))).toHaveLength(80);
    });
});

// ---- human-like breaks --------------------------------------------------

describe('downloadHistory — human-like breaks', () => {
    it('takes a short break on the configured cadence', async () => {
        vi.useFakeTimers();
        const client = fakeClient({ messages: [photoMsg(1), photoMsg(2), photoMsg(3)] });
        const cfg = makeConfig({
            advanced: { history: { shortBreakEveryN: 2, longBreakEveryN: 0 } },
        });
        const h = new HistoryDownloader(client, new FakeDownloader(), cfg);

        const run = h.downloadHistory('-100123');
        await vi.advanceTimersByTimeAsync(20_000);
        await run;

        expect(h.stats.processed).toBe(3);
    });

    it('setting both cadences to 0 disables the breaks entirely', async () => {
        // No fake timers: if a break fired, this test would hang for 60s+.
        const many = Array.from({ length: 120 }, (_, i) => photoMsg(i + 1));
        const client = fakeClient({ messages: many });
        const cfg = makeConfig({
            advanced: { history: { shortBreakEveryN: 0, longBreakEveryN: 0 } },
        });
        const h = new HistoryDownloader(client, new FakeDownloader(), cfg);

        await h.downloadHistory('-100123');
        expect(h.stats.processed).toBe(120);
    });
});
