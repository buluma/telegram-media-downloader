/**
 * AI subsystem — public surface (faces-only build).
 *
 * Search + Auto-tag were removed in this release; this module now exposes
 * face detection / clustering only. The downloader still calls
 * `pregenerateAi()` after each successful download — when face clustering
 * is on, the per-row detection runs in the background and writes the
 * face embeddings into the `faces` table for later cluster sweeps.
 *
 * Callers outside this directory import from here:
 *   import {
 *     pregenerateAi,
 *     startFacesScan,
 *     cancelScan, getScanState, isScanRunning,
 *     detectFaces, clusterFaces, dbscan, euclidean, centroid,
 *     FACE_DEFAULTS,
 *   } from './core/ai/index.js';
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { deleteFacesForDownload, getDb, insertFace, setAiIndexedAt } from '../db.js';
import { buildMetadataText, setImageEmbedding, setTextEmbedding } from '../db/faces.js';
import { computeFaceQualityScore, detectFaces } from './faces.js';
import { embedImage as _clientEmbedImage } from './faces-client.js';
import { resolveClipModelId } from './tgdl-ml-client.js';
import { toPosixPath } from '../util/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
// `TGDL_DATA_DIR` overrides the on-disk data root — mirrors db.js / scan-runner.js /
// faces-spawn.js / routes/ai.js. Must stay in sync: a hardcoded path here made
// `_resolveAbs()` miss every download when the data dir was overridden, which
// silently stamped rows as AI-indexed with no detection ever run.
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.resolve(PROJECT_ROOT, 'data');

// Float32Array → Buffer. Used to be in vector-store.js (deleted); kept
// inline because the only remaining caller is the face pre-generate hook.
function _f32ToBlob(f) {
    return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

function _resolveClipModelId(cfg = {}) {
    return resolveClipModelId(cfg);
}

// better-sqlite3 throws "This database connection is busy executing a
// query" when a write hits the same connection while a `.iterate()`
// from another caller (cluster sweep / dedup / integrity walk) is open.
// Mirrors the retry shape used in `kvSet` — async-friendly here so the
// drain loop's await stays well-behaved.
async function _runWithBusyRetry(fn, { retries = 4, backoffMs = 50 } = {}) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return fn();
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy || attempt === retries - 1) throw e;
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }
}

// Re-exports — keep the import surface flat for callers outside this dir.
export {
    centroid,
    clusterFaces,
    dbscan,
    detectFaces,
    euclidean,
    FACE_DEFAULTS,
} from './faces.js';
export {
    cancelScan,
    getScanState,
    isScanRunning,
    startFacesScan,
} from './scan-runner.js';

// ---- Background pre-generate ---------------------------------------------
//
// Two queues — realtime downloads jump ahead of history backfill so a
// fresh ingest stays responsive during a bulk import. Each queue is
// capped at 200; when full, new entries drop silently (a manual scan
// reconciles). The drain alternates: realtime first, then one backfill,
// then realtime — so backfill never starves entirely but never blocks
// live work either.

const _bgQueueRealtime = [];
const _bgQueueBackfill = [];
let _bgRunning = false;
const _BG_QUEUE_CAP = 200;
// Set when any enqueue call drops an item due to cap. Cleared after drain
// triggers a full scan reconcile so no rows stay permanently unindexed.
let _queueWasCapped = false;

// ---- Auto-cluster state ---------------------------------------------------

let _autoClusterDebounceTimer = null;
let _autoClusterIntervalTimer = null;
// Counts faces detected during the current drain pass; reset each drain.
let _newFacesInDrain = 0;

async function _fireCluster() {
    try {
        const { loadConfig } = await import('../../config/manager.js');
        const cfg = loadConfig()?.advanced?.ai || {};
        if (!cfg.enabled || !cfg.autoCluster || !cfg.faceClustering) return;
        const { isScanRunning, startFacesScan } = await import('./scan-runner.js');
        if (isScanRunning('faces')) return;
        startFacesScan(cfg).catch(() => {});
    } catch {
        /* config or sidecar unavailable */
    }
}

function _scheduleAutoCluster(cfg) {
    if (!cfg.autoCluster || !cfg.faceClustering) return;
    const debounceMs =
        Number(cfg.autoClusterDebounceMs) > 0 ? Number(cfg.autoClusterDebounceMs) : 60_000;
    if (_autoClusterDebounceTimer) clearTimeout(_autoClusterDebounceTimer);
    _autoClusterDebounceTimer = setTimeout(async () => {
        _autoClusterDebounceTimer = null;
        await _fireCluster();
    }, debounceMs);
    _autoClusterDebounceTimer.unref?.();
}

export function startAutoCluster({ intervalMin = 60 } = {}) {
    stopAutoCluster();
    const ms = Math.max(1000, intervalMin * 60 * 1000);
    _autoClusterIntervalTimer = setInterval(() => _fireCluster(), ms);
    _autoClusterIntervalTimer.unref?.();
}

export function stopAutoCluster() {
    if (_autoClusterIntervalTimer) {
        clearInterval(_autoClusterIntervalTimer);
        _autoClusterIntervalTimer = null;
    }
    if (_autoClusterDebounceTimer) {
        clearTimeout(_autoClusterDebounceTimer);
        _autoClusterDebounceTimer = null;
    }
}

/**
 * Hook called by `src/core/downloader.js` after each successful download.
 * Best-effort, fire-and-forget — failure to pregenerate just means the
 * row gets picked up by the next manual scan.
 *
 * `opts.priority`: 'realtime' jumps ahead of history backfill. Default
 * 'backfill'. The downloader passes 'realtime' for live monitor jobs;
 * the bulk history backfill leaves it default.
 */
export function pregenerateAi(downloadId, opts = {}) {
    const priority = opts?.priority === 'realtime' ? 'realtime' : 'backfill';
    queueMicrotask(() => {
        const queue = priority === 'realtime' ? _bgQueueRealtime : _bgQueueBackfill;
        if (queue.length >= _BG_QUEUE_CAP) {
            _queueWasCapped = true;
            return;
        }
        queue.push(downloadId);
        _drainBg();
    });
}

function _nextQueuedId() {
    if (_bgQueueRealtime.length) return _bgQueueRealtime.shift();
    if (_bgQueueBackfill.length) return _bgQueueBackfill.shift();
    return undefined;
}

function _allQueuesEmpty() {
    return _bgQueueRealtime.length === 0 && _bgQueueBackfill.length === 0;
}

async function _drainBg() {
    if (_bgRunning) return;
    _bgRunning = true;
    _newFacesInDrain = 0;
    try {
        const { loadConfig } = await import('../../config/manager.js');
        let cfg;
        try {
            const live = loadConfig();
            cfg = live?.advanced?.ai || {};
            if (cfg.enabled !== true) {
                _bgQueueRealtime.length = 0;
                _bgQueueBackfill.length = 0;
                return;
            }
        } catch {
            _bgQueueRealtime.length = 0;
            _bgQueueBackfill.length = 0;
            return;
        }

        const db = getDb();
        const lookupRow = db.prepare(`
            SELECT id, file_path, file_type, ai_indexed_at
              FROM downloads
             WHERE id = ?
        `);
        const fileTypeOk = new Set(
            (cfg.fileTypes || ['photo']).map((s) => String(s).toLowerCase()),
        );

        while (!_allQueuesEmpty()) {
            const id = _nextQueuedId();
            if (id === undefined) break;
            const row = lookupRow.get(Number(id));
            if (!row) continue;
            if (row.ai_indexed_at != null) continue;
            if (!fileTypeOk.has(String(row.file_type || '').toLowerCase())) continue;

            const abs = _resolveAbs(row.file_path);
            if (!abs) {
                setAiIndexedAt(row.id);
                continue;
            }

            // Per-row face detection. Clustering is a separate batch pass
            // (kicked off via the AI maintenance page), so here we only
            // populate the faces table with embeddings.
            let detected = null;
            if (cfg.faceClustering === true) {
                try {
                    detected = await detectFaces(abs, cfg);
                    if (Array.isArray(detected) && detected.length) {
                        _newFacesInDrain += detected.length;
                    }
                } catch {
                    /* swallow — clustering refresh retries */
                }
            }

            // Per-row image embedding for semantic/natural-language search.
            // Computed once per download; the `image_embeddings` table
            // already exists with an UPSERT, so repeated calls are safe.
            // The embedding model identifier (sidecar CLIP model) is used
            // so model swaps trigger a re-index via `clearStaleEmbeddings`.
            let imageEmbedding = null;
            let embeddingModel = '';
            try {
                const r = await _clientEmbedImage(abs);
                if (r?.embedding?.length) {
                    imageEmbedding = Float32Array.from(r.embedding);
                    // Keep model id aligned with the backend that produced it.
                    embeddingModel = r.model || _resolveClipModelId(cfg);
                }
            } catch {
                /* sidecar unavailable or non-image — skip silently */
            }

            // LLM text embedding — runs AFTER the CLIP step so tags/objects
            // written in a prior scan pass are already present for buildMetadataText.
            // Best-effort: if the LLM is unavailable the row is still marked
            // indexed and will not be re-queued (text_embeddings gap is filled
            // by the next full re-index when an LLM is configured).
            let textEmbedding = null;
            let textEmbeddingModel = '';
            try {
                const metaText = buildMetadataText(row.id);
                if (metaText.trim()) {
                    const { embed: llmEmbed, getActiveProvider } = await import('../llm/index.js');
                    const providerInfo = await getActiveProvider();
                    if (providerInfo.available) {
                        const vecs = await llmEmbed({ texts: [metaText] });
                        if (Array.isArray(vecs) && vecs[0]?.length) {
                            textEmbedding = Float32Array.from(vecs[0]);
                            textEmbeddingModel =
                                cfg.llm?.ollama?.embedModel ||
                                cfg.llm?.openai?.embedModel ||
                                'nomic-embed-text';
                        }
                    }
                }
            } catch {
                /* LLM unavailable or metadata empty — text_embeddings stays empty */
            }

            // All DB writes go through the busy-aware retry: a long-running
            // sweep / cluster iterator on the same connection will throw
            // "This database connection is busy" on any concurrent UPDATE.
            // If retries are exhausted we skip — the row stays
            // ai_indexed_at = NULL and gets re-picked by the next scan.
            try {
                await _runWithBusyRetry(() => {
                    if (Array.isArray(detected) && detected.length) {
                        deleteFacesForDownload(row.id);
                        for (const f of detected) {
                            insertFace({
                                downloadId: row.id,
                                x: f.x,
                                y: f.y,
                                w: f.w,
                                h: f.h,
                                embeddingBlob: _f32ToBlob(f.embedding),
                                qualityScore: computeFaceQualityScore(f, cfg),
                            });
                        }
                    }
                    // Persist CLIP image embedding for semantic search
                    if (imageEmbedding && embeddingModel) {
                        setImageEmbedding(row.id, _f32ToBlob(imageEmbedding), embeddingModel);
                    }
                    // Persist LLM text embedding for semantic fallback search
                    if (textEmbedding && textEmbeddingModel) {
                        setTextEmbedding(row.id, _f32ToBlob(textEmbedding), textEmbeddingModel);
                    }
                    setAiIndexedAt(row.id);
                });
            } catch (e) {
                console.warn(
                    '[ai-pregenerate] db write skipped for download',
                    row.id,
                    String(e?.message || e),
                );
            }
            // Yield so realtime downloads aren't blocked behind a long
            // backfill of pregenerate work.
            await new Promise((r) => setImmediate(r));
        }
        // Queue drained — if new faces landed this pass, schedule a
        // debounced cluster sweep so back-to-back downloads batch up
        // before the (potentially expensive) DBSCAN runs.
        if (_newFacesInDrain > 0) {
            _scheduleAutoCluster(cfg);
        }
        // The queue cap dropped items silently during this ingest burst.
        // Kick a full faces scan so rows with ai_indexed_at = NULL get
        // picked up — scan-runner queries the DB directly, not this queue.
        if (_queueWasCapped) {
            _queueWasCapped = false;
            try {
                const { isScanRunning, startFacesScan } = await import('./scan-runner.js');
                if (!isScanRunning('faces')) {
                    console.log(
                        '[ai-pregenerate] queue cap hit — triggering full scan to reconcile missed rows',
                    );
                    startFacesScan(cfg).catch(() => {});
                }
            } catch {
                /* scan-runner unavailable */
            }
        }
    } finally {
        _bgRunning = false;
    }
}

function _resolveAbs(storedPath) {
    if (!storedPath) return null;
    if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
    let s = toPosixPath(storedPath);
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DATA_DIR, 'downloads', s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(storedPath)) return storedPath;
    return null;
}

/** For tests — clear both queues + state. */
export function _resetForTests() {
    _bgQueueRealtime.length = 0;
    _bgQueueBackfill.length = 0;
    _bgRunning = false;
    _newFacesInDrain = 0;
    _queueWasCapped = false;
    if (_autoClusterDebounceTimer) {
        clearTimeout(_autoClusterDebounceTimer);
        _autoClusterDebounceTimer = null;
    }
    if (_autoClusterIntervalTimer) {
        clearInterval(_autoClusterIntervalTimer);
        _autoClusterIntervalTimer = null;
    }
}

/** Queue-length snapshot for the AI status endpoint + tests. */
export function _bgQueueDepths() {
    return {
        realtime: _bgQueueRealtime.length,
        backfill: _bgQueueBackfill.length,
    };
}
