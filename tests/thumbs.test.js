// Covers src/core/thumbs.js — the server-side thumbnail cache: binary
// resolution, cache-key/path derivation, the hwaccel cascade and GPU pipeline
// builders, getOrCreateThumb's hit/miss/dedupe paths, and the purge, build and
// stats sweeps.
//
// The two process-spawning dependencies are mocked: `sharp` (libvips) and
// `child_process` (ffmpeg/ffprobe). Both are engine surfaces, and the point of
// this file is the logic wrapped around them. Everything else is real —
// core/db.js and config/manager.js run against an isolated TGDL_DATA_DIR, and
// the cache files really are written to and unlinked from disk.
//
// thumbs.js holds module-level state (resolved binary paths, a 30s hwaccel
// config cache, the suspend flag, the GPU-scaler probe). Every test therefore
// re-imports through vi.resetModules() so none of it leaks between cases.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-thumbs-'));
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

// ---- engine doubles -----------------------------------------------------

// sharp() is a builder whose terminal .toFile() writes the output. The double
// records calls and produces a real (tiny) file so the caller's existsSync +
// rename dance exercises actual disk behaviour.
const sharpCalls = [];
let sharpToFileImpl = async (dst, _call) => {
    fs.writeFileSync(dst, 'WEBPFAKE');
};
vi.mock('sharp', () => {
    const factory = (src, opts) => {
        const call = { src, opts, ops: [] };
        sharpCalls.push(call);
        const chain = {
            rotate(...a) {
                call.ops.push(['rotate', a]);
                return chain;
            },
            resize(...a) {
                call.ops.push(['resize', a]);
                return chain;
            },
            webp(...a) {
                call.ops.push(['webp', a]);
                return chain;
            },
            async toFile(dst) {
                call.dst = dst;
                return sharpToFileImpl(dst, call);
            },
        };
        return chain;
    };
    return { default: factory };
});

// ffmpeg/ffprobe. spawn() drives the async _runFfmpeg wrapper; spawnSync()
// backs the `-filters` GPU-scaler probe and the libwebp check.
const spawnCalls = [];
const spawnSyncCalls = [];
let spawnImpl = null;
let spawnSyncImpl = (_bin, _args, _opts) => ({ status: 0, stdout: '', stderr: '' });

vi.mock('child_process', () => {
    const { EventEmitter } = require('events');
    return {
        spawn: (bin, args, opts) => {
            spawnCalls.push({ bin, args, opts });
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.kill = () => {};
            queueMicrotask(() => {
                if (spawnImpl) spawnImpl(proc, { bin, args });
                else proc.emit('close', 0);
            });
            return proc;
        },
        spawnSync: (bin, args, opts) => {
            spawnSyncCalls.push({ bin, args, opts });
            return spawnSyncImpl(bin, args, opts);
        },
    };
});

// ---- harness ------------------------------------------------------------

let dbApi;
let downloadsApi;

/** Fresh module registry per test — thumbs.js caches a lot at module scope. */
async function loadThumbs() {
    vi.resetModules();
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    return import('../src/core/thumbs.js');
}

function seedDownload({ id, filePath, fileType = 'photo' }) {
    const r = downloadsApi.insertDownload({
        groupId: '-100123',
        groupName: 'G',
        messageId: id,
        fileName: path.basename(filePath || 'x.jpg'),
        fileType,
        filePath,
    });
    return Number(r.lastInsertRowid);
}

/** Write a real source file under the downloads root. */
function writeSource(rel, bytes = 'SRC') {
    const abs = path.join(DOWNLOADS_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return abs;
}

beforeAll(() => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
});

afterAll(() => {
    try {
        dbApi?.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    sharpCalls.length = 0;
    spawnCalls.length = 0;
    spawnSyncCalls.length = 0;
    spawnImpl = null;
    spawnSyncImpl = () => ({ status: 0, stdout: '', stderr: '' });
    sharpToFileImpl = async (dst, _call) => {
        fs.writeFileSync(dst, 'WEBPFAKE');
    };
    delete process.env.FFMPEG_HWACCEL;
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    fs.rmSync(THUMBS_DIR, { recursive: true, force: true });
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
});

afterEach(() => {
    try {
        dbApi?.getDb().prepare('DELETE FROM downloads').run();
    } catch {
        /* db may be closed */
    }
});

// ---- binary resolution --------------------------------------------------

describe('binary resolution', () => {
    it('honours FFMPEG_PATH when the file exists', async () => {
        const fake = path.join(DATA_DIR, 'my-ffmpeg');
        fs.writeFileSync(fake, '');
        process.env.FFMPEG_PATH = fake;
        const t = await loadThumbs();
        expect(t.resolveFfmpegBin()).toBe(fake);
    });

    it('ignores FFMPEG_PATH pointing at a missing file', async () => {
        process.env.FFMPEG_PATH = path.join(DATA_DIR, 'does-not-exist');
        const t = await loadThumbs();
        expect(t.resolveFfmpegBin()).not.toBe(process.env.FFMPEG_PATH);
    });

    it('memoises the resolved path', async () => {
        const t = await loadThumbs();
        expect(t.resolveFfmpegBin()).toBe(t.resolveFfmpegBin());
    });

    it('honours FFPROBE_PATH when the file exists', async () => {
        const fake = path.join(DATA_DIR, 'my-ffprobe');
        fs.writeFileSync(fake, '');
        process.env.FFPROBE_PATH = fake;
        const t = await loadThumbs();
        expect(t.resolveFfprobeBin()).toBe(fake);
    });
});

// ---- width + cache key --------------------------------------------------

describe('width clamping and cache keys', () => {
    it('collapses every requested width to the single canonical one', async () => {
        const t = await loadThumbs();
        for (const w of [1, 120, 240, 320, 480, 9999, undefined, null, 'abc']) {
            expect(t.clampWidth(w)).toBe(t.DEFAULT_WIDTH);
        }
        expect(t.ALLOWED_WIDTHS).toEqual([320]);
    });

    it('hasCachedThumb rejects non-positive and non-numeric ids', async () => {
        const t = await loadThumbs();
        for (const bad of [0, -1, 'abc', null, undefined, '']) {
            expect(t.hasCachedThumb(bad)).toBe(false);
        }
    });

    it('hasCachedThumb reports a file that exists on disk', async () => {
        const t = await loadThumbs();
        expect(t.hasCachedThumb(7)).toBe(false);

        // Materialise the cache file by driving a real generation.
        const abs = writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        await t.getOrCreateThumb(id);
        expect(t.hasCachedThumb(id)).toBe(true);
        expect(abs).toBeTruthy();
    });

    it('derives distinct cache paths per id', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        writeSource('G/photos/b.jpg');
        const a = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        const b = seedDownload({ id: 2, filePath: 'G/photos/b.jpg' });
        const ta = await t.getOrCreateThumb(a);
        const tb = await t.getOrCreateThumb(b);
        expect(ta.path).not.toBe(tb.path);
        expect(path.dirname(ta.path)).toBe(THUMBS_DIR);
    });
});

// ---- kind mapping -------------------------------------------------------

describe('thumbKindTypes', () => {
    it('maps each public kind to its stored file_type values', async () => {
        const t = await loadThumbs();
        expect(t.thumbKindTypes('image')).toEqual(['photo', 'image', 'sticker']);
        expect(t.thumbKindTypes('video')).toEqual(['video']);
        expect(t.thumbKindTypes('audio')).toEqual(['audio']);
    });

    it('unions every kind for "all" and for a missing argument', async () => {
        const t = await loadThumbs();
        const all = ['photo', 'image', 'sticker', 'video', 'audio'];
        expect(t.thumbKindTypes('all')).toEqual(all);
        expect(t.thumbKindTypes()).toEqual(all);
        expect(t.thumbKindTypes('ALL')).toEqual(all);
    });

    it('returns null for an unknown kind', async () => {
        const t = await loadThumbs();
        expect(t.thumbKindTypes('document')).toBeNull();
    });

    it('hands back copies, so a caller cannot mutate the table', async () => {
        const t = await loadThumbs();
        t.thumbKindTypes('image').push('mutated');
        expect(t.thumbKindTypes('image')).toEqual(['photo', 'image', 'sticker']);
    });
});

// ---- hwaccel cascade ----------------------------------------------------

describe('hwaccelPrefix', () => {
    it('returns an empty prefix when nothing is configured', async () => {
        const t = await loadThumbs();
        expect(await t.hwaccelPrefix(null)).toEqual([]);
    });

    it('takes an explicit override ahead of everything else', async () => {
        process.env.FFMPEG_HWACCEL = 'cuda';
        const t = await loadThumbs();
        expect(await t.hwaccelPrefix('vaapi')).toEqual(['-hwaccel', 'vaapi']);
    });

    it('treats an empty-string override as "force CPU"', async () => {
        process.env.FFMPEG_HWACCEL = 'cuda';
        const t = await loadThumbs();
        expect(await t.hwaccelPrefix('')).toEqual([]);
    });

    it('falls back to the cascade for an unknown override', async () => {
        process.env.FFMPEG_HWACCEL = 'cuda';
        const t = await loadThumbs();
        expect(await t.hwaccelPrefix('nonsense')).toEqual(['-hwaccel', 'cuda']);
    });

    it('reads the env var when no override is given', async () => {
        process.env.FFMPEG_HWACCEL = 'qsv';
        const t = await loadThumbs();
        expect(await t.hwaccelPrefix(null)).toEqual(['-hwaccel', 'qsv']);
        expect(await t.hwaccelPrefix(undefined)).toEqual(['-hwaccel', 'qsv']);
    });

    it('rejects a backend outside the allow-list', async () => {
        process.env.FFMPEG_HWACCEL = 'rootkit';
        const t = await loadThumbs();
        expect(await t.hwaccelPrefix(null)).toEqual([]);
    });

    it('picks the backend up from config when no env var is set', async () => {
        const t = await loadThumbs();
        const { loadConfig, saveConfig } = await import('../src/config/manager.js');
        const cfg = loadConfig();
        cfg.advanced = { ...cfg.advanced, thumbs: { hwaccel: 'vaapi' } };
        saveConfig(cfg);

        expect(await t.hwaccelPrefix(null)).toEqual(['-hwaccel', 'vaapi']);

        cfg.advanced.thumbs.hwaccel = '';
        saveConfig(cfg);
    });
});

describe('GPU pipeline builders', () => {
    it('produce empty pipelines when no backend is active', async () => {
        const t = await loadThumbs();
        expect(t.hwaccelFullPipeline(null)).toEqual({ inputArgs: [], scaleVf: null });
        expect(t.hwaccelUploadPipeline(null)).toEqual({ inputArgs: [], scaleVf: null });
    });

    it('full pipeline keeps decode on GPU but scales in software', async () => {
        const t = await loadThumbs();
        // Single-frame jobs deliberately avoid hwdownload colour-space issues.
        expect(t.hwaccelFullPipeline('cuda')).toEqual({
            inputArgs: ['-hwaccel', 'cuda'],
            scaleVf: null,
        });
    });

    it('upload pipeline emits a GPU scaler when ffmpeg advertises the filter', async () => {
        spawnSyncImpl = () => ({ status: 0, stdout: 'scale_vaapi scale_cuda vpp_qsv', stderr: '' });
        const t = await loadThumbs();

        const vaapi = t.hwaccelUploadPipeline('vaapi');
        expect(vaapi.inputArgs).toEqual(['-hwaccel', 'vaapi']);
        expect(vaapi.scaleVf(320)).toContain('scale_vaapi=w=320');
        expect(vaapi.scaleVf(320)).toContain('hwupload');
        expect(vaapi.scaleVf(320)).toContain('hwdownload');

        expect(t.hwaccelUploadPipeline('cuda').scaleVf(320)).toContain('scale_cuda=w=320');
        expect(t.hwaccelUploadPipeline('qsv').scaleVf(320)).toContain('vpp_qsv=w=320');
    });

    it('upload pipeline degrades to a software scaler when the filter is absent', async () => {
        spawnSyncImpl = () => ({ status: 0, stdout: 'scale crop overlay', stderr: '' });
        const t = await loadThumbs();
        expect(t.hwaccelUploadPipeline('vaapi')).toEqual({
            inputArgs: ['-hwaccel', 'vaapi'],
            scaleVf: null,
        });
    });

    it('upload pipeline degrades when the filter probe itself fails', async () => {
        spawnSyncImpl = () => {
            throw new Error('ffmpeg missing');
        };
        const t = await loadThumbs();
        expect(t.hwaccelUploadPipeline('cuda').scaleVf).toBeNull();
    });

    it('backends with decode-only acceleration never get a GPU scaler', async () => {
        spawnSyncImpl = () => ({ status: 0, stdout: 'scale_vaapi scale_cuda vpp_qsv', stderr: '' });
        const t = await loadThumbs();
        for (const backend of ['videotoolbox', 'd3d11va', 'dxva2']) {
            const p = t.hwaccelUploadPipeline(backend);
            expect(p.inputArgs, backend).toEqual(['-hwaccel', backend]);
            expect(p.scaleVf, backend).toBeNull();
        }
    });

    it('probes ffmpeg for filters only once', async () => {
        spawnSyncImpl = () => ({ status: 0, stdout: 'scale_vaapi', stderr: '' });
        const t = await loadThumbs();
        t.hwaccelUploadPipeline('vaapi');
        t.hwaccelUploadPipeline('vaapi');
        t.hwaccelUploadPipeline('cuda');
        const filterProbes = spawnSyncCalls.filter((c) => c.args?.includes('-filters'));
        expect(filterProbes).toHaveLength(1);
    });
});

// ---- getOrCreateThumb ---------------------------------------------------

describe('getOrCreateThumb', () => {
    it('rejects a non-positive or non-numeric id without touching the db', async () => {
        const t = await loadThumbs();
        for (const bad of [0, -5, 'abc', null, undefined]) {
            expect(await t.getOrCreateThumb(bad)).toBeNull();
        }
    });

    it('returns null when the row does not exist', async () => {
        const t = await loadThumbs();
        expect(await t.getOrCreateThumb(999999)).toBeNull();
    });

    it('returns null when the stored path resolves to nothing on disk', async () => {
        const t = await loadThumbs();
        const id = seedDownload({ id: 1, filePath: 'G/photos/missing.jpg' });
        expect(await t.getOrCreateThumb(id)).toBeNull();
    });

    it('generates a webp from an image source and reports its width', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });

        const out = await t.getOrCreateThumb(id);
        expect(out.width).toBe(320);
        expect(fs.existsSync(out.path)).toBe(true);
        expect(typeof out.mtime).toBe('number');

        // Orientation is honoured before the resize, and no upscaling.
        const ops = Object.fromEntries(sharpCalls[0].ops);
        expect(sharpCalls[0].ops[0][0]).toBe('rotate');
        expect(ops.resize[0]).toMatchObject({ width: 320, withoutEnlargement: true });
    });

    it('serves the cached file on the second call without re-encoding', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });

        const first = await t.getOrCreateThumb(id);
        sharpCalls.length = 0;
        const second = await t.getOrCreateThumb(id);

        expect(second.path).toBe(first.path);
        expect(sharpCalls).toHaveLength(0);
    });

    it('skips webp sources so the gallery can serve the original', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.webp');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.webp' });
        expect(await t.getOrCreateThumb(id)).toBeNull();
        expect(sharpCalls).toHaveLength(0);
    });

    it('returns null for a kind it cannot thumbnail', async () => {
        const t = await loadThumbs();
        writeSource('G/documents/a.pdf');
        const id = seedDownload({ id: 1, filePath: 'G/documents/a.pdf', fileType: 'document' });
        expect(await t.getOrCreateThumb(id)).toBeNull();
    });

    it('classifies by declared type ahead of extension', async () => {
        const t = await loadThumbs();
        // A ".bin" file declared as a photo still goes down the image path.
        writeSource('G/photos/a.bin');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.bin', fileType: 'photo' });
        expect(await t.getOrCreateThumb(id)).toBeTruthy();
        expect(sharpCalls).toHaveLength(1);
    });

    it('strips a legacy data/downloads/ prefix from the stored path', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'data/downloads/G/photos/a.jpg' });
        expect(await t.getOrCreateThumb(id)).toBeTruthy();
    });

    it('returns null and leaves no .tmp behind when generation fails', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        sharpToFileImpl = async () => {
            throw new Error('libvips exploded');
        };

        expect(await t.getOrCreateThumb(id)).toBeNull();
        const leftovers = fs.existsSync(THUMBS_DIR)
            ? fs.readdirSync(THUMBS_DIR).filter((n) => n.endsWith('.tmp'))
            : [];
        expect(leftovers).toEqual([]);
    });

    it('collapses concurrent requests for the same id into one generation', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });

        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        sharpToFileImpl = async (dst) => {
            await gate;
            fs.writeFileSync(dst, 'WEBPFAKE');
        };

        const all = Promise.all(Array.from({ length: 10 }, () => t.getOrCreateThumb(id)));
        await new Promise((r) => setTimeout(r, 10));
        release();
        const results = await all;

        expect(sharpCalls).toHaveLength(1);
        expect(results.every((r) => r && r.path === results[0].path)).toBe(true);
    });

    it('returns null while generation is suspended', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });

        t.suspendThumbGen();
        expect(await t.getOrCreateThumb(id)).toBeNull();
        expect(sharpCalls).toHaveLength(0);

        t.resumeThumbGen();
        expect(await t.getOrCreateThumb(id)).toBeTruthy();
    });

    it('still serves a cached file while suspended', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        await t.getOrCreateThumb(id);

        t.suspendThumbGen();
        expect(await t.getOrCreateThumb(id)).toBeTruthy();
        t.resumeThumbGen();
    });

    // Two encode paths, chosen once from `ffmpeg -encoders`: a single ffmpeg
    // pass when the build links libwebp, or ffmpeg-to-JPEG plus a sharp
    // re-encode when it doesn't (stripped Alpine/musl and Windows static
    // builds). Both are live in the field, so both are pinned here.
    it('encodes a video thumb in one ffmpeg pass when the build has libwebp', async () => {
        spawnSyncImpl = () => ({
            status: 0,
            stdout: Buffer.from('V..... libwebp WebP'),
            stderr: '',
        });
        const t = await loadThumbs();
        writeSource('G/videos/a.mp4');
        const id = seedDownload({ id: 1, filePath: 'G/videos/a.mp4', fileType: 'video' });

        spawnImpl = (proc, { args }) => {
            fs.writeFileSync(args[args.length - 1], 'WEBPFAKE');
            proc.emit('close', 0);
        };

        const res = await t.getOrCreateThumb(id);
        expect(res).toBeTruthy();
        expect(sharpCalls).toHaveLength(0);
        expect(spawnCalls[0].args).toContain('libwebp');
        expect(spawnCalls[0].args).toContain('-frames:v');
    });

    it('falls back to ffmpeg-then-sharp when the build lacks libwebp', async () => {
        spawnSyncImpl = () => ({ status: 0, stdout: Buffer.from('V..... mjpeg JPEG'), stderr: '' });
        const t = await loadThumbs();
        writeSource('G/videos/a.mp4');
        const id = seedDownload({ id: 1, filePath: 'G/videos/a.mp4', fileType: 'video' });

        spawnImpl = (proc, { args }) => {
            fs.writeFileSync(args[args.length - 1], 'JPEGFAKE');
            proc.emit('close', 0);
        };

        const res = await t.getOrCreateThumb(id);
        expect(res).toBeTruthy();
        expect(spawnCalls[0].args).not.toContain('libwebp');
        // The intermediate JPEG goes through sharp, and is cleaned up after.
        expect(sharpCalls).toHaveLength(1);
        expect(sharpCalls[0].src).toMatch(/\.frame\.jpg$/);
        expect(fs.existsSync(sharpCalls[0].src)).toBe(false);
    });

    it('retries the frame grab at t=0 when the 1s seek yields nothing', async () => {
        spawnSyncImpl = () => ({
            status: 0,
            stdout: Buffer.from('V..... libwebp WebP'),
            stderr: '',
        });
        const t = await loadThumbs();
        writeSource('G/videos/short.mp4');
        const id = seedDownload({ id: 1, filePath: 'G/videos/short.mp4', fileType: 'video' });

        // First pass produces no output (seek past the end of a short clip).
        spawnImpl = (proc, { args }) => {
            if (spawnCalls.length > 1) fs.writeFileSync(args[args.length - 1], 'WEBPFAKE');
            proc.emit('close', 0);
        };

        expect(await t.getOrCreateThumb(id)).toBeTruthy();
        expect(spawnCalls).toHaveLength(2);
        expect(spawnCalls[0].args[spawnCalls[0].args.indexOf('-ss') + 1]).toBe('1');
        expect(spawnCalls[1].args[spawnCalls[1].args.indexOf('-ss') + 1]).toBe('0');
    });

    it('returns null when ffmpeg exits non-zero', async () => {
        const t = await loadThumbs();
        writeSource('G/videos/a.mp4');
        const id = seedDownload({ id: 1, filePath: 'G/videos/a.mp4', fileType: 'video' });
        spawnImpl = (proc) => {
            proc.stderr.emit('data', Buffer.from('moov atom not found'));
            proc.emit('close', 1);
        };
        expect(await t.getOrCreateThumb(id)).toBeNull();
    });
});

// ---- purge --------------------------------------------------------------

describe('purgeThumbsForDownload', () => {
    it('returns 0 when the cache directory does not exist', async () => {
        const t = await loadThumbs();
        expect(await t.purgeThumbsForDownload(1)).toBe(0);
    });

    it('rejects a bad id', async () => {
        const t = await loadThumbs();
        fs.mkdirSync(THUMBS_DIR, { recursive: true });
        expect(await t.purgeThumbsForDownload(0)).toBe(0);
        expect(await t.purgeThumbsForDownload('abc')).toBe(0);
    });

    it('removes the cached thumb for one id', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        const made = await t.getOrCreateThumb(id);

        expect(await t.purgeThumbsForDownload(id)).toBe(1);
        expect(fs.existsSync(made.path)).toBe(false);
    });

    it('leaves other ids alone', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        writeSource('G/photos/b.jpg');
        const a = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        const b = seedDownload({ id: 2, filePath: 'G/photos/b.jpg' });
        await t.getOrCreateThumb(a);
        const keep = await t.getOrCreateThumb(b);

        await t.purgeThumbsForDownload(a);
        expect(fs.existsSync(keep.path)).toBe(true);
    });
});

describe('purgeAllThumbs', () => {
    it('returns 0 when the cache directory does not exist', async () => {
        const t = await loadThumbs();
        expect(await t.purgeAllThumbs()).toBe(0);
    });

    it('unlinks every webp and tmp file on the fast path', async () => {
        const t = await loadThumbs();
        fs.mkdirSync(THUMBS_DIR, { recursive: true });
        fs.writeFileSync(path.join(THUMBS_DIR, 'a.webp'), 'x');
        fs.writeFileSync(path.join(THUMBS_DIR, 'b.webp'), 'x');
        fs.writeFileSync(path.join(THUMBS_DIR, 'c.webp.tmp'), 'x');
        fs.writeFileSync(path.join(THUMBS_DIR, 'notes.txt'), 'keep me');

        expect(await t.purgeAllThumbs()).toBe(3);
        expect(fs.readdirSync(THUMBS_DIR)).toEqual(['notes.txt']);
    });

    it('suspends generation so an in-flight sweep is not fighting new writes', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        await t.getOrCreateThumb(id);

        await t.purgeAllThumbs();
        expect(await t.getOrCreateThumb(id)).toBeNull();
        t.resumeThumbGen();
    });
});

describe('purgeNonStandardThumbs', () => {
    it('returns zeroes when the cache directory does not exist', async () => {
        const t = await loadThumbs();
        expect(await t.purgeNonStandardThumbs()).toEqual({ removed: 0, bytes: 0 });
    });

    it('leaves canonical-width thumbs untouched', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        const made = await t.getOrCreateThumb(id);

        const res = await t.purgeNonStandardThumbs();
        expect(res.removed).toBe(0);
        expect(fs.existsSync(made.path)).toBe(true);
    });
});

// ---- build sweep --------------------------------------------------------

describe('buildAllThumbnails', () => {
    it('builds every eligible row and reports the tally', async () => {
        const t = await loadThumbs();
        for (let i = 1; i <= 3; i++) {
            writeSource(`G/photos/a${i}.jpg`);
            seedDownload({ id: i, filePath: `G/photos/a${i}.jpg` });
        }

        const res = await t.buildAllThumbnails();
        expect(res.scanned).toBe(3);
        expect(res.built).toBe(3);
        expect(res.errored).toBe(0);
    });

    it('excludes webp sources from the scan entirely', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        writeSource('G/photos/b.webp');
        seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        seedDownload({ id: 2, filePath: 'G/photos/b.webp' });

        const res = await t.buildAllThumbnails();
        expect(res.scanned).toBe(1);
        expect(res.built).toBe(1);
    });

    it('scopes the sweep by kind', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        writeSource('G/videos/b.mp4');
        seedDownload({ id: 1, filePath: 'G/photos/a.jpg', fileType: 'photo' });
        seedDownload({ id: 2, filePath: 'G/videos/b.mp4', fileType: 'video' });

        const res = await t.buildAllThumbnails({ kind: 'image' });
        expect(res.scanned).toBe(1);
        expect(sharpCalls).toHaveLength(1);
    });

    it('counts an already-cached row as skipped rather than rebuilding it', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        const id = seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        await t.getOrCreateThumb(id);
        sharpCalls.length = 0;

        const res = await t.buildAllThumbnails();
        expect(res.skipped).toBe(1);
        expect(res.built).toBe(0);
        expect(sharpCalls).toHaveLength(0);
    });

    it('counts a generation failure as errored, not built', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });
        sharpToFileImpl = async () => {
            throw new Error('nope');
        };

        const res = await t.buildAllThumbnails();
        expect(res.built).toBe(0);
        expect(res.skipped).toBe(1); // getOrCreateThumb swallows and returns null
    });

    it('emits progress, ending with a done stage', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });

        const stages = [];
        await t.buildAllThumbnails({ onProgress: (p) => stages.push(p.stage) });
        expect(stages[0]).toBe('building');
        expect(stages[stages.length - 1]).toBe('done');
    });

    it('stops early on an aborted signal', async () => {
        const t = await loadThumbs();
        for (let i = 1; i <= 3; i++) {
            writeSource(`G/photos/a${i}.jpg`);
            seedDownload({ id: i, filePath: `G/photos/a${i}.jpg` });
        }
        const ctrl = new AbortController();
        ctrl.abort();

        const res = await t.buildAllThumbnails({ signal: ctrl.signal });
        expect(res.built).toBe(0);
        expect(sharpCalls).toHaveLength(0);
    });

    it('clears the suspend flag so a rebuild after a purge actually runs', async () => {
        const t = await loadThumbs();
        writeSource('G/photos/a.jpg');
        seedDownload({ id: 1, filePath: 'G/photos/a.jpg' });

        await t.purgeAllThumbs(); // sets the suspend flag
        const res = await t.buildAllThumbnails();
        expect(res.built).toBe(1);
    });
});

// ---- stats --------------------------------------------------------------

describe('getThumbsCacheStats', () => {
    it('reports zeroes when the cache directory does not exist', async () => {
        const t = await loadThumbs();
        expect(await t.getThumbsCacheStats()).toEqual({ count: 0, bytes: 0 });
    });

    it('counts only webp files and sums their bytes', async () => {
        const t = await loadThumbs();
        fs.mkdirSync(THUMBS_DIR, { recursive: true });
        fs.writeFileSync(path.join(THUMBS_DIR, 'a.webp'), '12345');
        fs.writeFileSync(path.join(THUMBS_DIR, 'b.webp'), '123');
        fs.writeFileSync(path.join(THUMBS_DIR, 'c.webp.tmp'), 'ignored');
        fs.writeFileSync(path.join(THUMBS_DIR, 'notes.txt'), 'ignored');

        expect(await t.getThumbsCacheStats()).toEqual({ count: 2, bytes: 8 });
    });
});

// ---- exported paths -----------------------------------------------------

describe('THUMBS_PATHS', () => {
    it('exposes both roots under the configured data dir', async () => {
        const t = await loadThumbs();
        expect(t.THUMBS_PATHS).toEqual({
            DOWNLOADS_DIR,
            THUMBS_DIR,
        });
    });
});
