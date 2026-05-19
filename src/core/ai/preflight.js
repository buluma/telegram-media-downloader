import { getSidecarUrl } from './faces-client.js';

const _INFO_CACHE = new Map(); // url -> { ts, data }
const INFO_TTL_MS = 5000;

async function _fetchInfo(url) {
    const now = Date.now();
    const cached = _INFO_CACHE.get(url);
    if (cached && now - cached.ts < INFO_TTL_MS) return cached.data;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/info`, { signal: ctrl.signal });
        if (!res.ok) return null;
        const data = await res.json();
        _INFO_CACHE.set(url, { ts: now, data });
        return data;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const _REQUIRED = {
    ocr: { endpoint: 'ocr', model: 'ocr' },
    wd14: { endpoint: 'tag_wd14', model: 'wd14' },
    clip: { endpoint: 'tag', model: 'clip' },
    faces: { endpoint: 'detect', model: 'faces' },
};

/**
 * Check whether the sidecar exposes the capability needed for a given scanner.
 *
 * @param {'ocr'|'wd14'|'clip'|'faces'} scanner
 * @param {string} [sidecarUrl] Defaults to getSidecarUrl().
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string }>}
 */
export async function checkSidecarCapability(scanner, sidecarUrl) {
    const req = _REQUIRED[scanner];
    if (!req) {
        return { ok: false, code: 'UNKNOWN_SCANNER', reason: `Unknown scanner: ${scanner}` };
    }

    const url = sidecarUrl || getSidecarUrl();
    if (!url) {
        return { ok: false, code: 'SIDECAR_OFFLINE', reason: 'Sidecar URL not configured' };
    }

    const info = await _fetchInfo(url);
    if (!info) {
        return {
            ok: false,
            code: 'SIDECAR_UNREACHABLE',
            reason: `Sidecar /info did not respond at ${url}`,
        };
    }

    if (!info?.endpoints?.[req.endpoint]) {
        return {
            ok: false,
            code: 'CAPABILITY_MISSING',
            reason: `Sidecar does not expose /${req.endpoint} endpoint`,
        };
    }

    const model = info?.models?.[req.model];
    if (model && model.ready === false) {
        return {
            ok: false,
            code: 'MODEL_NOT_READY',
            reason: `Model '${req.model}' is not loaded`,
        };
    }

    return { ok: true };
}
