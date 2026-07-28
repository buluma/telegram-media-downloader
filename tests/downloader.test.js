// Covers src/core/downloader.js's DownloadManager — everything around the
// actual byte transfer: gramJS media introspection (input locations, sizes,
// extensions, tg file ids), the on-disk path builder, worker pool scaling and
// throttling, the retry/snapshot/status surface, and the disk-usage cache.
//
// tests/downloader-utils.test.js already covers the exported `sanitizeName`;
// this file starts at the class.
//
// `telegram` is mocked — only `Api.*` marker classes and the client interface
// are used here, and the real package opens MTProto sockets on import. Real:
// core/db.js against an isolated TGDL_DATA_DIR (isDownloaded and the disk
// totals are genuine SQL), and the filesystem, so buildPath really creates
// directories.
//
// download() and registerDownload() are NOT covered here. Between them they
// are ~600 lines that stream bytes from Telegram, sniff media, dedup by hash,
// and fan out to thumbs/nsfw/faststart — a fixture surface of its own, and
// bolting it onto this file would make both halves worse.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-downloader-'));

// gramJS input-location classes are constructed and handed straight back to
// the client, so recording the args is the whole contract.
class FakeInputDocumentFileLocation {
    constructor(args) {
        Object.assign(this, args);
        this.className = 'InputDocumentFileLocation';
    }
}
class FakeInputPhotoFileLocation {
    constructor(args) {
        Object.assign(this, args);
        this.className = 'InputPhotoFileLocation';
    }
}
class FakeMessageMediaWebPage {}
class FakeMessageMediaPhoto {}
class FakeMessageMediaDocument {}
class FakePhoto {}
class FakeDocument {}

vi.mock('telegram', () => ({
    Api: {
        InputDocumentFileLocation: FakeInputDocumentFileLocation,
        InputPhotoFileLocation: FakeInputPhotoFileLocation,
        MessageMediaWebPage: FakeMessageMediaWebPage,
        MessageMediaPhoto: FakeMessageMediaPhoto,
        MessageMediaDocument: FakeMessageMediaDocument,
        Photo: FakePhoto,
        Document: FakeDocument,
    },
}));

let DownloadManager;
let dbApi;
let downloadsApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    ({ DownloadManager } = await import('../src/core/downloader.js'));
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

const _live = [];
afterEach(async () => {
    for (const dm of _live.splice(0)) {
        try {
            await dm.stop();
        } catch {
            /* already stopped */
        }
    }
    vi.useRealTimers();
});

// ---- harness ------------------------------------------------------------

function mk(configOverrides = {}) {
    const config = {
        download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 4 },
        ...configOverrides,
    };
    const dm = new DownloadManager({ tag: 'client' }, config, null);
    _live.push(dm);
    return dm;
}

const docMsg = (over = {}) => ({
    id: 1,
    date: 1700000000,
    document: { id: '111', accessHash: '222', size: 2048, attributes: [], ...over.document },
    ...over,
});

const photoMsg = (over = {}) => ({
    id: 2,
    date: 1700000000,
    photo: { id: '333', accessHash: '444', sizes: [{ size: 100 }, { size: 900 }], ...over.photo },
    ...over,
});

// ---- input location -----------------------------------------------------

describe('getInputLocation', () => {
    it('returns null for a message with no media', () => {
        const dm = mk();
        expect(dm.getInputLocation(null)).toBeNull();
        expect(dm.getInputLocation('nope')).toBeNull();
        expect(dm.getInputLocation({ id: 1 })).toBeNull();
    });

    it('builds a document location from the top-level document', () => {
        const dm = mk();
        const loc = dm.getInputLocation(docMsg());
        expect(loc.className).toBe('InputDocumentFileLocation');
        expect(loc.id).toBe('111');
        expect(loc.accessHash).toBe('222');
        expect(loc.thumbSize).toBe('');
    });

    it('finds a document nested under media', () => {
        const dm = mk();
        const loc = dm.getInputLocation({ media: { document: { id: 'd', accessHash: 'h' } } });
        expect(loc.className).toBe('InputDocumentFileLocation');
        expect(loc.id).toBe('d');
    });

    it('finds a document behind a webpage preview', () => {
        const dm = mk();
        const loc = dm.getInputLocation({
            media: { webpage: { document: { id: 'w', accessHash: 'h' } } },
        });
        expect(loc.id).toBe('w');
    });

    it('substitutes an empty buffer for a missing fileReference', () => {
        const dm = mk();
        const loc = dm.getInputLocation({ document: { id: 'd', accessHash: 'h' } });
        expect(Buffer.isBuffer(loc.fileReference)).toBe(true);
        expect(loc.fileReference).toHaveLength(0);
    });

    it('builds a photo location and asks for the largest size', () => {
        const dm = mk();
        const loc = dm.getInputLocation(photoMsg());
        expect(loc.className).toBe('InputPhotoFileLocation');
        expect(loc.id).toBe('333');
        expect(loc.thumbSize).toBe('y');
    });

    it('prefers a document over a photo on the same message', () => {
        const dm = mk();
        const loc = dm.getInputLocation({ ...docMsg(), ...photoMsg() });
        expect(loc.className).toBe('InputDocumentFileLocation');
    });
});

// ---- media introspection ------------------------------------------------

describe('media introspection', () => {
    it('getFileSize reads a document size and the largest photo size', () => {
        const dm = mk();
        expect(dm.getFileSize(docMsg())).toBe(2048);
        expect(dm.getFileSize(photoMsg())).toBe(900);
        expect(dm.getFileSize({ photo: { sizes: [] } })).toBe(0);
        expect(dm.getFileSize(null)).toBe(0);
        expect(dm.getFileSize({ id: 1 })).toBe(0);
    });

    it('getFileTypeCategory maps each carrier', () => {
        const dm = mk();
        expect(dm.getFileTypeCategory({ photo: {} })).toBe('image');
        expect(dm.getFileTypeCategory({ video: {} })).toBe('video');
        expect(dm.getFileTypeCategory({ voice: {} })).toBe('audio');
        expect(dm.getFileTypeCategory({ audio: {} })).toBe('audio');
        expect(dm.getFileTypeCategory({ document: {} })).toBe('document');
        expect(dm.getFileTypeCategory({ id: 1 })).toBeNull();
        expect(dm.getFileTypeCategory(null)).toBeNull();
    });

    it('getExtension prefers the carrier, then the document filename', () => {
        const dm = mk();
        expect(dm.getExtension({ photo: {} })).toBe('.jpg');
        expect(dm.getExtension({ video: {} })).toBe('.mp4');
        expect(dm.getExtension({ voice: {} })).toBe('.ogg');
        expect(dm.getExtension({ audio: {} })).toBe('.mp3');
        expect(dm.getExtension({ videoNote: {} })).toBe('.mp4');
        expect(dm.getExtension({ sticker: {} })).toBe('.webp');
        expect(dm.getExtension({ document: { attributes: [{ fileName: 'report.pdf' }] } })).toBe(
            '.pdf',
        );
    });

    it('getExtension falls back to .bin', () => {
        const dm = mk();
        expect(dm.getExtension(null)).toBe('.bin');
        expect(dm.getExtension({ id: 1 })).toBe('.bin');
        expect(dm.getExtension({ document: { attributes: [] } })).toBe('.bin');
        expect(dm.getExtension({ document: { attributes: [{ fileName: 'noext' }] } })).toBe('.bin');
    });

    it('_getOriginalFilename reads the first filename attribute', () => {
        const dm = mk();
        expect(dm._getOriginalFilename({ document: { attributes: [{ fileName: 'a.zip' }] } })).toBe(
            'a.zip',
        );
        expect(
            dm._getOriginalFilename({
                media: { document: { attributes: [{ fileName: 'b.zip' }] } },
            }),
        ).toBe('b.zip');
        expect(dm._getOriginalFilename({ document: { attributes: [] } })).toBeNull();
        expect(dm._getOriginalFilename({ photo: {} })).toBeNull();
        expect(dm._getOriginalFilename(null)).toBeNull();
    });

    it('_getVideoDurationSec reads the video attribute only', () => {
        const dm = mk();
        const withDuration = {
            document: { attributes: [{ className: 'DocumentAttributeVideo', duration: 42 }] },
        };
        expect(dm._getVideoDurationSec(withDuration)).toBe(42);
        expect(
            dm._getVideoDurationSec({
                document: { attributes: [{ className: 'DocumentAttributeAudio', duration: 9 }] },
            }),
        ).toBeNull();
        expect(dm._getVideoDurationSec({ document: { attributes: [] } })).toBeNull();
        expect(dm._getVideoDurationSec(null)).toBeNull();
    });

    it('_getTgFileId is the stable identity across reposts', () => {
        const dm = mk();
        expect(dm._getTgFileId(docMsg())).toBe('111');
        expect(dm._getTgFileId(photoMsg())).toBe('333');
        expect(dm._getTgFileId({ media: { document: { id: 7 } } })).toBe('7');
        expect(dm._getTgFileId({ id: 1 })).toBeNull();
        expect(dm._getTgFileId(null)).toBeNull();
    });

    it('describeDownloadableMedia recognises what can be fetched', () => {
        const dm = mk();
        expect(dm.describeDownloadableMedia(photoMsg()).downloadable).toBe(true);
        expect(dm.describeDownloadableMedia(docMsg()).downloadable).toBe(true);
        expect(
            dm.describeDownloadableMedia({ media: { className: 'MessageMediaDocument' } })
                .downloadable,
        ).toBe(true);
        expect(
            dm.describeDownloadableMedia({ media: { className: 'MessageMediaPoll' } }).downloadable,
        ).toBe(false);
        expect(dm.describeDownloadableMedia({}).downloadable).toBe(false);
    });

    it('describeDownloadableMedia unwraps a webpage preview and names the mime', () => {
        const dm = mk();
        const out = dm.describeDownloadableMedia({
            media: {
                className: 'MessageMediaWebPage',
                webpage: { document: { className: 'Document', mimeType: 'video/mp4' } },
            },
        });
        expect(out.downloadable).toBe(true);
        expect(out.description).toContain('MessageMediaWebPage->Document');
        expect(out.description).toContain('mime=video/mp4');
    });
});

// ---- keys ---------------------------------------------------------------

describe('generateKey', () => {
    it('prefers the channel id, then chat, then user, then chatId', () => {
        const dm = mk();
        expect(dm.generateKey({ id: 5, peerId: { channelId: 100 } })).toEqual({
            key: '100_5',
            groupId: '100',
        });
        expect(dm.generateKey({ id: 5, peerId: { chatId: 200 } }).groupId).toBe('200');
        expect(dm.generateKey({ id: 5, peerId: { userId: 300 } }).groupId).toBe('300');
        expect(dm.generateKey({ id: 5, chatId: 400 }).groupId).toBe('400');
    });

    it('falls back to "unknown" when nothing identifies the chat', () => {
        const dm = mk();
        expect(dm.generateKey({ id: 5 })).toEqual({ key: 'unknown_5', groupId: 'unknown' });
    });
});

describe('isDownloaded', () => {
    it('reflects real rows in the database', () => {
        const dm = mk();
        expect(dm.isDownloaded('-100123', 77)).toBeFalsy();
        downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'G',
            messageId: 77,
            fileName: 'a.jpg',
            fileType: 'photos',
            filePath: 'G/images/a.jpg',
        });
        expect(dm.isDownloaded('-100123', 77)).toBeTruthy();
    });
});

// ---- path building ------------------------------------------------------

describe('buildPath / generateFilename', () => {
    it('routes each media type into its own folder and creates it', async () => {
        const dm = mk();
        const cases = {
            photos: 'images',
            image: 'images',
            videos: 'videos',
            video: 'videos',
            audio: 'audio',
            voice: 'audio',
            gifs: 'gifs',
            stickers: 'stickers',
            documents: 'documents',
        };
        for (const [mediaType, folder] of Object.entries(cases)) {
            const out = await dm.buildPath({
                groupName: 'My Group',
                mediaType,
                message: photoMsg(),
            });
            expect(path.basename(path.dirname(out)), mediaType).toBe(folder);
            expect(fs.existsSync(path.dirname(out))).toBe(true);
        }
    });

    it('sanitises the group name into the folder', async () => {
        const dm = mk();
        const out = await dm.buildPath({
            groupName: 'Bad/Name: Here',
            mediaType: 'photos',
            message: photoMsg(),
        });
        expect(out).toContain(`${path.sep}Bad_Name_Here${path.sep}`);
    });

    it('falls back to Unknown for an unnamed group', async () => {
        const dm = mk();
        const out = await dm.buildPath({ mediaType: 'photos', message: photoMsg() });
        expect(out).toContain(`${path.sep}Unknown${path.sep}`);
    });

    it('infers the folder from the message when mediaType is absent', async () => {
        const dm = mk();
        const out = await dm.buildPath({ groupName: 'G', message: photoMsg() });
        expect(path.basename(path.dirname(out))).toBe('images');
    });

    it('names the file from the message timestamp and id', () => {
        const dm = mk();
        const name = dm.generateFilename({ message: photoMsg({ id: 99, date: 1700000000 }) });
        expect(name).toMatch(/^2023-11-14T\d{2}-\d{2}-\d{2}_99\.jpg$/);
    });

    // Stories and self-destruct events arrive with no usable date;
    // `new Date(NaN).toISOString()` throws, which used to fail the whole job.
    //
    // Two guards cover this — the Number.isFinite() check on msg.date and the
    // Number.isNaN(d.getTime()) check after. Either alone produces the same
    // result, so removing one keeps this test green. Belt and braces, left
    // alone deliberately.
    it('falls back to wall-clock for a message with no usable date', () => {
        const dm = mk();
        for (const date of [undefined, null, NaN, 'nonsense']) {
            const name = dm.generateFilename({ message: { id: 7, date, photo: {} } });
            expect(name, String(date)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+_7\.jpg$/);
        }
    });

    it('uses noid when the message has no id', () => {
        const dm = mk();
        expect(dm.generateFilename({ message: { photo: {}, date: 1700000000 } })).toContain(
            '_noid',
        );
    });
});

// ---- sizes --------------------------------------------------------------

describe('formatBytes / parseSize', () => {
    it('formats each magnitude', () => {
        const dm = mk();
        expect(dm.formatBytes(0)).toBe('0 B');
        expect(dm.formatBytes(512)).toBe('512 B');
        expect(dm.formatBytes(1024)).toBe('1 KB');
        expect(dm.formatBytes(1536)).toBe('1.5 KB');
        expect(dm.formatBytes(1024 ** 3)).toBe('1 GB');
    });

    it('parses unit suffixes', () => {
        const dm = mk();
        expect(dm.parseSize('1024')).toBe(Infinity); // no unit → unbounded
        expect(dm.parseSize('10KB')).toBe(10 * 1024);
        expect(dm.parseSize('1.5 GB')).toBe(1.5 * 1024 ** 3);
        expect(dm.parseSize('2 tb')).toBe(2 * 1024 ** 4);
    });

    it('treats unparseable input as no limit', () => {
        const dm = mk();
        expect(dm.parseSize('')).toBe(Infinity);
        expect(dm.parseSize('lots')).toBe(Infinity);
        expect(dm.parseSize(null)).toBe(Infinity);
    });
});

describe('disk usage', () => {
    it('reads the live total from the downloads table', async () => {
        const dm = mk();
        downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'G',
            messageId: 1,
            fileName: 'a.jpg',
            fileSize: 5000,
            fileType: 'photos',
            filePath: 'G/images/a.jpg',
        });
        expect(await dm.getDiskUsage()).toBe(5000);
    });

    // Named "increment", but it invalidates rather than adds — the `bytes`
    // argument is ignored outright. That is coherent with the rest of the
    // design (getDiskUsage recomputes from the downloads table, and the kv
    // blob records source:'downloads_db'), so the behaviour is pinned rather
    // than the name chased. Its one caller passes bytesAddedToDisk, which
    // reads as if it accumulates.
    it('incrementDiskUsage invalidates the cache and schedules a save', async () => {
        vi.useFakeTimers();
        const dm = mk();
        await dm.getDiskUsage();
        expect(dm._diskUsageCache).not.toBeNull();

        dm.incrementDiskUsage(1234);

        expect(dm._diskUsageCache).toBeNull();
        expect(dm._saveTimeout).toBeTruthy();
    });

    it('coalesces repeated invalidations onto one pending save', async () => {
        vi.useFakeTimers();
        const dm = mk();
        dm.incrementDiskUsage(1);
        const first = dm._saveTimeout;
        dm.incrementDiskUsage(2);
        expect(dm._saveTimeout).not.toBe(first);
    });

    it('stop flushes a pending disk-usage save', async () => {
        vi.useFakeTimers();
        const dm = mk();
        downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'G',
            messageId: 2,
            fileName: 'b.jpg',
            fileSize: 7000,
            fileType: 'photos',
            filePath: 'G/images/b.jpg',
        });
        dm.incrementDiskUsage(7000);

        await dm.stop();

        expect(dbApi.kvGet('disk_usage')).toMatchObject({ size: 7000, source: 'downloads_db' });
    });
});

// ---- worker pool --------------------------------------------------------

describe('worker pool', () => {
    it('start spins up the configured concurrency once', () => {
        const dm = mk({ download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 3 } });
        const started = vi.fn();
        dm.on('started', started);

        dm.start();
        dm.start(); // idempotent

        expect(dm.running).toBe(true);
        expect(dm.workerCount).toBe(3);
        expect(started).toHaveBeenCalledTimes(1);
        expect(started).toHaveBeenCalledWith({ workers: 3 });
    });

    it('stop halts the scaler', async () => {
        const dm = mk();
        dm.start();
        await dm.stop();
        expect(dm.running).toBe(false);
    });

    it('throttle drops straight to the floor and says why', () => {
        const dm = mk({
            download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 10 },
            advanced: { downloader: { minConcurrency: 2 } },
        });
        dm.start();
        const scale = vi.fn();
        dm.on('scale', scale);

        dm.throttle();

        expect(dm.concurrency).toBe(2);
        expect(dm.workerCount).toBe(2);
        expect(scale).toHaveBeenCalledWith(
            expect.objectContaining({ direction: 'down', reason: 'flood' }),
        );
    });

    it('_autoScale is inert while stopped', () => {
        const dm = mk();
        const scale = vi.fn();
        dm.on('scale', scale);
        dm._autoScale();
        expect(scale).not.toHaveBeenCalled();
    });

    it('_autoScale adds workers when the queue outruns them', () => {
        const dm = mk({
            download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 2 },
            advanced: { downloader: { maxConcurrency: 20 } },
        });
        dm.start();
        const before = dm.workerCount;
        // Queue deeper than 2x the worker count triggers a scale-up.
        for (let i = 0; i < 50; i++) {
            dm._high.push({ key: `k${i}`, message: photoMsg({ id: i }) });
        }
        const scale = vi.fn();
        dm.on('scale', scale);

        dm._autoScale();

        expect(dm.workerCount).toBeGreaterThan(before);
        expect(scale).toHaveBeenCalledWith(expect.objectContaining({ direction: 'up' }));
    });

    it('_autoScale never exceeds the configured ceiling', () => {
        const dm = mk({
            download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 2 },
            advanced: { downloader: { maxConcurrency: 3 } },
        });
        dm.start();
        for (let i = 0; i < 100; i++) {
            dm._high.push({ key: `k${i}`, message: photoMsg({ id: i }) });
        }
        dm._autoScale();
        dm._autoScale();
        expect(dm.workerCount).toBeLessThanOrEqual(3);
    });

    it('_autoScale trims the target back when the queue drains', () => {
        const dm = mk({
            download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 10 },
            advanced: { downloader: { minConcurrency: 2 } },
        });
        dm.start();
        dm._autoScale();
        expect(dm.workerCount).toBeLessThan(10);
        expect(dm.workerCount).toBeGreaterThanOrEqual(2);
    });
});

// ---- retry / snapshot / status ------------------------------------------

// The live implementation is QueueManager.retryJob (download-queue.js);
// DownloadManager only forwards to it via an own property assigned in the
// constructor. A second, unreachable copy used to sit on the prototype here,
// shadowed by that assignment — mutating it left this whole block green,
// which is how it was found. Removed; these tests exercise the real one.
describe('retryJob', () => {
    it('puts the job at the front of the high lane', () => {
        const dm = mk();
        dm._high.push({ key: 'existing', message: photoMsg({ id: 1 }) });

        const ok = dm.retryJob({ groupId: '-100123', message: photoMsg({ id: 9 }) });

        expect(ok).toBe(true);
        expect(dm._high[0].key).toBe('-100123_9');
    });

    it('clears a paused flag so the retry actually runs', () => {
        const dm = mk();
        const job = { key: 'k1', groupId: 'g', message: photoMsg({ id: 1 }) };
        dm._paused.add('k1');
        dm.retryJob(job);
        expect(dm._paused.has('k1')).toBe(false);
    });

    it('announces the retry on the queue channel', () => {
        const dm = mk();
        const changed = vi.fn();
        dm.on('queue_changed', changed);
        dm.retryJob({ groupId: 'g', message: photoMsg({ id: 3 }) });
        expect(changed).toHaveBeenCalledWith(expect.objectContaining({ op: 'retry' }));
    });

    it('refuses a job with no message', () => {
        const dm = mk();
        expect(dm.retryJob(null)).toBe(false);
        expect(dm.retryJob({})).toBe(false);
    });
});

describe('snapshot / getStatus', () => {
    it('describes queued work without leaking the raw message', () => {
        const dm = mk();
        dm._high.push({
            key: 'k1',
            groupId: '-100123',
            groupName: 'G',
            mediaType: 'photos',
            fileName: 'a.jpg',
            message: photoMsg({ id: 11 }),
        });

        const snap = dm.snapshot();
        const all = JSON.stringify(snap);

        expect(all).toContain('k1');
        expect(all).not.toContain('accessHash');
    });

    it('reports counts through getStatus', () => {
        const dm = mk();
        dm._high.push({ key: 'k1', message: photoMsg({ id: 1 }) });
        const st = dm.getStatus();
        expect(st.queued).toBe(1);
        expect(st.active).toBe(0);
        expect(Array.isArray(st.downloads)).toBe(true);
    });

    it('falls back to the message when a job carries no fileSize', () => {
        const dm = mk();
        dm._high.push({ key: 'k1', groupId: 'g', message: photoMsg({ id: 1 }) });
        const snap = dm.snapshot();
        const flat = JSON.stringify(snap);
        expect(flat).toContain('900'); // largest photo size
    });
});

// ---- misc ---------------------------------------------------------------

describe('misc helpers', () => {
    it('sanitize delegates to the exported sanitizeName', () => {
        const dm = mk();
        expect(dm.sanitize('a<b>c')).toBe('a_b_c');
    });

    it('init announces readiness', async () => {
        const dm = mk();
        const ready = vi.fn();
        dm.on('ready', ready);
        await dm.init();
        expect(ready).toHaveBeenCalled();
    });

    it('sleep resolves after the requested delay', async () => {
        vi.useFakeTimers();
        const dm = mk();
        let done = false;
        dm.sleep(1000).then(() => {
            done = true;
        });
        await vi.advanceTimersByTimeAsync(1001);
        expect(done).toBe(true);
    });

    it('enqueue fills in a missing fileSize from the message', async () => {
        const dm = mk();
        const job = { groupId: '-100123', groupName: 'G', message: photoMsg({ id: 5 }) };
        await dm.enqueue(job, 1);
        expect(job.fileSize).toBe(900);
    });
});
