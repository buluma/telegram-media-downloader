/**
 * HTTP client for the Python face-detection sidecar.
 *
 * Owns nothing persistent: the URL is set by `faces-spawn.js` (Track C)
 * on boot — empty string disables, a non-empty URL switches the client
 * to that sidecar. Docker installs override via the `FACES_SERVICE_URL`
 * env so they talk to the bundled `tgdl-faces` container directly.
 *
 * Wire format (matches faces-service/tgdl_faces/app.py):
 *   POST /detect  { path, min_score, min_box_px, ar_range }
 *                 → 200 { faces: [{ x, y, w, h, score, embedding[], landmarks? }] }
 *                 → 403 { code: 'path_not_allowed' }  (sandbox; fall back to b64)
 *                 → 5xx { error }                     (retry with backoff)
 *
 * Output contract for callers (faces.js / scan-runner.js / index.js):
 *   - `null` on total failure (network gone, retries exhausted, decode died).
 *   - `[]` when the sidecar replied but found no faces.
 *   - `[{x, y, w, h, score, embedding: Float32Array, landmarks?}, …]` on success.
 *     The `embedding` MUST be a `Float32Array` — scan-runner.js's `_f32ToBlob`
 *     reads `.buffer`/`.byteLength` so a plain array breaks the DB write.
 */

import { promises as fs } from 'fs';
import { Buffer } from 'buffer';

import { resolveFacesValue } from './faces-config.js';

// Defaults used when the operator hasn't tuned `advanced.ai.faces.*` and
// hasn't set any of the matching `TGDL_FACES_*` env vars. `applyFacesCfg`
// pushes operator values on top, so this is the bare-install behaviour.
const HEALTH_CACHE_TTL_MS_DEFAULT = 5000;
// CPU-only buffalo_l inference can take 5-30 s per image on slow hardware;
// 60 s gives headroom without hanging the scan loop forever on a dead sidecar.
const REQUEST_TIMEOUT_MS_DEFAULT = 60000;
const MAX_RETRIES_DEFAULT = 3;
const RETRY_BACKOFF_MS_DEFAULT = [300, 600, 1200];

// Mutable runtime knobs. Initialised from defaults; overridden by either:
//   - `applyFacesCfg(resolvedCfg)` — called by faces-spawn at boot.
//   - Env vars on first access — for code paths that import the client
//     before spawn has run (e.g. AI maintenance card during cold boot).
let _healthCacheTtlMs = HEALTH_CACHE_TTL_MS_DEFAULT;
let _requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;
let _maxRetries = MAX_RETRIES_DEFAULT;
let _retryBackoffMs = RETRY_BACKOFF_MS_DEFAULT.slice();
let _maxConcurrency = 0; // 0 = unlimited
let _inflight = 0;
let _envBootstrapped = false;

let _primaryUrl = '';
let _fallbackUrl = '';
let _activeRole = 'primary'; // primary | fallback
let _primaryPathMode = true;
let _fallbackPathMode = true;
let _primaryHealthFailures = 3;
let _primaryRecoverySuccesses = 2;
let _primaryFailCount = 0;
let _primaryRecoveryCount = 0;
let _healthCache = { primary: null, fallback: null }; // role -> { value, expiresAt }

/**
 * Apply a resolved faces config snapshot to the client's runtime knobs.
 * Called by `faces-spawn._doStart()` once it's read `loadConfig()` + env.
 * Safe to call multiple times — later calls overwrite earlier values.
 *
 * Treats every key as optional: a partial snapshot only updates the
 * supplied knobs and leaves the rest untouched. Invalid values fall back
 * to the previous setting so a broken env var doesn't disable retries.
 */
export function applyFacesCfg(cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Number.isFinite(cfg.healthCacheTtlMs) && cfg.healthCacheTtlMs >= 0) {
        _healthCacheTtlMs = cfg.healthCacheTtlMs | 0;
    }
    if (Number.isFinite(cfg.requestTimeoutMs) && cfg.requestTimeoutMs > 0) {
        _requestTimeoutMs = cfg.requestTimeoutMs | 0;
    }
    if (Number.isFinite(cfg.maxRetries) && cfg.maxRetries >= 0) {
        _maxRetries = cfg.maxRetries | 0;
    }
    if (Array.isArray(cfg.retryBackoffMs) && cfg.retryBackoffMs.length) {
        const cleaned = cfg.retryBackoffMs
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n >= 0);
        if (cleaned.length) _retryBackoffMs = cleaned;
    }
    if (Number.isFinite(cfg.sidecarMaxConcurrency) && cfg.sidecarMaxConcurrency >= 0) {
        _maxConcurrency = cfg.sidecarMaxConcurrency | 0;
    }
    if (typeof cfg.fallbackUrl === 'string') {
        setFallbackSidecarUrl(cfg.fallbackUrl);
    }
    if (typeof cfg.primaryPathMode === 'boolean') {
        _primaryPathMode = cfg.primaryPathMode;
    }
    if (typeof cfg.fallbackPathMode === 'boolean') {
        _fallbackPathMode = cfg.fallbackPathMode;
    }
    if (Number.isFinite(cfg.primaryHealthFailures) && cfg.primaryHealthFailures > 0) {
        _primaryHealthFailures = cfg.primaryHealthFailures | 0;
    }
    if (Number.isFinite(cfg.primaryRecoverySuccesses) && cfg.primaryRecoverySuccesses > 0) {
        _primaryRecoverySuccesses = cfg.primaryRecoverySuccesses | 0;
    }
    _envBootstrapped = true;
}

// Lazy env bootstrap for code paths that import the client before spawn —
// e.g. the AI maintenance card hitting `/api/ai/status` during cold boot.
// Once `applyFacesCfg` has run we trust the snapshot it pushed.
function _bootstrapFromEnv() {
    if (_envBootstrapped) return;
    _envBootstrapped = true;
    const probe = (key) => resolveFacesValue(key, {});
    const ttl = probe('healthCacheTtlMs');
    if (Number.isFinite(ttl) && ttl >= 0) _healthCacheTtlMs = ttl | 0;
    const to = probe('requestTimeoutMs');
    if (Number.isFinite(to) && to > 0) _requestTimeoutMs = to | 0;
    const mr = probe('maxRetries');
    if (Number.isFinite(mr) && mr >= 0) _maxRetries = mr | 0;
    const bo = probe('retryBackoffMs');
    if (Array.isArray(bo) && bo.length) _retryBackoffMs = bo;
    const mc = probe('sidecarMaxConcurrency');
    if (Number.isFinite(mc) && mc >= 0) _maxConcurrency = mc | 0;
    const fallbackUrl = probe('fallbackUrl');
    if (typeof fallbackUrl === 'string') setFallbackSidecarUrl(fallbackUrl);
    const primaryPathMode = probe('primaryPathMode');
    if (typeof primaryPathMode === 'boolean') _primaryPathMode = primaryPathMode;
    const fallbackPathMode = probe('fallbackPathMode');
    if (typeof fallbackPathMode === 'boolean') _fallbackPathMode = fallbackPathMode;
    const failCount = probe('primaryHealthFailures');
    if (Number.isFinite(failCount) && failCount > 0) _primaryHealthFailures = failCount | 0;
    const recoveryCount = probe('primaryRecoverySuccesses');
    if (Number.isFinite(recoveryCount) && recoveryCount > 0) {
        _primaryRecoverySuccesses = recoveryCount | 0;
    }
}

/**
 * Set the sidecar base URL. Empty string disables the client entirely
 * (callers see `getSidecarUrl()` return null). Called by `faces-spawn.js`
 * once the child process is healthy, and by Docker boot when
 * `FACES_SERVICE_URL` env is present.
 *
 * Mutating the URL invalidates the cached health probe so the next caller
 * doesn't see a stale "down" / "up" answer from the previous sidecar.
 */
export function setSidecarUrl(url) {
    const next = _normaliseUrl(url);
    if (next === _primaryUrl) return;
    _primaryUrl = next;
    _activeRole = next ? 'primary' : _fallbackUrl ? 'fallback' : 'primary';
    _primaryFailCount = 0;
    _primaryRecoveryCount = 0;
    _healthCache = { primary: null, fallback: null };
}

/** Optional secondary sidecar URL used when the primary is unavailable. */
export function setFallbackSidecarUrl(url) {
    const next = _normaliseUrl(url);
    if (next === _fallbackUrl) return;
    _fallbackUrl = next;
    if (!_primaryUrl && next) _activeRole = 'fallback';
    if (_activeRole === 'fallback' && !next) _activeRole = _primaryUrl ? 'primary' : 'fallback';
    _primaryRecoveryCount = 0;
    _healthCache.fallback = null;
}

/** Current InsightFace sidecar URL or null when none is configured. */
export function getSidecarUrl() {
    return _activeEndpoint()?.url || null;
}

/** Current primary/fallback routing state for status endpoints and tests. */
export function getSidecarRoutingStatus() {
    const primary = _endpoint('primary');
    const fallback = _endpoint('fallback');
    return {
        active: _activeEndpoint(),
        activeRole: _activeEndpoint()?.role || null,
        primary,
        fallback,
        failoverEnabled: !!(primary?.url && fallback?.url),
        primaryFailCount: _primaryFailCount,
        primaryRecoveryCount: _primaryRecoveryCount,
        primaryHealthFailures: _primaryHealthFailures,
        primaryRecoverySuccesses: _primaryRecoverySuccesses,
    };
}

const HEALTH_PROBE_TIMEOUT_MS = 5000;
const HEALTH_PROBE_RETRIES = 3;

/**
 * Probe the sidecar's `/health` endpoint. Result is cached for 5 s — the
 * AI maintenance card polls this on every redraw and the sidecar's
 * `/health` is otherwise hit several times per second during a scan.
 *
 * Retries up to `HEALTH_PROBE_RETRIES` times on network / 5xx errors
 * before caching a failure so a single transient blip doesn't flip the
 * status card red. Uses a dedicated 5 s timeout (not `_requestTimeoutMs`)
 * so a hung sidecar never blocks the maintenance page.
 *
 * NEVER throws — a thrown error here would cascade into a broken card
 * (the AI panel is the only thing that reports sidecar status, so it
 * must always render). On failure returns `{ ok: false, error }`.
 */
export async function health() {
    _bootstrapFromEnv();
    const selected = await _selectEndpoint();
    if (!selected?.endpoint?.url) return { ok: false, error: 'sidecar_url_unset' };
    return selected.value;
}

async function _probeEndpoint(role, { bypassCache = false } = {}) {
    const endpoint = _endpoint(role);
    if (!endpoint?.url) return { ok: false, error: 'sidecar_url_unset', role };
    const now = Date.now();
    const cached = _healthCache[role];
    if (!bypassCache && cached && cached.expiresAt > now) {
        return cached.value;
    }
    let value;
    let lastErr = null;
    for (let attempt = 0; attempt < HEALTH_PROBE_RETRIES; attempt++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
            let res;
            try {
                res = await globalThis.fetch(`${endpoint.url}/health`, {
                    method: 'GET',
                    signal: ctrl.signal,
                });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                lastErr = new Error(`http_${res.status}`);
                // 5xx is retryable; 4xx is a final answer.
                if (res.status < 500) {
                    value = { ok: false, error: `http_${res.status}` };
                    break;
                }
                continue;
            }
            const body = await res.json();
            value = {
                ok: body?.ok === true,
                role,
                url: endpoint.url,
                pathMode: endpoint.pathMode,
                version: body?.version ?? null,
                model: body?.model ?? null,
                dim: body?.dim ?? null,
                ready: body?.ready === true,
                // Forward the new diagnostic fields (Phase 6) so the AI
                // maintenance card can render real state instead of just
                // a green dot. Older sidecars (pre-Track-I) don't ship
                // these — leave them null so the UI knows to fall back.
                providersResolved: Array.isArray(body?.providers_resolved)
                    ? body.providers_resolved.slice()
                    : null,
                providersRequested: body?.providers_requested ?? null,
                detSize: Number.isFinite(body?.det_size) ? body.det_size : null,
                platform: typeof body?.platform === 'string' ? body.platform : null,
                python: typeof body?.python === 'string' ? body.python : null,
            };
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (value === undefined) {
        value = {
            ok: false,
            role,
            url: endpoint.url,
            pathMode: endpoint.pathMode,
            error: lastErr?.message || String(lastErr),
        };
    }
    _healthCache[role] = { value, expiresAt: now + _healthCacheTtlMs };
    return value;
}

async function _selectEndpoint({ fallbackOnly = false, probe = true } = {}) {
    if (fallbackOnly) {
        const endpoint = _endpoint('fallback');
        if (!endpoint?.url)
            return { endpoint: null, value: { ok: false, error: 'fallback_url_unset' } };
        const value = await _probeEndpoint('fallback', { bypassCache: true });
        if (value.ok) _activeRole = 'fallback';
        return { endpoint, value };
    }

    const primary = _endpoint('primary');
    const fallback = _endpoint('fallback');
    if (!primary?.url && !fallback?.url) {
        return { endpoint: null, value: { ok: false, error: 'sidecar_url_unset' } };
    }
    if (!primary?.url) {
        _activeRole = 'fallback';
        if (!probe) return { endpoint: fallback, value: { ok: true } };
        const value = await _probeEndpoint('fallback');
        return { endpoint: fallback, value };
    }
    if (!fallback?.url) {
        _activeRole = 'primary';
        if (!probe) return { endpoint: primary, value: { ok: true } };
        const value = await _probeEndpoint('primary');
        return { endpoint: primary, value };
    }
    if (!probe) {
        const endpoint = _activeEndpoint() || primary;
        return { endpoint, value: { ok: true } };
    }

    if (_activeRole === 'fallback') {
        const fallbackValue = await _probeEndpoint('fallback');
        const primaryValue = await _probeEndpoint('primary', { bypassCache: true });
        if (primaryValue.ok) {
            _primaryRecoveryCount++;
            _primaryFailCount = 0;
            if (_primaryRecoveryCount >= _primaryRecoverySuccesses) {
                _activeRole = 'primary';
                return { endpoint: primary, value: primaryValue };
            }
        } else {
            _primaryRecoveryCount = 0;
        }
        if (fallbackValue.ok) return { endpoint: fallback, value: fallbackValue };
        if (primaryValue.ok) {
            _activeRole = 'primary';
            return { endpoint: primary, value: primaryValue };
        }
        return { endpoint: fallback, value: fallbackValue };
    }

    const primaryValue = await _probeEndpoint('primary');
    if (primaryValue.ok) {
        _primaryFailCount = 0;
        _primaryRecoveryCount = 0;
        return { endpoint: primary, value: primaryValue };
    }
    _primaryFailCount++;
    _primaryRecoveryCount = 0;
    if (_primaryFailCount >= _primaryHealthFailures) {
        const fallbackValue = await _probeEndpoint('fallback', { bypassCache: true });
        if (fallbackValue.ok) {
            _activeRole = 'fallback';
            return { endpoint: fallback, value: fallbackValue };
        }
    }
    return { endpoint: primary, value: primaryValue };
}

/**
 * Detect faces in one image via the sidecar. Path mode first; on
 * `403 path_not_allowed` falls back to b64 mode (POSTs the bytes
 * directly — needed for Docker installs where the sidecar container
 * cannot see host-side paths).
 *
 * @param {string} absPath absolute path to the source image
 * @param {object} cfg     `advanced.ai` config slice
 * @param {function?} onLog optional `({source, level, msg}) => void`
 * @returns {Promise<Array | null>}
 */
export async function detectFaces(absPath, cfg = {}, onLog = null) {
    _bootstrapFromEnv();
    const selected = await _selectEndpoint({ probe: false });
    if (!selected?.endpoint?.url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFaces returning null');
        return null;
    }
    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    const baseBody = { min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };
    const pathBody = { ...baseBody, path: absPath };

    // Concurrency gate — operator can cap inflight detects on shared NAS
    // hardware where running 16 simultaneous detections OOMs the box.
    // 0 = unlimited (default).
    if (_maxConcurrency > 0) {
        while (_inflight >= _maxConcurrency) {
            await _sleep(25);
        }
    }
    _inflight++;
    try {
        const first = await _detectInner(absPath, pathBody, baseBody, selected.endpoint, onLog);
        if (first !== null || selected.endpoint.role !== 'primary' || !_fallbackUrl) {
            return first;
        }
        _primaryFailCount++;
        const fallback = await _selectEndpoint({ fallbackOnly: true });
        if (!fallback?.value?.ok || !fallback?.endpoint?.url) return first;
        _log(
            onLog,
            'warn',
            `primary sidecar failed for ${absPath}; retrying on fallback ${fallback.endpoint.url}`,
        );
        return await _detectInner(absPath, pathBody, baseBody, fallback.endpoint, onLog);
    } finally {
        _inflight = Math.max(0, _inflight - 1);
    }
}

/**
 * Detect faces in a batch of images via the sidecar's `/detect/batch`
 * endpoint — one HTTP round-trip for up to `batchSize` files.
 *
 * @param {string[]}  absPaths absolute paths to source images
 * @param {object}    cfg      `advanced.ai` config slice
 * @param {function?} onLog    optional `({source, level, msg}) => void`
 * @returns {Promise<Array<Array|null>>} same order as input;
 *   `null`  = sidecar error / path unresolvable
 *   `[]`    = processed but no faces found
 *   `[…]`  = detected faces
 *   Items rejected with `path_not_allowed` (Docker sandbox) are retried
 *   individually via the single-detect b64 fallback path.
 */
export async function detectFacesBatch(absPaths, cfg = {}, onLog = null) {
    _bootstrapFromEnv();
    if (!absPaths.length) return [];
    const selected = await _selectEndpoint({ probe: false });
    if (!selected?.endpoint?.url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFacesBatch returning nulls');
        return absPaths.map(() => null);
    }
    if (!selected.endpoint.pathMode) {
        return Promise.all(absPaths.map((p) => detectFaces(p, cfg, onLog)));
    }

    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    // Sidecar processes the batch sequentially — scale timeout with count.
    const batchTimeoutMs = Math.max(absPaths.length * _requestTimeoutMs, 120_000);
    const body = { files: absPaths, min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };

    let batchRes;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), batchTimeoutMs);
        try {
            batchRes = await globalThis.fetch(`${selected.endpoint.url}/detect/batch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        _log(onLog, 'warn', `detectFacesBatch: network error — ${e?.message || e}`);
        if (selected.endpoint.role === 'primary' && _fallbackUrl) {
            _primaryFailCount++;
            const fallback = await _selectEndpoint({ fallbackOnly: true });
            if (fallback?.value?.ok && fallback?.endpoint?.url) {
                _log(
                    onLog,
                    'warn',
                    `primary batch sidecar failed; retrying ${absPaths.length} files on fallback ${fallback.endpoint.url}`,
                );
                return detectFacesBatch(absPaths, cfg, onLog);
            }
        }
        return absPaths.map(() => null);
    }

    if (!batchRes.ok) {
        _log(onLog, 'warn', `detectFacesBatch: sidecar returned ${batchRes.status}`);
        if (selected.endpoint.role === 'primary' && _fallbackUrl && batchRes.status >= 500) {
            _primaryFailCount++;
            const fallback = await _selectEndpoint({ fallbackOnly: true });
            if (fallback?.value?.ok && fallback?.endpoint?.url) {
                _log(
                    onLog,
                    'warn',
                    `primary batch sidecar returned ${batchRes.status}; retrying on fallback ${fallback.endpoint.url}`,
                );
                return detectFacesBatch(absPaths, cfg, onLog);
            }
        }
        return absPaths.map(() => null);
    }

    let batchBody;
    try {
        batchBody = await batchRes.json();
    } catch (e) {
        _log(onLog, 'warn', `detectFacesBatch: invalid JSON — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    const resultMap = new Map();
    for (const item of batchBody?.results ?? []) {
        resultMap.set(item.file, item);
    }

    const output = new Array(absPaths.length).fill(null);
    const pathFallbacks = [];

    for (let i = 0; i < absPaths.length; i++) {
        const item = resultMap.get(absPaths[i]);
        if (!item) continue; // path missing from response → null
        if (item.error === 'path_not_allowed') {
            pathFallbacks.push(i);
            continue;
        }
        if (item.error) {
            // decode_failed is expected for some non-image payloads with image-like
            // extensions (for example compressed sticker documents).
            const lvl = item.error === 'decode_failed' ? 'info' : 'warn';
            _log(onLog, lvl, `batch detect ${absPaths[i]}: sidecar soft-error="${item.error}"`);
            output[i] = []; // soft error → empty (sidecar reached the file)
            continue;
        }
        output[i] = _parseFacesList(item.faces);
    }

    // Per-image b64 fallback for Docker/sandbox environments where the sidecar
    // can't read host paths. Rare but required for correctness.
    for (const idx of pathFallbacks) {
        output[idx] = await detectFaces(absPaths[idx], cfg, onLog);
    }

    return output;
}

async function _detectInner(absPath, pathBody, baseBody, endpoint, onLog) {
    const url = endpoint.url;
    // Path mode first. If the sidecar rejects with `path_not_allowed`
    // (Docker sandbox, or operator chose strict allow-roots), fall back
    // to b64. The fallback only fires on that explicit 403 — other
    // errors flow through retry / null.
    let res;
    if (endpoint.pathMode) {
        try {
            res = await _postWithRetry(`${url}/detect`, pathBody, onLog);
        } catch (e) {
            _log(onLog, 'warn', `detect path-mode failed for ${absPath}: ${e?.message || e}`);
            return null;
        }
    }

    if (!endpoint.pathMode || (res && res.status === 403)) {
        let code = null;
        if (res) {
            try {
                const body = await res.clone().json();
                code = body?.code || null;
            } catch {
                /* body may not be JSON; treat as generic 403 */
            }
        }
        if (!endpoint.pathMode || code === 'path_not_allowed') {
            _log(
                onLog,
                'info',
                endpoint.pathMode
                    ? `path mode rejected for ${absPath}; falling back to b64`
                    : `path mode disabled for ${endpoint.role} sidecar; using b64 for ${absPath}`,
            );
            let bytes;
            try {
                bytes = await fs.readFile(absPath);
            } catch (e) {
                _log(onLog, 'warn', `b64 read failed for ${absPath}: ${e?.message || e}`);
                return null;
            }
            const b64Body = { ...baseBody, image_b64: Buffer.from(bytes).toString('base64') };
            try {
                res = await _postWithRetry(`${url}/detect`, b64Body, onLog);
            } catch (e) {
                _log(onLog, 'warn', `detect b64-mode failed for ${absPath}: ${e?.message || e}`);
                return null;
            }
        }
    }

    if (!res || !res.ok) {
        const status = res?.status ?? 'no_response';
        _log(onLog, 'warn', `detect ${absPath}: sidecar returned ${status}`);
        return null;
    }

    let body;
    try {
        body = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `detect ${absPath}: invalid JSON from sidecar: ${e?.message || e}`);
        return null;
    }

    // The sidecar returns 200 + an `error` field for soft failures
    // (file_not_found, decode_failed). Log them so the scan summary
    // shows *why* a photo yielded 0 faces instead of silently moving on.
    if (body?.error) {
        _log(
            onLog,
            'warn',
            `detect ${absPath}: sidecar soft-error="${body.error}" — 0 faces stored`,
        );
    }
    return _parseFacesList(Array.isArray(body?.faces) ? body.faces : []);
}

// Parse a raw faces array from the sidecar into typed Face objects.
// Shared by both single-detect and batch paths.
function _parseFacesList(faces) {
    if (!Array.isArray(faces)) return [];
    return faces
        .map((f) => {
            // Embedding must be Float32Array — downstream (`_f32ToBlob`)
            // reads `.buffer` / `.byteLength`. A plain JS array breaks the
            // DB write silently (writes [object Array] as text).
            const emb = Array.isArray(f?.embedding) ? Float32Array.from(f.embedding) : null;
            if (!emb || !emb.length) return null;
            const out = {
                x: Number(f.x) || 0,
                y: Number(f.y) || 0,
                w: Number(f.w) || 0,
                h: Number(f.h) || 0,
                score: Number.isFinite(f.score) ? Number(f.score) : 0,
                embedding: emb,
            };
            if (f.landmarks != null) out.landmarks = f.landmarks;
            return out;
        })
        .filter(Boolean);
}

/**
 * POST with linear-backoff retry on 5xx / network errors. 403 / 4xx
 * (except 408 / 429) return the response immediately so the caller can
 * inspect the body — those are not retryable.
 */
async function _postWithRetry(url, body, onLog) {
    const maxRetries = Math.max(1, _maxRetries);
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let bail = false;
        let bailReason = '';
        try {
            const res = await _fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            // Retry only on 5xx, 408, 429 — everything else (200/4xx) is
            // a final answer the caller needs to see.
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                lastErr = new Error(`sidecar http ${res.status}`);
            } else {
                return res;
            }
        } catch (e) {
            lastErr = e;
            if (attempt < maxRetries - 1 && e?.name === 'AbortError') {
                // Client-side timeout: sidecar is alive but slow — don't retry
                // (piling up requests against a slow CPU just makes it worse).
                bail = true;
                bailReason = `— timed out after ${_requestTimeoutMs}ms, skipping image`;
            }
        }
        const hasMore = attempt < maxRetries - 1 && !bail;
        const backoff =
            _retryBackoffMs[attempt] ?? _retryBackoffMs[_retryBackoffMs.length - 1] ?? 300;
        const suffix = bail ? bailReason : hasMore ? `— retrying in ${backoff} ms` : '— giving up';
        _log(
            onLog,
            'warn',
            `sidecar POST ${url} attempt ${attempt + 1}/${maxRetries} failed: ${
                lastErr?.message || lastErr
            } ${suffix}`,
        );
        if (bail) break;
        if (hasMore) await _sleep(backoff);
    }
    throw lastErr || new Error('sidecar POST: retries exhausted');
}

/** fetch() with a hard timeout via AbortController. */
async function _fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
        try {
            ctrl.abort();
        } catch {
            /* AbortController.abort() never throws but defend anyway */
        }
    }, _requestTimeoutMs);
    try {
        return await globalThis.fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

function _pickNumber(candidates, fallback) {
    for (const c of candidates) {
        if (Number.isFinite(c)) return c;
    }
    return fallback;
}

function _normaliseUrl(url) {
    return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

function _endpoint(role) {
    if (role === 'fallback') {
        return _fallbackUrl
            ? { role: 'fallback', url: _fallbackUrl, pathMode: _fallbackPathMode }
            : null;
    }
    return _primaryUrl ? { role: 'primary', url: _primaryUrl, pathMode: _primaryPathMode } : null;
}

function _activeEndpoint() {
    return _endpoint(_activeRole) || _endpoint('primary') || _endpoint('fallback');
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function _log(onLog, level, msg) {
    if (typeof onLog !== 'function') return;
    try {
        onLog({ source: 'ai-faces-client', level, msg });
    } catch {
        /* logging must never throw out of the client */
    }
}

/** Test-only: clear cached URL + health probe so each spec starts fresh. */
export function _resetForTests() {
    _primaryUrl = '';
    _fallbackUrl = '';
    _activeRole = 'primary';
    _primaryPathMode = true;
    _fallbackPathMode = true;
    _primaryHealthFailures = 3;
    _primaryRecoverySuccesses = 2;
    _primaryFailCount = 0;
    _primaryRecoveryCount = 0;
    _healthCache = { primary: null, fallback: null };
    _healthCacheTtlMs = HEALTH_CACHE_TTL_MS_DEFAULT;
    _requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;
    _maxRetries = MAX_RETRIES_DEFAULT;
    _retryBackoffMs = RETRY_BACKOFF_MS_DEFAULT.slice();
    _maxConcurrency = 0;
    _inflight = 0;
    _envBootstrapped = false;
}

/** Test-only: snapshot the resolved runtime knobs. */
export function _runtimeKnobs() {
    return {
        healthCacheTtlMs: _healthCacheTtlMs,
        requestTimeoutMs: _requestTimeoutMs,
        maxRetries: _maxRetries,
        retryBackoffMs: _retryBackoffMs.slice(),
        sidecarMaxConcurrency: _maxConcurrency,
        primaryPathMode: _primaryPathMode,
        fallbackPathMode: _fallbackPathMode,
        primaryHealthFailures: _primaryHealthFailures,
        primaryRecoverySuccesses: _primaryRecoverySuccesses,
    };
}

// ---- Embeddings (CLIP) ---------------------------------------------------

/** Current embedding backend URL. Uses the InsightFace sidecar CLIP endpoints. */
export function getEmbeddingProviderUrl() {
    return getSidecarUrl();
}

export function hasEmbeddingProvider() {
    return !!getEmbeddingProviderUrl();
}

/**
 * Compute the CLIP image embedding for a single file on disk.
 * Returns ``{ embedding: number[], dim: number }`` or throws.
 */
export async function embedImage(absPath) {
    _bootstrapFromEnv();
    const selected = await _selectEndpoint({ probe: false });
    const endpoint = selected?.endpoint;
    const url = endpoint?.url;
    if (!url) throw new Error('sidecar URL not configured');

    // Path mode first — fast path for local installs.
    let res;
    if (endpoint.pathMode) {
        try {
            res = await _postWithRetry(url + '/embed-image', { path: absPath });
        } catch (e) {
            throw new Error(`embed-image path-mode failed: ${e?.message || e}`);
        }
    }

    // If sidecar can't read the path (Docker sandbox / strict allow_roots),
    // fall back to base64 mode.
    if (!endpoint.pathMode || (res && res.status === 403)) {
        let code = null;
        if (res) {
            try {
                const body = await res.clone().json();
                code = body?.code || null;
            } catch {}
        }
        if (!endpoint.pathMode || code === 'path_not_allowed') {
            const maxBytes = 20 * 1024 * 1024; // 20 MB safety limit
            const stat = await fs.stat(absPath);
            if (stat.size > maxBytes) {
                throw new Error(`file too large for b64 fallback: ${absPath} (${stat.size} bytes)`);
            }
            const bytes = await fs.readFile(absPath);
            const b64 = bytes.toString('base64');
            res = await _postWithRetry(url + '/embed-image', {
                image_b64: b64,
            });
        }
    }

    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `sidecar http ${res.status}`);
    return body;
}

/**
 * Compute a CLIP text embedding for a natural-language query string.
 * Returns ``{ embedding: number[], dim: number }`` or throws.
 */
export async function embedText(text, opts = {}) {
    const url = getSidecarUrl();
    if (!url) throw new Error('sidecar URL not configured');
    const res = await _postWithRetry(url + '/embed-text', { text: String(text) });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `sidecar http ${res.status}`);
    return body;
}
