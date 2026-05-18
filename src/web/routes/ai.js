import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import sharp from 'sharp';
import { loadConfig, watchConfig } from '../../config/manager.js';
import { maskLlmConfig } from '../../core/llm/llm-config.js';
import { resolveClipModelId, getTgdlMlUrl, isTgdlMlEnabled } from '../../core/ai/tgdl-ml-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
import { getDb } from '../../core/db.js';
import {
    startFacesScan as aiStartFacesScan,
    cancelScan as aiCancelScan,
    isScanRunning as aiIsScanRunning,
    getScanState as aiGetScanState,
    _bgQueueDepths as aiBgQueueDepths,
} from '../../core/ai/index.js';
import {
    startOcrScan as aiStartOcrScan,
    startWd14Scan as aiStartWd14Scan,
} from '../../core/ai/scan-runner.js';
import {
    backfillMissingFaceQualityScores,
    deleteSmartAlbum,
    getAiCounts,
    listPeople,
    listPhotosForPerson,
    listSmartAlbumItems,
    listSmartAlbums,
    renamePerson,
    rebuildSmartAlbum,
    previewSmartAlbumRule,
    deletePerson,
    resetAllAiData,
    upsertSmartAlbum,
    getUnindexedAiBatch,
} from '../../core/db/faces.js';
import { pregenerateAi as aiPregenerateAi } from '../../core/ai/index.js';
import * as llm from '../../core/llm/index.js';
import { safeResolveDownload } from '../lib/resolve-download.js';

export function createAiRouter({ broadcast, log, jobTrackers }) {
    const router = express.Router();
    function _facesScanFileTypes(cfg = _aiCfg()) {
        const facesBlk = cfg.faces && typeof cfg.faces === 'object' ? cfg.faces : {};
        const base =
            Array.isArray(cfg.fileTypes) && cfg.fileTypes.length ? cfg.fileTypes : ['photo'];
        const set = new Set(base.map((t) => String(t || '').toLowerCase()).filter(Boolean));
        if (facesBlk.includeVideos === true) set.add('video');
        return [...set];
    }

    // Provide jobTrackers-compatible access via the injected jobTrackers dep.
    function _aiTrackerFor(feature) {
        if (feature === 'faces') return jobTrackers.aiPeople;
        if (feature === 'ocr') return jobTrackers.aiOcr;
        if (feature === 'wd14') return jobTrackers.aiWd14;
        return null;
    }

    // Resolve a stored file_path to an absolute path on disk. Mirrors
    // the same logic in scan-runner.js and ai/index.js.
    function _resolveAiPath(storedPath) {
        if (!storedPath) return null;
        if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
        let s = String(storedPath).replace(/\\/g, '/');
        while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
        const candidate = path.join(DATA_DIR, 'downloads', s);
        if (existsSync(candidate)) return candidate;
        if (existsSync(storedPath)) return storedPath;
        return null;
    }

    function _aiStarterFor(feature) {
        if (feature === 'faces') return aiStartFacesScan;
        if (feature === 'ocr') return aiStartOcrScan;
        if (feature === 'wd14') return aiStartWd14Scan;
        return null;
    }

    // ====== AI subsystem (semantic search + auto-tag + face clustering) =========
    //
    // Three independent scans share one page (Maintenance → AI). Each is
    // admin-only by virtue of the global mutation gate, opt-in via
    // `config.advanced.ai.{enabled,semanticSearch,autoTags,faceClustering}`.
    // Patterns mirror the NSFW route group:
    //   - status returns the kv flags + scan states + counts in one round trip
    //   - scan/start uses the same JobTracker `tryStart` contract
    //   - search endpoints are reads against `image_embeddings` (in-memory cosine)
    //   - tags + people endpoints are list/paginate against the persisted rows
    //
    // Bug-class avoidance:
    //   - Every read goes through paginated DB helpers (LIMIT/OFFSET) so
    //     CLAUDE.md → Big-data rule 1 stays honoured.
    //   - All 503s carry `code` so the client can render targeted help.
    function _aiCfg() {
        try {
            const live = loadConfig();
            return live?.advanced?.ai || {};
        } catch {
            return {};
        }
    }

    function _semanticSearchEnabled(cfg = _aiCfg()) {
        const s = cfg?.semanticSearch;
        if (typeof s === 'object' && s) return s.enabled === true;
        if (typeof s === 'boolean') return s === true;
        return false;
    }

    function _smartAlbumsLlmRulesEnabled(cfg = _aiCfg()) {
        const sa = cfg?.smartAlbums;
        if (typeof sa === 'object' && sa) {
            return sa.enabled !== false && sa.allowLlmRules === true;
        }
        return false;
    }

    function _resolveClipModelId(cfg = _aiCfg()) {
        return resolveClipModelId(cfg);
    }

    // ---- AI status -----------------------------------------------------------
    //
    // Faces-only build — the prior `/api/ai/status` payload exposed embed +
    // tag pipeline state, vec extension probe, model preset metadata, etc.
    // All of that's gone with the Search/Tags removal; this is the minimum
    // the AI maintenance page actually reads now.

    // 5 s in-memory cache for the live `/info` probe. The dashboard polls
    // /api/ai/status every few seconds; without the cache we'd hit the
    // sidecar each time + spike when many tabs are open.
    const _SIDECAR_INFO_CACHE = { url: null, ts: 0, data: null };
    const _SIDECAR_INFO_TTL_MS = 5000;
    async function _fetchSidecarInfo(url) {
        const now = Date.now();
        if (
            _SIDECAR_INFO_CACHE.url === url &&
            now - _SIDECAR_INFO_CACHE.ts < _SIDECAR_INFO_TTL_MS &&
            _SIDECAR_INFO_CACHE.data
        ) {
            return _SIDECAR_INFO_CACHE.data;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/info`, {
                signal: controller.signal,
            });
            if (!res.ok) return null;
            const data = await res.json();
            _SIDECAR_INFO_CACHE.url = url;
            _SIDECAR_INFO_CACHE.ts = now;
            _SIDECAR_INFO_CACHE.data = data;
            return data;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    const _SIDECAR_HEALTH_CACHE = { url: null, ts: 0, data: null };
    const _ML_HEALTH_CACHE = { url: null, ts: 0, data: null };
    const _ML_INFO_CACHE = { url: null, ts: 0, data: null };

    async function _fetchTgdlMlHealth(url) {
        const now = Date.now();
        if (
            _ML_HEALTH_CACHE.url === url &&
            now - _ML_HEALTH_CACHE.ts < _SIDECAR_INFO_TTL_MS &&
            _ML_HEALTH_CACHE.data
        )
            return _ML_HEALTH_CACHE.data;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: ctrl.signal });
            if (!res.ok) return null;
            const data = await res.json();
            _ML_HEALTH_CACHE.url = url;
            _ML_HEALTH_CACHE.ts = now;
            _ML_HEALTH_CACHE.data = data;
            return data;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function _fetchTgdlMlInfo(url) {
        const now = Date.now();
        if (
            _ML_INFO_CACHE.url === url &&
            now - _ML_INFO_CACHE.ts < _SIDECAR_INFO_TTL_MS &&
            _ML_INFO_CACHE.data
        )
            return _ML_INFO_CACHE.data;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/info`, { signal: ctrl.signal });
            if (!res.ok) return null;
            const data = await res.json();
            _ML_INFO_CACHE.url = url;
            _ML_INFO_CACHE.ts = now;
            _ML_INFO_CACHE.data = data;
            return data;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function _getTgdlMlSnapshot() {
        const url = getTgdlMlUrl() || null;
        if (!url) return { url: null, ok: false, ready: false, endpoints: {} };
        const [health, info] = await Promise.all([_fetchTgdlMlHealth(url), _fetchTgdlMlInfo(url)]);
        const ok = !!health?.ok;
        return {
            url,
            ok,
            ready: !!health?.ready,
            version: health?.version || null,
            clipModel: health?.clip_model || null,
            ocrModel: health?.ocr_model || null,
            faceModel: health?.face_model || null,
            providers: info?.providers || null,
            error: health?.error || null,
            endpoints: {
                embedImage: !!(info?.endpoints?.embed_image ?? ok),
                embedText: !!(info?.endpoints?.embed_text ?? ok),
                detect: !!(info?.endpoints?.faces ?? ok),
                ocr: !!(info?.endpoints?.ocr ?? ok),
                tag: !!info?.endpoints?.tag,
            },
        };
    }

    async function _fetchSidecarHealth(url) {
        const now = Date.now();
        if (
            _SIDECAR_HEALTH_CACHE.url === url &&
            now - _SIDECAR_HEALTH_CACHE.ts < _SIDECAR_INFO_TTL_MS &&
            _SIDECAR_HEALTH_CACHE.data
        ) {
            return _SIDECAR_HEALTH_CACHE.data;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
                signal: controller.signal,
            });
            if (!res.ok) return null;
            const data = await res.json();
            _SIDECAR_HEALTH_CACHE.url = url;
            _SIDECAR_HEALTH_CACHE.ts = now;
            _SIDECAR_HEALTH_CACHE.data = data;
            return data;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function _getAiSidecarSnapshot() {
        let url = null;
        let mode = 'unknown';
        try {
            const { getSidecarUrl } = await import('../../core/ai/faces-client.js');
            url = getSidecarUrl() || null;
        } catch {}
        if (isTgdlMlEnabled()) {
            mode = 'tgdl-ml';
        }
        if (mode !== 'tgdl-ml') {
            try {
                const facesSpawn = await import('../../core/ai/faces-spawn.js');
                const st = facesSpawn.getSidecarStatus?.() || {};
                url = url || st.url || null;
                mode = st.mode || st.state || mode;
            } catch {}
        }
        const info = url ? await _fetchSidecarInfo(url) : null;
        const health = url ? await _fetchSidecarHealth(url) : null;
        const isTgdlMl = info?.provider === 'tgdl-ml';
        const eps = info?.endpoints || {};
        const endpoints = isTgdlMl
            ? {
                  faces: !!eps.faces,
                  tag: !!eps.tag,
                  ocr: !!eps.ocr,
                  wd14: !!eps.wd14,
                  embedImage: !!eps.embed_image,
                  embedText: !!eps.embed_text,
              }
            : {
                  faces: !!url,
                  tag: !!(info?.clip_ready || health?.clip_ready),
                  ocr: !!health?.ocr_ready,
                  wd14: true,
              };
        return {
            url,
            mode,
            ok: !!(health?.ok ?? info),
            version: info?.version || health?.version || null,
            platform: info?.platform || health?.platform || null,
            python: info?.python || health?.python || null,
            providers: info?.providers || health?.providers_resolved || null,
            info,
            health,
            endpoints,
        };
    }

    const _AI_ISSUES_TTL_MS = 60_000;
    const _AI_ISSUES_CACHE = { ts: 0, data: null };
    async function _getAiIssuesSnapshot({ force = false } = {}) {
        const now = Date.now();
        if (!force && _AI_ISSUES_CACHE.data && now - _AI_ISSUES_CACHE.ts < _AI_ISSUES_TTL_MS) {
            return _AI_ISSUES_CACHE.data;
        }
        const db = getDb();
        const issues = [];
        const push = (issue) => {
            if (!issue || !issue.count) return;
            issues.push({ severity: 'warn', samples: [], ...issue });
        };

        const fkRows = db.prepare('PRAGMA foreign_key_check').all();
        push({
            type: 'foreign_key',
            severity: 'error',
            title: 'Foreign key integrity errors',
            count: fkRows.length,
            detail: 'Derived AI rows reference missing parent rows.',
            samples: fkRows.slice(0, 20),
        });

        const scanErrors = [];
        for (const feature of ['faces', 'ocr', 'wd14']) {
            const s = aiGetScanState(feature);
            if (s?.error) scanErrors.push({ feature, error: s.error, finishedAt: s.finishedAt });
        }
        push({
            type: 'scan_errors',
            severity: 'error',
            title: 'Scanner errors',
            count: scanErrors.length,
            detail: 'One or more scanners ended with an error this process lifetime.',
            samples: scanErrors,
        });

        const sidecar = await _getAiSidecarSnapshot();
        push({
            type: 'sidecar_offline',
            severity: 'error',
            title: 'AI sidecar offline',
            count: sidecar.url ? 0 : 1,
            detail: 'Sidecar-dependent scans cannot run until the sidecar is available.',
            samples: [],
        });

        const { sniffMediaFile } = await import('../../core/media-sniff.js');
        const rows = db
            .prepare(
                `SELECT id, file_name, file_type, file_path, file_size
                   FROM downloads
                  WHERE file_path IS NOT NULL
                  ORDER BY id DESC
                  LIMIT 20000`,
            )
            .all();
        let missing = 0;
        let mislabeled = 0;
        let invalidPhotos = 0;
        let folderMismatch = 0;
        const missingSamples = [];
        const mislabeledSamples = [];
        const invalidSamples = [];
        const folderSamples = [];
        const expectedFolderFor = (ft) =>
            ft === 'photo'
                ? 'images'
                : ft === 'video'
                  ? 'videos'
                  : ft === 'audio'
                    ? 'audio'
                    : 'documents';
        for (const row of rows) {
            const fp = String(row.file_path || '').replace(/\\/g, '/');
            if (fp.startsWith('_clusterref/')) continue;
            const abs = _resolveAiPath(fp);
            if (!abs) {
                missing += 1;
                if (missingSamples.length < 20) missingSamples.push(row);
                continue;
            }
            const parts = fp.split('/');
            const folder = parts.length >= 3 ? parts[1] : '';
            const expectedFolder = expectedFolderFor(row.file_type);
            if (folder && expectedFolder && folder !== expectedFolder) {
                folderMismatch += 1;
                if (folderSamples.length < 20)
                    folderSamples.push({ ...row, folder, expectedFolder });
            }
            try {
                const sniff = await sniffMediaFile(abs);
                if (sniff.fileType && sniff.fileType !== row.file_type) {
                    mislabeled += 1;
                    if (mislabeledSamples.length < 20) {
                        mislabeledSamples.push({
                            ...row,
                            actualType: sniff.fileType,
                            mime: sniff.mime,
                        });
                    }
                }
                if (
                    row.file_type === 'photo' &&
                    sniff.mime &&
                    !String(sniff.mime).startsWith('image/')
                ) {
                    invalidPhotos += 1;
                    if (invalidSamples.length < 20)
                        invalidSamples.push({ ...row, mime: sniff.mime });
                }
            } catch (e) {
                if (row.file_type === 'photo') {
                    invalidPhotos += 1;
                    if (invalidSamples.length < 20)
                        invalidSamples.push({ ...row, error: e?.message || String(e) });
                }
            }
        }
        push({
            type: 'missing_files',
            severity: 'warn',
            title: 'Database rows with missing files',
            count: missing,
            detail: 'Rows in downloads point at files that are not present on disk.',
            samples: missingSamples,
        });
        push({
            type: 'mislabeled_media',
            severity: 'warn',
            title: 'Mislabeled media rows',
            count: mislabeled,
            detail: 'The stored file_type does not match the bytes on disk.',
            samples: mislabeledSamples,
        });
        push({
            type: 'invalid_photos',
            severity: 'warn',
            title: 'Photo rows that are not decodable images',
            count: invalidPhotos,
            detail: 'These rows would fail image-only scanners such as OCR or NSFW.',
            samples: invalidSamples,
        });
        push({
            type: 'folder_mismatch',
            severity: 'info',
            title: 'Rows in unexpected media folders',
            count: folderMismatch,
            detail: 'File path folder does not match file_type convention.',
            samples: folderSamples,
        });

        const data = {
            success: true,
            generatedAt: now,
            ttlMs: _AI_ISSUES_TTL_MS,
            scannedRows: rows.length,
            total: issues.length,
            counts: Object.fromEntries(issues.map((i) => [i.type, i.count])),
            issues,
        };
        _AI_ISSUES_CACHE.ts = now;
        _AI_ISSUES_CACHE.data = data;
        return data;
    }

    router.get('/ai/status', async (_req, res) => {
        try {
            const cfg = _aiCfg();
            const counts = (() => {
                try {
                    return getAiCounts({ fileTypes: _facesScanFileTypes(cfg) });
                } catch {
                    return { totalEligible: 0, indexed: 0, withFaces: 0 };
                }
            })();
            // Surface the nested `faces` block too so the AI maintenance
            // page can hydrate the provider dropdown without a second
            // /api/config call. Keeping the flat `facesEpsilon` / etc.
            // siblings preserves backward compat with any in-flight code
            // that still reads the legacy shape.
            const facesBlock = cfg.faces && typeof cfg.faces === 'object' ? cfg.faces : {};
            const sidecar = await _getAiSidecarSnapshot();
            // When sidecar IS tgdl-ml, derive mlSidecar from the already-fetched
            // sidecar data instead of making a second set of HTTP calls.
            const mlSidecar =
                sidecar.info?.provider === 'tgdl-ml'
                    ? {
                          url: sidecar.url,
                          ok: sidecar.ok,
                          ready: sidecar.ok,
                          version: sidecar.version,
                          clipModel:
                              sidecar.info?.models?.clip || sidecar.health?.clip_model || null,
                          ocrModel: sidecar.info?.models?.ocr || sidecar.health?.ocr_model || null,
                          faceModel:
                              sidecar.info?.models?.faces || sidecar.health?.face_model || null,
                          providers: sidecar.providers,
                          error: null,
                          endpoints: {
                              embedImage: !!sidecar.endpoints?.embedImage,
                              embedText: !!sidecar.endpoints?.embedText,
                              detect: !!sidecar.endpoints?.faces,
                              ocr: !!sidecar.endpoints?.ocr,
                              tag: !!sidecar.endpoints?.tag,
                          },
                      }
                    : await _getTgdlMlSnapshot();
            res.json({
                success: true,
                config: {
                    enabled: cfg.enabled === true,
                    faceClustering: cfg.faceClustering !== false,
                    federateFaces: cfg.federateFaces === true,
                    fileTypes: _facesScanFileTypes(cfg),
                    facesEpsilon: Number.isFinite(cfg.facesEpsilon) ? cfg.facesEpsilon : 0.5,
                    facesMinPoints: Number.isFinite(cfg.facesMinPoints) ? cfg.facesMinPoints : 3,
                    facesDetector: cfg.facesDetector || 'tiny',
                    facesDetectorModel: String(
                        facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                    ),
                    imageOcr: cfg.imageOcr === true,
                    faces: {
                        providers: String(facesBlock.providers || 'auto').toLowerCase(),
                        detectorModel: String(
                            facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                        ),
                        includeVideos: facesBlock.includeVideos === true,
                        videoFrameIntervalSec: Number(facesBlock.videoFrameIntervalSec || 8),
                        videoMaxFrames: Number(facesBlock.videoMaxFrames || 24),
                    },
                },
                counts,
                sidecar,
                mlSidecar,
                scans: {
                    faces: aiGetScanState('faces'),
                    ocr: aiGetScanState('ocr'),
                    wd14: aiGetScanState('wd14'),
                },
                models: {
                    faces: await (async () => {
                        // Surface the operator-chosen insightface preset
                        // (buffalo_l / antelopev2 / buffalo_m / buffalo_s /
                        // buffalo_sc) in the human-readable id. The legacy
                        // `cfg.facesModel` free-text override still wins
                        // when set (advanced operator path); otherwise use
                        // the dropdown-saved `facesDetectorModel`.
                        const preset = String(
                            facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                        );
                        const id =
                            (cfg.facesModel || '').trim() ||
                            (isTgdlMlEnabled()
                                ? `insightface ${preset} (tgdl-ml)`
                                : `insightface ${preset} (Python sidecar)`);
                        // Live provider list — probe the running sidecar's
                        // `/info` so the dashboard's "GPU acceleration"
                        // chip reflects the actually-loaded EP, not the
                        // saved hint. The probe is best-effort: a 2 s
                        // timeout caps the worst case so a dead sidecar
                        // doesn't slow the status page down. Result is
                        // cached for 5 s so the page can poll without
                        // hammering the sidecar.
                        let providers = null;
                        try {
                            const facesSpawn = await import('../../core/ai/faces-spawn.js');
                            const facesClient = await import('../../core/ai/faces-client.js');
                            const sidecarUrl =
                                facesSpawn.getSidecarStatus()?.url ||
                                facesClient.getSidecarUrl() ||
                                null;
                            if (sidecarUrl) {
                                const info = await _fetchSidecarInfo(sidecarUrl);
                                if (info?.providers) providers = info.providers;
                            }
                        } catch {
                            /* sidecar offline / fetch failed — fall through */
                        }
                        return {
                            id,
                            preset,
                            dim: 512,
                            dtype: 'fp32',
                            source: cfg.facesModel ? 'override' : 'bundled',
                            enabled: cfg.faceClustering !== false,
                            loaded: !cfg.facesModel,
                            bundled: !cfg.facesModel,
                            providers,
                            providersRequested: String(facesBlock.providers || 'auto'),
                        };
                    })(),
                    ocr: await (async () => {
                        const enabled = cfg.imageOcr === true;
                        let ready = false;
                        let error = null;
                        let provider = 'sidecar';
                        try {
                            const info = sidecar.health || sidecar.info;
                            if (info) {
                                ready = info.ocr_ready === true;
                                error = info.ocr_error || null;
                            }
                        } catch {
                            /* probe failed */
                        }
                        if (!ready && mlSidecar.ok && mlSidecar.endpoints?.ocr) {
                            ready = true;
                            error = null;
                            provider = 'tgdl-ml';
                        }
                        return { enabled, ready, error, provider };
                    })(),
                    wd14: {
                        enabled: cfg.wd14Tagging !== false,
                        ready: !!sidecar.url && !!sidecar.endpoints?.wd14,
                        id: 'SmilingWolf WD14 tagger',
                    },
                    tags: {
                        enabled: true,
                        loaded: !!(mlSidecar.ok && mlSidecar.endpoints?.tag),
                        id: mlSidecar.clipModel ? `CLIP ${mlSidecar.clipModel} (tgdl-ml)` : '',
                    },
                },
                bgQueue: (() => {
                    try {
                        return aiBgQueueDepths();
                    } catch {
                        return { realtime: 0, backfill: 0 };
                    }
                })(),
                trackers: {
                    aiPeople: jobTrackers.aiPeople.getStatus(),
                    aiTags: jobTrackers.aiTags.getStatus(),
                    aiOcr: jobTrackers.aiOcr.getStatus(),
                    aiWd14: jobTrackers.aiWd14.getStatus(),
                },
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/issues', async (req, res) => {
        try {
            const force = req.query.force === '1' || req.query.refresh === '1';
            res.json(await _getAiIssuesSnapshot({ force }));
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e), code: 'AI_ISSUES_FAILED' });
        }
    });

    // ---- Tag browsing ---------------------------------------------------------

    router.get('/ai/tags/list', async (req, res) => {
        try {
            const { listAllTags } = await import('../../core/db/faces.js');
            const tags = listAllTags({ minCount: 1 });
            res.json({ success: true, tags });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/tags/photos', async (req, res) => {
        try {
            const tag = String(req.query.tag || '').trim();
            if (!tag) return res.status(400).json({ error: 'tag query param required' });
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const { listPhotosForTag } = await import('../../core/db/faces.js');
            const result = listPhotosForTag(tag, { limit, offset });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/tags/details', async (req, res) => {
        try {
            const tag = String(req.query.tag || '').trim();
            if (!tag) return res.status(400).json({ error: 'tag query param required' });
            const { getTagDetails } = await import('../../core/db/faces.js');
            const details = getTagDetails(tag);
            if (!details) return res.status(404).json({ error: 'Tag not found' });
            res.json({ success: true, details });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/ai/tags/suggestions', async (req, res) => {
        try {
            const minRate = Math.max(0, Math.min(1, Number(req.query.minRate) || 0.6));
            const minImages = Math.max(1, Number(req.query.minImages) || 2);
            const { getTagCooccurrenceSuggestions } = await import('../../core/db/faces.js');
            const suggestions = getTagCooccurrenceSuggestions({
                minCooccurrenceRate: minRate,
                minImagesPerTag: minImages,
            });
            res.json({ success: true, suggestions });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/text/:downloadId', async (req, res) => {
        try {
            const { getImageText } = await import('../../core/db/faces.js');
            const result = getImageText(Number(req.params.downloadId));
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/ocr/words', async (req, res) => {
        try {
            const { listOcrWords } = await import('../../core/db/faces.js');
            const minLength = Math.max(2, Number(req.query.minLength) || 3);
            const minCount = Math.max(1, Number(req.query.minCount) || 1);
            const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
            const words = listOcrWords({ minLength, minCount, limit });
            res.json({ success: true, words });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/ocr/photos', async (req, res) => {
        try {
            const word = String(req.query.word || '').trim();
            if (!word) return res.status(400).json({ error: 'word query param required' });
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const { listPhotosForOcrWord } = await import('../../core/db/faces.js');
            const result = listPhotosForOcrWord(word, { limit, offset });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/wd14/tags', async (req, res) => {
        try {
            const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
            const minCount = Math.max(1, Number(req.query.minCount) || 1);
            const minScore = Math.max(0, Math.min(1, Number(req.query.minScore) || 0.2));
            const { listWd14Tags } = await import('../../core/db/faces.js');
            const tags = listWd14Tags({ limit, minCount, minScore });
            res.json({ success: true, tags });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/wd14/photos', async (req, res) => {
        try {
            const tag = String(req.query.tag || '').trim();
            if (!tag) return res.status(400).json({ error: 'tag query param required' });
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const minScore = Math.max(0, Math.min(1, Number(req.query.minScore) || 0.2));
            const { listPhotosForWd14Tag } = await import('../../core/db/faces.js');
            const result = listPhotosForWd14Tag(tag, { limit, offset, minScore });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- Smart albums (v1 + v2 compound rules) ------------------------------
    function _smartAlbumRuleErrorPayload(error) {
        const msg = String(error?.message || 'invalid smart album rule');
        const prefix = msg.includes(':') ? msg.split(':', 1)[0] : 'rule';
        return {
            error: msg,
            code: 'INVALID_RULE',
            details: {
                section: prefix,
            },
        };
    }

    const _smartAlbumsRuntime = {
        running: false,
        enabled: false,
        intervalMin: 15,
        lastRunAt: 0,
        lastDurationMs: 0,
        lastError: null,
        lastAlbums: 0,
        lastMatched: 0,
    };
    let _smartAlbumsTimer = null;

    async function _rebuildAllSmartAlbums({ source = 'manual' } = {}) {
        if (_smartAlbumsRuntime.running) {
            return { skipped: true, reason: 'already_running' };
        }
        _smartAlbumsRuntime.running = true;
        const start = Date.now();
        let totalMatched = 0;
        let rebuilt = 0;
        try {
            const cfg = _aiCfg();
            const sa =
                cfg.smartAlbums && typeof cfg.smartAlbums === 'object' ? cfg.smartAlbums : {};
            if (sa.enabled === false) {
                return { skipped: true, reason: 'disabled' };
            }
            const albums = listSmartAlbums().filter((a) => a.enabled !== false);
            for (const album of albums) {
                try {
                    const r = await rebuildSmartAlbum(album.id);
                    rebuilt += 1;
                    totalMatched += Number(r?.matched || 0);
                } catch (e) {
                    _smartAlbumsRuntime.lastError = `album ${album.id}: ${e?.message || e}`;
                }
            }
            _smartAlbumsRuntime.lastRunAt = Date.now();
            _smartAlbumsRuntime.lastDurationMs = _smartAlbumsRuntime.lastRunAt - start;
            _smartAlbumsRuntime.lastAlbums = rebuilt;
            _smartAlbumsRuntime.lastMatched = totalMatched;
            _smartAlbumsRuntime.lastError = null;
            log({
                source: 'smart-albums',
                level: 'info',
                msg: `rebuild-all (${source}): albums=${rebuilt} matched=${totalMatched} in ${_smartAlbumsRuntime.lastDurationMs}ms`,
            });
            return { rebuilt, matched: totalMatched };
        } catch (e) {
            _smartAlbumsRuntime.lastError = e?.message || String(e);
            log({
                source: 'smart-albums',
                level: 'warn',
                msg: `rebuild-all failed (${source}): ${_smartAlbumsRuntime.lastError}`,
            });
            throw e;
        } finally {
            _smartAlbumsRuntime.running = false;
        }
    }

    function _smartAlbumsRearmSchedule() {
        if (_smartAlbumsTimer) {
            clearInterval(_smartAlbumsTimer);
            _smartAlbumsTimer = null;
        }
        const cfg = _aiCfg();
        const sa = cfg.smartAlbums && typeof cfg.smartAlbums === 'object' ? cfg.smartAlbums : {};
        const enabled = sa.enabled !== false;
        const intervalMin = Math.max(1, Math.min(1440, Number(sa.refreshIntervalMin) || 15));
        _smartAlbumsRuntime.enabled = enabled;
        _smartAlbumsRuntime.intervalMin = intervalMin;
        if (!enabled) return;
        const ms = intervalMin * 60_000;
        _smartAlbumsTimer = setInterval(() => {
            _rebuildAllSmartAlbums({ source: 'scheduled' }).catch(() => {});
        }, ms);
        _smartAlbumsTimer.unref?.();
    }

    setImmediate(_smartAlbumsRearmSchedule);
    try {
        watchConfig(() => _smartAlbumsRearmSchedule());
    } catch {}

    router.get('/ai/smart-albums/runtime', async (_req, res) => {
        const cfg = _aiCfg();
        const sa = cfg.smartAlbums && typeof cfg.smartAlbums === 'object' ? cfg.smartAlbums : {};
        res.json({
            success: true,
            config: {
                enabled: sa.enabled !== false,
                refreshIntervalMin: Math.max(
                    1,
                    Math.min(1440, Number(sa.refreshIntervalMin) || 15),
                ),
                allowLlmRules: sa.allowLlmRules === true,
            },
            runtime: { ..._smartAlbumsRuntime },
        });
    });

    router.post('/ai/smart-albums/rebuild-all', async (_req, res) => {
        try {
            const out = await _rebuildAllSmartAlbums({ source: 'manual' });
            res.json({ success: true, ...out, runtime: { ..._smartAlbumsRuntime } });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/ai/smart-albums', async (_req, res) => {
        try {
            const albums = listSmartAlbums();
            res.json({ success: true, albums });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/ai/smart-albums', async (req, res) => {
        try {
            const id = req.body?.id == null ? null : Number(req.body.id);
            const name = String(req.body?.name || '');
            const rule = req.body?.rule || {};
            const enabled = req.body?.enabled !== false;
            const sortKey = String(req.body?.sortKey || 'created_at_desc');
            const albumId = upsertSmartAlbum({ id, name, rule, enabled, sortKey });
            const rebuilt = await rebuildSmartAlbum(albumId);
            res.json({ success: true, id: albumId, rebuilt });
        } catch (e) {
            res.status(400).json(_smartAlbumRuleErrorPayload(e));
        }
    });

    router.delete('/ai/smart-albums/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const deleted = deleteSmartAlbum(id);
            if (!deleted) return res.status(404).json({ error: 'album not found' });
            res.json({ success: true, deleted });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.post('/ai/smart-albums/:id/rebuild', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const rebuilt = await rebuildSmartAlbum(id);
            res.json({ success: true, id, rebuilt });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Preview a rule without saving/materializing an album.
    router.post('/ai/smart-albums/preview', async (req, res) => {
        try {
            const rule = req.body?.rule || null;
            if (!rule || typeof rule !== 'object') {
                return res.status(400).json({
                    error: 'rule object is required',
                    code: 'MISSING_RULE',
                });
            }
            const limit = Math.max(1, Math.min(500, Number(req.body?.limit) || 50));
            const offset = Math.max(0, Number(req.body?.offset) || 0);
            const preview = await previewSmartAlbumRule(rule, { limit, offset });
            res.json({ success: true, ...preview });
        } catch (e) {
            res.status(400).json(_smartAlbumRuleErrorPayload(e));
        }
    });

    // Parse a natural-language album description into a validated compound
    // rule using the active LLM provider. Returns the parsed rule JSON for
    // the operator to preview before saving. Returns 503 when the LLM is
    // unavailable so the UI can fall back to the manual rule builder.
    router.post('/ai/smart-albums/parse', async (req, res) => {
        try {
            const description = String(req.body?.description || '').trim();
            if (!description) {
                return res.status(400).json({
                    error: 'description is required',
                    code: 'MISSING_DESCRIPTION',
                });
            }

            const cfg = _aiCfg();
            if (!_smartAlbumsLlmRulesEnabled(cfg)) {
                return res.status(503).json({
                    error: 'Natural-language smart album rules are disabled in config',
                    code: 'SMART_ALBUMS_LLM_RULES_DISABLED',
                });
            }

            const llm = await import('../../core/llm/index.js');
            const facesMod = await import('../../core/db/faces.js');

            // Fetch actual tags so the LLM uses real vocabulary
            let availableTags = [];
            let scoreMin = 0;
            let scoreMax = 1;
            try {
                const rows = facesMod.listAllTags({ minCount: 1 });
                if (rows.length) {
                    availableTags = rows.slice(0, 60).map((r) => ({
                        tag: r.tag,
                        count: r.count,
                        avgScore: Number(r.avg_score.toFixed(3)),
                    }));
                    const allAvg = availableTags.map((t) => t.avgScore);
                    scoreMin = Math.min(...allAvg);
                    scoreMax = Math.max(...allAvg);
                }
            } catch {}

            const tagVocabSection =
                availableTags.length > 0
                    ? [
                          '',
                          'AVAILABLE TAGS (from this library — use ONLY these for tags_contains):',
                          availableTags
                              .map((t) => `  "${t.tag}" (n=${t.count}, avg_score=${t.avgScore})`)
                              .join('\n'),
                          '',
                          `Tag score range in this library: ${scoreMin.toFixed(3)} – ${scoreMax.toFixed(3)}.`,
                          'Set tags_contains minScore to 0 unless the user asks for high confidence.',
                          'NEVER invent tags not in this list for tags_contains sub-rules.',
                          'For concepts with no matching tag (e.g. person names, locations, moods),',
                          'use "semantic" sub-rules instead.',
                      ].join('\n')
                    : [
                          '',
                          'No tags scanned yet. Prefer "semantic" sub-rules over "tags_contains".',
                      ].join('\n');

            const systemPrompt = [
                'You are a media album builder. Given a natural-language',
                'description, return a JSON rule object for a smart album.',
                '',
                'Response must be ONLY valid JSON with this schema:',
                JSON.stringify(
                    {
                        type: 'compound',
                        all: [
                            { type: 'tags_contains', tag: 'nsfw', minScore: 0 },
                            { type: 'people_count', min: 2 },
                            { type: 'semantic', query: 'smiling at sunset', minScore: 0.7 },
                            { type: 'text_contains', substring: 'receipt' },
                            { type: 'date', from: '2025-06-01', to: '2025-09-01' },
                            { type: 'file_type', fileType: 'photo' },
                        ],
                        any: [],
                        sort: 'score_desc',
                    },
                    null,
                    2,
                ),
                '',
                'Rules:',
                '- Use "compound" type at top level.',
                '- "all" = every sub-rule must match (AND).',
                '- "any" = at least one must match (OR).',
                '- Combine all/any for complex logic.',
                '- "tags_contains" for OCR-derived keyword matches — ONLY use tags from AVAILABLE TAGS list.',
                '- "people_count" for minimum people in photo.',
                '- "semantic" for natural-language similarity (person names, moods, scenes).',
                '- "text_contains" for OCR text search.',
                '- "date" with ISO date strings.',
                '- "file_type": photo/video/audio/file/voice.',
                '- Omit empty arrays (all/any).',
                '- sort: "score_desc" or "date_desc" or "date_asc".',
                tagVocabSection,
                '',
                'Return ONLY the JSON object, no markdown, no explanation.',
            ].join('\n');

            const result = await llm.generate({
                prompt: description,
                systemPrompt,
                temperature: 0.1,
                maxTokens: 1024,
            });

            if (result.unavailable) {
                return res.status(503).json({
                    error: result.reason,
                    code: result.code || 'LLM_UNAVAILABLE',
                });
            }

            let parsed;
            try {
                let json = (result.text || '').trim();
                if (json.startsWith('```')) {
                    json = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '');
                }
                parsed = JSON.parse(json);
            } catch {
                return res.status(422).json({
                    error: 'LLM returned invalid JSON',
                    code: 'INVALID_JSON',
                    raw: (result.text || '').slice(0, 500),
                });
            }

            let normalized;
            try {
                normalized = facesMod._normalizeSmartAlbumRule(parsed);
            } catch (e) {
                return res.status(400).json(_smartAlbumRuleErrorPayload(e));
            }

            res.json({ success: true, description, rule: normalized });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/ai/smart-albums/:id/items', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
            const offset = Math.max(0, Number(req.query?.offset) || 0);
            const result = listSmartAlbumItems(id, { limit, offset });
            res.json({ success: true, id, ...result });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    // ---- Scan controls -------------------------------------------------------
    const AI_SCAN_FEATURES = new Set(['faces', 'ocr', 'wd14']);

    // JobTracker integration for AI scans:
    //   The scan-runner module already owns the per-feature state machine
    //   (running/scanned/total/abort) and broadcasts its own WS events; the
    //   tracker is wired in via a one-shot tryStart so re-mounted pages can
    //   recover via `jobTrackers.aiX.getStatus()` and so the "ai_index_done"
    //   WS event still fires through the tracker's standard finish hook. The
    //   inner runFn returns a Promise that resolves on the scan-runner's
    //   onDone callback so tracker.success/failure semantics line up with
    //   the actual work.
    router.post('/ai/scan/start', async (req, res) => {
        try {
            const cfg = _aiCfg();
            if (cfg.enabled !== true) {
                return res.status(503).json({
                    error: 'AI subsystem disabled — enable it in Maintenance → AI first.',
                    code: 'AI_DISABLED',
                });
            }
            const feature = String(req.body?.feature || '').toLowerCase();
            if (!AI_SCAN_FEATURES.has(feature)) {
                return res.status(400).json({ error: 'feature must be faces|ocr|wd14' });
            }
            if (aiIsScanRunning(feature)) {
                return res
                    .status(409)
                    .json({ error: 'Scan already running', code: 'ALREADY_RUNNING' });
            }
            if (['ocr', 'wd14'].includes(feature)) {
                const sidecar = await _getAiSidecarSnapshot();
                const mlOcrReady = feature === 'ocr' && isTgdlMlEnabled();
                if (!sidecar.url && !mlOcrReady) {
                    return res.status(503).json({
                        error: 'AI sidecar is not running — start/restart the sidecar before scanning.',
                        code: 'SIDECAR_OFFLINE',
                    });
                }
                if (feature === 'ocr' && !sidecar.endpoints.ocr && !mlOcrReady) {
                    return res.status(503).json({
                        error: 'OCR is not ready — start the sidecar or enable tgdl-ml.',
                        code: 'OCR_NOT_READY',
                    });
                }
            }
            // Allow request-level parameter overrides (e.g., confidence sliders)
            if (feature === 'ocr' && typeof req.body?.language === 'string') {
                cfg.ocrLanguage = req.body.language.trim() || 'eng';
            }
            const tracker = _aiTrackerFor(feature);
            const starter = _aiStarterFor(feature);
            const claim = tracker.tryStart(({ onProgress, signal }) => {
                return new Promise((resolve, reject) => {
                    (async () => {
                        let durableJobId = null;
                        let jobsMod = null;

                        // Create a durable job record as part of the actual run.
                        // This guarantees every started scan gets a lifecycle row
                        // we can close on success/failure.
                        try {
                            jobsMod = await import('../../core/ai/jobs.js');
                            const c = (() => {
                                try {
                                    return getAiCounts({ fileTypes: _facesScanFileTypes(cfg) });
                                } catch {
                                    return { totalEligible: 0 };
                                }
                            })();
                            durableJobId = jobsMod.createJob({
                                type: 'scan',
                                feature,
                                total: c.totalEligible || 0,
                                requestedBy: 'admin',
                            });
                            log({
                                source: 'ai',
                                level: 'info',
                                msg: `job ${durableJobId} created for ${feature} scan`,
                            });
                        } catch (e) {
                            log({
                                source: 'ai',
                                level: 'warn',
                                msg: `failed to create durable job for ${feature}: ${e?.message || e}`,
                            });
                        }

                        // Forward the runner's signal abort -> our internal
                        // cancelScan, so /api/ai/scan/cancel and the tracker's
                        // own abort path both terminate the same scan.
                        if (signal && typeof signal.addEventListener === 'function') {
                            signal.addEventListener('abort', () => {
                                try {
                                    aiCancelScan(feature);
                                } catch {}
                            });
                        }

                        try {
                            starter(
                                cfg,
                                (p) => {
                                    // tracker.onProgress already _safeBroadcasts
                                    // `${prefix}_progress` with the merged status — a
                                    // second broadcast here would double every event
                                    // on the wire. Keep tracker as the single source.
                                    try {
                                        onProgress(p);
                                    } catch {}
                                    if (durableJobId && jobsMod?.updateJobProgress) {
                                        try {
                                            const processed = Number.isFinite(p?.scanned)
                                                ? p.scanned
                                                : Number.isFinite(p?.processed)
                                                  ? p.processed
                                                  : undefined;
                                            jobsMod.updateJobProgress(durableJobId, { processed });
                                        } catch {}
                                    }
                                },
                                (p) => {
                                    // tracker auto-broadcasts `${prefix}_done` on
                                    // resolve/reject — surface scan errors back into
                                    // the tracker promise so it logs + finishes once.
                                    if (p?.error) {
                                        if (durableJobId && jobsMod?.finishJob) {
                                            try {
                                                jobsMod.finishJob(durableJobId, 'failed', p.error);
                                            } catch {}
                                        }
                                        reject(new Error(p.error));
                                        return;
                                    }
                                    if (durableJobId && jobsMod?.finishJob) {
                                        try {
                                            jobsMod.finishJob(durableJobId, 'completed');
                                        } catch {}
                                    }
                                    resolve(p || {});
                                },
                                (entry) => log(entry),
                            );
                        } catch (e) {
                            if (durableJobId && jobsMod?.finishJob) {
                                try {
                                    jobsMod.finishJob(
                                        durableJobId,
                                        'failed',
                                        e?.message || String(e),
                                    );
                                } catch {}
                            }
                            reject(e);
                        }
                    })().catch(reject);
                });
            });
            if (!claim.started) {
                return res.status(409).json({ error: 'Tracker busy', code: claim.code });
            }
            log({ source: 'ai', level: 'info', msg: `${feature} scan starting` });
            res.json({ success: true, started: true });
        } catch (e) {
            log({ source: 'ai', level: 'error', msg: `scan/start failed: ${e?.message || e}` });
            const status =
                e.code === 'AI_LIB_MISSING' || e.code === 'FACES_LIB_MISSING' ? 503 : 500;
            res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    router.post('/ai/scan/cancel', async (req, res) => {
        const feature = String(req.body?.feature || '').toLowerCase();
        if (!AI_SCAN_FEATURES.has(feature)) {
            return res.status(400).json({ error: 'feature must be faces|ocr|wd14' });
        }
        const ok = aiCancelScan(feature);
        // Finish any running job for this feature
        try {
            const { listJobs, finishJob } = await import('../../core/ai/jobs.js');
            const running = listJobs({ feature, status: 'running', limit: 1 });
            if (running.jobs?.length) {
                finishJob(running.jobs[0].id, 'cancelled');
            }
        } catch (e) {
            log({ source: 'ai', level: 'warn', msg: `finish job on cancel: ${e?.message || e}` });
        }
        res.json({ success: true, cancelled: ok });
    });

    router.get('/ai/scan/status', async (req, res) => {
        const feature = String(req.query?.feature || '').toLowerCase();
        if (!AI_SCAN_FEATURES.has(feature)) {
            return res.status(400).json({ error: 'feature must be faces|ocr|wd14' });
        }
        res.json({ success: true, state: aiGetScanState(feature) });
    });

    // ---- Durable job endpoints (Phase 4) ------------------------------------

    router.get('/ai/jobs', async (req, res) => {
        try {
            const { listJobs } = await import('../../core/ai/jobs.js');
            const feature = String(req.query.feature || '').trim() || undefined;
            const status = String(req.query.status || '').trim() || undefined;
            const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            res.json({ success: true, ...listJobs({ feature, status, limit, offset }) });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/ai/jobs/:jobId', async (req, res) => {
        try {
            const { getJob } = await import('../../core/ai/jobs.js');
            const job = getJob(req.params.jobId);
            if (!job) return res.status(404).json({ error: 'Job not found' });
            res.json({ success: true, job });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/ai/jobs/:jobId/cancel', async (req, res) => {
        try {
            const { cancelJob, getJob } = await import('../../core/ai/jobs.js');
            const job = getJob(req.params.jobId);
            if (!job) return res.status(404).json({ error: 'Job not found' });
            cancelJob(req.params.jobId);
            // Also cancel the in-memory scan if it's running
            if (job.feature) aiCancelScan(job.feature);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/ai/scan-state/:scanner', async (req, res) => {
        try {
            const { getScanStateSummary, releaseStaleLocks } = await import(
                '../../core/ai/jobs.js'
            );
            const scanner = String(req.params.scanner || '')
                .trim()
                .toLowerCase();
            if (!scanner) return res.status(400).json({ error: 'scanner param required' });
            // Release stale locks before returning state
            const released = releaseStaleLocks(scanner);
            const summary = getScanStateSummary(scanner);
            res.json({ success: true, scanner, summary, staleLocksReleased: released });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Provider probe (face sidecar onnxruntime backends) -----------------
    //
    // Mirrors the ffmpeg `hwaccel-probe` endpoint pattern used by the Build
    // thumbnails page. Proxies to the Python sidecar's `/providers` route
    // which spins up a tiny onnxruntime session against each candidate
    // provider — only backends that genuinely allocate a session end up in
    // `available`. Surfaces a clear 503 when the sidecar isn't running.
    router.get('/ai/faces/provider-probe', async (_req, res) => {
        try {
            const facesClient = await import('../../core/ai/faces-client.js');
            const url = facesClient.getSidecarUrl();
            if (!url) {
                return res
                    .status(503)
                    .json({ error: 'Face sidecar not running', code: 'SIDECAR_OFFLINE' });
            }
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 10_000);
            let r;
            try {
                r = await globalThis.fetch(`${url}/providers`, { signal: ctrl.signal });
            } finally {
                clearTimeout(t);
            }
            if (!r.ok) {
                return res
                    .status(r.status)
                    .json({ error: `Sidecar returned HTTP ${r.status}`, code: 'SIDECAR_ERROR' });
            }
            const body = await r.json();
            res.json(body);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ====== LLM provider status ===========================================

    // Return LLM provider availability, active provider info, and
    // capabilities. Follows the same pattern as the faces provider-probe
    // endpoint — lightweight probes the AI maintenance page polls.
    router.get('/ai/llm/status', async (_req, res) => {
        try {
            const [providers, active] = await Promise.all([
                llm.probeProviders(),
                llm.getActiveProvider(),
            ]);
            // Include the resolved config so the UI can pre-fill the
            // inline config form without a separate /api/config call.
            let config = {};
            try {
                const { loadConfig } = await import('../../config/manager.js');
                const live = loadConfig();
                config = maskLlmConfig(live?.advanced?.ai?.llm || {});
            } catch {}
            res.json({
                success: true,
                providers,
                active,
                list: llm.listProviders(),
                config,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Run a quick test prompt through the active LLM provider. Useful for
    // the AI maintenance page to verify the provider is responding before
    // the operator tries to use it for a real task.
    router.post('/ai/llm/test', async (req, res) => {
        try {
            const { prompt, systemPrompt, model, temperature, maxTokens } = req.body || {};
            const result = await llm.generate({
                prompt: prompt || 'Reply with exactly one word: ok',
                systemPrompt,
                model,
                temperature,
                maxTokens: maxTokens || 50,
            });
            if (result.unavailable) {
                return res.status(503).json({
                    error: result.reason,
                    code: result.code || 'LLM_UNAVAILABLE',
                });
            }
            res.json({ success: true, text: result.text });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/ai/llm/generate', async (req, res) => {
        try {
            const { prompt, systemPrompt, model, temperature, maxTokens } = req.body || {};
            if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
                return res
                    .status(400)
                    .json({ error: 'prompt is required', code: 'MISSING_PROMPT' });
            }
            if (prompt.length > 32_000) {
                return res
                    .status(400)
                    .json({ error: 'prompt too long (max 32000 chars)', code: 'PROMPT_TOO_LONG' });
            }
            const result = await llm.generate({
                prompt: prompt.trim(),
                systemPrompt,
                model,
                temperature,
                maxTokens,
            });
            if (result.unavailable) {
                return res
                    .status(503)
                    .json({ error: result.reason, code: result.code || 'LLM_UNAVAILABLE' });
            }
            res.json({ success: true, text: result.text, finishReason: result.finishReason });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/ai/llm/chat', async (req, res) => {
        try {
            const { messages, model, temperature, maxTokens } = req.body || {};
            if (!Array.isArray(messages) || !messages.length) {
                return res
                    .status(400)
                    .json({ error: 'messages array is required', code: 'MISSING_MESSAGES' });
            }
            if (messages.length > 100) {
                return res
                    .status(400)
                    .json({ error: 'too many messages (max 100)', code: 'TOO_MANY_MESSAGES' });
            }
            for (const msg of messages) {
                if (!msg?.role || typeof msg.content !== 'string') {
                    return res.status(400).json({
                        error: 'each message must have role and string content',
                        code: 'INVALID_MESSAGE',
                    });
                }
            }
            const result = await llm.chat({ messages, model, temperature, maxTokens });
            if (result.unavailable) {
                return res
                    .status(503)
                    .json({ error: result.reason, code: result.code || 'LLM_UNAVAILABLE' });
            }
            res.json({ success: true, text: result.text, finishReason: result.finishReason });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ====== Semantic / natural-language search (image embeddings) =============

    function _compatSearchRow(row) {
        return {
            ...row,
            // Back-compat aliases for older gallery callers that still read
            // snake_case fields from /api/ai/search.
            download_id: row.id,
            group_id: row.groupId,
            group_name: row.groupName,
            file_name: row.fileName,
            file_path: row.filePath,
            file_type: row.fileType,
            file_size: row.fileSize,
            created_at: row.createdAt,
        };
    }

    async function _runAiSearch({ query, topK, minScore, fileTypes, sources }) {
        const { crossModalSearch } = await import('../../core/ai/search.js');
        const { embed: llmEmbedFn } = await import('../../core/llm/index.js');
        const llmEmbed = async (texts) => {
            const r = await llmEmbedFn({ texts });
            return Array.isArray(r) ? r : null;
        };
        const result = await crossModalSearch(query, {
            topK,
            minScore,
            fileTypes,
            sources,
            llmEmbed,
        });
        return {
            query: result.query,
            modalities: result.modalities,
            results: (result.results || []).map(_compatSearchRow),
        };
    }

    // Search images by natural-language query. Supports both GET and POST
    // for backward compatibility with older gallery clients.
    router.get('/ai/search', async (req, res) => {
        try {
            const cfg = _aiCfg();
            if (!_semanticSearchEnabled(cfg)) {
                return res.status(503).json({
                    error: 'Semantic search is disabled in config',
                    code: 'SEMANTIC_SEARCH_DISABLED',
                });
            }

            const query = String(req.query.q || '').trim();
            if (!query) {
                return res.status(400).json({
                    error: 'query parameter q is required',
                    code: 'MISSING_QUERY',
                });
            }

            const topK = Math.min(Math.max(1, Number(req.query.topK) || 50), 500);
            const minScore = Number(req.query.minScore) || 0.0;
            const fileTypes = req.query.fileTypes
                ? String(req.query.fileTypes)
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                : undefined;
            const sources = req.query.sources
                ? String(req.query.sources)
                      .split(',')
                      .map((s) => s.trim().toLowerCase())
                      .filter(Boolean)
                : undefined;

            const result = await _runAiSearch({ query, topK, minScore, fileTypes, sources });
            res.json({
                success: true,
                query: result.query,
                total: result.results.length,
                results: result.results,
                modalities: result.modalities,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/ai/search', async (req, res) => {
        try {
            const cfg = _aiCfg();
            if (!_semanticSearchEnabled(cfg)) {
                return res.status(503).json({
                    error: 'Semantic search is disabled in config',
                    code: 'SEMANTIC_SEARCH_DISABLED',
                });
            }

            const query = String(req.body?.q || '').trim();
            if (!query) {
                return res.status(400).json({
                    error: 'q is required',
                    code: 'MISSING_QUERY',
                });
            }

            const topK = Math.min(
                Math.max(1, Number(req.body?.topK || req.body?.limit) || 50),
                500,
            );
            const minScore = Number(req.body?.minScore) || 0.0;
            const fileTypes = Array.isArray(req.body?.fileTypes)
                ? req.body.fileTypes.map((s) => String(s).trim()).filter(Boolean)
                : undefined;
            const sources = Array.isArray(req.body?.sources)
                ? req.body.sources.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
                : undefined;

            const result = await _runAiSearch({ query, topK, minScore, fileTypes, sources });
            res.json({
                success: true,
                query: result.query,
                total: result.results.length,
                results: result.results,
                modalities: result.modalities,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Find similar media by seeding cosine search with one existing
    // embedding row. Response shape mirrors /ai/search for gallery reuse.
    router.post('/ai/search/similar', async (req, res) => {
        try {
            const cfg = _aiCfg();
            if (!_semanticSearchEnabled(cfg)) {
                return res.status(503).json({
                    error: 'Semantic search is disabled in config',
                    code: 'SEMANTIC_SEARCH_DISABLED',
                });
            }

            const downloadId = Number(req.body?.downloadId);
            if (!Number.isFinite(downloadId) || downloadId <= 0) {
                return res
                    .status(400)
                    .json({ error: 'downloadId is required', code: 'INVALID_ID' });
            }
            const limit = Math.min(Math.max(1, Number(req.body?.limit) || 60), 500);

            const db = getDb();
            const seed = db
                .prepare(
                    `SELECT download_id, embedding, model FROM image_embeddings WHERE download_id = ?`,
                )
                .get(downloadId);
            if (!seed?.embedding?.byteLength) {
                return res.json({
                    success: true,
                    seedId: downloadId,
                    total: 0,
                    results: [],
                    modalities: ['semantic'],
                    code: 'SEED_EMBEDDING_MISSING',
                });
            }

            const queryEmbedding = new Float32Array(
                seed.embedding.buffer,
                seed.embedding.byteOffset,
                seed.embedding.byteLength / 4,
            );
            const { searchEmbeddings } = await import('../../core/db/faces.js');
            const rows = searchEmbeddings(queryEmbedding, {
                topK: limit + 1,
                minScore: 0,
                model: seed.model || null,
            })
                .filter((r) => Number(r.id) !== downloadId)
                .slice(0, limit)
                .map((r) =>
                    _compatSearchRow({
                        ...r,
                        explanations: [{ source: 'semantic', score: Number(r.score) || 0 }],
                    }),
                );

            return res.json({
                success: true,
                seedId: downloadId,
                total: rows.length,
                results: rows,
                modalities: ['semantic'],
            });
        } catch (e) {
            return res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Return embedding coverage stats for the AI maintenance page.
    router.get('/ai/embeddings/stats', async (_req, res) => {
        try {
            const { listEmbeddingModels } = await import('../../core/db/faces.js');
            const cfg = _aiCfg();
            const configuredModel = _resolveClipModelId(cfg);
            const models = listEmbeddingModels();
            const totalImages = models.reduce((sum, m) => sum + m.count, 0);
            const activeStoredModel = models.length
                ? models.reduce((a, b) => (a.count >= b.count ? a : b)).model
                : null;
            const staleRows = models
                .filter((m) => String(m.model) !== String(configuredModel))
                .reduce((sum, m) => sum + Number(m.count || 0), 0);
            res.json({
                success: true,
                total: totalImages,
                models,
                configuredModel,
                activeStoredModel,
                staleRows,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Re-index embeddings — compute CLIP image embeddings for every
    // download that is missing one (or whose model is stale). Iterates
    // in batches so the sidecar isn't flooded and the operator can watch
    // progress on the AI maintenance page.
    router.post('/ai/embeddings/reindex', async (req, res) => {
        try {
            const { loadConfig } = await import('../../config/manager.js');
            const { embedImage, hasEmbeddingProvider } = await import(
                '../../core/ai/faces-client.js'
            );
            const { clearStaleEmbeddings, listEmbeddingModels, setImageEmbedding } = await import(
                '../../core/db/faces.js'
            );
            const { getDb } = await import('../../core/db.js');

            const live = loadConfig();
            const clipModel = _resolveClipModelId(live?.advanced?.ai || {});

            if (!hasEmbeddingProvider()) {
                return res.status(503).json({
                    error: 'No embedding provider is running — configure tgdl sidecar CLIP or tgdl-ml',
                    code: 'EMBEDDING_PROVIDER_OFFLINE',
                });
            }

            // Clear stale embeddings if the model changed.
            // Always pick the most common model for comparison — when
            // multiple models exist (e.g. after an interrupted migration)
            // we still detect the change and purge non-matching rows.
            const before = listEmbeddingModels();
            const activeModel = before.length
                ? before.reduce((a, b) => (a.count > b.count ? a : b)).model
                : null;

            if (activeModel && activeModel !== clipModel) {
                const purged = clearStaleEmbeddings(clipModel);
                console.log(
                    '[ai-embeddings] model changed from',
                    activeModel,
                    'to',
                    clipModel,
                    '- purged',
                    purged.dropped,
                    'stale rows, requeued',
                    purged.requeued,
                );
            }

            // Find downloads that have no embedding yet
            const db = getDb();
            const missing = db
                .prepare(
                    `SELECT d.id, d.file_path, d.file_type
                       FROM downloads d
                      WHERE d.id NOT IN (
                          SELECT download_id FROM image_embeddings
                      )
                        AND d.file_type IN ('photo', 'image')
                      ORDER BY d.id
                      LIMIT ?`,
                )
                .all(req.body?.limit || 250);

            if (!missing.length) {
                return res.json({
                    success: true,
                    processed: 0,
                    remaining: 0,
                    done: true,
                });
            }

            let processed = 0;
            let errors = 0;
            const errors_ = [];

            for (const row of missing) {
                const abs = _resolveAiPath(row.file_path);
                if (!abs) {
                    errors++;
                    continue;
                }
                try {
                    const r = await embedImage(abs);
                    if (r?.embedding?.length) {
                        const blob = Buffer.from(
                            new Uint8Array(Float32Array.from(r.embedding).buffer),
                        );
                        setImageEmbedding(row.id, blob, r.model || clipModel);
                        processed++;
                    } else {
                        errors++;
                    }
                } catch {
                    errors++;
                    if (errors_.length < 5) errors_.push(row.id);
                }
            }

            const after = listEmbeddingModels();
            const totalAfter = after.reduce((s, m) => s + m.count, 0);

            res.json({
                success: true,
                model: clipModel,
                processed,
                errors,
                sampleErrors: errors_.length ? errors_ : undefined,
                total: totalAfter,
                remaining: Math.max(0, missing.length - processed - errors),
                done: !(errors > 0),
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Restart the sidecar so a config change (e.g. provider switch) takes
    // effect without an app restart. The spawn module's stopSidecar() sends
    // SIGTERM with a SIGKILL fallback after KILL_GRACE_MS; startSidecar()
    // then re-reads `loadConfig()` + env so the new provider is picked up.
    router.post('/ai/faces/restart', async (_req, res) => {
        try {
            const spawn = await import('../../core/ai/faces-spawn.js');
            spawn.stopSidecar();
            // Fire-and-forget — startSidecar() is idempotent and never
            // throws (errors surface via `getSidecarStatus()` + WS).
            spawn.startSidecar().catch(() => {});
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Auto-detect-platform installer for the Python sidecar. Runs
    // `python -m tgdl_faces.install`, which picks the right onnxruntime EP
    // (DirectML on Windows, CUDA on Linux+NVIDIA, OpenVINO on Linux+Intel,
    // CoreML/CPU elsewhere) and pip-installs it. Progress streams over WS
    // as `ai_faces_install_progress` / `ai_faces_install_done`. Body accepts
    // optional `{force: 'cpu'|'gpu'|'directml'|'openvino'}` for operators
    // who want to override detection. Single-flight inside faces-spawn.
    router.post('/ai/faces/install-deps', async (req, res) => {
        try {
            const spawnMod = await import('../../core/ai/faces-spawn.js');
            const force = typeof req.body?.force === 'string' ? req.body.force : undefined;
            spawnMod.resetAutoInstallGuard();
            // Fire-and-forget — pip can take 1-5 min on first run while
            // downloading onnxruntime wheels. Progress flows over WS.
            spawnMod
                .installPythonDeps({ force })
                .then((r) => {
                    if (r.ok) {
                        try {
                            spawnMod.stopSidecar();
                        } catch {}
                        try {
                            spawnMod.startSidecar().catch(() => {});
                        } catch {}
                    }
                })
                .catch(() => {});
            res.json({ started: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Full reindex — clears every face detection + every cluster, then
    // flips every photo's `ai_indexed_at` back to NULL so the next scan
    // re-detects from scratch. Use when:
    //   - switching `facesDetectorModel` (embedding space changes)
    //   - a previous run produced obviously-wrong clusters (bad threshold)
    //   - the operator wants a clean slate
    //
    // This is DESTRUCTIVE — the People grid wipes immediately and the
    // next scan re-builds it. Caller MUST gate this behind a confirm
    // sheet UI-side. The Node side enforces a single-flight guard against
    // any scan that's currently running.
    // Phase B only — re-cluster existing face embeddings without
    // re-detecting. Lets the operator tweak ε / minPoints and see the new
    // People grid in seconds (vs minutes for a full re-scan). Implemented
    // by triggering the standard faces scan-runner; Phase A is a no-op when
    // every photo carries `ai_indexed_at IS NOT NULL`, so for fully-indexed
    // libraries this lands in Phase B immediately. For partially-indexed
    // libraries (a scan was cancelled mid-way), Phase A picks up where it
    // left off — same as clicking "Scan now".
    router.post('/ai/faces/recluster', async (_req, res) => {
        try {
            if (aiIsScanRunning && aiIsScanRunning('faces')) {
                return res.status(409).json({
                    error: 'scan_running',
                    message: 'A face scan is already in progress.',
                });
            }
            const cfg = _aiCfg();
            try {
                if (aiStartFacesScan) aiStartFacesScan(cfg).catch(() => {});
            } catch {}
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/ai/faces/reindex', async (_req, res) => {
        try {
            if (aiIsScanRunning && aiIsScanRunning('faces')) {
                return res.status(409).json({
                    error: 'scan_running',
                    message: 'A face scan is already in progress. Cancel it before reindexing.',
                });
            }
            const cfg = _aiCfg();
            const types = _facesScanFileTypes(cfg);
            const placeholders = types.map(() => '?').join(',');
            const db = getDb();
            const tx = db.transaction(() => {
                db.prepare(`DELETE FROM faces`).run();
                db.prepare(`DELETE FROM people`).run();
                db.prepare(
                    `UPDATE downloads SET ai_indexed_at = NULL WHERE file_type IN (${placeholders})`,
                ).run(...types);
            });
            tx();
            broadcast({ type: 'ai_faces_reindexed', ts: Date.now() });
            // Kick off the scan immediately so the operator sees progress
            // right away. Fire-and-forget — the scan owns its own state
            // machine + WS events.
            try {
                if (aiStartFacesScan) aiStartFacesScan(cfg).catch(() => {});
            } catch {}
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Backfill missing `faces.quality_score` for legacy rows without
    // re-running full detection. Uses bbox-only heuristics (size/aspect +
    // confidence fallback) and writes only rows where score is currently NULL.
    router.post('/ai/faces/backfill-quality', async (req, res) => {
        try {
            const chunkSize = Math.max(100, Math.min(5000, Number(req.body?.chunkSize) || 1000));
            const minFaceSizePx = Math.max(
                16,
                Math.min(1024, Number(req.body?.minFaceSizePx) || 48),
            );
            const confidenceFallback = Math.max(
                0,
                Math.min(1, Number(req.body?.confidenceFallback) || 0.3),
            );
            const result = backfillMissingFaceQualityScores({
                chunkSize,
                minFaceSizePx,
                confidenceFallback,
            });
            log({
                source: 'ai',
                level: 'info',
                msg: `faces quality backfill complete: scanned=${result.scanned} updated=${result.updated}`,
            });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- People (face clusters) ---------------------------------------------

    router.get('/ai/people', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
            const offset = Math.max(0, Number(req.query?.offset) || 0);
            const scope = String(req.query?.scope || 'local').toLowerCase();
            const local = listPeople({ limit, offset });
            if (scope !== 'federated') {
                return res.json({ success: true, scope: 'local', ...local });
            }
            // Federated — list local clusters first, then peer summaries
            // tagged with the owning peer id. The UI's cover thumbnail is
            // resolved via the peer-aware /api/thumbs/* path.
            let peerErrors = 0;
            try {
                const { listPeers } = await import('../../core/cluster/peers.js');
                const { relayTo } = await import('../../core/cluster/relay.js');
                const peers = listPeers();
                const peerLists = await Promise.all(
                    peers.map(async (p) => {
                        try {
                            const r = await relayTo({
                                targetPeerId: p.peerId,
                                method: 'GET',
                                path: `/api/ai/people?limit=${limit}`,
                            });
                            if (!r.ok) return [];
                            const json = await r.json();
                            const rows = Array.isArray(json?.people) ? json.people : [];
                            return rows.map((row) => ({
                                ...row,
                                _peerId: p.peerId,
                                _peerName: p.name || p.peerId,
                            }));
                        } catch {
                            peerErrors += 1;
                            return [];
                        }
                    }),
                );
                const merged = [
                    ...(local.people || []).map((row) => ({ ...row, _peerId: 'local' })),
                    ...peerLists.flat(),
                ];
                return res.json({
                    success: true,
                    scope: 'federated',
                    people: merged,
                    total: merged.length,
                    peerErrors,
                });
            } catch (e) {
                return res.json({ success: true, scope: 'local', ...local });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Faces detected on a single download — used by the viewer's overlay
    // to draw face boxes over the image. Cheap (single indexed SELECT)
    // + small payload (tens of rows max per photo).
    router.get('/ai/faces/by-download/:id', async (req, res) => {
        try {
            const downloadId = Number(req.params.id);
            if (!Number.isFinite(downloadId) || downloadId <= 0) {
                return res.status(400).json({ error: 'invalid download id' });
            }
            const rows = getDb()
                .prepare(`
                SELECT f.id, f.x, f.y, f.w, f.h, f.person_id, f.quality_score,
                       p.label AS person_label
                  FROM faces f
                  LEFT JOIN people p ON p.id = f.person_id
                 WHERE f.download_id = ?
                 ORDER BY f.id ASC
            `)
                .all(downloadId);
            res.json({ success: true, downloadId, faces: rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/group-by-person', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
            const rows = getDb()
                .prepare(`
                SELECT p.id, p.label, p.face_count,
                       (SELECT f.download_id FROM faces f WHERE f.person_id = p.id LIMIT 1) AS cover_download_id
                  FROM people p
                 ORDER BY p.face_count DESC, p.id ASC
                 LIMIT ?
            `)
                .all(limit);
            res.json({ success: true, groups: rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Best-face crop for a person tile/avatar.
    router.get('/ai/person/:id/face', async (req, res) => {
        try {
            const personId = Number(req.params.id);
            if (!Number.isFinite(personId) || personId <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const size = Math.max(64, Math.min(512, Number(req.query.w) || 160));
            const row = getDb()
                .prepare(
                    `SELECT f.x, f.y, f.w, f.h, d.file_path
                       FROM faces f
                       JOIN downloads d ON d.id = f.download_id
                      WHERE f.person_id = ?
                      ORDER BY COALESCE(f.quality_score, 0) DESC, f.w * f.h DESC
                      LIMIT 1`,
                )
                .get(personId);
            if (!row) return res.status(404).json({ error: 'no face found' });

            const resolved = await safeResolveDownload(row.file_path);
            if (!resolved.ok) {
                return res
                    .status(resolved.reason === 'missing' ? 404 : 403)
                    .json({ error: resolved.reason });
            }

            const pad = 0.4;
            const meta = await sharp(resolved.real, { failOn: 'none' }).metadata();
            const imgW = meta.width || 9999;
            const imgH = meta.height || 9999;
            const left = Math.max(0, Math.round(row.x - row.w * pad));
            const top = Math.max(0, Math.round(row.y - row.h * pad));
            const right = Math.min(imgW, Math.round(row.x + row.w + row.w * pad));
            const bottom = Math.min(imgH, Math.round(row.y + row.h + row.h * pad));
            const width = Math.max(1, right - left);
            const height = Math.max(1, bottom - top);

            const buf = await sharp(resolved.real, { failOn: 'none' })
                .extract({ left, top, width, height })
                .resize(size, size, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 82, progressive: true })
                .toBuffer();
            res.set('content-type', 'image/jpeg');
            res.set('cache-control', 'public, max-age=604800, immutable');
            res.send(buf);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Crop for one face row (used in person photo gallery).
    router.get('/ai/faces/:id/crop', async (req, res) => {
        try {
            const faceId = Number(req.params.id);
            if (!Number.isFinite(faceId) || faceId <= 0) {
                return res.status(400).json({ error: 'invalid face id' });
            }
            const size = Math.max(64, Math.min(512, Number(req.query.w) || 128));
            const row = getDb()
                .prepare(
                    `SELECT f.x, f.y, f.w, f.h, d.file_path
                       FROM faces f
                       JOIN downloads d ON d.id = f.download_id
                      WHERE f.id = ?`,
                )
                .get(faceId);
            if (!row) return res.status(404).json({ error: 'face not found' });

            const resolved = await safeResolveDownload(row.file_path);
            if (!resolved.ok) {
                return res
                    .status(resolved.reason === 'missing' ? 404 : 403)
                    .json({ error: resolved.reason });
            }

            const pad = 0.4;
            const meta = await sharp(resolved.real, { failOn: 'none' }).metadata();
            const imgW = meta.width || 9999;
            const imgH = meta.height || 9999;
            const left = Math.max(0, Math.round(row.x - row.w * pad));
            const top = Math.max(0, Math.round(row.y - row.h * pad));
            const right = Math.min(imgW, Math.round(row.x + row.w + row.w * pad));
            const bottom = Math.min(imgH, Math.round(row.y + row.h + row.h * pad));
            const width = Math.max(1, right - left);
            const height = Math.max(1, bottom - top);

            const buf = await sharp(resolved.real, { failOn: 'none' })
                .extract({ left, top, width, height })
                .resize(size, size, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 82, progressive: true })
                .toBuffer();
            res.set('content-type', 'image/jpeg');
            res.set('cache-control', 'public, max-age=604800, immutable');
            res.send(buf);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/people/:id/photos', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
            const offset = Math.max(0, Number(req.query?.offset) || 0);
            const result = listPhotosForPerson(id, { limit, offset });
            res.json({ success: true, personId: id, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.patch('/ai/people/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const label = String(req.body?.label || '')
                .trim()
                .slice(0, 100);
            const changes = renamePerson(id, label || null);
            if (!changes) return res.status(404).json({ error: 'person not found' });
            res.json({ success: true, id, label });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Merge person `otherId` INTO `id`. Every face previously labelled
    // `otherId` now belongs to `id`; the empty cluster is deleted. The
    // preserved cluster keeps its label. Used by the UI when two clusters
    // turn out to be the same person.
    router.post('/ai/people/:id/merge', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const otherId = Number(req.body?.otherId);
            if (!Number.isFinite(id) || !Number.isFinite(otherId) || id === otherId) {
                return res.status(400).json({ error: 'id + otherId required and must differ' });
            }
            const { mergeFacePerson } = await import('../../core/db.js');
            const r = mergeFacePerson(id, otherId);
            log({
                source: 'ai',
                level: 'info',
                msg: `people/merge: target=${id} other=${otherId} moved=${r.moved} deleted=${r.deleted}`,
            });
            res.json({ success: true, target: id, other: otherId, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Pull selected faces out of their current cluster(s) and create a
    // fresh cluster from them. Used when DBSCAN over-merged two similar
    // people — operator picks the faces that look wrong, calls split,
    // gets a new cluster they can rename.
    router.post('/ai/people/:id/split', async (req, res) => {
        try {
            const faceIds = Array.isArray(req.body?.faceIds) ? req.body.faceIds : [];
            const label =
                String(req.body?.label || '')
                    .trim()
                    .slice(0, 100) || null;
            if (!faceIds.length) {
                return res.status(400).json({ error: 'faceIds required (non-empty array)' });
            }
            const { splitFacePerson } = await import('../../core/db.js');
            const r = splitFacePerson(faceIds, label);
            if (!r.personId) {
                return res.status(404).json({ error: 'no faces matched the supplied ids' });
            }
            log({
                source: 'ai',
                level: 'info',
                msg: `people/split: new personId=${r.personId} moved=${r.moved} label=${label || '(unlabelled)'}`,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Move a single face to a different cluster (or to `null` = unassigned).
    // Used for "this one face was put in the wrong cluster" repair.
    router.post('/ai/faces/:id/reassign', async (req, res) => {
        try {
            const faceId = Number(req.params.id);
            if (!Number.isFinite(faceId) || faceId <= 0) {
                return res.status(400).json({ error: 'invalid face id' });
            }
            const target =
                req.body?.personId == null || req.body.personId === ''
                    ? null
                    : Number(req.body.personId);
            if (target != null && !Number.isFinite(target)) {
                return res.status(400).json({ error: 'invalid personId' });
            }
            const { reassignFace } = await import('../../core/db.js');
            const r = reassignFace(faceId, target);
            if (!r.ok) return res.status(404).json({ error: 'face not found' });
            log({
                source: 'ai',
                level: 'info',
                msg: `faces/reassign: face=${faceId} from=${r.oldPersonId} to=${r.newPersonId}`,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.delete('/ai/people/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const changes = deletePerson(id);
            if (!changes) return res.status(404).json({ error: 'person not found' });
            res.json({ success: true, id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Re-index — full reset. Drops every AI artefact (embeddings, tags,
    // faces, people) and clears `ai_indexed_at` on every download so the
    // next scan starts from scratch. Use after changing model/dtype/label
    // list when the partial-clear of `clearStaleEmbeddings` isn't enough
    // (e.g. label list shrunk and the operator wants stale tags gone too).
    //
    // Aborts every in-flight scan first to avoid the race where the loop
    // keeps re-stamping `ai_indexed_at` while we're trying to null it out.
    router.post('/ai/reindex', async (req, res) => {
        try {
            // Cancel any in-flight scan before nuking the artefacts.
            let cancelled = 0;
            for (const f of ['embed', 'faces', 'ocr', 'wd14']) {
                if (aiCancelScan(f)) cancelled += 1;
            }
            // Settle one tick so the scan loops see the abort signal.
            if (cancelled) await new Promise((r) => setTimeout(r, 100));
            const r = resetAllAiData();
            log({
                source: 'ai',
                level: 'info',
                msg: `re-index — wiped embeddings=${r.embeddings} tags=${r.tags} wd14Tags=${r.wd14Tags} faces=${r.faces} people=${r.people} text=${r.text}; re-queued=${r.requeued}; cancelled-scans=${cancelled}`,
            });
            try {
                broadcast({ type: 'ai_reindex', ...r });
            } catch {}
            res.json({ success: true, cancelled, ...r });
        } catch (e) {
            log({ source: 'ai', level: 'error', msg: `re-index failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message });
        }
    });

    // AI auto-scan drip timer — wakes every `autoScanIntervalMs`, checks
    // the live config + queue depth, then pushes up to `autoScanBatchSize`
    // un-indexed photos onto the backfill queue. The existing
    // `pregenerateAi` drain picks them up and runs them through the
    // embed/tag/face pipelines using the operator's current model + dtype
    // settings.
    //
    // Why drip + queue (not direct scan loop):
    //   - Queue path is shared with realtime downloads, so live monitor
    //     jobs always preempt drip work (realtime is `priority='realtime'`,
    //     drip is `'backfill'`).
    //   - Resume-safe: state lives in `cfg.autoScan`. A restart leaves the
    //     state untouched, the timer rearms on boot, and we resume from
    //     wherever `ai_indexed_at IS NULL` says we left off.
    //   - Cancel-safe: switching to 'paused' / 'idle' just makes the next
    //     tick a no-op. In-flight work in the existing queue finishes
    //     gracefully (operator stops new work, not the row currently
    //     being embedded).
    let _aiAutoScanTimer = null;
    let _aiAutoScanLastTickAt = 0;
    let _aiAutoScanLastEnqueued = 0;

    function _aiAutoScanTick() {
        try {
            const cfg = _aiCfg();
            if (cfg.enabled !== true) return;
            if (cfg.autoScan !== 'running') return;
            const ceiling = Math.max(1, Number(cfg.autoScanQueueCeiling) || 50);
            const batchSize = Math.max(1, Number(cfg.autoScanBatchSize) || 10);
            let depths;
            try {
                depths = aiBgQueueDepths();
            } catch {
                depths = { realtime: 0, backfill: 0 };
            }
            // Back off when the backfill queue is already saturated — the
            // drain reads from it FIFO, so dumping more in just grows the
            // in-memory list without speeding work up.
            if (depths.backfill >= ceiling) {
                _aiAutoScanLastTickAt = Date.now();
                _aiAutoScanLastEnqueued = 0;
                return;
            }
            // Realtime traffic gets priority — if there's live work
            // happening, skip the drip this tick so the user-visible path
            // finishes faster.
            if (depths.realtime > 0) {
                _aiAutoScanLastTickAt = Date.now();
                _aiAutoScanLastEnqueued = 0;
                return;
            }
            const fileTypes = _facesScanFileTypes(cfg);
            const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
            if (!batch.length) {
                _aiAutoScanLastTickAt = Date.now();
                _aiAutoScanLastEnqueued = 0;
                return;
            }
            for (const row of batch) {
                try {
                    aiPregenerateAi(row.id, { priority: 'backfill' });
                } catch {}
            }
            _aiAutoScanLastTickAt = Date.now();
            _aiAutoScanLastEnqueued = batch.length;
            log({
                source: 'ai-autoscan',
                level: 'info',
                msg: `tick: enqueued=${batch.length} backfillDepth=${depths.backfill} ceiling=${ceiling}`,
            });
        } catch (e) {
            log({
                source: 'ai-autoscan',
                level: 'warn',
                msg: `tick failed: ${e?.message || e}`,
            });
        }
    }

    function _aiAutoScanRearm() {
        try {
            if (_aiAutoScanTimer) {
                clearInterval(_aiAutoScanTimer);
                _aiAutoScanTimer = null;
            }
            const cfg = _aiCfg();
            if (cfg.enabled !== true) return;
            if (cfg.autoScan !== 'running') return;
            const ms = Math.max(
                5_000,
                Math.min(3_600_000, Number(cfg.autoScanIntervalMs) || 60_000),
            );
            _aiAutoScanTimer = setInterval(_aiAutoScanTick, ms);
            _aiAutoScanTimer.unref?.();
            // Kick once right away so the operator sees a tick land before
            // the first full interval elapses.
            setImmediate(_aiAutoScanTick);
            log({
                source: 'ai-autoscan',
                level: 'info',
                msg: `armed: interval=${ms}ms batchSize=${cfg.autoScanBatchSize ?? 10}`,
            });
        } catch (e) {
            log({
                source: 'ai-autoscan',
                level: 'warn',
                msg: `rearm failed: ${e?.message || e}`,
            });
        }
    }
    // Arm on boot — picks up the persisted state automatically. The
    // config-change subscriber below also rearms on every save.
    setImmediate(_aiAutoScanRearm);
    try {
        watchConfig(() => _aiAutoScanRearm());
    } catch {}

    // Start / Pause / Stop control — single endpoint, action enum so the
    // state machine stays explicit. Resume is just `action='start'` from
    // a paused state — the un-indexed cursor (ai_indexed_at IS NULL)
    // keeps the picks identical so progress persists.
    router.post('/ai/auto-scan', async (req, res) => {
        try {
            const action = String(req.body?.action || '').toLowerCase();
            const ACTIONS = { start: 'running', pause: 'paused', stop: 'idle' };
            const next = ACTIONS[action];
            if (!next) {
                return res.status(400).json({ error: 'action must be one of: start, pause, stop' });
            }
            const { loadConfig, saveConfig } = await import('../../config/manager.js');
            const live = loadConfig();
            const merged = {
                ...live,
                advanced: {
                    ...(live.advanced || {}),
                    ai: { ...(live.advanced?.ai || {}), autoScan: next },
                },
            };
            await saveConfig(merged);
            _aiAutoScanRearm();
            log({
                source: 'ai-autoscan',
                level: 'info',
                msg: `state: ${live.advanced?.ai?.autoScan || 'idle'} → ${next} (action=${action})`,
            });
            res.json({ success: true, state: next });
        } catch (e) {
            log({
                source: 'ai-autoscan',
                level: 'error',
                msg: `state change failed: ${e?.message || e}`,
            });
            res.status(500).json({ error: e.message });
        }
    });

    // AI health check / doctor strip — surfaces the Python face sidecar's
    // install + runtime surface (binary, interpreter, provider, model, index
    // progress). UI renders the response as a list of ✓/⚠/✗ rows so the
    // operator can spot a missing dep in one look. Each `check` has a stable
    // `id` so the UI can color-code without parsing the label string.
    //
    // Hardening rules (carried over from the v2.12.1 hardening pass):
    //   - Every probe wrapped in try/catch — one failing probe never
    //     fails the request.
    //   - Every setTimeout / spawn uses an integer literal — no NaN risk
    //     that could surface as `TimeoutNaNWarning` in the docker logs.
    //   - Every fetch / child spawn carries an AbortController or hard
    //     timeout so a wedged dep can't hang the request.

    // Doctor — sidecar-aligned probe set. Six rows that cover the actual
    // install surface (Python sidecar + onnxruntime backends + buffalo_l):
    //
    //   1. Python face sidecar reachability (auto-spawn lifecycle state).
    //   2. Host Python on PATH — informational, used by the fallback spawn
    //      path when the prebuilt binary is unavailable.
    //   3. Prebuilt sidecar binary on disk (auto-downloaded on first scan).
    //   4. Inference provider resolved by onnxruntime inside the sidecar.
    //   5. Model loaded (insightface buffalo_l).
    //   6. Photos indexed (kept — drives the operator's progress sense).
    //
    // Each probe is wrapped in try/catch — one failing probe never fails the
    // request. Every fetch / spawn carries a fixed-integer timeout so a
    // black-holed dep can't hang the request.
    router.get(['/ai/doctor', '/ai/health'], async (_req, res) => {
        const checks = [];
        const mlActive = isTgdlMlEnabled();

        if (mlActive) {
            // tgdl-ml is the active inference backend — show its health instead
            // of the legacy Python sidecar probes (Host Python / binary checks
            // are irrelevant when tgdl-ml handles all inference).

            // 1. tgdl-ml reachability.
            try {
                const mlUrl = getTgdlMlUrl();
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3000);
                let ok = false;
                let info = null;
                try {
                    const r = await globalThis.fetch(`${mlUrl}/health`, { signal: ctrl.signal });
                    if (r.ok) {
                        ok = true;
                        info = await r.json().catch(() => null);
                    }
                } finally {
                    clearTimeout(t);
                }
                checks.push({
                    id: 'sidecar',
                    label: 'tgdl-ml sidecar',
                    status: ok ? 'ok' : 'fail',
                    detail: ok ? `healthy at ${mlUrl}` : `unreachable at ${mlUrl}`,
                });

                // 2. Inference provider (from /info).
                let providers = [];
                try {
                    const ctrl2 = new AbortController();
                    const t2 = setTimeout(() => ctrl2.abort(), 2000);
                    try {
                        const r2 = await globalThis.fetch(`${mlUrl}/info`, {
                            signal: ctrl2.signal,
                        });
                        if (r2.ok) {
                            const inf = await r2.json();
                            if (Array.isArray(inf?.providers)) providers = inf.providers;
                        }
                    } finally {
                        clearTimeout(t2);
                    }
                } catch {
                    /* best-effort */
                }
                const top = providers[0] || 'CPUExecutionProvider';
                const providerLabel =
                    {
                        CUDAExecutionProvider: 'GPU acceleration: CUDA',
                        CoreMLExecutionProvider: 'GPU acceleration: Apple Silicon (CoreML)',
                        DmlExecutionProvider: 'GPU acceleration: DirectML',
                        CPUExecutionProvider: 'CPU-only (no GPU detected)',
                    }[top] || top;
                checks.push({
                    id: 'provider',
                    label: 'Inference provider',
                    status: 'ok',
                    detail: ok ? providerLabel : 'unable to probe (sidecar offline)',
                });

                // 3. Model loaded — from /health.
                const ready = info?.ok && (info?.face_ready ?? info?.faces_ready ?? true);
                const model = info?.face_model || info?.faces_model || 'buffalo_l';
                const dim = info?.face_dim || info?.dim || 512;
                checks.push({
                    id: 'model',
                    label: 'Model loaded',
                    status: ok ? 'ok' : 'warn',
                    detail: ok ? `${model} (${dim}-dim)` : 'unable to probe (sidecar offline)',
                });
            } catch (e) {
                checks.push(
                    {
                        id: 'sidecar',
                        label: 'tgdl-ml sidecar',
                        status: 'warn',
                        detail: e?.message || 'probe failed',
                    },
                    {
                        id: 'provider',
                        label: 'Inference provider',
                        status: 'warn',
                        detail: e?.message || 'probe failed',
                    },
                    {
                        id: 'model',
                        label: 'Model loaded',
                        status: 'warn',
                        detail: e?.message || 'probe failed',
                    },
                );
            }
        } else {
            // Legacy Python faces sidecar path.

            // 1. Sidecar reachability — drives the headline OK/spawning/failed
            //    state. We surface the spawn module's lifecycle directly so the
            //    operator sees "downloading…" / "starting up…" instead of a bare
            //    fail row while the binary is being fetched in the background.
            try {
                const { getSidecarStatus } = await import('../../core/ai/faces-spawn.js');
                const st = getSidecarStatus();
                if (st.state === 'healthy') {
                    checks.push({
                        id: 'sidecar',
                        label: 'Python face sidecar',
                        status: 'ok',
                        detail: `running at ${st.url}`,
                    });
                } else if (st.state === 'downloading') {
                    checks.push({
                        id: 'sidecar',
                        label: 'Python face sidecar',
                        status: 'info',
                        detail: 'downloading binary…',
                    });
                } else if (st.state === 'spawning') {
                    checks.push({
                        id: 'sidecar',
                        label: 'Python face sidecar',
                        status: 'info',
                        detail: 'starting up…',
                    });
                } else if (st.state === 'failed') {
                    checks.push({
                        id: 'sidecar',
                        label: 'Python face sidecar',
                        status: 'fail',
                        detail: st.error || 'failed to start',
                    });
                } else {
                    checks.push({
                        id: 'sidecar',
                        label: 'Python face sidecar',
                        status: 'info',
                        detail: 'disabled',
                    });
                }
            } catch (e) {
                checks.push({
                    id: 'sidecar',
                    label: 'Python face sidecar',
                    status: 'warn',
                    detail: e?.message || 'probe failed',
                });
            }

            // 2. Host Python — informational. The auto-spawn flow prefers the
            //    PyInstaller binary; Python on the host is only consulted as a
            //    fallback when the prebuilt binary fails to launch. Never fails
            //    the card on absence — most installs run the prebuilt and never
            //    need a host interpreter.
            try {
                const { execFile } = await import('node:child_process');
                const bin = process.platform === 'win32' ? 'python' : 'python3';
                const out = await new Promise((resolve, reject) => {
                    execFile(bin, ['--version'], { timeout: 2000 }, (err, stdout, stderr) => {
                        if (err) reject(err);
                        else resolve(String(stdout || stderr).trim());
                    });
                });
                const m = out.match(/Python (\d+)\.(\d+)(?:\.(\d+))?/);
                const major = m ? Number(m[1]) : 0;
                const minor = m ? Number(m[2]) : 0;
                if (major >= 3 && minor >= 10) {
                    checks.push({
                        id: 'python',
                        label: 'Host Python',
                        status: 'ok',
                        detail: `${out} (fallback path available)`,
                    });
                } else if (major >= 3) {
                    checks.push({
                        id: 'python',
                        label: 'Host Python',
                        status: 'warn',
                        detail: `${out} — sidecar prefers 3.10+`,
                    });
                } else {
                    checks.push({
                        id: 'python',
                        label: 'Host Python',
                        status: 'info',
                        detail: `${out} (using prebuilt binary)`,
                    });
                }
            } catch {
                checks.push({
                    id: 'python',
                    label: 'Host Python',
                    status: 'info',
                    detail: 'no Python on PATH (using prebuilt binary)',
                });
            }

            // 3. Prebuilt sidecar binary on disk. Mirrors the path resolution
            //    used by faces-spawn.js so the doctor card reports the same
            //    location the spawn flow actually writes to (including
            //    TGDL_DATA_DIR overrides used in tests).
            try {
                const { promises: fs } = await import('node:fs');
                const dataDir = process.env.TGDL_DATA_DIR
                    ? path.resolve(process.env.TGDL_DATA_DIR)
                    : DATA_DIR;
                const plat =
                    process.platform === 'win32'
                        ? 'win'
                        : process.platform === 'darwin'
                          ? 'mac'
                          : 'linux';
                const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
                const ext = process.platform === 'win32' ? '.exe' : '';
                const binPath = path.join(
                    dataDir,
                    'faces-service',
                    'bin',
                    `tgdl-faces-${plat}-${arch}${ext}`,
                );
                const st = await fs.stat(binPath);
                const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
                checks.push({
                    id: 'binary',
                    label: 'Prebuilt sidecar binary',
                    status: 'ok',
                    detail: `cached: ${sizeMb} MB`,
                });
            } catch {
                // First-run setup hint — until the GitHub Release lands the
                // download will 404, so the operator needs to know about the two
                // recovery paths (docker compose or `pip install -e faces-service/`).
                checks.push({
                    id: 'binary',
                    label: 'Prebuilt sidecar binary',
                    status: 'info',
                    detail:
                        'not yet downloaded — `docker compose --profile faces up` or ' +
                        '`pip install -e faces-service/` from the repo root, then restart',
                });
            }

            // 4 + 5. Provider + model — both pulled from the sidecar. `/health`
            //    carries the model + ready flag; the resolved onnxruntime
            //    providers list lives on `/info` (set after the model loads).
            //    Merging both keeps the doctor card aligned with the sidecar's
            //    wire format without forcing a Python-side change.
            try {
                const facesClient = await import('../../core/ai/faces-client.js');
                const url = facesClient.getSidecarUrl();
                const h = await facesClient.health();
                if (h.ok) {
                    let providers = [];
                    if (url) {
                        try {
                            const ctrl = new AbortController();
                            const t = setTimeout(() => ctrl.abort(), 2000);
                            try {
                                const r = await globalThis.fetch(`${url}/info`, {
                                    signal: ctrl.signal,
                                });
                                if (r.ok) {
                                    const info = await r.json();
                                    if (Array.isArray(info?.providers)) providers = info.providers;
                                }
                            } finally {
                                clearTimeout(t);
                            }
                        } catch {
                            /* /info is best-effort — fall through to CPU default */
                        }
                    }
                    const top = providers[0] || 'CPUExecutionProvider';
                    const providerLabel =
                        {
                            CUDAExecutionProvider: 'GPU acceleration: CUDA',
                            CoreMLExecutionProvider: 'GPU acceleration: Apple Silicon (CoreML)',
                            DmlExecutionProvider: 'GPU acceleration: DirectML',
                            CPUExecutionProvider: 'CPU-only (no GPU detected)',
                        }[top] || top;
                    checks.push({
                        id: 'provider',
                        label: 'Inference provider',
                        status: 'ok',
                        detail: providerLabel,
                    });
                    checks.push({
                        id: 'model',
                        label: 'Model loaded',
                        status: h.ready ? 'ok' : 'warn',
                        detail: h.ready
                            ? `${h.model || 'buffalo_l'} (${h.dim || 512}-dim)`
                            : 'not loaded yet (first scan will load)',
                    });
                } else {
                    checks.push({
                        id: 'provider',
                        label: 'Inference provider',
                        status: 'warn',
                        detail: 'unable to probe (sidecar offline)',
                    });
                    checks.push({
                        id: 'model',
                        label: 'Model loaded',
                        status: 'warn',
                        detail: 'unable to probe (sidecar offline)',
                    });
                }
            } catch (e) {
                checks.push({
                    id: 'provider',
                    label: 'Inference provider',
                    status: 'warn',
                    detail: e?.message || 'probe failed',
                });
                checks.push({
                    id: 'model',
                    label: 'Model loaded',
                    status: 'warn',
                    detail: e?.message || 'probe failed',
                });
            }
        }

        // 6. Photos indexed — kept from the prior probe set. Drives the
        //    operator's sense of progress; cheap (single SQL aggregate).
        try {
            const cfg = _aiCfg();
            const c = getAiCounts({ fileTypes: _facesScanFileTypes(cfg) });
            const pct = c.totalEligible ? Math.floor((c.indexed / c.totalEligible) * 100) : 0;
            checks.push({
                id: 'indexed',
                label: cfg?.faces?.includeVideos === true ? 'Files indexed' : 'Photos indexed',
                status: 'ok',
                detail: `${c.indexed}/${c.totalEligible} (${pct}%) · with faces ${c.withFaces || 0}`,
            });
        } catch (e) {
            checks.push({
                id: 'indexed',
                label: 'Files indexed',
                status: 'warn',
                detail: e?.message || String(e),
            });
        }

        res.json({ success: true, checks });
    });
    return router;
}
