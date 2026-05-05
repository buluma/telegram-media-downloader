import express from 'express';
import * as ai from '../../core/ai/index.js';
import {
    getDb,
    getAiCounts, listPeople, listPhotosForPerson,
    renamePerson, deletePerson,
    listAllTags, listPhotosForTag,
} from '../../core/db.js';

// Per-capability descriptors used by the model-status endpoint. Mirrors
// the names the dashboard already uses. The kind is the Transformers.js
// pipeline kind — needed because the same model id can be loaded under
// two kinds (CLIP image vs text).
const _MODEL_CAPS = [
    { cap: 'embeddings', cfgKey: 'embeddings', defaultKind: 'image-feature-extraction' },
    { cap: 'faces',      cfgKey: 'faces',      defaultKind: 'object-detection' },
    { cap: 'tags',       cfgKey: 'tags',       defaultKind: 'image-classification' },
];

/**
 * AI subsystem routes — embeddings, face clustering, perceptual dedup, tagging, model management.
 *
 * @param {object} ctx
 * @param {Function} ctx.loadConfig      () => config (sync, cached)
 * @param {Function} ctx.getJobTracker   (key: string) => JobTracker
 * @param {Function} ctx.broadcast       WebSocket broadcast
 * @param {Function} ctx.log             Structured logger
 */
export function createAiRouter({ loadConfig, getJobTracker, broadcast, log }) {
    const router = express.Router();

    function _aiCfg() {
        try {
            const live = loadConfig();
            const cfg = live.advanced?.ai || {};
            return {
                enabled: cfg.enabled === true,
                embeddings: {
                    enabled: cfg.embeddings?.enabled === true,
                    model: cfg.embeddings?.model || ai.AI_DEFAULTS.embeddings.model,
                },
                faces: {
                    enabled: cfg.faces?.enabled === true,
                    model: cfg.faces?.model || ai.AI_DEFAULTS.faces.model,
                    epsilon: Number.isFinite(cfg.faces?.epsilon) ? cfg.faces.epsilon : ai.AI_DEFAULTS.faces.epsilon,
                    minPoints: Number.isFinite(cfg.faces?.minPoints) ? cfg.faces.minPoints : ai.AI_DEFAULTS.faces.minPoints,
                },
                tags: {
                    enabled: cfg.tags?.enabled === true,
                    model: cfg.tags?.model || ai.AI_DEFAULTS.tags.model,
                    topK: Number.isFinite(cfg.tags?.topK) ? cfg.tags.topK : ai.AI_DEFAULTS.tags.topK,
                },
                phash: { enabled: cfg.phash?.enabled === true },
                indexConcurrency: Number.isFinite(cfg.indexConcurrency) ? cfg.indexConcurrency : ai.AI_DEFAULTS.indexConcurrency,
                batchSize: Number.isFinite(cfg.batchSize) ? cfg.batchSize : ai.AI_DEFAULTS.batchSize,
                fileTypes: (Array.isArray(cfg.fileTypes) && cfg.fileTypes.length) ? cfg.fileTypes : ai.AI_DEFAULTS.fileTypes,
            };
        } catch {
            return { ...ai.AI_DEFAULTS };
        }
    }

    // Probe sqlite-vec lazily on the first AI status hit. Result is cached so
    // we don't re-probe on every poll.
    let _aiVecProbed = false;
    async function _maybeProbeVec() {
        if (_aiVecProbed) return;
        _aiVecProbed = true;
        try { await ai.loadVecExtension(getDb, log); } catch {}
    }

    // Wire Transformers.js progress callbacks into the WS bus so the model
    // status panel can show live download bytes without polling. Idempotent —
    // the hook is registered once at module evaluation; subsequent reloads
    // (e.g. test re-imports) overwrite the same slot.
    try {
        ai.setModelProgressHook?.( ({ kind, modelId, progress }) => {
            try {
                broadcast({
                    type: 'ai_model_progress',
                    kind, modelId,
                    progress: progress || null,
                    ts: Date.now(),
                });
            } catch { /* swallow — never crash the loader */ }
        });
    } catch { /* setModelProgressHook is optional */ }

    // Probe a HuggingFace token. POST `{ token? }` — when `token` is present
    // we use that value directly, otherwise we fall back to the saved
    // `advanced.ai.hfToken`. Hits `/api/whoami-v2` which returns the user
    // object on a valid token + 401 on a bad one. We never echo the token
    // back, only `{ ok: true, name, type }` or `{ ok: false, status, message }`.
    router.post('/api/ai/hf/test', async (req, res) => {
        try {
            let token = (req.body && typeof req.body.token === 'string') ? req.body.token.trim() : '';
            if (!token) {
                try {
                    const cfg = loadConfig();
                    token = String(cfg?.advanced?.ai?.hfToken || '').trim();
                } catch { /* config not ready */ }
            }
            if (!token) {
                return res.status(400).json({ ok: false, status: 0, message: 'No token to test. Paste one above first.' });
            }
            // 5-second timeout — HF whoami is fast and the operator is
            // staring at a button waiting.
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 5000);
            let r;
            try {
                r = await fetch('https://huggingface.co/api/whoami-v2', {
                    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                    signal: ac.signal,
                });
            } catch (e) {
                return res.json({ ok: false, status: 0, message: e?.name === 'AbortError' ? 'Timed out talking to huggingface.co.' : `Network error: ${e?.message || e}` });
            } finally {
                clearTimeout(timer);
            }
            if (r.status === 401 || r.status === 403) {
                return res.json({ ok: false, status: r.status, message: 'Token rejected by HuggingFace (401). Re-create the token with Read role.' });
            }
            if (!r.ok) {
                return res.json({ ok: false, status: r.status, message: `HuggingFace returned HTTP ${r.status}.` });
            }
            let body = null;
            try { body = await r.json(); } catch { /* ignore */ }
            const name = body?.name || body?.fullname || '(unknown)';
            const type = body?.type || 'user';
            return res.json({ ok: true, status: r.status, name, type });
        } catch (e) {
            res.status(500).json({ ok: false, status: 0, message: e.message });
        }
    });

    router.get('/api/ai/status', async (_req, res) => {
        try {
            await _maybeProbeVec();
            const cfg = _aiCfg();
            const counts = getAiCounts({ fileTypes: cfg.fileTypes });
            res.json({
                success: true,
                enabled: cfg.enabled,
                capabilities: {
                    master:     cfg.enabled,
                    embeddings: cfg.embeddings.enabled,
                    faces:      cfg.faces.enabled,
                    tags:       cfg.tags.enabled,
                    phash:      cfg.phash.enabled,
                },
                models: {
                    embeddings: cfg.embeddings.model,
                    faces:      cfg.faces.model,
                    tags:       cfg.tags.model,
                },
                counts,
                loadedPipelines: ai.loadedPipelines(),
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/ai/index/scan', async (_req, res) => {
        const cfg = _aiCfg();
        if (!cfg.enabled) {
            return res.status(503).json({ error: 'AI subsystem disabled. Toggle "Enable AI subsystem" in Maintenance → AI search.', code: 'AI_DISABLED' });
        }
        const tracker = getJobTracker('aiIndex');
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            return ai.runIndexScan(cfg, { onProgress, signal, onLog: log });
        });
        if (!r.started) return res.status(409).json({ error: 'AI index scan already running', code: 'ALREADY_RUNNING' });
        res.json({ success: true, started: true });
    });

    router.get('/api/ai/index/scan/status', async (_req, res) => {
        res.json(getJobTracker('aiIndex').getStatus());
    });

    router.post('/api/ai/index/cancel', async (_req, res) => {
        const ok = getJobTracker('aiIndex').cancel();
        res.json({ success: true, cancelled: ok });
    });

    router.post('/api/ai/search', async (req, res) => {
        try {
            const { query, limit, fileTypes } = req.body || {};
            if (typeof query !== 'string' || !query.trim()) {
                return res.status(400).json({ error: 'query required' });
            }
            const cfg = _aiCfg();
            if (!cfg.enabled || !cfg.embeddings.enabled) {
                return res.status(503).json({ error: 'AI embeddings are disabled', code: 'EMBEDDINGS_DISABLED' });
            }
            const r = await ai.searchByText(query.trim(), cfg, {
                limit: Number(limit) || 20,
                fileTypes: Array.isArray(fileTypes) && fileTypes.length ? fileTypes : null,
                onLog: log,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            log({ source: 'ai', level: 'error', msg: `search failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    router.post('/api/ai/people/scan', async (_req, res) => {
        const cfg = _aiCfg();
        if (!cfg.enabled || !cfg.faces.enabled) {
            return res.status(503).json({ error: 'Face clustering is disabled', code: 'FACES_DISABLED' });
        }
        const tracker = getJobTracker('aiPeople');
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            return ai.runFaceClustering(cfg, { onProgress, signal, onLog: log });
        });
        if (!r.started) return res.status(409).json({ error: 'Face clustering already running', code: 'ALREADY_RUNNING' });
        res.json({ success: true, started: true });
    });

    router.get('/api/ai/people/scan/status', async (_req, res) => {
        res.json(getJobTracker('aiPeople').getStatus());
    });

    router.get('/api/ai/people', async (req, res) => {
        try {
            const limit = Number(req.query.limit) || 200;
            const offset = Number(req.query.offset) || 0;
            res.json({ success: true, ...listPeople({ limit, offset }) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.put('/api/ai/people/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const label = req.body?.label;
            const updated = renamePerson(id, label == null ? null : String(label).slice(0, 80));
            log({ source: 'ai', level: 'info', msg: `person #${id} renamed to "${label}"` });
            res.json({ success: true, updated });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.delete('/api/ai/people/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const deleted = deletePerson(id);
            log({ source: 'ai', level: 'info', msg: `person #${id} deleted (faces unclustered)` });
            res.json({ success: true, deleted });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/ai/people/:id/photos', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;
            res.json({ success: true, ...listPhotosForPerson(id, { limit, offset }) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/ai/perceptual-dedup/scan', async (_req, res) => {
        const cfg = _aiCfg();
        if (!cfg.enabled || !cfg.phash.enabled) {
            return res.status(503).json({ error: 'Perceptual dedup is disabled', code: 'PHASH_DISABLED' });
        }
        const tracker = getJobTracker('aiPhash');
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            return ai.runPhashScan({ onProgress, signal, onLog: log, fileTypes: cfg.fileTypes });
        });
        if (!r.started) return res.status(409).json({ error: 'phash scan already running', code: 'ALREADY_RUNNING' });
        res.json({ success: true, started: true });
    });

    router.get('/api/ai/perceptual-dedup/scan/status', async (_req, res) => {
        res.json(getJobTracker('aiPhash').getStatus());
    });

    router.get('/api/ai/perceptual-dedup/groups', async (req, res) => {
        try {
            const threshold = Math.max(0, Math.min(20, Number(req.query.threshold) || 6));
            const cfg = _aiCfg();
            const r = ai.findPhashGroups({ threshold, fileTypes: cfg.fileTypes });
            // phash stays BigInt inside the grouping logic (Hamming distance).
            // Strip it before JSON serialisation — clients only need file metadata.
            const safe = {
                ...r,
                groups: r.groups.map(g => ({
                    ...g,
                    rows: g.rows.map(({ phash: _p, ...rest }) => rest),
                })),
            };
            res.json({ success: true, ...safe });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/ai/tags/scan', async (_req, res) => {
        const cfg = _aiCfg();
        if (!cfg.enabled || !cfg.tags.enabled) {
            return res.status(503).json({ error: 'Auto-tagging is disabled', code: 'TAGS_DISABLED' });
        }
        const tracker = getJobTracker('aiTags');
        // Reuse the full index scan with only tags enabled — keeps the backfill
        // logic centralised. Other capabilities are tri-state (cap.* missing
        // = skip) so this only computes tags for the rows it visits.
        const onlyTags = {
            ...cfg,
            embeddings: { ...cfg.embeddings, enabled: false },
            faces:      { ...cfg.faces, enabled: false },
            phash:      { enabled: false },
        };
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            return ai.runIndexScan(onlyTags, { onProgress, signal, onLog: log });
        });
        if (!r.started) return res.status(409).json({ error: 'tags scan already running', code: 'ALREADY_RUNNING' });
        res.json({ success: true, started: true });
    });

    router.get('/api/ai/tags/scan/status', async (_req, res) => {
        res.json(getJobTracker('aiTags').getStatus());
    });

    router.get('/api/ai/tags', async (req, res) => {
        try {
            const minCount = Math.max(1, Number(req.query.min_count) || 1);
            res.json({ success: true, tags: listAllTags({ minCount }) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/ai/tags/:tag/photos', async (req, res) => {
        try {
            const tag = String(req.params.tag || '').trim();
            if (!tag) return res.status(400).json({ error: 'tag required' });
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;
            res.json({ success: true, ...listPhotosForTag(tag, { limit, offset }) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- Model status + swap -----------------------------------------------
    //
    // The dashboard's "Models" panel asks: which AI models are loaded, how
    // big are their on-disk caches, and what's the most recent download
    // progress event? Single endpoint per page render — live progress arrives
    // via the `ai_model_progress` WS event wired above.
    router.get('/api/ai/models/status', async (_req, res) => {
        try {
            const cfg = _aiCfg();
            const meta = ai.pipelineMetaSnapshot();
            const errors = ai.pipelineErrorsSnapshot();
            const metaByKey = new Map(meta.map((m) => [m.key, m]));
            const errsByKey = new Map(errors.map((e) => [e.key, e]));

            const out = {};
            for (const desc of _MODEL_CAPS) {
                const capCfg = cfg[desc.cfgKey] || {};
                const modelId = capCfg.model || ai.AI_MODEL_DEFAULTS[desc.cfgKey]?.modelId || '';
                const kind = ai.AI_MODEL_DEFAULTS[desc.cfgKey]?.kind || desc.defaultKind;
                const key = `${kind}::${modelId}`;
                const m = metaByKey.get(key);
                const err = errsByKey.get(key);
                const cache = await ai.inspectModelCache(modelId, cfg.cacheDir);
                out[desc.cap] = {
                    modelId,
                    kind,
                    enabled: capCfg.enabled === true,
                    loaded: !!(m && m.loadedAt),
                    loading: !!(m && !m.loadedAt),
                    lastLoadedAt: m?.loadedAt || null,
                    startedAt: m?.startedAt || null,
                    lastProgress: m?.lastProgress || null,
                    error: err ? err.message : null,
                    cacheBytes: cache.bytes,
                    cacheFiles: cache.files,
                    cacheDir: cache.dir,
                };
            }
            res.json({
                success: true,
                cacheRoot: ai.resolveCacheDir(cfg.cacheDir),
                models: out,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Wipe the cached weights for a single model id. The next scan / search
    // will redownload from huggingface.co. Confirm-gated on the client.
    router.delete('/api/ai/models/cache', async (req, res) => {
        try {
            const modelId = String(req.query.model || req.body?.model || '').trim();
            if (!modelId) return res.status(400).json({ error: 'model id required' });
            const cfg = _aiCfg();
            // Drop the in-process pipeline first so the on-disk wipe doesn't
            // leave a stale handle wired to deleted weights.
            try { await ai.clearPipelineForModel(modelId); } catch { /* ignore */ }
            const r = await ai.deleteModelCache(modelId, cfg.cacheDir);
            log({ source: 'ai', level: 'info', msg: `model cache wiped: ${modelId} (${r.bytes} bytes)` });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // "More like this" — top-K rows by cosine similarity against the source
    // row's embedding. Reuses the in-memory vector cache from vector-store.js
    // so a second similar-search after a text search is essentially free
    // (same cache hit).
    router.post('/api/ai/search/similar', async (req, res) => {
        try {
            const downloadId = Number(req.body?.downloadId);
            if (!Number.isInteger(downloadId) || downloadId <= 0) {
                return res.status(400).json({ error: 'downloadId required' });
            }
            const cfg = _aiCfg();
            if (!cfg.enabled || !cfg.embeddings.enabled) {
                return res.status(503).json({ error: 'AI embeddings are disabled', code: 'EMBEDDINGS_DISABLED' });
            }
            const limit = Math.max(1, Math.min(200, Number(req.body?.limit) || 24));
            // Pull every embedding (cache-friendly via vector-store.topK
            // re-using the same listing) so we can grab the source row's
            // vector without a new SELECT path.
            const { listAllImageEmbeddings } = await import('../../core/db.js');
            const rows = listAllImageEmbeddings({ fileTypes: cfg.fileTypes });
            const src = rows.find((r) => r.download_id === downloadId);
            if (!src || !src.embedding) {
                return res.status(404).json({ error: 'no embedding for that download' });
            }
            const { blobToVector, topK } = await import('../../core/ai/vector-store.js');
            const vec = blobToVector(src.embedding);
            if (!vec) return res.status(500).json({ error: 'embedding decode failed' });
            // Run topK; remove the source row itself from the result list.
            const top = topK(vec, { limit: limit + 1, fileTypes: cfg.fileTypes });
            const results = top
                .filter((r) => r.download_id !== downloadId)
                .slice(0, limit)
                .map((r) => ({
                    download_id: r.download_id,
                    score: r.score,
                    file_name: r.row.file_name,
                    file_path: r.row.file_path,
                    file_type: r.row.file_type,
                    file_size: r.row.file_size,
                    group_id:  r.row.group_id,
                    group_name: r.row.group_name,
                    created_at: r.row.created_at,
                }));
            res.json({
                success: true,
                source: {
                    download_id: src.download_id,
                    file_name: src.file_name,
                    group_id: src.group_id,
                    group_name: src.group_name,
                },
                results,
                total: results.length,
            });
        } catch (e) {
            log({ source: 'ai', level: 'error', msg: `similar search failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
