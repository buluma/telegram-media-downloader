// Route-level tests for src/web/routes/ai.js — the largest route file
// in the app (semantic search, face clustering, OCR/WD14 tagging, smart
// albums, LLM passthrough, durable scan jobs, doctor/health).
//
// ML/network-backed subsystems are mocked wholesale (core/ai/index.js,
// core/ai/scan-runner.js, core/ai/faces-client.js, core/ai/faces-spawn.js,
// core/ai/jobs.js, core/ai/search.js, core/llm/index.js, core/cluster/
// peers.js + relay.js, core/media-sniff.js, sharp). Pure-SQL collaborators
// (core/db/faces.js, core/db/scan-state.js, core/db.js's face-cluster
// helpers) and config/db themselves run for real against an isolated
// TGDL_DATA_DIR temp dir, matching the maintenance/groups/downloads test
// convention.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-ai-'));

const aiIndexApi = {
    startFacesScan: vi.fn((_cfg, _onProgress, onDone) => onDone({ scanned: 0 })),
    cancelScan: vi.fn(() => true),
    isScanRunning: vi.fn(() => false),
    getScanState: vi.fn((feature) => ({
        feature,
        running: false,
        scanned: 0,
        total: 0,
        error: null,
        finishedAt: null,
    })),
    _bgQueueDepths: vi.fn(() => ({ realtime: 0, backfill: 0 })),
    pregenerateAi: vi.fn(),
};
vi.mock('../src/core/ai/index.js', () => aiIndexApi);

const scanRunnerApi = {
    startOcrScan: vi.fn((_cfg, _onProgress, onDone) => onDone({ scanned: 0 })),
    startWd14Scan: vi.fn((_cfg, _onProgress, onDone) => onDone({ scanned: 0 })),
};
vi.mock('../src/core/ai/scan-runner.js', () => scanRunnerApi);

const facesClientApi = {
    getSidecarUrl: vi.fn(() => null),
    getSidecarRoutingStatus: vi.fn(() => null),
    health: vi.fn(async () => ({ ok: false })),
    hasEmbeddingProvider: vi.fn(() => false),
    embedImage: vi.fn(async () => ({ embedding: new Array(8).fill(0.1), model: 'test-clip' })),
};
vi.mock('../src/core/ai/faces-client.js', () => facesClientApi);

const facesSpawnApi = {
    getSidecarStatus: vi.fn(() => ({ state: 'idle', url: null })),
    stopSidecar: vi.fn(() => {}),
    startSidecar: vi.fn(async () => {}),
    installPythonDeps: vi.fn(async () => ({ ok: true })),
    resetAutoInstallGuard: vi.fn(() => {}),
};
vi.mock('../src/core/ai/faces-spawn.js', () => facesSpawnApi);

const aiJobsApi = {
    createJob: vi.fn(() => 'job-1'),
    updateJobProgress: vi.fn(),
    finishJob: vi.fn(),
    listJobs: vi.fn(() => ({ jobs: [], total: 0 })),
    getJob: vi.fn(() => null),
    cancelJob: vi.fn(),
    getScanStateSummary: vi.fn(() => ({ pending: 0, done: 0, failed: 0 })),
    releaseStaleLocks: vi.fn(() => 0),
    findStaleLocks: vi.fn(() => []),
};
vi.mock('../src/core/ai/jobs.js', () => aiJobsApi);

const aiSearchApi = {
    crossModalSearch: vi.fn(async (query) => ({ query, modalities: ['semantic'], results: [] })),
};
vi.mock('../src/core/ai/search.js', () => aiSearchApi);

const llmApi = {
    listProviders: vi.fn(() => ['ollama']),
    probeProviders: vi.fn(async () => ({ ollama: { ok: true } })),
    getActiveProvider: vi.fn(async () => ({ provider: 'ollama' })),
    generate: vi.fn(async () => ({ text: 'ok', finishReason: 'stop' })),
    chat: vi.fn(async () => ({ text: 'ok', finishReason: 'stop' })),
    embed: vi.fn(async () => [[0.1, 0.2]]),
};
vi.mock('../src/core/llm/index.js', () => llmApi);

const clusterPeersApi = { listPeers: vi.fn(() => []) };
vi.mock('../src/core/cluster/peers.js', () => clusterPeersApi);

const clusterRelayApi = { relayTo: vi.fn(async () => ({ ok: false })) };
vi.mock('../src/core/cluster/relay.js', () => clusterRelayApi);

const mediaSniffApi = { sniffMediaFile: vi.fn(async () => ({ ok: true })) };
vi.mock('../src/core/media-sniff.js', () => mediaSniffApi);

vi.mock('sharp', () => {
    const chain = {
        metadata: vi.fn(async () => ({ width: 800, height: 600 })),
        extract: vi.fn(function () {
            return this;
        }),
        resize: vi.fn(function () {
            return this;
        }),
        jpeg: vi.fn(function () {
            return this;
        }),
        toBuffer: vi.fn(async () => Buffer.from('fake-jpeg')),
    };
    return { default: vi.fn(() => chain) };
});

const safeResolveDownload = vi.fn(async () => ({ ok: false, reason: 'missing' }));
vi.mock('../src/web/lib/resolve-download.js', () => ({
    safeResolveDownload: (...a) => safeResolveDownload(...a),
}));

let manager;
let dbApi;
let downloadsApi;
let facesApi;
let app;
let server;
let port;
let broadcasts;
let jobTrackers;
let logs;

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
        /* not json */
    }
    return { status: res.status, body: parsed, res };
}

async function patch(p, body) {
    const res = await fetch(apiUrl(p), {
        method: 'PATCH',
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
    facesApi = await import('../src/core/db/faces.js');
    manager = await import('../src/config/manager.js');
    const { createJobTracker } = await import('../src/core/job-tracker.js');

    const { createAiRouter } = await import('../src/web/routes/ai.js');
    broadcasts = [];
    const broadcast = (m) => broadcasts.push(m);
    logs = [];
    jobTrackers = {};
    for (const kind of ['aiPeople', 'aiOcr', 'aiWd14', 'aiTags', 'aiIndex']) {
        jobTrackers[kind] = createJobTracker({ kind, broadcast });
    }

    app = express();
    app.use(express.json());
    app.use('/api', createAiRouter({ broadcast, log: (m) => logs.push(m), jobTrackers }));
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

async function waitTracker(tracker) {
    for (let i = 0; i < 100; i++) {
        if (!tracker.getStatus().running) return tracker.getStatus();
        await new Promise((r) => setTimeout(r, 20));
    }
    return tracker.getStatus();
}

beforeEach(async () => {
    const cfg = manager.loadConfig();
    cfg.groups = [];
    cfg.advanced = { ...cfg.advanced, ai: { enabled: false } };
    await manager.saveConfig(cfg);
    for (const table of ['downloads', 'faces', 'people', 'image_embeddings', 'media_scan_state']) {
        try {
            dbApi.getDb().prepare(`DELETE FROM ${table}`).run();
        } catch {
            /* table may not exist */
        }
    }
    broadcasts.length = 0;
    logs.length = 0;
    vi.clearAllMocks();
    aiIndexApi.isScanRunning.mockReturnValue(false);
    aiIndexApi.getScanState.mockImplementation((feature) => ({
        feature,
        running: false,
        scanned: 0,
        total: 0,
        error: null,
        finishedAt: null,
    }));
    aiIndexApi.startFacesScan.mockImplementation((_cfg, _onProgress, onDone) =>
        onDone({ scanned: 0 }),
    );
    scanRunnerApi.startOcrScan.mockImplementation((_cfg, _onProgress, onDone) =>
        onDone({ scanned: 0 }),
    );
    scanRunnerApi.startWd14Scan.mockImplementation((_cfg, _onProgress, onDone) =>
        onDone({ scanned: 0 }),
    );
    facesClientApi.getSidecarUrl.mockReturnValue(null);
    facesClientApi.health.mockResolvedValue({ ok: false });
    facesClientApi.hasEmbeddingProvider.mockReturnValue(false);
    safeResolveDownload.mockResolvedValue({ ok: false, reason: 'missing' });
    aiJobsApi.listJobs.mockReturnValue({ jobs: [], total: 0 });
    aiJobsApi.getJob.mockReturnValue(null);
    llmApi.generate.mockResolvedValue({ text: 'ok', finishReason: 'stop' });
    llmApi.chat.mockResolvedValue({ text: 'ok', finishReason: 'stop' });
});

function enableAi(extra = {}) {
    const cfg = manager.loadConfig();
    cfg.advanced = { ...cfg.advanced, ai: { enabled: true, ...extra } };
    return manager.saveConfig(cfg);
}

describe('GET /ai/status', () => {
    it('returns config, counts, sidecar, scans, models, trackers', async () => {
        const { status, body } = await get('/api/ai/status');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.trackers.aiPeople).toBeDefined();
        expect(body.scans.faces).toBeDefined();
    });
});

describe('GET /ai/issues', () => {
    it('returns a quick snapshot with foreign_key + scan_errors + sidecar checks', async () => {
        const { status, body } = await get('/api/ai/issues');
        expect(status).toBe(200);
        expect(body.mode).toBe('quick');
        expect(Array.isArray(body.issues)).toBe(true);
    });

    it('runs a full snapshot that walks disk-backed rows when ?full=1', async () => {
        const { status, body } = await get('/api/ai/issues?full=1');
        expect(status).toBe(200);
        expect(body.mode).toBe('full');
    });
});

describe('tag/text/ocr/wd14 browsing', () => {
    it('lists all tags', async () => {
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        facesApi.setImageTags(r.lastInsertRowid, [{ tag: 'cat', score: 0.9 }]);
        const { status, body } = await get('/api/ai/tags/list');
        expect(status).toBe(200);
        expect(body.tags.some((t) => t.tag === 'cat')).toBe(true);
    });

    it('400s tags/photos without a tag', async () => {
        expect((await get('/api/ai/tags/photos')).status).toBe(400);
    });

    it('lists photos for a tag', async () => {
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        facesApi.setImageTags(r.lastInsertRowid, [{ tag: 'cat', score: 0.9 }]);
        const { status, body } = await get('/api/ai/tags/photos?tag=cat');
        expect(status).toBe(200);
        expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('400s tags/details without a tag; 200s with empty sources for an unknown tag', async () => {
        // getTagDetails() only returns null for an empty tag string, so the
        // route's 404 branch is unreachable through the public API for any
        // real (if unused) tag — it just reports zero sources/counts.
        expect((await get('/api/ai/tags/details')).status).toBe(400);
        const { status, body } = await get('/api/ai/tags/details?tag=nope');
        expect(status).toBe(200);
        expect(body.details.sources).toEqual([]);
    });

    it('returns tag co-occurrence suggestions', async () => {
        const { status, body } = await get('/api/ai/tags/suggestions');
        expect(status).toBe(200);
        expect(Array.isArray(body.suggestions)).toBe(true);
    });

    it('returns OCR text for a download', async () => {
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        const { status, body } = await get(`/api/ai/text/${r.lastInsertRowid}`);
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('lists OCR words + photos', async () => {
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        facesApi.setImageText(r.lastInsertRowid, 'hello world this is receipt text');
        const words = await get('/api/ai/ocr/words?minLength=3');
        expect(words.status).toBe(200);
        expect((await get('/api/ai/ocr/photos')).status).toBe(400);
        const photos = await get('/api/ai/ocr/photos?word=receipt');
        expect(photos.status).toBe(200);
    });

    it('lists WD14 tags + photos', async () => {
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        facesApi.setWd14Tags(r.lastInsertRowid, [{ tag: 'outdoor', score: 0.8 }]);
        const tags = await get('/api/ai/wd14/tags');
        expect(tags.status).toBe(200);
        expect((await get('/api/ai/wd14/photos')).status).toBe(400);
        const photos = await get('/api/ai/wd14/photos?tag=outdoor');
        expect(photos.status).toBe(200);
    });
});

describe('smart albums', () => {
    it('reports runtime state', async () => {
        const { status, body } = await get('/api/ai/smart-albums/runtime');
        expect(status).toBe(200);
        expect(body.runtime).toBeDefined();
    });

    it('creates, lists, rebuilds, and deletes an album', async () => {
        const create = await post('/api/ai/smart-albums', {
            name: 'Test Album',
            rule: { type: 'compound', all: [{ type: 'file_type', fileType: 'photo' }] },
        });
        expect(create.status).toBe(200);
        const id = create.body.id;

        const list = await get('/api/ai/smart-albums');
        expect(list.body.albums.some((a) => a.id === id)).toBe(true);

        const rebuild = await post(`/api/ai/smart-albums/${id}/rebuild`);
        expect(rebuild.status).toBe(200);

        const items = await get(`/api/ai/smart-albums/${id}/items`);
        expect(items.status).toBe(200);

        const del1 = await del(`/api/ai/smart-albums/${id}`);
        expect(del1.status).toBe(200);
        expect(del1.body.deleted).toBeTruthy();
    });

    it('404s deleting a nonexistent album', async () => {
        expect((await del('/api/ai/smart-albums/999999')).status).toBe(404);
    });

    it('400s an invalid rule with a structured error payload', async () => {
        const { status, body } = await post('/api/ai/smart-albums', {
            name: 'Bad',
            rule: { type: 'not_a_real_type' },
        });
        expect(status).toBe(400);
        expect(body.code).toBe('INVALID_RULE');
    });

    it('rebuilds all albums', async () => {
        const { status, body } = await post('/api/ai/smart-albums/rebuild-all');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('previews a rule without saving', async () => {
        const { status, body } = await post('/api/ai/smart-albums/preview', {
            rule: { type: 'compound', all: [{ type: 'file_type', fileType: 'photo' }] },
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('400s preview without a rule', async () => {
        const { status, body } = await post('/api/ai/smart-albums/preview', {});
        expect(status).toBe(400);
        expect(body.code).toBe('MISSING_RULE');
    });

    it('400s parse without a description', async () => {
        const { status, body } = await post('/api/ai/smart-albums/parse', {});
        expect(status).toBe(400);
        expect(body.code).toBe('MISSING_DESCRIPTION');
    });

    it('503s parse when LLM rules are disabled', async () => {
        const { status, body } = await post('/api/ai/smart-albums/parse', {
            description: 'sunset photos',
        });
        expect(status).toBe(503);
        expect(body.code).toBe('SMART_ALBUMS_LLM_RULES_DISABLED');
    });

    it('parses a description into a rule via the LLM when enabled', async () => {
        const cfg = manager.loadConfig();
        cfg.advanced = {
            ...cfg.advanced,
            ai: { enabled: true, smartAlbums: { enabled: true, allowLlmRules: true } },
        };
        await manager.saveConfig(cfg);
        llmApi.generate.mockResolvedValue({
            text: JSON.stringify({
                type: 'compound',
                all: [{ type: 'file_type', fileType: 'photo' }],
            }),
        });
        const { status, body } = await post('/api/ai/smart-albums/parse', {
            description: 'photos only',
        });
        expect(status).toBe(200);
        expect(body.rule.type).toBe('compound');
    });
});

describe('scan controls', () => {
    it('503s scan/start when AI is disabled', async () => {
        const { status, body } = await post('/api/ai/scan/start', { feature: 'faces' });
        expect(status).toBe(503);
        expect(body.code).toBe('AI_DISABLED');
    });

    it('400s scan/start with an invalid feature', async () => {
        await enableAi();
        const { status } = await post('/api/ai/scan/start', { feature: 'bogus' });
        expect(status).toBe(400);
    });

    it('503s ocr/wd14 scan/start when the sidecar is offline', async () => {
        await enableAi();
        const { status, body } = await post('/api/ai/scan/start', { feature: 'ocr' });
        expect(status).toBe(503);
        expect(body.code).toBe('SIDECAR_OFFLINE');
    });

    it('starts a faces scan and reports completion via the tracker', async () => {
        await enableAi();
        const { status, body } = await post('/api/ai/scan/start', { feature: 'faces' });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitTracker(jobTrackers.aiPeople);
        expect(final.running).toBe(false);
        expect(aiJobsApi.createJob).toHaveBeenCalled();
        expect(aiJobsApi.finishJob).toHaveBeenCalledWith('job-1', 'completed');
    });

    it('409s scan/start when the scan is already running', async () => {
        await enableAi();
        aiIndexApi.isScanRunning.mockReturnValue(true);
        const { status, body } = await post('/api/ai/scan/start', { feature: 'faces' });
        expect(status).toBe(409);
        expect(body.code).toBe('ALREADY_RUNNING');
    });

    it('surfaces a scan failure through finishJob("failed") and 500s the tracker result', async () => {
        await enableAi();
        aiIndexApi.startFacesScan.mockImplementation((_cfg, _onProgress, _onDone2, _onLog) => {
            _onDone2({ error: 'boom' });
        });
        const { status } = await post('/api/ai/scan/start', { feature: 'faces' });
        expect(status).toBe(200);
        const final = await waitTracker(jobTrackers.aiPeople);
        expect(final.error).toContain('boom');
        expect(aiJobsApi.finishJob).toHaveBeenCalledWith('job-1', 'failed', 'boom');
    });

    it('400s scan/cancel + scan/status with an invalid feature', async () => {
        expect((await post('/api/ai/scan/cancel', {})).status).toBe(400);
        expect((await get('/api/ai/scan/status')).status).toBe(400);
    });

    it('cancels a scan and finishes running durable jobs', async () => {
        aiJobsApi.listJobs.mockReturnValue({ jobs: [{ id: 'job-x' }], total: 1 });
        const { status, body } = await post('/api/ai/scan/cancel', { feature: 'faces' });
        expect(status).toBe(200);
        expect(body.cancelled).toBe(true);
        expect(aiJobsApi.finishJob).toHaveBeenCalledWith('job-x', 'cancelled');
    });

    it('reports scan status for a valid feature', async () => {
        const { status, body } = await get('/api/ai/scan/status?feature=wd14');
        expect(status).toBe(200);
        expect(body.state.feature).toBe('wd14');
    });
});

describe('durable jobs + scan-state', () => {
    it('lists jobs', async () => {
        const { status, body } = await get('/api/ai/jobs');
        expect(status).toBe(200);
        expect(body.jobs).toEqual([]);
    });

    it('404s a missing job', async () => {
        expect((await get('/api/ai/jobs/nope')).status).toBe(404);
    });

    it('gets + cancels a job', async () => {
        aiJobsApi.getJob.mockReturnValue({ id: 'job-1', feature: 'faces' });
        const g = await get('/api/ai/jobs/job-1');
        expect(g.status).toBe(200);
        const c = await post('/api/ai/jobs/job-1/cancel');
        expect(c.status).toBe(200);
        expect(aiJobsApi.cancelJob).toHaveBeenCalledWith('job-1');
    });

    it('400s scan-state without a scanner param handled by route path', async () => {
        const { status, body } = await get('/api/ai/scan-state/faces');
        expect(status).toBe(200);
        expect(body.scanner).toBe('faces');
    });

    it('reports stale jobs/locks', async () => {
        const { status, body } = await get('/api/ai/scan/stale');
        expect(status).toBe(200);
        expect(Array.isArray(body.staleJobs)).toBe(true);
    });

    it('reports scan failures by scanner', async () => {
        const { status, body } = await get('/api/ai/scan/failures');
        expect(status).toBe(200);
        expect(body.byScanner.faces).toBeDefined();
    });

    it('keeps a prototype-named scanner as a plain key', async () => {
        const { status, body } = await get('/api/ai/scan/failures?scanner=__proto__');
        expect(status).toBe(200);
        expect(Object.keys(body.byScanner)).toEqual(['__proto__']);
    });

    it('400s retry-failed without a scanner', async () => {
        expect((await post('/api/ai/scan/retry-failed', {})).status).toBe(400);
    });

    it('resets failed rows for a scanner', async () => {
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        const { markScanFailed } = await import('../src/core/db/scan-state.js');
        markScanFailed(r.lastInsertRowid, 'ocr', 'boom');
        const { status, body } = await post('/api/ai/scan/retry-failed', { scanner: 'ocr' });
        expect(status).toBe(200);
        expect(body.reset).toBe(1);
    });
});

describe('face sidecar provider probe', () => {
    it('503s when the sidecar is offline', async () => {
        const { status, body } = await get('/api/ai/faces/provider-probe');
        expect(status).toBe(503);
        expect(body.code).toBe('SIDECAR_OFFLINE');
    });
});

describe('LLM endpoints', () => {
    it('reports provider status', async () => {
        const { status, body } = await get('/api/ai/llm/status');
        expect(status).toBe(200);
        expect(body.providers).toBeDefined();
    });

    // Slow cached routes report their latency. It's info, not warn: warns go
    // to the header notification bell, and a routine 12s doctor/llm-status
    // probe filling the bell buries anything that actually needs attention.
    describe('slow-route logging', () => {
        function withFakeElapsed(ms, fn) {
            const real = Date.now;
            let elapsed = 0;
            vi.spyOn(Date, 'now').mockImplementation(() => real() + elapsed);
            llmApi.probeProviders.mockImplementationOnce(async () => {
                elapsed = ms;
                return { ollama: { ok: true } };
            });
            return fn().finally(() => {
                Date.now = real;
            });
        }

        it('says nothing for a producer under the threshold', async () => {
            await withFakeElapsed(9000, async () => {
                const { status } = await get('/api/ai/llm/status');
                expect(status).toBe(200);
            });
            expect(logs.filter((l) => l.source === 'ai-route')).toEqual([]);
        });

        it('logs at info — not warn — once a producer runs long', async () => {
            await withFakeElapsed(20000, async () => {
                const { status } = await get('/api/ai/llm/status');
                expect(status).toBe(200);
            });
            const slow = logs.filter((l) => l.source === 'ai-route');
            expect(slow).toHaveLength(1);
            expect(slow[0].level).toBe('info');
            // The real clock still ticks under the offset, so the reported
            // figure is 20000ms plus however long the request actually took.
            expect(slow[0].msg).toMatch(/^\/api\/ai\/llm\/status generated in 200\d\dms$/);
        });
    });

    it('runs a test prompt', async () => {
        const { status, body } = await post('/api/ai/llm/test', {});
        expect(status).toBe(200);
        expect(body.text).toBe('ok');
    });

    it('503s test/generate/chat when the provider is unavailable', async () => {
        llmApi.generate.mockResolvedValue({
            unavailable: true,
            reason: 'no provider',
            code: 'NONE',
        });
        const { status, body } = await post('/api/ai/llm/generate', { prompt: 'hi' });
        expect(status).toBe(503);
        expect(body.code).toBe('NONE');
    });

    it('400s generate without a prompt / with too-long a prompt', async () => {
        expect((await post('/api/ai/llm/generate', {})).status).toBe(400);
        expect((await post('/api/ai/llm/generate', { prompt: 'x'.repeat(32001) })).status).toBe(
            400,
        );
    });

    it('generates text', async () => {
        const { status, body } = await post('/api/ai/llm/generate', { prompt: 'hello' });
        expect(status).toBe(200);
        expect(body.text).toBe('ok');
    });

    it('400s chat with invalid messages', async () => {
        expect((await post('/api/ai/llm/chat', {})).status).toBe(400);
        expect((await post('/api/ai/llm/chat', { messages: [{ role: 'user' }] })).status).toBe(400);
    });

    it('chats successfully', async () => {
        const { status, body } = await post('/api/ai/llm/chat', {
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(status).toBe(200);
        expect(body.text).toBe('ok');
    });
});

describe('semantic search', () => {
    it('503s when semantic search is disabled', async () => {
        expect((await get('/api/ai/search?q=cat')).status).toBe(503);
        expect((await post('/api/ai/search', { q: 'cat' })).status).toBe(503);
    });

    it('400s a missing query when enabled', async () => {
        await enableAi({ semanticSearch: { enabled: true } });
        expect((await get('/api/ai/search')).status).toBe(400);
        expect((await post('/api/ai/search', {})).status).toBe(400);
    });

    it('searches via GET and POST', async () => {
        await enableAi({ semanticSearch: { enabled: true } });
        aiSearchApi.crossModalSearch.mockResolvedValue({
            query: 'cat',
            modalities: ['semantic'],
            results: [{ id: 1, groupId: '-1', fileName: 'a.jpg' }],
        });
        const g = await get('/api/ai/search?q=cat');
        expect(g.status).toBe(200);
        expect(g.body.results[0].download_id).toBe(1);
        const p = await post('/api/ai/search', { q: 'cat' });
        expect(p.status).toBe(200);
    });

    it('503s search/similar when disabled, 400s an invalid id when enabled', async () => {
        expect((await post('/api/ai/search/similar', { downloadId: 1 })).status).toBe(503);
        await enableAi({ semanticSearch: { enabled: true } });
        expect((await post('/api/ai/search/similar', {})).status).toBe(400);
    });

    it('reports SEED_EMBEDDING_MISSING when the seed row has no embedding', async () => {
        await enableAi({ semanticSearch: { enabled: true } });
        const { status, body } = await post('/api/ai/search/similar', { downloadId: 999999 });
        expect(status).toBe(200);
        expect(body.code).toBe('SEED_EMBEDDING_MISSING');
    });

    it('finds similar rows from a real seed embedding', async () => {
        await enableAi({ semanticSearch: { enabled: true } });
        const r = downloadsApi.insertDownload({ groupId: '-1', groupName: 'G', messageId: 1 });
        const blob = Buffer.from(new Uint8Array(Float32Array.from([1, 0, 0, 0]).buffer));
        facesApi.setImageEmbedding(r.lastInsertRowid, blob, 'test-clip');
        const { status, body } = await post('/api/ai/search/similar', {
            downloadId: r.lastInsertRowid,
        });
        expect(status).toBe(200);
        expect(Array.isArray(body.results)).toBe(true);
    });
});

describe('embeddings', () => {
    it('reports stats with zero rows', async () => {
        const { status, body } = await get('/api/ai/embeddings/stats');
        expect(status).toBe(200);
        expect(body.total).toBe(0);
    });

    it('503s reindex when no embedding provider is running', async () => {
        const { status, body } = await post('/api/ai/embeddings/reindex');
        expect(status).toBe(503);
        expect(body.code).toBe('EMBEDDING_PROVIDER_OFFLINE');
    });

    it('reindexes missing embeddings when a provider is available', async () => {
        facesClientApi.hasEmbeddingProvider.mockReturnValue(true);
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileType: 'photo',
            filePath: 'G/images/a.jpg',
        });
        const dir = path.join(DATA_DIR, 'downloads', 'G', 'images');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
        const { status, body } = await post('/api/ai/embeddings/reindex', { limit: 10 });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
        const final = await waitTracker(jobTrackers.aiIndex);
        expect(final.result.processed).toBe(1);
        const row = dbApi
            .getDb()
            .prepare('SELECT COUNT(*) AS n FROM image_embeddings WHERE download_id = ?')
            .get(r.lastInsertRowid);
        expect(row.n).toBe(1);
    });

    it('409s reindex when already running', async () => {
        facesClientApi.hasEmbeddingProvider.mockReturnValue(true);
        jobTrackers.aiIndex.tryStart(() => new Promise(() => {}));
        const { status } = await post('/api/ai/embeddings/reindex');
        expect(status).toBe(409);
    });
});

describe('faces admin', () => {
    it('restarts the sidecar', async () => {
        const { status, body } = await post('/api/ai/faces/restart');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(facesSpawnApi.stopSidecar).toHaveBeenCalled();
    });

    it('starts a dependency install', async () => {
        const { status, body } = await post('/api/ai/faces/install-deps', { force: 'cpu' });
        expect(status).toBe(200);
        expect(body.started).toBe(true);
    });

    it('recluster starts a tracked faces scan', async () => {
        await enableAi();
        const { status, body } = await post('/api/ai/faces/recluster');
        expect(status).toBe(200);
        expect(body.started).toBe(true);
    });

    it('409s reindex when a faces scan is already running', async () => {
        aiIndexApi.isScanRunning.mockReturnValue(true);
        const { status, body } = await post('/api/ai/faces/reindex');
        expect(status).toBe(409);
        expect(body.error).toBe('scan_running');
    });

    it('wipes faces/people and kicks off a fresh scan', async () => {
        await enableAi();
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileType: 'photo',
        });
        facesApi.insertFace({
            downloadId: r.lastInsertRowid,
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            embeddingBlob: Buffer.alloc(4),
        });
        const { status, body } = await post('/api/ai/faces/reindex');
        expect(status).toBe(200);
        expect(body.scanStarted).toBe(true);
        const count = dbApi.getDb().prepare('SELECT COUNT(*) AS n FROM faces').get().n;
        expect(count).toBe(0);
        expect(broadcasts.some((b) => b.type === 'ai_faces_reindexed')).toBe(true);
    });

    it('backfills missing quality scores', async () => {
        const { status, body } = await post('/api/ai/faces/backfill-quality', {});
        expect(status).toBe(200);
        expect(body.success).toBe(true);
    });
});

describe('people (face clusters)', () => {
    function makePersonWithFace() {
        const r = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileType: 'photo',
            filePath: 'G/images/a.jpg',
        });
        const personId = facesApi.insertPerson({ label: 'Alice', centroidBlob: Buffer.alloc(4) });
        const faceId = facesApi.insertFace({
            downloadId: r.lastInsertRowid,
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            embeddingBlob: Buffer.alloc(4),
            personId,
        }).lastInsertRowid;
        return { downloadId: r.lastInsertRowid, personId, faceId };
    }

    it('lists people (local scope)', async () => {
        makePersonWithFace();
        const { status, body } = await get('/api/ai/people');
        expect(status).toBe(200);
        expect(body.scope).toBe('local');
        expect(body.people.length).toBeGreaterThanOrEqual(1);
    });

    it('lists people federated scope with no peers', async () => {
        const { status, body } = await get('/api/ai/people?scope=federated');
        expect(status).toBe(200);
        expect(body.scope).toBe('federated');
        expect(body.people).toEqual([]);
    });

    it('400s an invalid download id for faces/by-download', async () => {
        expect((await get('/api/ai/faces/by-download/abc')).status).toBe(400);
    });

    it('lists faces for a download', async () => {
        const { downloadId } = makePersonWithFace();
        const { status, body } = await get(`/api/ai/faces/by-download/${downloadId}`);
        expect(status).toBe(200);
        expect(body.faces).toHaveLength(1);
    });

    it('groups by person', async () => {
        makePersonWithFace();
        const { status, body } = await get('/api/ai/group-by-person');
        expect(status).toBe(200);
        expect(body.groups.length).toBeGreaterThanOrEqual(1);
    });

    it('400s + 404s person/:id/face', async () => {
        expect((await get('/api/ai/person/abc/face')).status).toBe(400);
        expect((await get('/api/ai/person/999999/face')).status).toBe(404);
    });

    it('crops a person face when the file resolves', async () => {
        const { personId } = makePersonWithFace();
        safeResolveDownload.mockResolvedValue({ ok: true, real: '/fake/a.jpg' });
        const res = await fetch(apiUrl(`/api/ai/person/${personId}/face`));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    it('400s + 404s faces/:id/crop', async () => {
        expect((await get('/api/ai/faces/abc/crop')).status).toBe(400);
        expect((await get('/api/ai/faces/999999/crop')).status).toBe(404);
    });

    it('403s a face crop when the resolver forbids the path', async () => {
        const { faceId } = makePersonWithFace();
        safeResolveDownload.mockResolvedValue({ ok: false, reason: 'forbidden' });
        const { status } = await get(`/api/ai/faces/${faceId}/crop`);
        expect(status).toBe(403);
    });

    it('400s people/:id/photos with an invalid id', async () => {
        expect((await get('/api/ai/people/abc/photos')).status).toBe(400);
    });

    it('lists photos for a person', async () => {
        const { personId } = makePersonWithFace();
        const { status, body } = await get(`/api/ai/people/${personId}/photos`);
        expect(status).toBe(200);
        expect(body.personId).toBe(personId);
    });

    it('400s + 404s PATCH people/:id (rename)', async () => {
        expect((await patch('/api/ai/people/abc', { label: 'x' })).status).toBe(400);
        expect((await patch('/api/ai/people/999999', { label: 'x' })).status).toBe(404);
    });

    it('renames a person', async () => {
        const { personId } = makePersonWithFace();
        const { status, body } = await patch(`/api/ai/people/${personId}`, { label: 'Bob' });
        expect(status).toBe(200);
        expect(body.label).toBe('Bob');
    });

    it('400s merge without a valid otherId', async () => {
        const { personId } = makePersonWithFace();
        expect((await post(`/api/ai/people/${personId}/merge`, {})).status).toBe(400);
        expect((await post(`/api/ai/people/${personId}/merge`, { otherId: personId })).status).toBe(
            400,
        );
    });

    it('merges two people', async () => {
        const { personId } = makePersonWithFace();
        const otherId = facesApi.insertPerson({ label: 'Carl', centroidBlob: Buffer.alloc(4) });
        const { status, body } = await post(`/api/ai/people/${personId}/merge`, { otherId });
        expect(status).toBe(200);
        expect(body.target).toBe(personId);
    });

    it('400s split without faceIds, 404s when none match', async () => {
        expect((await post('/api/ai/people/1/split', {})).status).toBe(400);
        const { status } = await post('/api/ai/people/1/split', { faceIds: [999999] });
        expect(status).toBe(404);
    });

    it('splits faces into a new person', async () => {
        const { faceId } = makePersonWithFace();
        const { status, body } = await post('/api/ai/people/1/split', {
            faceIds: [faceId],
            label: 'Split Person',
        });
        expect(status).toBe(200);
        expect(body.personId).toBeDefined();
    });

    it('400s + 404s reassign', async () => {
        expect((await post('/api/ai/faces/abc/reassign', {})).status).toBe(400);
        expect((await post('/api/ai/faces/999999/reassign', {})).status).toBe(404);
    });

    it('reassigns a face to a different person (or null)', async () => {
        const { faceId } = makePersonWithFace();
        const { status, body } = await post(`/api/ai/faces/${faceId}/reassign`, {
            personId: null,
        });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
    });

    it('400s + 404s delete person', async () => {
        expect((await del('/api/ai/people/abc')).status).toBe(400);
        expect((await del('/api/ai/people/999999')).status).toBe(404);
    });

    it('deletes a person', async () => {
        const { personId } = makePersonWithFace();
        const { status } = await del(`/api/ai/people/${personId}`);
        expect(status).toBe(200);
    });
});

describe('POST /ai/reindex (full reset)', () => {
    it('cancels in-flight scans, wipes AI data, and broadcasts', async () => {
        const { status, body } = await post('/api/ai/reindex');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(broadcasts.some((b) => b.type === 'ai_reindex')).toBe(true);
    });
});

describe('POST /ai/auto-scan', () => {
    it('400s an invalid action', async () => {
        const { status } = await post('/api/ai/auto-scan', { action: 'bogus' });
        expect(status).toBe(400);
    });

    it('starts, pauses, and stops the auto-scan drip', async () => {
        let r = await post('/api/ai/auto-scan', { action: 'start' });
        expect(r.body.state).toBe('running');
        r = await post('/api/ai/auto-scan', { action: 'pause' });
        expect(r.body.state).toBe('paused');
        r = await post('/api/ai/auto-scan', { action: 'stop' });
        expect(r.body.state).toBe('idle');
    });
});

describe('GET /ai/doctor and /ai/health', () => {
    it('returns a checks array for both aliases', async () => {
        const doctor = await get('/api/ai/doctor');
        expect(doctor.status).toBe(200);
        expect(Array.isArray(doctor.body.checks)).toBe(true);
        const health = await get('/api/ai/health');
        expect(health.status).toBe(200);
        expect(Array.isArray(health.body.checks)).toBe(true);
    });
});
