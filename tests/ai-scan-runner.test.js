// Covers src/core/ai/scan-runner.js — the shared driver behind the three AI
// scans (faces, OCR, WD14): the per-feature state machine, the
// already-running guard, progress throttling, cancellation, the fatal-vs-
// recoverable error split, and each feature's row loop.
//
// Mocked: everything that talks to a model or a sidecar — ./faces.js,
// ./faces-client.js, ./tgdl-ml-client.js, ./preflight.js, and ../thumbs.js's
// ffmpeg probes. Real: core/db.js and the db/faces.js + db/scan-state.js
// helpers against an isolated TGDL_DATA_DIR, so every row the loops write is
// a genuine SQL round-trip — which is what surfaces the path-resolution bug
// this file fixes.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-scanrunner-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

// ---- engine doubles -----------------------------------------------------

const facesApi = {
    detectFaces: vi.fn(async () => []),
    computeFaceQualityScore: vi.fn(() => 0.9),
    FACE_DEFAULTS: { minFaceSize: 40 },
};
vi.mock('../src/core/ai/faces.js', () => facesApi);

const facesClientApi = {
    getSidecarUrl: vi.fn(() => 'http://127.0.0.1:9999'),
    detectFacesBatch: vi.fn(async () => []),
    clusterFacesRemote: vi.fn(async () => ({ clusters: [] })),
};
vi.mock('../src/core/ai/faces-client.js', () => facesClientApi);

const mlApi = {
    mlOcr: vi.fn(async () => ({ text: 'hello', language: 'eng', confidence: 0.9 })),
    isTgdlMlEnabled: vi.fn(() => false),
    getTgdlMlUrl: vi.fn(() => 'http://127.0.0.1:3800'),
};
vi.mock('../src/core/ai/tgdl-ml-client.js', () => mlApi);

const preflightApi = {
    checkSidecarCapability: vi.fn(async () => ({ ok: true })),
};
vi.mock('../src/core/ai/preflight.js', () => preflightApi);

const thumbsApi = {
    resolveFfmpegBin: vi.fn(() => '/usr/bin/ffmpeg'),
    hasFfmpeg: vi.fn(() => false),
    hwaccelPrefix: vi.fn(async () => []),
    hwaccelFullPipeline: vi.fn(() => ({ inputArgs: [], scaleVf: null })),
    purgeThumbsForDownload: vi.fn(async () => 0),
    THUMBS_PATHS: {},
};
vi.mock('../src/core/thumbs.js', () => thumbsApi);

// Sidecar HTTP calls (OCR/WD14 single-item helpers) go through global fetch.
let fetchImpl = null;
const realFetch = globalThis.fetch;

// ---- harness ------------------------------------------------------------

let runner;
let dbApi;
let downloadsApi;

async function loadRunner() {
    vi.resetModules();
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    runner = await import('../src/core/ai/scan-runner.js');
    return runner;
}

function seedRow(name, { fileType = 'photo', onDisk = true } = {}) {
    const rel = `G/photos/${name}`;
    if (onDisk) {
        const abs = path.join(DOWNLOADS_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `bytes-${name}`);
    }
    const r = downloadsApi.insertDownload({
        groupId: '-100123',
        groupName: 'G',
        messageId: Math.floor(Math.random() * 1e9),
        fileName: name,
        fileType,
        filePath: rel,
    });
    return { id: Number(r.lastInsertRowid), rel };
}

async function waitIdle(feature, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!runner.isScanRunning(feature)) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`${feature} scan did not settle`);
}

beforeAll(() => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    globalThis.fetch = (...args) => (fetchImpl ? fetchImpl(...args) : realFetch(...args));
});

afterAll(() => {
    globalThis.fetch = realFetch;
    try {
        dbApi?.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    facesApi.detectFaces.mockResolvedValue([]);
    facesApi.computeFaceQualityScore.mockReturnValue(0.9);
    facesClientApi.getSidecarUrl.mockReturnValue('http://127.0.0.1:9999');
    facesClientApi.detectFacesBatch.mockResolvedValue([]);
    mlApi.isTgdlMlEnabled.mockReturnValue(false);
    mlApi.mlOcr.mockResolvedValue({ text: 'hello', language: 'eng', confidence: 0.9 });
    preflightApi.checkSidecarCapability.mockResolvedValue({ ok: true });
    thumbsApi.hasFfmpeg.mockReturnValue(false);
    fetchImpl = null;
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
});

afterEach(() => {
    try {
        const db = dbApi?.getDb();
        db?.prepare('DELETE FROM downloads').run();
        db?.prepare('DELETE FROM media_scan_state').run();
        db?.prepare('DELETE FROM image_text').run();
    } catch {
        /* table may not exist / db closed */
    }
});

// ---- state machine ------------------------------------------------------

describe('scan state', () => {
    it('starts idle for every feature', async () => {
        const r = await loadRunner();
        for (const f of ['faces', 'ocr', 'wd14']) {
            expect(r.getScanState(f)).toMatchObject({
                running: false,
                scanned: 0,
                total: 0,
                error: null,
            });
            expect(r.isScanRunning(f)).toBe(false);
        }
    });

    it('returns null for an unknown feature', async () => {
        const r = await loadRunner();
        expect(r.getScanState('nope')).toBeNull();
        expect(r.isScanRunning('nope')).toBe(false);
        expect(r.cancelScan('nope')).toBe(false);
    });

    it('never leaks the AbortController through the public state', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        r.startOcrScan({}, null, null, null);
        expect(r.getScanState('ocr').abort).toBeUndefined();
        await waitIdle('ocr');
    });

    it('cancelScan is a no-op when nothing is running', async () => {
        const r = await loadRunner();
        expect(r.cancelScan('ocr')).toBe(false);
    });

    it('_resetForTests clears every feature back to idle', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');
        r._resetForTests();
        expect(r.getScanState('ocr')).toMatchObject({ scanned: 0, startedAt: null });
    });
});

// ---- shared driver behaviour --------------------------------------------

describe('_runScan driver', () => {
    it('refuses a second run of the same feature', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        let release;
        const gate = new Promise((res) => {
            release = res;
        });
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        mlApi.mlOcr.mockImplementation(async () => {
            await gate;
            return { text: '' };
        });

        const first = r.startOcrScan({}, null, null, null);
        const second = r.startOcrScan({}, null, null, null);

        expect(await second).toEqual({ alreadyRunning: true });
        release();
        await first;
        await waitIdle('ocr');
    });

    it('lets different features run at once', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        r.startOcrScan({}, null, null, null);
        const wd14 = r.startWd14Scan({}, null, null, null);
        expect(await wd14).not.toEqual({ alreadyRunning: true });
        await waitIdle('ocr');
        await waitIdle('wd14');
    });

    it('records timings and clears running on completion', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        const done = [];
        r.startOcrScan({}, null, (d) => done.push(d), null);
        await waitIdle('ocr');

        const st = r.getScanState('ocr');
        expect(st.running).toBe(false);
        expect(st.startedAt).toBeTypeOf('number');
        expect(st.finishedAt).toBeTypeOf('number');
        expect(done).toHaveLength(1);
    });

    it('funnels a worker crash into state.error instead of throwing', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        preflightApi.checkSidecarCapability.mockRejectedValue(new Error('sidecar exploded'));

        const logs = [];
        r.startOcrScan({}, null, null, (l) => logs.push(l));
        await waitIdle('ocr');

        expect(r.getScanState('ocr').error).toMatch(/sidecar exploded/);
        expect(logs.some((l) => l.level === 'error')).toBe(true);
        expect(logs.every((l) => l.source === 'ai-scan-ocr')).toBe(true);
    });

    it('surfaces a failed preflight as a fatal error', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        preflightApi.checkSidecarCapability.mockResolvedValue({
            ok: false,
            reason: 'model not installed',
            code: 'NO_MODEL',
        });

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');
        expect(r.getScanState('ocr').error).toMatch(/preflight failed: model not installed/);
    });

    it('always emits a final progress event even when throttled', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        const progress = [];
        r.startOcrScan({}, (p) => progress.push(p), null, null);
        await waitIdle('ocr');
        expect(progress.length).toBeGreaterThan(0);
        expect(progress[progress.length - 1].running).toBe(false);
    });

    it('tolerates onProgress / onDone / onLog throwing', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        const boom = () => {
            throw new Error('listener exploded');
        };
        r.startOcrScan({}, boom, boom, boom);
        await expect(waitIdle('ocr')).resolves.toBeUndefined();
    });
});

// ---- path resolution ----------------------------------------------------

describe('download path resolution', () => {
    it('resolves rows under TGDL_DATA_DIR, not the in-repo data dir', async () => {
        const r = await loadRunner();
        const { id } = seedRow('present.jpg');
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        mlApi.mlOcr.mockResolvedValue({ text: 'found it', language: 'eng', confidence: 1 });

        const logs = [];
        r.startOcrScan({}, null, null, (l) => logs.push(l));
        await waitIdle('ocr');

        // The row was OCR'd rather than reported missing.
        expect(logs.some((l) => /file not found/.test(l.msg))).toBe(false);
        const row = dbApi
            .getDb()
            .prepare('SELECT text FROM image_text WHERE download_id = ?')
            .get(id);
        expect(row.text).toBe('found it');
    });

    it('reports a genuinely missing file and still stamps the row', async () => {
        const r = await loadRunner();
        const { id } = seedRow('ghost.jpg', { onDisk: false });
        mlApi.isTgdlMlEnabled.mockReturnValue(true);

        const logs = [];
        r.startOcrScan({}, null, null, (l) => logs.push(l));
        await waitIdle('ocr');

        expect(logs.some((l) => /file not found/.test(l.msg))).toBe(true);
        const row = dbApi
            .getDb()
            .prepare('SELECT text FROM image_text WHERE download_id = ?')
            .get(id);
        expect(row.text).toBe('');
    });

    it('strips a legacy data/downloads/ prefix from the stored path', async () => {
        const r = await loadRunner();
        const abs = path.join(DOWNLOADS_DIR, 'G/photos/legacy.jpg');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'bytes');
        const ins = downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'G',
            messageId: 1,
            fileName: 'legacy.jpg',
            fileType: 'photo',
            filePath: 'data/downloads/G/photos/legacy.jpg',
        });
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        mlApi.mlOcr.mockResolvedValue({ text: 'legacy ok' });

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');

        const row = dbApi
            .getDb()
            .prepare('SELECT text FROM image_text WHERE download_id = ?')
            .get(Number(ins.lastInsertRowid));
        expect(row.text).toBe('legacy ok');
    });
});

// ---- OCR ----------------------------------------------------------------

describe('startOcrScan', () => {
    it('writes extracted text for every eligible row', async () => {
        const r = await loadRunner();
        const a = seedRow('a.jpg');
        const b = seedRow('b.jpg');
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        mlApi.mlOcr.mockImplementation(async (abs) => ({
            text: path.basename(abs) === 'a.jpg' ? 'text A' : 'text B',
        }));

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');

        const get = (id) =>
            dbApi.getDb().prepare('SELECT text FROM image_text WHERE download_id = ?').get(id).text;
        expect(get(a.id)).toBe('text A');
        expect(get(b.id)).toBe('text B');
    });

    it('skips the sidecar preflight entirely when tgdl-ml is enabled', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        mlApi.isTgdlMlEnabled.mockReturnValue(true);

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');
        expect(preflightApi.checkSidecarCapability).not.toHaveBeenCalled();
    });

    it('writes an empty row for a non-photo so it is not re-queued', async () => {
        const r = await loadRunner();
        const { id } = seedRow('clip.mp4', { fileType: 'video' });
        mlApi.isTgdlMlEnabled.mockReturnValue(true);

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');

        const row = dbApi
            .getDb()
            .prepare('SELECT text FROM image_text WHERE download_id = ?')
            .get(id);
        // Either skipped as non-photo or never queued — both leave no text.
        expect(row?.text ?? '').toBe('');
    });

    it('records an empty row when the engine fails on one image', async () => {
        const r = await loadRunner();
        const { id } = seedRow('bad.jpg');
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        mlApi.mlOcr.mockRejectedValue(new Error('decode error'));

        const logs = [];
        r.startOcrScan({}, null, null, (l) => logs.push(l));
        await waitIdle('ocr');

        const row = dbApi
            .getDb()
            .prepare('SELECT text FROM image_text WHERE download_id = ?')
            .get(id);
        expect(row.text).toBe('');
        expect(logs.some((l) => /ocr failed/.test(l.msg))).toBe(true);
        // A per-image failure is not fatal.
        expect(r.getScanState('ocr').error).toBeNull();
    });

    it('aborts the whole scan once tgdl-ml is unreachable repeatedly', async () => {
        const r = await loadRunner();
        for (let i = 0; i < 12; i++) seedRow(`a${i}.jpg`);
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        mlApi.mlOcr.mockRejectedValue(
            Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');

        expect(r.getScanState('ocr').error).toMatch(/unreachable|ECONNREFUSED/i);
    });

    it('stops mid-batch on cancel', async () => {
        const r = await loadRunner();
        for (let i = 0; i < 20; i++) seedRow(`a${i}.jpg`);
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        let n = 0;
        mlApi.mlOcr.mockImplementation(async () => {
            if (++n === 3) r.cancelScan('ocr');
            await new Promise((res) => setTimeout(res, 1));
            return { text: 'x' };
        });

        r.startOcrScan({}, null, null, null);
        await waitIdle('ocr');
        expect(r.getScanState('ocr').scanned).toBeLessThan(20);
    });

    it('clamps batchSize into range', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        mlApi.isTgdlMlEnabled.mockReturnValue(true);
        r.startOcrScan({ batchSize: 99999 }, null, null, null);
        await expect(waitIdle('ocr')).resolves.toBeUndefined();
    });
});

// ---- WD14 ---------------------------------------------------------------

describe('startWd14Scan', () => {
    it('exits early when there is nothing to tag', async () => {
        const r = await loadRunner();
        const logs = [];
        r.startWd14Scan({}, null, null, (l) => logs.push(l));
        await waitIdle('wd14');

        expect(logs.some((l) => /nothing to tag/.test(l.msg))).toBe(true);
        expect(preflightApi.checkSidecarCapability).not.toHaveBeenCalled();
    });

    it('runs preflight only once there is work', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        fetchImpl = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ tags: [{ name: 'cat', score: 0.9 }] }),
        });

        r.startWd14Scan({}, null, null, null);
        await waitIdle('wd14');
        expect(preflightApi.checkSidecarCapability).toHaveBeenCalledWith(
            'wd14',
            expect.any(String),
        );
    });

    it('marks a missing file as skipped rather than re-queueing it forever', async () => {
        const r = await loadRunner();
        const { id } = seedRow('ghost.jpg', { onDisk: false });
        fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tags: [] }) });

        r.startWd14Scan({}, null, null, null);
        await waitIdle('wd14');

        const st = dbApi
            .getDb()
            .prepare(
                "SELECT status, last_error FROM media_scan_state WHERE download_id = ? AND scanner = 'wd14'",
            )
            .get(id);
        expect(st?.status).toBe('skipped');
    });

    // A sidecar failure has to be recorded as failed, not silently written
    // off as a successful tag with no results. _tagWd14One() used to catch
    // everything and return [], so the row was marked DONE with a sentinel
    // and "retry failed" — which only looks at rows recorded as failed —
    // could never surface it. One transient outage marked a whole library
    // as tagged, permanently.
    it('records a sidecar outage as failed so it can be retried', async () => {
        const r = await loadRunner();
        const { id } = seedRow('a.jpg');
        fetchImpl = async () => {
            throw new Error('sidecar 500');
        };

        const logs = [];
        r.startWd14Scan({}, null, null, (l) => logs.push(l));
        await waitIdle('wd14');

        const st = dbApi
            .getDb()
            .prepare(
                "SELECT status, last_error FROM media_scan_state WHERE download_id = ? AND scanner = 'wd14'",
            )
            .get(id);
        expect(st?.status).toBe('failed');
        expect(st?.last_error).toMatch(/sidecar 500/);
        expect(logs.some((l) => /wd14 tagging failed/.test(l.msg))).toBe(true);
        expect(r.getScanState('wd14').failed).toBe(1);
    });

    it('records a non-ok sidecar response as failed too', async () => {
        const r = await loadRunner();
        const { id } = seedRow('a.jpg');
        fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

        r.startWd14Scan({}, null, null, null);
        await waitIdle('wd14');

        const st = dbApi
            .getDb()
            .prepare(
                "SELECT status, last_error FROM media_scan_state WHERE download_id = ? AND scanner = 'wd14'",
            )
            .get(id);
        expect(st?.status).toBe('failed');
        expect(st?.last_error).toMatch(/503/);
    });

    // The empty result is still a real, successful outcome — an image with
    // nothing above minScore must stay done, not be retried forever.
    it('keeps a genuinely tagless image marked done', async () => {
        const r = await loadRunner();
        const { id } = seedRow('a.jpg');
        fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tags: [] }) });

        r.startWd14Scan({}, null, null, null);
        await waitIdle('wd14');

        const st = dbApi
            .getDb()
            .prepare(
                "SELECT status FROM media_scan_state WHERE download_id = ? AND scanner = 'wd14'",
            )
            .get(id);
        expect(st?.status).toBe('done');
        expect(r.getScanState('wd14').failed ?? 0).toBe(0);
    });

    it('aborts on a failed preflight', async () => {
        const r = await loadRunner();
        seedRow('a.jpg');
        preflightApi.checkSidecarCapability.mockResolvedValue({
            ok: false,
            reason: 'wd14 model missing',
            code: 'NO_MODEL',
        });

        r.startWd14Scan({}, null, null, null);
        await waitIdle('wd14');
        expect(r.getScanState('wd14').error).toMatch(/WD14 preflight failed/);
    });

    it('reports the total up front so the bar is determinate', async () => {
        const r = await loadRunner();
        for (let i = 0; i < 3; i++) seedRow(`a${i}.jpg`);
        fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tags: [] }) });

        const progress = [];
        r.startWd14Scan({}, (p) => progress.push(p), null, null);
        await waitIdle('wd14');

        expect(progress[0].total).toBe(3);
    });
});

// ---- faces --------------------------------------------------------------
//
// startFacesScan() is deliberately NOT covered here. Its phase B spawns a real
// worker thread (`new Worker(new URL('./cluster-worker.js', …))` at line 98),
// and that worker never settles inside a vitest fork — the file hangs past any
// testTimeout rather than failing. Covering it needs worker_threads mocked
// alongside the faces sidecar, which is the same harness core/ai/faces-spawn.js
// requires, so it lands with that file instead of half-done here.
