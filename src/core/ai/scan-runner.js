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
import { Worker } from 'worker_threads';

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
    countUnscannedWd14,
    getUnscannedOcrBatch,
    getUnscannedWd14Batch,
    setWd14Tags,
} from '../db/faces.js';
import { computeFaceQualityScore, detectFaces, FACE_DEFAULTS } from './faces.js';
import { resolveFacesValue } from './faces-config.js';
import { clusterFacesRemote, detectFacesBatch, getSidecarUrl } from './faces-client.js';
import { mlOcr, isTgdlMlEnabled, getTgdlMlUrl } from './tgdl-ml-client.js';
import { checkSidecarCapability } from './preflight.js';
import { getActiveProvider, generate } from '../llm/index.js';
import { setImageText } from '../db/faces.js';
import { readFileSync } from 'fs';
import {
    markScanDone,
    markScanFailed,
    markScanSkipped,
    recoverStaleLocks,
} from '../db/scan-state.js';
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

function _runClusterWorker(faces, opts = {}) {
    return new Promise((resolve, reject) => {
        const embeddings = faces.map((face) => face.embedding.buffer);
        const qualityScores = faces.map((face) => face.qualityScore);
        const worker = new Worker(new URL('./cluster-worker.js', import.meta.url), {
            workerData: {
                embeddings,
                qualityScores,
                opts,
            },
            transferList: embeddings,
        });
        worker.once('message', (msg) => {
            if (msg?.error) {
                reject(new Error(msg.error));
                return;
            }
            const clusters = Array.isArray(msg?.clusters)
                ? msg.clusters.map((cluster) => ({
                      memberIdxs: cluster.memberIdxs || [],
                      centroid:
                          cluster.centroid instanceof Float32Array
                              ? cluster.centroid
                              : new Float32Array(cluster.centroid || []),
                      faceCount: cluster.faceCount || 0,
                  }))
                : [];
            resolve({ clusters, noise: Array.isArray(msg?.noise) ? msg.noise : [] });
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`cluster worker exited with code ${code}`));
        });
    });
}

/**
 * Returns a wrapper that tracks consecutive network-level failures against
 * an auxiliary ML service. OCR/WD14 may still use tgdl-ml when explicitly
 * configured, but faces no longer route through it.
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
    ocr: _emptyState(),
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
            const groupId = cfg.groupId || null;
            const phaseATotal = db
                .prepare(`
                    SELECT COUNT(*) AS n FROM downloads
                     WHERE file_type IN (${fileTypes.map(() => '?').join(',')})
                       AND ai_indexed_at IS NULL
                       AND deleted_at IS NULL
                       ${groupId ? 'AND group_id = ?' : ''}
                `)
                .get(...fileTypes, ...(groupId ? [String(groupId)] : [])).n;
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
            let _statNull = 0;
            let _statSkip = 0;
            let _statEmpty = 0;
            let _statFaces = 0;
            let _statPhotos = 0;
            let _nextStatLog = 0;
            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize, groupId });
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
                                    const faces = await detectFaces(frameAbs, cfg, logEntry);
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

                                try {
                                    const llmStat = await getActiveProvider();
                                    if (llmStat?.available && llmStat?.supportsVision) {
                                        const sampleCount = Math.min(5, framePaths.length);
                                        const step = Math.max(
                                            1,
                                            Math.floor(framePaths.length / sampleCount),
                                        );
                                        const sampledFrames = [];
                                        for (
                                            let i = 0;
                                            i < framePaths.length &&
                                            sampledFrames.length < sampleCount;
                                            i += step
                                        ) {
                                            sampledFrames.push(framePaths[i]);
                                        }
                                        if (sampledFrames.length > 0) {
                                            const imagesBase64 = sampledFrames.map((p) =>
                                                readFileSync(p).toString('base64'),
                                            );
                                            log(
                                                'info',
                                                `faces scan: summarizing video id=${row.id} with ${imagesBase64.length} frames`,
                                            );
                                            const summary = await generate({
                                                prompt: 'Describe what is happening in this sequence of video frames in a single concise paragraph. Focus on objects, people, actions, and scenery.',
                                                images: imagesBase64,
                                            });
                                            if (summary && summary.text && summary.text.trim()) {
                                                setImageText(
                                                    row.id,
                                                    summary.text.trim(),
                                                    'video_summary',
                                                    1.0,
                                                );
                                                log(
                                                    'info',
                                                    `faces scan: video id=${row.id} summary saved`,
                                                );
                                            }
                                        }
                                    }
                                } catch (e) {
                                    log(
                                        'warn',
                                        `faces scan: video summarization failed id=${row.id}: ${e?.message || String(e)}`,
                                    );
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
                        batchResults = await detectFacesBatch(
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
                    // Only stamp when detection actually ran. null + file present
                    // means the service was unavailable — leave ai_indexed_at NULL
                    // so the next scan retries when the service recovers.
                    if (!fileStillExists || detected !== null) {
                        _safeSetIndexed(row.id, log);
                    }
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
                FACE_DEFAULTS.facesEpsilon, // 1.05 — ArcFace 512-dim calibrated (not legacy FaceNet 0.5)
            );
            const minPointsForCluster = _pickNumber(
                [
                    resolveFacesValue('minPoints', facesCfgForCluster),
                    facesCfgForCluster.minPoints,
                    cfg.facesMinPoints,
                ],
                FACE_DEFAULTS.facesMinPoints, // 2 — surfaces rarer faces (not legacy 3)
            );
            const qualityWeightedCentroid =
                resolveFacesValue('qualityWeightedCentroid', facesCfgForCluster) === true ||
                facesCfgForCluster.qualityWeightedCentroid === true ||
                cfg.qualityWeightedCentroid === true;
            log(
                'info',
                `faces scan: clustering ${faces.length} faces (eps=${epsForCluster}, minPts=${minPointsForCluster})`,
            );
            const clusterOpts = {
                eps: epsForCluster,
                minPts: minPointsForCluster,
                qualityWeightedCentroid,
            };
            let clusterResult = null;
            if (getSidecarUrl()) {
                log('info', 'faces scan: attempting sidecar clustering');
                try {
                    clusterResult = await clusterFacesRemote(faces, clusterOpts, log);
                } catch (e) {
                    log('warn', `faces scan: sidecar clustering failed: ${e?.message || e}`);
                    clusterResult = null;
                }
            }
            if (!clusterResult) {
                log('info', 'faces scan: sidecar clustering unavailable — using Node worker');
                clusterResult = await _runClusterWorker(faces, clusterOpts);
            }
            const { clusters } = clusterResult;
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
                FACE_DEFAULTS.facesEpsilon, // 1.05 — must match epsForCluster fallback above
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

// ---- OCR-derived keyword tags -------------------------------------------

/**
 * Tokenise OCR text into keyword tags stored in `image_tags`.
 * Returns [{tag, score}] — score is normalised word frequency (0–1).
 * Empty text returns a single sentinel so the row isn't re-processed.
 */
function _deriveTagsFromOcrText(text) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return [{ tag: '_scanned_', score: 0 }];
    }
    const STOPWORDS = new Set([
        'the',
        'a',
        'an',
        'and',
        'or',
        'but',
        'in',
        'on',
        'at',
        'to',
        'for',
        'of',
        'with',
        'by',
        'from',
        'as',
        'is',
        'are',
        'was',
        'were',
        'be',
        'been',
        'being',
        'have',
        'has',
        'had',
        'do',
        'does',
        'did',
        'will',
        'would',
        'could',
        'should',
        'may',
        'might',
        'shall',
        'can',
        'that',
        'this',
        'these',
        'those',
        'it',
        'its',
        'we',
        'our',
        'you',
        'your',
        'he',
        'she',
        'they',
        'their',
        'them',
        'him',
        'her',
        'i',
        'me',
        'my',
        'not',
        'no',
        'nor',
        'so',
        'yet',
        'both',
        'either',
        'neither',
        'also',
        'just',
        'more',
        'than',
        'then',
        'when',
        'where',
        'who',
        'which',
        'what',
        'how',
    ]);
    const freq = new Map();
    for (const tok of text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)) {
        if (tok.length >= 3 && !STOPWORDS.has(tok)) {
            freq.set(tok, (freq.get(tok) || 0) + 1);
        }
    }
    if (!freq.size) return [{ tag: '_scanned_', score: 0 }];
    const maxFreq = Math.max(...freq.values());
    return Array.from(freq.entries())
        .map(([tag, count]) => ({ tag, score: Math.min(1, count / maxFreq) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);
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
            if (!useMlOcr) {
                const preflight = await checkSidecarCapability('ocr', sidecarUrl);
                if (!preflight.ok) {
                    throw Object.assign(new Error(`OCR preflight failed: ${preflight.reason}`), {
                        code: preflight.code,
                        fatal: true,
                    });
                }
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
                        _safeSetOcrTags(row.id, '', log);
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    if (row.file_type !== 'photo') {
                        log('debug', `ocr: skipping non-photo: ${row.file_name}`);
                        setImageText(row.id, '', null, null);
                        _safeSetOcrTags(row.id, '', log);
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
                        const text = result?.text || '';
                        // Always write a row (even empty) so the same image
                        // isn't picked up on the next batch query.
                        setImageText(
                            row.id,
                            text,
                            result?.language || null,
                            result?.confidence || null,
                        );
                        _safeSetOcrTags(row.id, text, log);
                    } catch (e) {
                        if (e?.fatal) throw e;
                        log('warn', `ocr failed for id=${row.id}: ${e?.message || e}`);
                        setImageText(row.id, '', null, null);
                        _safeSetOcrTags(row.id, '', log);
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

            // Release stale processing locks from any prior crash before counting.
            const recovered = recoverStaleLocks('wd14');
            if (recovered > 0) log('info', `wd14 scan: recovered ${recovered} stale locks`);

            const total = countUnscannedWd14({ fileTypes });
            state.total = total;
            bump();
            log('info', `wd14 scan: ${total} files to tag`);

            if (total === 0) {
                log('info', 'wd14 scan: nothing to tag');
                return;
            }

            const sidecarUrl = isTgdlMlEnabled() ? getTgdlMlUrl() : getSidecarUrl();
            const wd14Preflight = await checkSidecarCapability('wd14', sidecarUrl);
            if (!wd14Preflight.ok) {
                throw Object.assign(new Error(`WD14 preflight failed: ${wd14Preflight.reason}`), {
                    code: wd14Preflight.code,
                    fatal: true,
                });
            }

            const batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize) || 16));
            const minScore = Math.max(0, Math.min(1, Number(cfg.wd14MinScore) || 0.35));

            while (!signal.aborted) {
                const batch = getUnscannedWd14Batch({ fileTypes, limit: batchSize });
                if (!batch.length) break;

                for (const row of batch) {
                    if (signal.aborted) break;
                    const abs = _resolveAbs(row.file_path);
                    if (!abs) {
                        // File missing on disk — write sentinel + record skip so it isn't
                        // re-queued on every subsequent scan.
                        setWd14Tags(row.id, []);
                        markScanSkipped(row.id, 'wd14', 'file_missing');
                        state.scanned += 1;
                        bump();
                        continue;
                    }

                    let tags = null;
                    try {
                        tags = await _tagWd14One(sidecarUrl, abs, minScore, log, isTgdlMlEnabled());
                    } catch (e) {
                        log('warn', `wd14 tagging failed for id=${row.id}: ${e?.message || e}`);
                        // Write sentinel so the row exits the batch query this scan run,
                        // but record the failure in scan_state so "retry failed" can unblock it.
                        setWd14Tags(row.id, []);
                        markScanFailed(row.id, 'wd14', e?.message || String(e), e?.code || null);
                        state.failed = (state.failed || 0) + 1;
                        state.scanned += 1;
                        bump();
                        await new Promise((r) => setImmediate(r));
                        continue;
                    }

                    setWd14Tags(row.id, Array.isArray(tags) ? tags : []);
                    markScanDone(row.id, 'wd14');
                    state.scanned += 1;
                    bump();
                    await new Promise((r) => setImmediate(r));
                }
            }
            log(
                'info',
                `wd14 scan: finished — ${state.scanned} files tagged, ${state.failed || 0} failed`,
            );
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
async function _tagWd14One(sidecarUrl, absPath, minScore, log, skipPathMode = false) {
    const url = `${sidecarUrl.replace(/\/+$/, '')}/tag-wd14`;
    const doFetch = async (body) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });
    try {
        let res;
        if (skipPathMode) {
            const b64 = await _readAsBase64(absPath);
            res = await doFetch({ image_b64: b64, min_score: minScore });
        } else {
            res = await doFetch({ path: absPath, min_score: minScore });
            if (res.status === 403) {
                const b64 = await _readAsBase64(absPath);
                res = await doFetch({ image_b64: b64, min_score: minScore });
            }
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

function _safeSetOcrTags(downloadId, text, log) {
    try {
        clearImageTagsForDownload(downloadId);
        setImageTags(downloadId, _deriveTagsFromOcrText(text));
        return true;
    } catch (e) {
        if (_isForeignKeyError(e)) {
            log('warn', `ocr tags: download row vanished while writing tags id=${downloadId}`);
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
    _scans.ocr = _emptyState();
    _scans.wd14 = _emptyState();
}
