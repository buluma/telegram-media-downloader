// Covers src/core/nsfw.js — the NSFW classifier wrapper: the batch scan loop
// (progress, cancel, concurrency, error funnelling), score interpretation
// across model label vocabularies, the post-download background queue, and
// the hash-blocklist auto-delete path.
//
// `@huggingface/transformers` is the only mocked dependency — it is a ~10 MB
// WASM/ONNX runtime that downloads models from HuggingFace on first use.
// Everything underneath stays real: core/db.js against an isolated
// TGDL_DATA_DIR, core/checksum.js hashing actual bytes, and
// core/delete-queue.js moving actual files into the trash tree, which is what
// makes the blocklist auto-delete assertions meaningful.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-nsfw-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

// ---- transformers double ------------------------------------------------

const pipelineCalls = [];
// Per-path scores the fake classifier hands back. Anything unlisted scores 0.
let scoreByPath = new Map();
let pipelineImpl = null;
let classifyImpl = null;

const envDouble = { backends: { onnx: { wasm: {} } } };

vi.mock('@huggingface/transformers', () => ({
    env: envDouble,
    pipeline: async (task, modelId, opts) => {
        pipelineCalls.push({ task, modelId, opts });
        if (pipelineImpl) return pipelineImpl(task, modelId, opts);
        const cls = async (absPath) => {
            if (classifyImpl) return classifyImpl(absPath);
            const score = scoreByPath.get(path.basename(absPath)) ?? 0;
            return [
                { label: 'nsfw', score },
                { label: 'normal', score: 1 - score },
            ];
        };
        cls.dispose = vi.fn(async () => {});
        return cls;
    },
}));

// ---- harness ------------------------------------------------------------

let dbApi;
let downloadsApi;
let manager;

async function loadNsfw() {
    vi.resetModules();
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../src/core/db/downloads.js');
    manager = await import('../src/config/manager.js');
    return import('../src/core/nsfw.js');
}

function cfg(overrides = {}) {
    return {
        model: 'test/model',
        dtype: 'q8',
        threshold: 0.6,
        concurrency: 1,
        fileTypes: ['photo'],
        cacheDir: path.join(DATA_DIR, 'models'),
        batchSize: 50,
        ...overrides,
    };
}

/** Write a real file under downloads/ and insert the matching row. */
function seedPhoto(name, { fileType = 'photo', bytes = null } = {}) {
    const rel = `G/photos/${name}`;
    const abs = path.join(DOWNLOADS_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes ?? `bytes-of-${name}`);
    const r = downloadsApi.insertDownload({
        groupId: '-100123',
        groupName: 'G',
        messageId: Math.floor(Math.random() * 1e9),
        fileName: name,
        fileType,
        filePath: rel,
    });
    return { id: Number(r.lastInsertRowid), abs, rel };
}

/** preloadClassifier() is fire-and-forget — poll until the load settles. */
async function waitReady(nsfw, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const st = nsfw.classifierReady();
        if (st.state === 'ready' || st.state === 'error') return st;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('classifier did not settle in time');
}

/** Poll until the scan reports finished, or fail loudly. */
async function waitDone(nsfw, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!nsfw.isScanRunning()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('scan did not finish in time');
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
    pipelineCalls.length = 0;
    scoreByPath = new Map();
    pipelineImpl = null;
    classifyImpl = null;
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
});

afterEach(() => {
    try {
        const db = dbApi?.getDb();
        db?.prepare('DELETE FROM downloads').run();
        db?.prepare('DELETE FROM nsfw_hash_blocklist').run();
    } catch {
        /* db may be closed */
    }
});

// ---- defaults -----------------------------------------------------------

describe('NSFW defaults', () => {
    it('exposes a frozen default set', async () => {
        const nsfw = await loadNsfw();
        expect(nsfw.NSFW_DEFAULTS.model).toBe('AdamCodd/vit-base-nsfw-detector');
        expect(nsfw.NSFW_DEFAULTS.dtype).toBe('q8');
        expect(nsfw.NSFW_DEFAULTS.fileTypes).toEqual(['photo']);
        expect(Object.isFrozen(nsfw.NSFW_DEFAULTS)).toBe(true);
    });

    it('lists model suggestions without closing the field', async () => {
        const nsfw = await loadNsfw();
        expect(nsfw.NSFW_MODEL_SUGGESTIONS).toContain('AdamCodd/vit-base-nsfw-detector');
        expect(Object.isFrozen(nsfw.NSFW_MODEL_SUGGESTIONS)).toBe(true);
    });
});

// ---- classifier loading -------------------------------------------------

describe('classifier loading', () => {
    it('requests the image-classification pipeline for the configured model', async () => {
        const nsfw = await loadNsfw();
        await nsfw.preloadClassifier(cfg({ model: 'owner/custom' }));
        await waitReady(nsfw);

        expect(pipelineCalls[0].task).toBe('image-classification');
        expect(pipelineCalls[0].modelId).toBe('owner/custom');
        expect(nsfw.classifierReady().ready).toBe(true);
    });

    it('points the runtime cache at the configured directory', async () => {
        const nsfw = await loadNsfw();
        const dir = path.join(DATA_DIR, 'models-custom');
        await nsfw.preloadClassifier(cfg({ cacheDir: dir }));
        await waitReady(nsfw);
        expect(envDouble.cacheDir).toBe(dir);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('reuses the pipeline for a repeat load of the same model+dtype', async () => {
        const nsfw = await loadNsfw();
        await nsfw.preloadClassifier(cfg());
        await waitReady(nsfw);
        await nsfw.preloadClassifier(cfg());
        await waitReady(nsfw);
        expect(pipelineCalls).toHaveLength(1);
    });

    it('rebuilds the pipeline when the dtype changes', async () => {
        const nsfw = await loadNsfw();
        await nsfw.preloadClassifier(cfg({ dtype: 'q8' }));
        await waitReady(nsfw);
        await nsfw.preloadClassifier(cfg({ dtype: 'fp16' }));
        await waitReady(nsfw);
        expect(pipelineCalls).toHaveLength(2);
    });

    it('falls back to the default dtype for an unknown value', async () => {
        const nsfw = await loadNsfw();
        await nsfw.preloadClassifier(cfg({ dtype: 'wat' }));
        await waitReady(nsfw);
        expect(pipelineCalls[0].opts.dtype).toBe('q8');
    });

    // disposeClassifier() drops the pipeline, so the reported state has to
    // drop with it — clearClassifierCache() already resets _loadState, and a
    // dispose that left it saying 'ready' would have the maintenance UI show
    // a loaded model that is no longer in memory.
    it('reports not-ready after disposal', async () => {
        const nsfw = await loadNsfw();
        await nsfw.preloadClassifier(cfg());
        await waitReady(nsfw);
        expect(nsfw.classifierReady().ready).toBe(true);
        await nsfw.disposeClassifier();
        expect(nsfw.classifierReady().ready).toBe(false);
    });

    it('disposal is safe with nothing loaded', async () => {
        const nsfw = await loadNsfw();
        await expect(nsfw.disposeClassifier()).resolves.toBeUndefined();
    });
});

// ---- score interpretation ----------------------------------------------

describe('score interpretation', () => {
    async function scoreOf(labels) {
        const nsfw = await loadNsfw();
        classifyImpl = async () => labels;
        const { id } = seedPhoto('a.jpg');
        await nsfw.startScan(cfg(), null, null, null, null);
        await waitDone(nsfw);
        return dbApi.getDb().prepare('SELECT nsfw_score FROM downloads WHERE id = ?').get(id);
    }

    it('recognises every label vocabulary the models use', async () => {
        for (const label of ['nsfw', 'porn', 'hentai', 'sexy', 'explicit', 'adult']) {
            const row = await scoreOf([{ label, score: 0.9 }]);
            expect(row.nsfw_score, label).toBeCloseTo(0.9);
        }
    });

    it('is case-insensitive about labels', async () => {
        const row = await scoreOf([{ label: 'NSFW', score: 0.8 }]);
        expect(row.nsfw_score).toBeCloseTo(0.8);
    });

    it('takes the highest matching label when several match', async () => {
        const row = await scoreOf([
            { label: 'porn', score: 0.3 },
            { label: 'hentai', score: 0.7 },
        ]);
        expect(row.nsfw_score).toBeCloseTo(0.7);
    });

    it('scores zero when no label matches', async () => {
        const row = await scoreOf([{ label: 'neutral', score: 0.99 }]);
        expect(row.nsfw_score).toBe(0);
    });

    it('records a null score when the classifier throws on a file', async () => {
        const nsfw = await loadNsfw();
        classifyImpl = async () => {
            throw new Error('corrupt jpeg');
        };
        const { id } = seedPhoto('a.jpg');
        await nsfw.startScan(cfg(), null, null, null, null);
        await waitDone(nsfw);

        const row = dbApi
            .getDb()
            .prepare('SELECT nsfw_score, nsfw_checked_at FROM downloads WHERE id = ?')
            .get(id);
        expect(row.nsfw_score).toBeNull();
        // Still marked as checked so the row is not retried forever.
        expect(row.nsfw_checked_at).not.toBeNull();
    });
});

// ---- scan loop ----------------------------------------------------------

describe('startScan', () => {
    it('scores every eligible row and splits them at the threshold', async () => {
        const nsfw = await loadNsfw();
        seedPhoto('safe.jpg');
        seedPhoto('spicy.jpg');
        scoreByPath.set('spicy.jpg', 0.95);
        scoreByPath.set('safe.jpg', 0.1);

        const done = [];
        await nsfw.startScan(cfg({ threshold: 0.6 }), null, (d) => done.push(d), null, null);
        await waitDone(nsfw);

        expect(done[0].scanned).toBe(2);
        expect(done[0].keep).toBe(1); // >= threshold
        expect(done[0].candidates).toBe(1); // below threshold, surfaced for review
        expect(done[0].error).toBeNull();
    });

    // The final payload recomputes keep/candidates from the DB, so the
    // in-loop counters are only ever visible in mid-scan progress events.
    // Assert one of those directly, otherwise the running split is untested.
    it('splits keep vs candidates in the live progress counters', async () => {
        const nsfw = await loadNsfw();
        for (let i = 0; i < 6; i++) seedPhoto(`p${i}.jpg`);
        // Alternate above/below the threshold.
        for (let i = 0; i < 6; i++) scoreByPath.set(`p${i}.jpg`, i % 2 === 0 ? 0.95 : 0.05);

        // Progress broadcasts are throttled to one per 500ms, so an instant
        // classifier produces no mid-scan event at all — pace it out.
        classifyImpl = async (abs) => {
            await new Promise((r) => setTimeout(r, 200));
            const score = scoreByPath.get(path.basename(abs)) ?? 0;
            return [{ label: 'nsfw', score }];
        };

        const progress = [];
        await nsfw.startScan(
            cfg({ threshold: 0.6 }),
            (p) => progress.push({ ...p }),
            null,
            null,
            null,
        );
        await waitDone(nsfw, 8000);

        const mid = progress.filter((p) => p.running && p.scanned > 0);
        expect(mid.length).toBeGreaterThan(0);
        const last = mid[mid.length - 1];
        expect(last.keep + last.candidates).toBe(last.scanned);
        expect(last.keep).toBeGreaterThan(0);
        expect(last.candidates).toBeGreaterThan(0);
    });

    it('refuses to start a second scan while one is in flight', async () => {
        const nsfw = await loadNsfw();
        seedPhoto('a.jpg');
        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        classifyImpl = async () => {
            await gate;
            return [{ label: 'nsfw', score: 0.1 }];
        };

        const first = await nsfw.startScan(cfg(), null, null, null, null);
        const second = await nsfw.startScan(cfg(), null, null, null, null);

        expect(first).toEqual({ started: true });
        expect(second).toEqual({ alreadyRunning: true });
        release();
        await waitDone(nsfw);
    });

    it('reports nothing to do on an empty library', async () => {
        const nsfw = await loadNsfw();
        const logs = [];
        await nsfw.startScan(cfg(), null, null, null, (l) => logs.push(l));
        await waitDone(nsfw);
        expect(logs.some((l) => /nothing to scan/.test(l.msg))).toBe(true);
    });

    it('skips file types outside the configured set', async () => {
        const nsfw = await loadNsfw();
        seedPhoto('clip.mp4', { fileType: 'video' });
        const done = [];
        await nsfw.startScan(cfg({ fileTypes: ['photo'] }), null, (d) => done.push(d), null, null);
        await waitDone(nsfw);
        expect(done[0].scanned).toBe(0);
    });

    it('funnels a classifier load failure into the done payload', async () => {
        const nsfw = await loadNsfw();
        seedPhoto('a.jpg');
        pipelineImpl = async () => {
            throw new Error('model 404');
        };

        const done = [];
        const logs = [];
        await nsfw.startScan(
            cfg(),
            null,
            (d) => done.push(d),
            null,
            (l) => logs.push(l),
        );
        await waitDone(nsfw);

        expect(done[0].error).toMatch(/model 404/);
        expect(done[0].running).toBe(false);
        expect(logs.some((l) => l.level === 'error')).toBe(true);
        expect(nsfw.isScanRunning()).toBe(false);
    });

    it('emits progress as it goes', async () => {
        const nsfw = await loadNsfw();
        for (let i = 0; i < 3; i++) seedPhoto(`a${i}.jpg`);
        const progress = [];
        await nsfw.startScan(cfg(), (p) => progress.push(p), null, null, null);
        await waitDone(nsfw);
        expect(progress.length).toBeGreaterThan(0);
        expect(progress[progress.length - 1].scanned).toBe(3);
    });

    it('cancel stops the loop and settles the state', async () => {
        const nsfw = await loadNsfw();
        for (let i = 0; i < 25; i++) seedPhoto(`a${i}.jpg`);
        let seen = 0;
        classifyImpl = async () => {
            seen++;
            if (seen === 3) nsfw.cancelScan();
            await new Promise((r) => setTimeout(r, 1));
            return [{ label: 'nsfw', score: 0.9 }];
        };

        const done = [];
        await nsfw.startScan(cfg({ batchSize: 5 }), null, (d) => done.push(d), null, null);
        await waitDone(nsfw);

        expect(done[0].scanned).toBeLessThan(25);
        expect(nsfw.isScanRunning()).toBe(false);
    });

    it('cancel is a no-op when nothing is running', async () => {
        const nsfw = await loadNsfw();
        expect(nsfw.cancelScan()).toBe(false);
    });

    it('processes rows in parallel chunks when concurrency > 1', async () => {
        const nsfw = await loadNsfw();
        for (let i = 0; i < 4; i++) seedPhoto(`a${i}.jpg`);
        let inFlight = 0;
        let peak = 0;
        classifyImpl = async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return [{ label: 'nsfw', score: 0.9 }];
        };

        await nsfw.startScan(cfg({ concurrency: 3 }), null, null, null, null);
        await waitDone(nsfw);
        expect(peak).toBeGreaterThan(1);
    });

    it('clamps concurrency and batch size to sane bounds', async () => {
        const nsfw = await loadNsfw();
        seedPhoto('a.jpg');
        // Absurd values must not throw or hang.
        await nsfw.startScan(cfg({ concurrency: 9999, batchSize: 99999 }), null, null, null, null);
        await waitDone(nsfw);
        expect(nsfw.isScanRunning()).toBe(false);
    });

    it('scores a row whose stored path carries a legacy data/downloads prefix', async () => {
        const nsfw = await loadNsfw();
        const abs = path.join(DOWNLOADS_DIR, 'G/photos/legacy.jpg');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'bytes');
        const r = downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'G',
            messageId: 1,
            fileName: 'legacy.jpg',
            fileType: 'photo',
            filePath: 'data/downloads/G/photos/legacy.jpg',
        });
        scoreByPath.set('legacy.jpg', 0.8);

        await nsfw.startScan(cfg(), null, null, null, null);
        await waitDone(nsfw);

        const row = dbApi
            .getDb()
            .prepare('SELECT nsfw_score FROM downloads WHERE id = ?')
            .get(Number(r.lastInsertRowid));
        expect(row.nsfw_score).toBeCloseTo(0.8);
    });

    it('marks a row whose file is missing as checked with a null score', async () => {
        const nsfw = await loadNsfw();
        const { id, abs } = seedPhoto('gone.jpg');
        fs.unlinkSync(abs);

        await nsfw.startScan(cfg(), null, null, null, null);
        await waitDone(nsfw);

        const row = dbApi
            .getDb()
            .prepare('SELECT nsfw_score, nsfw_checked_at FROM downloads WHERE id = ?')
            .get(id);
        expect(row.nsfw_score).toBeNull();
        expect(row.nsfw_checked_at).not.toBeNull();
    });
});

describe('getScanState', () => {
    it('merges live scan state with the db-derived counts', async () => {
        const nsfw = await loadNsfw();
        seedPhoto('a.jpg');
        const state = nsfw.getScanState(cfg({ threshold: 0.42 }));
        expect(state.running).toBe(false);
        expect(state.threshold).toBe(0.42);
        expect(state.model).toBe('test/model');
        expect(typeof state.totalEligible).toBe('number');
    });
});

// ---- background queue ---------------------------------------------------

describe('pregenerateNsfw', () => {
    async function enableNsfw({ enabled = true, blocklistEnabled = false } = {}) {
        const live = manager.loadConfig();
        live.advanced = {
            ...live.advanced,
            nsfw: {
                ...cfg(),
                enabled,
                blocklistEnabled,
            },
        };
        manager.saveConfig(live);
    }

    async function settle(ms = 300) {
        await new Promise((r) => setTimeout(r, ms));
    }

    it('scores a freshly-downloaded row', async () => {
        const nsfw = await loadNsfw();
        await enableNsfw();
        const { id } = seedPhoto('new.jpg');
        scoreByPath.set('new.jpg', 0.77);

        nsfw.pregenerateNsfw(id);
        await settle();

        const row = dbApi.getDb().prepare('SELECT nsfw_score FROM downloads WHERE id = ?').get(id);
        expect(row.nsfw_score).toBeCloseTo(0.77);
    });

    it('does nothing when both the scan and the blocklist are off', async () => {
        const nsfw = await loadNsfw();
        await enableNsfw({ enabled: false, blocklistEnabled: false });
        const { id } = seedPhoto('new.jpg');

        nsfw.pregenerateNsfw(id);
        await settle();

        const row = dbApi
            .getDb()
            .prepare('SELECT nsfw_checked_at FROM downloads WHERE id = ?')
            .get(id);
        expect(row.nsfw_checked_at).toBeNull();
        expect(pipelineCalls).toHaveLength(0);
    });

    it('skips a row that already carries a score', async () => {
        const nsfw = await loadNsfw();
        await enableNsfw();
        const { id } = seedPhoto('done.jpg');
        dbApi
            .getDb()
            .prepare('UPDATE downloads SET nsfw_score = 0.5, nsfw_checked_at = 123 WHERE id = ?')
            .run(id);

        nsfw.pregenerateNsfw(id);
        await settle();

        const row = dbApi
            .getDb()
            .prepare('SELECT nsfw_score, nsfw_checked_at FROM downloads WHERE id = ?')
            .get(id);
        expect(row.nsfw_checked_at).toBe(123);
    });

    it('ignores an unknown id', async () => {
        const nsfw = await loadNsfw();
        await enableNsfw();
        expect(() => nsfw.pregenerateNsfw(999999)).not.toThrow();
        await settle();
    });

    it('drops work rather than growing the queue without bound', async () => {
        const nsfw = await loadNsfw();
        await enableNsfw({ enabled: false, blocklistEnabled: false });
        for (let i = 0; i < 500; i++) nsfw.pregenerateNsfw(i + 1);
        await settle();
        // Nothing to assert beyond "did not blow up or hang" — the cap is a
        // memory guard on a fire-and-forget path.
        expect(nsfw.isScanRunning()).toBe(false);
    });
});

// ---- hash blocklist -----------------------------------------------------

describe('hash blocklist auto-delete', () => {
    async function enableBlocklist() {
        const live = manager.loadConfig();
        live.advanced = {
            ...live.advanced,
            nsfw: { ...cfg(), enabled: false, blocklistEnabled: true },
        };
        manager.saveConfig(live);
    }

    it('deletes a re-downloaded file whose hash is on the blocklist', async () => {
        const nsfw = await loadNsfw();
        await enableBlocklist();

        const { id, abs } = seedPhoto('banned.jpg', { bytes: 'known-bad-bytes' });
        const { sha256OfFile } = await import('../src/core/checksum.js');
        const hash = await sha256OfFile(abs);
        dbApi
            .getDb()
            .prepare(
                'INSERT INTO nsfw_hash_blocklist (file_hash, file_name, deleted_at, source) VALUES (?, ?, ?, ?)',
            )
            .run(hash, 'banned.jpg', Date.now(), 'test');

        const removed = [];
        nsfw.setBlocklistDeleteCallback((rid) => removed.push(rid));

        nsfw.pregenerateNsfw(id);
        await new Promise((r) => setTimeout(r, 400));

        expect(removed).toEqual([id]);
        expect(
            dbApi.getDb().prepare('SELECT 1 FROM downloads WHERE id = ?').get(id),
        ).toBeUndefined();
        expect(fs.existsSync(abs)).toBe(false);
    });

    it('leaves a file whose hash is not on the blocklist', async () => {
        const nsfw = await loadNsfw();
        await enableBlocklist();
        const { id, abs } = seedPhoto('fine.jpg');

        const removed = [];
        nsfw.setBlocklistDeleteCallback((rid) => removed.push(rid));

        nsfw.pregenerateNsfw(id);
        await new Promise((r) => setTimeout(r, 400));

        expect(removed).toEqual([]);
        expect(fs.existsSync(abs)).toBe(true);
    });

    it('backfills the file hash so later checks skip the read', async () => {
        const nsfw = await loadNsfw();
        await enableBlocklist();
        const { id } = seedPhoto('hashme.jpg');

        nsfw.pregenerateNsfw(id);
        await new Promise((r) => setTimeout(r, 400));

        const row = dbApi.getDb().prepare('SELECT file_hash FROM downloads WHERE id = ?').get(id);
        expect(row.file_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('accepts being handed a non-function callback', async () => {
        const nsfw = await loadNsfw();
        expect(() => nsfw.setBlocklistDeleteCallback(null)).not.toThrow();
        expect(() => nsfw.setBlocklistDeleteCallback('nope')).not.toThrow();
    });
});

// ---- cache management ---------------------------------------------------

describe('clearClassifierCache', () => {
    it('removes the on-disk model cache and drops the pipeline', async () => {
        const nsfw = await loadNsfw();
        const dir = path.join(DATA_DIR, 'models-clear');
        await nsfw.preloadClassifier(cfg({ cacheDir: dir }));
        await waitReady(nsfw);
        fs.writeFileSync(path.join(dir, 'model.onnx'), 'weights');

        await nsfw.clearClassifierCache(cfg({ cacheDir: dir }));

        expect(fs.existsSync(path.join(dir, 'model.onnx'))).toBe(false);
        expect(nsfw.classifierReady().ready).toBe(false);
    });

    it('is a no-op when the cache directory is absent', async () => {
        const nsfw = await loadNsfw();
        await expect(
            nsfw.clearClassifierCache(cfg({ cacheDir: path.join(DATA_DIR, 'never-made') })),
        ).resolves.toBeDefined();
    });
});
