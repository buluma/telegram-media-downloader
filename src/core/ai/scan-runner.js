/**
 * Faces scan runner. Search + Auto-tag flows were removed; this module
 * now owns only the face detection + DBSCAN clustering pipeline.
 *
 *   - `startFacesScan(cfg, …)` has two phases:
 *     (a) per-row face detection + persistence into the `faces` table,
 *     (b) one DBSCAN pass over every face embedding to populate `people`
 *         and link `faces.person_id`. Phase (b) is cheap compared to (a);
 *         we run it inside the same job so the UI sees one done event.
 *
 * Fire-and-forget: caller polls `getScanState('faces')` or subscribes to
 * the WS events the route layer broadcasts. Single-flight — a second
 * `startFacesScan` while one is running returns `{ alreadyRunning: true }`.
 */

import { existsSync } from 'fs';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    clearImageTagsForDownload,
    deleteFacesForDownload,
    getDb,
    getUnindexedAiBatch,
    insertFace,
    insertPerson,
    iterateAllFaces,
    setAiIndexedAt,
    setFacePerson,
    setImageTags,
} from '../db.js';
import {
    addImageObjects,
    countUnscannedTags,
    countUnscannedWd14,
    getUnscannedOcrBatch,
    getUnscannedObjectBatch,
    getUnscannedTagsBatch,
    getUnscannedWd14Batch,
    setWd14Tags,
} from '../db/faces.js';
import { clusterFaces, computeFaceQualityScore, detectFaces } from './faces.js';
import { resolveFacesValue } from './faces-config.js';
import { detectFacesBatch, getSidecarUrl } from './faces-client.js';
import { mlOcr, mlTag, isTgdlMlEnabled } from './tgdl-ml-client.js';
import { getVocabularyPreset } from './tag-vocabulary.js';
import { hasFfmpeg, resolveFfmpegBin } from '../thumbs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Float32Array <-> Buffer helpers. Previously came from vector-store.js
// (deleted with Search/Tags); inlined because clustering is now the only
// remaining caller.
function _f32ToBlob(f) {
    return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

// Pick the first finite number from a list of candidates; fall back to
// `fallback` if none match. Used to resolve cluster knobs with the
// "new path > legacy alias > env override > default" precedence.
function _pickNumber(candidates, fallback) {
    for (const c of candidates) {
        if (Number.isFinite(c)) return c;
    }
    return fallback;
}
function _blobToF32(blob) {
    const dim = blob.byteLength / 4;
    const out = new Float32Array(dim);
    const view = new Float32Array(blob.buffer, blob.byteOffset, dim);
    out.set(view);
    return out;
}

/**
 * Returns a wrapper that tracks consecutive network-level failures against
 * tgdl-ml. Once `maxFails` consecutive calls throw without a success in
 * between, it surfaces a fatal error that aborts the entire scan rather than
 * grinding through thousands of files each waiting up to the request timeout.
 *
 * "Network failure" is any error whose name is AbortError or whose message
 * contains typical fetch/TCP failure strings. HTTP 4xx/5xx from the service
 * itself are NOT counted — those are per-file errors, not connectivity loss.
 */
function _makeCircuitBreaker(maxFails = 5) {
    let consecutive = 0;
    return async function guard(fn) {
        try {
            const result = await fn();
            consecutive = 0;
            return result;
        } catch (e) {
            const msg = String(e?.message || e).toLowerCase();
            const isNetwork =
                e?.name === 'AbortError' ||
                msg.includes('fetch failed') ||
                msg.includes('econnrefused') ||
                msg.includes('econnreset') ||
                msg.includes('etimedout') ||
                msg.includes('network') ||
                msg.includes('socket');
            if (isNetwork) {
                consecutive += 1;
                if (consecutive >= maxFails) {
                    const fatal = new Error(
                        `tgdl-ml unreachable after ${consecutive} consecutive failures — ` +
                            'aborting scan. Check that the tgdl-ml container is running.',
                    );
                    fatal.fatal = true;
                    fatal.code = 'TGDL_ML_UNREACHABLE';
                    throw fatal;
                }
            } else {
                consecutive = 0;
            }
            throw e;
        }
    };
}

// Per-feature state.
const _scans = {
    faces: _emptyState(),
    wd14: _emptyState(),
};

function _emptyState() {
    return {
        running: false,
        scanned: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        abort: null,
    };
}

export function getScanState(feature) {
    const s = _scans[feature];
    if (!s) return null;
    const { abort: _abort, ...rest } = s;
    return rest;
}

export function isScanRunning(feature) {
    return Boolean(_scans[feature]?.running);
}

export function cancelScan(feature) {
    const s = _scans[feature];
    if (!s?.abort) return false;
    try {
        s.abort.abort();
    } catch {}
    return true;
}

/**
 * Resolve a stored relative download path to an absolute one. Mirrors the
 * NSFW resolver — DB stores `Group/images/foo.jpg`, files live under
 * `data/downloads/...`.
 */
function _resolveAbs(storedPath) {
    if (!storedPath) return null;
    if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
    let s = String(storedPath).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DATA_DIR, 'downloads', s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(storedPath)) return storedPath;
    return null;
}

function _resolveFfprobeBin() {
    try {
        const ffmpeg = resolveFfmpegBin();
        if (ffmpeg) {
            const probe = ffmpeg.endsWith('ffmpeg.exe')
                ? ffmpeg.slice(0, -10) + 'ffprobe.exe'
                : ffmpeg.endsWith('ffmpeg')
                  ? ffmpeg.slice(0, -6) + 'ffprobe'
                  : '';
            if (probe && existsSync(probe)) return probe;
        }
    } catch {
        /* fall through */
    }
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

function _runProc(bin, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, args, { windowsHide: true });
        const out = [];
        const err = [];
        p.stdout.on('data', (c) => out.push(c));
        p.stderr.on('data', (c) => err.push(c));
        p.on('error', reject);
        p.on('close', (code) => {
            if (code === 0) {
                resolve({
                    stdout: Buffer.concat(out).toString('utf8'),
                    stderr: Buffer.concat(err).toString('utf8'),
                });
                return;
            }
            reject(
                new Error(
                    `${bin} exited ${code}: ${Buffer.concat(err).toString('utf8').trim() || 'no stderr'}`,
                ),
            );
        });
    });
}

async function _probeVideoDurationSec(absPath) {
    try {
        const probe = _resolveFfprobeBin();
        const { stdout } = await _runProc(probe, [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            absPath,
        ]);
        const v = Number.parseFloat(String(stdout || '').trim());
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
        return null;
    }
}

async function _extractVideoFrames(absPath, { intervalSec = 8, maxFrames = 24 } = {}, log) {
    const duration = await _probeVideoDurationSec(absPath);
    if (!duration) return [];
    const interval = Math.max(1, Number(intervalSec) || 8);
    const cap = Math.max(1, Math.min(200, Number(maxFrames) || 24));
    const frameCount = Math.max(1, Math.min(cap, Math.ceil(duration / interval)));
    const realInterval = duration / frameCount;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tgdl-ai-frames-'));
    const outPattern = path.join(root, 'f-%05d.jpg');
    const ffmpeg = resolveFfmpegBin() || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try {
        await _runProc(ffmpeg, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            absPath,
            '-vf',
            `fps=1/${realInterval},scale=960:-2:flags=fast_bilinear`,
            '-frames:v',
            String(frameCount),
            '-q:v',
            '3',
            '-y',
            outPattern,
        ]);
        const names = (await fs.readdir(root)).filter((n) => n.endsWith('.jpg')).sort();
        return names.map((n) => path.join(root, n));
    } catch (e) {
        // Corrupt/undecodable video (e.g. invalid NAL units) — log, clean up
        // the empty temp dir, and return [] so the caller stamps ai_indexed_at
        // and moves on without crashing the scan.
        try {
            if (typeof log === 'function')
                log('warn', `faces scan: skipping corrupt video ${absPath}: ${e?.message || e}`);
        } catch {
            /* swallow */
        }
        try {
            await fs.rmdir(root);
        } catch {
            /* best effort */
        }
        return [];
    }
}

async function _cleanupTmpFrames(paths) {
    const dirs = new Set();
    for (const p of paths || []) {
        try {
            await fs.unlink(p);
        } catch {
            /* best effort */
        }
        try {
            dirs.add(path.dirname(p));
        } catch {}
    }
    for (const d of dirs) {
        try {
            await fs.rmdir(d);
        } catch {
            /* best effort */
        }
    }
}

// Generic envelope: claim slot → run worker → release. Worker owns its own
// progress reporting via the `bump` callback.
async function _runScan(feature, cfg, worker, onProgress, onDone, onLog) {
    const log = (level, msg) => {
        try {
            if (typeof onLog === 'function') onLog({ source: `ai-scan-${feature}`, level, msg });
        } catch {}
    };
    // Adapter for helpers that emit structured log envelopes
    // ({source, level, msg}) instead of (level, msg).
    const logEntry = (entry) => {
        if (entry && typeof entry === 'object') {
            const lvl = typeof entry.level === 'string' ? entry.level : 'info';
            const src = entry.source ? `${entry.source}: ` : '';
            const m = entry.msg ?? entry.message ?? JSON.stringify(entry);
            log(lvl, `${src}${String(m)}`);
            return;
        }
        log('info', String(entry ?? ''));
    };
    if (_scans[feature]?.running) {
        log('warn', `start${feature} called while already running — ignoring`);
        return { alreadyRunning: true };
    }
    const ctrl = new AbortController();
    const state = (_scans[feature] = {
        ..._emptyState(),
        running: true,
        startedAt: Date.now(),
        abort: ctrl,
    });

    let lastBroadcast = 0;
    const bcast = (force = false) => {
        const now = Date.now();
        if (!force && now - lastBroadcast < 500) return;
        lastBroadcast = now;
        try {
            if (typeof onProgress === 'function') onProgress(getScanState(feature));
        } catch {}
    };
    const bump = ({ scanned, total } = {}) => {
        if (Number.isFinite(scanned)) state.scanned = scanned;
        if (Number.isFinite(total)) state.total = total;
        bcast();
    };

    (async () => {
        try {
            await worker(state, ctrl.signal, bump, log, cfg, logEntry);
        } catch (e) {
            state.error = e?.message || String(e);
            log('error', `${feature} scan crashed: ${state.error}`);
        } finally {
            state.running = false;
            state.finishedAt = Date.now();
            state.abort = null;
            bcast(true);
            try {
                if (typeof onDone === 'function') onDone(getScanState(feature));
            } catch {}
        }
    })().catch(() => {
        /* never throw out of the IIFE */
    });

    return { started: true };
}

// ---- Faces scan + clustering pass ---------------------------------------

export function startFacesScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'faces',
        cfg,
        async (state, signal, bump, log, cfg, logEntry) => {
            // Resolve `fileTypes` with the same precedence as the cluster
            // knobs: new path > legacy flat alias > env override > default.
            const facesCfgIn = cfg?.faces || {};
            const includeVideos =
                resolveFacesValue('includeVideos', facesCfgIn) === true ||
                facesCfgIn.includeVideos === true ||
                cfg.includeVideos === true;
            const envFileTypes = resolveFacesValue('fileTypes', facesCfgIn);
            const fileTypesBase = Array.isArray(facesCfgIn.fileTypes)
                ? facesCfgIn.fileTypes
                : Array.isArray(cfg.fileTypes)
                  ? cfg.fileTypes
                  : Array.isArray(envFileTypes)
                    ? envFileTypes
                    : ['photo'];
            const fileTypesSet = new Set(
                fileTypesBase.map((t) => String(t || '').toLowerCase()).filter(Boolean),
            );
            if (includeVideos) fileTypesSet.add('video');
            const fileTypes = [...fileTypesSet];
            const db = getDb();
            const videoFrameIntervalSec = Math.max(
                1,
                Number(
                    resolveFacesValue('videoFrameIntervalSec', facesCfgIn) ??
                        facesCfgIn.videoFrameIntervalSec ??
                        cfg.videoFrameIntervalSec ??
                        8,
                ) || 8,
            );
            const videoMaxFrames = Math.max(
                1,
                Math.min(
                    200,
                    Number(
                        resolveFacesValue('videoMaxFrames', facesCfgIn) ??
                            facesCfgIn.videoMaxFrames ??
                            cfg.videoMaxFrames ??
                            24,
                    ) || 24,
                ),
            );
            const canSampleVideos = includeVideos && hasFfmpeg();
            if (includeVideos && !canSampleVideos) {
                log(
                    'warn',
                    'faces scan: includeVideos=true but ffmpeg is unavailable; skipping video rows',
                );
            }

            // Phase A — detect faces on every photo we haven't visited yet.
            // Visited = "ai_indexed_at IS NOT NULL"; even photos that yield
            // zero faces get stamped so the next pass doesn't re-decode.
            const phaseATotal = db
                .prepare(`
                    SELECT COUNT(*) AS n FROM downloads
                     WHERE file_type IN (${fileTypes.map(() => '?').join(',')})
                       AND ai_indexed_at IS NULL
                `)
                .get(...fileTypes).n;
            state.total = phaseATotal;
            bump();
            log('info', `faces scan: ${phaseATotal} photos to scan in phase A`);

            // `batchSize` precedence (same model as fileTypes above).
            const envBatch = resolveFacesValue('batchSize', facesCfgIn);
            const batchSizeRaw = _pickNumber([facesCfgIn.batchSize, cfg.batchSize, envBatch], 16);
            const batchSize = Math.max(1, Math.min(200, Number(batchSizeRaw) || 16));
            const envExclude = resolveFacesValue('excludeExtensions', facesCfgIn);
            const excludeExtsRaw = Array.isArray(facesCfgIn.excludeExtensions)
                ? facesCfgIn.excludeExtensions
                : Array.isArray(envExclude)
                  ? envExclude
                  : [];
            const excludeExts = new Set(
                excludeExtsRaw.map((e) =>
                    String(e || '')
                        .toLowerCase()
                        .replace(/^\.?/, '.'),
                ),
            );
            const faceGuard = isTgdlMlEnabled() ? _makeCircuitBreaker() : null;
            let _statNull = 0;
            let _statSkip = 0;
            let _statEmpty = 0;
            let _statFaces = 0;
            let _statPhotos = 0;
            let _nextStatLog = 0;
            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
                if (!batch.length) break;
                // Partition batch: videos use per-frame single detect, images
                // use one HTTP round-trip via /detect/batch.
                const items = batch.map((row) => ({ row, abs: _resolveAbs(row.file_path) }));
                const nullItems = items.filter((i) => !i.abs);
                const skipItems = items.filter(
                    (i) =>
                        i.abs &&
                        excludeExts.has(path.extname(String(i.abs || '')).toLowerCase() || ''),
                );
                const videoItems = items.filter(
                    (i) =>
                        i.abs &&
                        !excludeExts.has(path.extname(String(i.abs || '')).toLowerCase() || '') &&
                        String(i.row.file_type || '').toLowerCase() === 'video',
                );
                const imageItems = items.filter(
                    (i) =>
                        i.abs &&
                        !excludeExts.has(path.extname(String(i.abs || '')).toLowerCase() || '') &&
                        String(i.row.file_type || '').toLowerCase() !== 'video',
                );

                for (const { row } of nullItems) {
                    _statNull++;
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }
                for (const { row } of skipItems) {
                    _statSkip++;
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }

                if (signal.aborted) continue;

                // Videos: per-frame extraction + single-image detect.
                for (const { row, abs } of videoItems) {
                    if (signal.aborted) break;
                    // File may have been deleted since batch assembly (rescue
                    // sweeper / disk rotator). If gone, skip like a null item.
                    if (!existsSync(String(abs))) {
                        log('warn', `faces scan: video file vanished id=${row.id} ${abs}`);
                        _statNull++;
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        bump();
                        continue;
                    }
                    let detectedTotal = 0;
                    if (canSampleVideos) {
                        let framePaths = [];
                        try {
                            framePaths = await _extractVideoFrames(
                                abs,
                                { intervalSec: videoFrameIntervalSec, maxFrames: videoMaxFrames },
                                log,
                            );
                        } catch (e) {
                            log(
                                'warn',
                                `faces scan: video frame extraction failed id=${row.id}: ${e?.message || e}`,
                            );
                        }
                        if (framePaths.length) {
                            _safeDeleteFaces(row.id, log);
                            try {
                                for (const frameAbs of framePaths) {
                                    if (signal.aborted) break;
                                    const faces = faceGuard
                                        ? await faceGuard(() =>
                                              detectFaces(frameAbs, cfg, logEntry),
                                          )
                                        : await detectFaces(frameAbs, cfg, logEntry);
                                    if (Array.isArray(faces) && faces.length) {
                                        for (const f of faces) {
                                            _safeInsertFace(
                                                {
                                                    downloadId: row.id,
                                                    x: f.x,
                                                    y: f.y,
                                                    w: f.w,
                                                    h: f.h,
                                                    embeddingBlob: _f32ToBlob(f.embedding),
                                                    qualityScore: computeFaceQualityScore(f, cfg),
                                                },
                                                log,
                                            );
                                            detectedTotal += 1;
                                        }
                                    }
                                }
                            } finally {
                                await _cleanupTmpFrames(framePaths);
                            }
                        }
                    }
                    if (detectedTotal > 0) {
                        log('info', `faces scan: id=${row.id} detected=${detectedTotal}`);
                    }
                    _safeSetIndexed(row.id, log);
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }

                if (signal.aborted) continue;

                // Images: one HTTP round-trip for the whole sub-batch via /detect/batch.
                let batchResults = [];
                if (imageItems.length) {
                    try {
                        batchResults = faceGuard
                            ? await faceGuard(() =>
                                  detectFacesBatch(
                                      imageItems.map((i) => i.abs),
                                      cfg,
                                      logEntry,
                                  ),
                              )
                            : await detectFacesBatch(
                                  imageItems.map((i) => i.abs),
                                  cfg,
                                  logEntry,
                              );
                    } catch (e) {
                        if (e?.fatal) throw e;
                        log('warn', `detectFacesBatch threw: ${e?.message || e}`);
                        batchResults = imageItems.map(() => null);
                    }
                }

                for (let bi = 0; bi < imageItems.length; bi++) {
                    const { row } = imageItems[bi];
                    const detected = batchResults[bi] ?? null;
                    // File may have been deleted since batch detect ran (rescue
                    // sweeper / disk rotator). Treat as null rather than crashing.
                    const fileStillExists = existsSync(String(imageItems[bi].abs));
                    if (!fileStillExists) {
                        if (detected === null) {
                            _statNull++;
                        } else {
                            log(
                                'warn',
                                `faces scan: image vanished after detect id=${row.id} ${imageItems[bi].abs}`,
                            );
                            _statNull++;
                        }
                    } else if (detected === null) {
                        _statNull++;
                    } else if (detected.length === 0) {
                        _statEmpty++;
                    } else {
                        _statFaces += detected.length;
                        _statPhotos++;
                    }
                    if (fileStillExists && Array.isArray(detected) && detected.length) {
                        _safeDeleteFaces(row.id, log);
                        for (const f of detected) {
                            if (!f.embedding || !f.embedding.length) continue;
                            _safeInsertFace(
                                {
                                    downloadId: row.id,
                                    x: f.x,
                                    y: f.y,
                                    w: f.w,
                                    h: f.h,
                                    embeddingBlob: _f32ToBlob(f.embedding),
                                    qualityScore: computeFaceQualityScore(f, cfg),
                                },
                                log,
                            );
                        }
                    }
                    _safeSetIndexed(row.id, log);
                    state.scanned += 1;
                    bump();
                }
                if (state.scanned >= _nextStatLog) {
                    log(
                        'info',
                        `faces scan progress: ${state.scanned}/${phaseATotal} — ` +
                            `${_statPhotos} with faces (${_statFaces} total), ` +
                            `${_statEmpty} no-face, ${_statNull} errors, ${_statSkip} skipped`,
                    );
                    _nextStatLog = state.scanned + 200;
                }
            }

            // Phase B — DBSCAN over every face embedding. Always re-runs
            // (clusters drift as new faces land).
            if (signal.aborted) return;
            log('info', 'faces scan: starting clustering pass');
            const faces = [];
            for (const r of iterateAllFaces()) {
                faces.push({ id: r.id, embedding: _blobToF32(r.embedding) });
            }
            if (!faces.length) {
                log('info', 'faces scan: no faces detected — clustering skipped');
                return;
            }
            if (faces.length > 50000) {
                log(
                    'warn',
                    `faces scan: ${faces.length} faces is a large input for DBSCAN — clustering may take a while`,
                );
            }
            const facesCfgForCluster = cfg?.faces || {};
            const epsForCluster = _pickNumber(
                [
                    resolveFacesValue('epsilon', facesCfgForCluster),
                    facesCfgForCluster.epsilon,
                    cfg.facesEpsilon,
                ],
                0.5,
            );
            const minPointsForCluster = _pickNumber(
                [
                    resolveFacesValue('minPoints', facesCfgForCluster),
                    facesCfgForCluster.minPoints,
                    cfg.facesMinPoints,
                ],
                3,
            );
            const qualityWeightedCentroid =
                resolveFacesValue('qualityWeightedCentroid', facesCfgForCluster) === true ||
                facesCfgForCluster.qualityWeightedCentroid === true ||
                cfg.qualityWeightedCentroid === true;
            log(
                'info',
                `faces scan: clustering ${faces.length} faces (eps=${epsForCluster}, minPts=${minPointsForCluster})`,
            );
            const { clusters } = clusterFaces(faces, {
                eps: epsForCluster,
                minPts: minPointsForCluster,
                qualityWeightedCentroid,
            });
            await new Promise((r) => setImmediate(r));

            // Snapshot every labelled centroid BEFORE wiping people. The
            // match runs against the snapshot (in-memory) because by the
            // time the write transaction runs, people has already been cleared.
            // Renames survive re-runs as long as the new cluster's centroid
            // is within `matchEps` of the old labelled cluster's centroid.
            //
            // Precedence for the match radius:
            //   1. `cfg.faces.labelMatchEps`            (new nested path)
            //   2. `cfg.facesLabelMatchEps`             (legacy flat key)
            //   3. `TGDL_FACES_LABEL_MATCH_EPS` env     (deployment override)
            //   4. derived from `epsilon * 0.9`         (the default)
            const facesCfg = cfg?.faces || {};
            const epsilonResolved = _pickNumber(
                [resolveFacesValue('epsilon', facesCfg), facesCfg.epsilon, cfg.facesEpsilon],
                0.5,
            );
            const matchEpsEnv = resolveFacesValue('labelMatchEps', facesCfg);
            const matchEps = _pickNumber(
                [facesCfg.labelMatchEps, cfg.facesLabelMatchEps, matchEpsEnv],
                Math.max(0.2, Math.min(0.6, epsilonResolved * 0.9)),
            );
            const labelSnapshot = (() => {
                const out = [];
                const stmt = db.prepare(
                    'SELECT label, embedding_centroid FROM people WHERE label IS NOT NULL',
                );
                for (const r of stmt.iterate()) {
                    if (!r.embedding_centroid) continue;
                    const dim = r.embedding_centroid.byteLength / 4;
                    const c = new Float32Array(dim);
                    const view = new Float32Array(
                        r.embedding_centroid.buffer,
                        r.embedding_centroid.byteOffset,
                        dim,
                    );
                    c.set(view);
                    out.push({ label: r.label, centroid: c });
                }
                return out;
            })();
            const findCarryOverLabel = (centroid) => {
                let best = null;
                let bestDist = Infinity;
                for (const s of labelSnapshot) {
                    if (s.centroid.length !== centroid.length) continue;
                    let sum = 0;
                    for (let i = 0; i < centroid.length; i++) {
                        const d = centroid[i] - s.centroid[i];
                        sum += d * d;
                    }
                    const dist = Math.sqrt(sum);
                    if (dist < bestDist && dist <= matchEps) {
                        bestDist = dist;
                        best = s.label;
                    }
                }
                return best;
            };

            // Pre-compute carry-over labels before the transaction so the
            // read-only snapshot pass doesn't run inside the write lock.
            const clusterPlan = clusters.map((c) => ({
                ...c,
                carryOver: findCarryOverLabel(c.centroid),
            }));

            // Atomic: clear + re-assign in one transaction so a mid-loop
            // crash cannot leave orphaned people rows with no face assignments.
            let preservedCount = 0;
            const clusterTx = db.transaction(() => {
                db.prepare('UPDATE faces SET person_id = NULL').run();
                db.prepare('DELETE FROM people').run();
                for (const c of clusterPlan) {
                    const personId = insertPerson({
                        label: c.carryOver,
                        centroidBlob: _f32ToBlob(c.centroid),
                        faceCount: c.faceCount,
                    });
                    if (c.carryOver) preservedCount += 1;
                    for (const memberIdx of c.memberIdxs) {
                        setFacePerson(faces[memberIdx].id, personId);
                    }
                }
            });
            clusterTx();
            log(
                'info',
                `faces scan: clustered ${faces.length} faces into ${clusters.length} groups (${preservedCount}/${labelSnapshot.length} labels preserved across re-cluster, eps=${matchEps.toFixed(3)})`,
            );
        },
        onProgress,
        onDone,
        onLog,
    );
}

// ---- Tags scan (CLIP-based zero-shot tagging) ---------------------------

/**
 * Start a background scan that tags every unindexed photo via the Python
 * sidecar's ``/tag`` endpoint. Single-flight — a second call while one is
 * running returns ``{ alreadyRunning: true }``.
 *
 * Tags are persisted into the ``image_tags`` table via ``setImageTags()``
 * and ``ai_indexed_at`` is stamped so the row isn't re-processed.
 */
export function startTagsScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'tags',
        cfg,
        async (state, signal, bump, log, cfg) => {
            const fileTypes = Array.isArray(cfg.fileTypes) ? cfg.fileTypes : ['photo'];

            const total = countUnscannedTags({ fileTypes });
            state.total = total;
            bump();
            log('info', `tags scan: ${total} files to tag`);

            if (total === 0) {
                log('info', 'tags scan: nothing to tag');
                return;
            }

            const useMlTag = isTgdlMlEnabled();
            const sidecarUrl = useMlTag ? null : getSidecarUrl();
            if (!useMlTag && !sidecarUrl) {
                throw new Error(
                    'No tagging provider available — cannot tag images. ' +
                        'Start tgdl-ml or check the AI maintenance page.',
                );
            }

            const mlTagGuard = useMlTag ? _makeCircuitBreaker() : null;

            // Resolve tag vocabulary: explicit list > named preset > sidecar default.
            const presetLabels = cfg.tagVocabularyPreset
                ? (getVocabularyPreset(String(cfg.tagVocabularyPreset)) ?? [])
                : [];
            const tagLabels =
                Array.isArray(cfg.tagLabels) && cfg.tagLabels.length
                    ? cfg.tagLabels.filter(Boolean)
                    : presetLabels;

            const batchSize = Math.max(1, Math.min(200, Number(cfg.batchSize) || 64));
            const concurrency = Math.max(1, Math.min(8, Number(cfg.tagConcurrency) || 2));

            // Learned at runtime: once a 403 path_not_allowed is seen, skip
            // the path attempt for every subsequent image in this scan run.
            let skipPathMode = false;

            while (!signal.aborted) {
                const batch = getUnscannedTagsBatch({ fileTypes, limit: batchSize });
                if (!batch.length) break;

                // Process batch with a fixed-width worker pool so `concurrency`
                // requests are in-flight to the sidecar at any given time.
                const queue = [...batch];
                const workers = Array.from(
                    { length: Math.min(concurrency, queue.length) },
                    async () => {
                        while (queue.length && !signal.aborted) {
                            const row = queue.shift();
                            if (!row) break;
                            const abs = _resolveAbs(row.file_path);
                            let tags = [];
                            if (abs) {
                                try {
                                    if (useMlTag) {
                                        const result = await mlTagGuard(() =>
                                            mlTag(abs, {
                                                vocabulary: tagLabels.length
                                                    ? tagLabels
                                                    : undefined,
                                            }),
                                        );
                                        tags = result.tags;
                                    } else {
                                        const result = await _tagOne(
                                            sidecarUrl,
                                            abs,
                                            tagLabels,
                                            log,
                                            skipPathMode,
                                        );
                                        tags = result.tags;
                                        if (result.pathModeDisabled) skipPathMode = true;
                                    }
                                } catch (e) {
                                    if (e?.fatal) throw e;
                                    log(
                                        'warn',
                                        `tagging failed for id=${row.id}: ${e?.message || e}`,
                                    );
                                }
                            }
                            // DB writes are synchronous — safe across concurrent JS tasks.
                            _safeSetImageTagsForDownload(
                                row.id,
                                Array.isArray(tags) && tags.length
                                    ? tags.map((t) => ({ tag: t.tag, score: t.score }))
                                    : [{ tag: '_scanned_', score: 0 }],
                                log,
                                'tags scan',
                            );
                            state.scanned += 1;
                            bump();
                        }
                    },
                );
                await Promise.all(workers);
            }
            log('info', `tags scan: finished — ${state.scanned} files tagged`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Call the Python sidecar's ``POST /tag`` for one image.
 * Returns ``[{tag, score}, …]`` or an empty array on failure.
 *
 * If ``tagLabels`` is non-empty, it overrides the sidecar's default
 * vocabulary for this request.
 */
async function _tagOne(sidecarUrl, absPath, tagLabels, log, skipPathMode = false) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/tag`;
    const baseBody = {};
    if (Array.isArray(tagLabels) && tagLabels.length) {
        baseBody.vocabulary = tagLabels;
    }

    const _post = async (body) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });

    const _b64Body = async () => {
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(absPath);
        return { ...baseBody, image_b64: bytes.toString('base64') };
    };

    try {
        let pathModeDisabled = false;
        let res;
        let errBody = null;

        if (skipPathMode) {
            res = await _post(await _b64Body());
        } else {
            res = await _post({ ...baseBody, path: absPath });
            if (!res.ok) errBody = await res.json().catch(() => ({}));
            if (
                (res.status === 403 && errBody?.code === 'path_not_allowed') ||
                (res.status === 404 && errBody?.code === 'file_not_found')
            ) {
                // 403 means path mode is disabled/not allowed. 404+file_not_found
                // can also happen for files that exist but are unreadable via
                // path mode; fall back to base64 before treating it as a skip.
                if (res.status === 403) pathModeDisabled = true;
                res = await _post(await _b64Body());
                errBody = null;
            }
        }

        if (!res.ok) {
            if (!errBody) errBody = await res.json().catch(() => ({}));
            const code = String(errBody?.code || '');
            const msg = `tag endpoint returned ${res.status}${code ? ` (${code})` : ''} for ${absPath}`;
            log('warn', msg);
            if (res.status === 404 && !code) {
                const err = new Error(
                    `${msg} — sidecar does not expose /tag; upgrade/restart the faces sidecar or disable CLIP tags`,
                );
                err.code = 'TAG_ENDPOINT_UNAVAILABLE';
                err.fatal = true;
                throw err;
            }
            if (
                res.status === 400 ||
                res.status === 415 ||
                code === 'file_not_found' ||
                code === 'image_decode_failed'
            ) {
                return { tags: [], pathModeDisabled };
            }
            const err = new Error(`${msg}: ${errBody?.error || errBody?.detail || res.statusText}`);
            err.code = code || `HTTP_${res.status}`;
            err.fatal = true;
            throw err;
        }
        const data = await res.json();
        return { tags: Array.isArray(data?.tags) ? data.tags : [], pathModeDisabled };
    } catch (e) {
        if (e?.fatal) throw e;
        log('warn', `tag request failed for ${absPath}: ${e?.message || e}`);
        return { tags: [], pathModeDisabled: false };
    }
}

/**
 * Start OCR text extraction scan. Processes unscanned images and stores
 * extracted text in the `image_text` table.
 */
export function startOcrScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'ocr',
        cfg,
        async (state, signal, bump, log) => {
            const sidecarUrl = getSidecarUrl();
            const useMlOcr = isTgdlMlEnabled();
            if (!sidecarUrl && !useMlOcr) {
                throw new Error(
                    'No OCR provider is available — cannot extract text. ' +
                        'Start the Python sidecar or enable tgdl-ml.',
                );
            }

            const mlOcrGuard = useMlOcr ? _makeCircuitBreaker() : null;
            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));

            while (!signal.aborted) {
                const batch = getUnscannedOcrBatch({ limit: batchSize });
                if (!batch.length) {
                    log('info', 'ocr scan: no more unscanned images');
                    break;
                }
                state.total = Math.max(state.total, state.scanned + batch.length * 2);
                bump();

                const { setImageText } = await import('../db/faces.js');
                for (const row of batch) {
                    if (signal.aborted) break;

                    const absPath = _resolveAbs(row.file_path);
                    if (!absPath) {
                        log('warn', `ocr: file not found: ${row.file_path}`);
                        setImageText(row.id, '', null, null);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    if (row.file_type !== 'photo') {
                        log('debug', `ocr: skipping non-photo: ${row.file_name}`);
                        setImageText(row.id, '', null, null);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    try {
                        const lang =
                            typeof cfg.ocrLanguage === 'string' && cfg.ocrLanguage.trim()
                                ? cfg.ocrLanguage.trim()
                                : 'eng';
                        const result = useMlOcr
                            ? await mlOcrGuard(() =>
                                  mlOcr(absPath, {
                                      minDetectionScore: cfg.ocrMinDetectionScore,
                                      minRecognitionScore: cfg.ocrMinRecognitionScore,
                                      maxResolution: cfg.ocrMaxResolution,
                                  }),
                              )
                            : await _extractTextOne(sidecarUrl, absPath, lang, log);
                        // Always write a row (even empty) so the same image
                        // isn't picked up on the next batch query.
                        setImageText(
                            row.id,
                            result?.text || '',
                            result?.language || null,
                            result?.confidence || null,
                        );
                    } catch (e) {
                        if (e?.fatal) throw e;
                        log('warn', `ocr failed for id=${row.id}: ${e?.message || e}`);
                        setImageText(row.id, '', null, null);
                    }
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log('info', `ocr scan: finished — ${state.scanned} files scanned`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

async function _readAsBase64(absPath) {
    const buf = await fs.readFile(absPath);
    return buf.toString('base64');
}

/**
 * Call the Python sidecar's ``POST /ocr`` for one image.
 * Tries path mode first; falls back to base64 if sidecar's allow-list rejects.
 * Returns ``{text, language, confidence}`` or null on failure.
 */
async function _extractTextOne(sidecarUrl, absPath, lang, log) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/ocr`;
    const doFetch = async (body) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
    try {
        let res = await doFetch({ path: absPath, language: lang });
        if (res.status === 403) {
            const b64 = await _readAsBase64(absPath);
            res = await doFetch({ image_b64: b64, language: lang });
        }
        if (!res.ok) {
            log('warn', `ocr endpoint returned ${res.status} for ${absPath}`);
            return null;
        }
        const data = await res.json();
        return data?.result || null;
    } catch (e) {
        log('warn', `ocr request failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
}

/**
 * Start object detection scan. Processes unscanned images and stores
 * detected objects in the `image_objects` table.
 */
export function startObjectDetectionScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'objects',
        cfg,
        async (state, signal, bump, log) => {
            if (isTgdlMlEnabled()) {
                log('info', 'objects scan: not supported by tgdl-ml — skipping');
                return;
            }
            const sidecarUrl = getSidecarUrl();
            if (!sidecarUrl) {
                throw new Error(
                    'Python sidecar is not available — cannot detect objects. ' +
                        'Check the AI maintenance page for sidecar status.',
                );
            }

            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));
            const minConfidence = Math.max(0, Math.min(1, Number(cfg.minConfidence) || 0.5));

            while (!signal.aborted) {
                const batch = getUnscannedObjectBatch({ limit: batchSize });
                if (!batch.length) {
                    log('info', 'objects scan: no more unscanned images');
                    break;
                }
                state.total = Math.max(state.total, state.scanned + batch.length * 2);
                bump();

                for (const row of batch) {
                    if (signal.aborted) break;

                    const absPath = _resolveAbs(row.file_path);
                    if (!absPath) {
                        log('warn', `objects: file not found: ${row.file_path}`);
                        addImageObjects(row.id, [
                            { object: '_scanned_', confidence: 0, x: 0, y: 0, w: 0, h: 0 },
                        ]);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    if (row.file_type !== 'photo') {
                        log('debug', `objects: skipping non-photo: ${row.file_name}`);
                        addImageObjects(row.id, [
                            { object: '_scanned_', confidence: 0, x: 0, y: 0, w: 0, h: 0 },
                        ]);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    try {
                        const objects = await _detectObjectsOne(
                            sidecarUrl,
                            absPath,
                            minConfidence,
                            log,
                        );
                        // Always write a row (even sentinel) so the same
                        // image isn't picked up on the next batch query.
                        if (Array.isArray(objects) && objects.length > 0) {
                            addImageObjects(row.id, objects);
                            // Mirror detected objects into image_tags so they
                            // appear in tag browser, semantic search, and smart
                            // albums without requiring a separate tag scan.
                            // Dedup by object class — keep highest confidence.
                            const byClass = new Map();
                            for (const o of objects) {
                                if (!o.object || o.object === '_scanned_') continue;
                                const prev = byClass.get(o.object);
                                if (!prev || o.confidence > prev)
                                    byClass.set(o.object, o.confidence);
                            }
                            if (byClass.size > 0) {
                                setImageTags(
                                    row.id,
                                    [...byClass.entries()].map(([tag, score]) => ({ tag, score })),
                                );
                            }
                        } else {
                            addImageObjects(row.id, [
                                { object: '_scanned_', confidence: 0, x: 0, y: 0, w: 0, h: 0 },
                            ]);
                        }
                    } catch (e) {
                        log(
                            'warn',
                            `objects detection failed for id=${row.id}: ${e?.message || e}`,
                        );
                        addImageObjects(row.id, [
                            { object: '_scanned_', confidence: 0, x: 0, y: 0, w: 0, h: 0 },
                        ]);
                    }
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log('info', `objects scan: finished — ${state.scanned} files scanned`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Calls the WD14 tagger (``POST /tag-wd14``) — a Danbooru/e621 ONNX
 * model that gives relevant multi-label tags for adult/NSFW content
 * (body parts, poses, acts, fetishes) instead of the old YOLO COCO
 * object labels (person, car, chair...).
 *
 * Returns array of {object, confidence, x, y, w, h} (x/y/w/h = 0 since
 * WD14 is a tagger, not an object detector with bounding boxes).
 */
async function _detectObjectsOne(sidecarUrl, absPath, minScore, log) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/tag-wd14`;
    const doFetch = async (body) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });
    try {
        let res = await doFetch({ path: absPath, min_score: minScore });
        if (res.status === 403) {
            const b64 = await _readAsBase64(absPath);
            res = await doFetch({ image_b64: b64, min_score: minScore });
        }
        if (!res.ok) {
            log('warn', `tag-wd14 endpoint returned ${res.status} for ${absPath}`);
            return [];
        }
        const data = await res.json();
        const tags = Array.isArray(data?.tags) ? data.tags : [];
        // Map WD14 {tag, score} → {object, confidence, x:0, y:0, w:0, h:0}
        return tags.map((t) => ({
            object: String(t.tag || ''),
            confidence: Number(t.score) || 0,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        }));
    } catch (e) {
        log('warn', `tag-wd14 request failed for ${absPath}: ${e?.message || e}`);
        return [];
    }
}

/**
 * Start WD14 tagger scan. Processes unscanned images through the sidecar's
 * `/tag-wd14` endpoint (WD14 ONNX model trained on e621/Danbooru taxonomy)
 * and stores results in `image_tags_wd14`.
 *
 * Single-flight: a second call while one is running returns
 * `{ alreadyRunning: true }`.
 */
export function startWd14Scan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'wd14',
        cfg,
        async (state, signal, bump, log, cfg) => {
            const fileTypes = Array.isArray(cfg.fileTypes) ? cfg.fileTypes : ['photo'];

            const total = countUnscannedWd14({ fileTypes });
            state.total = total;
            bump();
            log('info', `wd14 scan: ${total} files to tag`);

            if (total === 0) {
                log('info', 'wd14 scan: nothing to tag');
                return;
            }

            if (isTgdlMlEnabled()) {
                log('info', 'wd14 scan: not supported by tgdl-ml — skipping');
                return;
            }
            const sidecarUrl = getSidecarUrl();
            if (!sidecarUrl) {
                throw new Error(
                    'Python sidecar is not available — cannot run WD14 tagger. ' +
                        'Check the AI maintenance page for sidecar status.',
                );
            }

            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));
            const minScore = Math.max(0, Math.min(1, Number(cfg.wd14MinScore) || 0.35));

            while (!signal.aborted) {
                const batch = getUnscannedWd14Batch({ fileTypes, limit: batchSize });
                if (!batch.length) break;

                for (const row of batch) {
                    if (signal.aborted) break;
                    const abs = _resolveAbs(row.file_path);
                    let tags = [];
                    if (abs) {
                        try {
                            tags = await _tagWd14One(sidecarUrl, abs, minScore, log);
                        } catch (e) {
                            log('warn', `wd14 tagging failed for id=${row.id}: ${e?.message || e}`);
                        }
                    }
                    setWd14Tags(row.id, Array.isArray(tags) ? tags : []);
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log('info', `wd14 scan: finished — ${state.scanned} files tagged`);
        },
        onProgress,
        onDone,
        onLog,
    );
}

/**
 * Call the Python sidecar's `POST /tag-wd14` for one image.
 * Returns `[{tag, score}, …]` or an empty array on failure.
 */
async function _tagWd14One(sidecarUrl, absPath, minScore, log) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/tag-wd14`;
    const doFetch = async (body) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });
    try {
        let res = await doFetch({ path: absPath, min_score: minScore });
        if (res.status === 403) {
            const b64 = await _readAsBase64(absPath);
            res = await doFetch({ image_b64: b64, min_score: minScore });
        }
        if (!res.ok) {
            log('warn', `tag-wd14 endpoint returned ${res.status} for ${absPath}`);
            return [];
        }
        const data = await res.json();
        return Array.isArray(data?.tags) ? data.tags : [];
    } catch (e) {
        log('warn', `tag-wd14 request failed for ${absPath}: ${e?.message || e}`);
        return [];
    }
}

/**
 * Safe wrappers around AI DB operations that catch FOREIGN KEY constraint
 * failures. Maintenance bulk-delete / rescue sweeps may delete download rows
 * concurrently with an AI scan, and we don't want that race to crash the scan.
 * Returns false when the parent download row no longer exists, true on
 * success (or when the operation was a no-op).
 */
function _isForeignKeyError(e) {
    return /FOREIGN KEY/i.test(String(e?.message || e));
}

function _safeSetImageTagsForDownload(downloadId, tags, log, context = 'image tags') {
    try {
        clearImageTagsForDownload(downloadId);
        setImageTags(downloadId, tags);
        return true;
    } catch (e) {
        if (_isForeignKeyError(e)) {
            log('warn', `${context}: download row vanished while writing tags id=${downloadId}`);
            return false;
        }
        throw e;
    }
}

function _safeDeleteFaces(downloadId, log) {
    try {
        deleteFacesForDownload(downloadId);
        return true;
    } catch (e) {
        if (_isForeignKeyError(e)) {
            log('warn', `faces scan: download row vanished (deleteFaces) id=${downloadId}`);
            return false;
        }
        throw e;
    }
}

function _safeInsertFace(opts, log) {
    try {
        insertFace(opts);
        return true;
    } catch (e) {
        if (_isForeignKeyError(e)) {
            log('warn', `faces scan: download row vanished (insertFace) id=${opts.downloadId}`);
            return false;
        }
        throw e;
    }
}

function _safeSetIndexed(downloadId, log) {
    try {
        setAiIndexedAt(downloadId);
    } catch (e) {
        if (_isForeignKeyError(e)) {
            log('warn', `faces scan: download row vanished (setAiIndexedAt) id=${downloadId}`);
        } else {
            throw e;
        }
    }
}

/** For tests — clear in-memory state so the next test starts fresh. */
export function _resetForTests() {
    _scans.faces = _emptyState();
    _scans.tags = _emptyState();
    _scans.wd14 = _emptyState();
}
