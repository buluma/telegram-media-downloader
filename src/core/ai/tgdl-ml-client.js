import { readFile } from 'fs/promises';

const DEFAULT_TGDL_ML_URL = 'http://100.100.245.3:3800';
const DEFAULT_CLIP_MODEL = 'ViT-B-32__openai';
const DEFAULT_OCR_MODEL = 'PP-OCRv5_mobile';
const DEFAULT_TIMEOUT_MS = 30_000;

function _cleanUrl(url) {
    return String(url || '')
        .trim()
        .replace(/\/+$/, '');
}

export function getTgdlMlUrl() {
    const enabled = String(process.env.TGDL_ML_ENABLED ?? '')
        .trim()
        .toLowerCase();
    if (enabled === 'false' || enabled === '0') return '';

    const explicit = _cleanUrl(process.env.TGDL_ML_URL || '');
    if (explicit) return explicit;

    return DEFAULT_TGDL_ML_URL;
}

export function isTgdlMlEnabled() {
    return !!getTgdlMlUrl();
}

export function getTgdlClipModelName() {
    return String(process.env.TGDL_ML_CLIP_MODEL || DEFAULT_CLIP_MODEL).trim();
}

export function getTgdlOcrModelName() {
    return String(process.env.TGDL_ML_OCR_MODEL || DEFAULT_OCR_MODEL).trim();
}

export function getTgdlEmbeddingModelId() {
    return `tgdl-ml:${getTgdlClipModelName()}`;
}

export function resolveClipModelId(cfg = {}) {
    if (isTgdlMlEnabled()) return getTgdlEmbeddingModelId();
    return (
        String(cfg?.searchModel || '').trim() ||
        String(cfg?.model || '').trim() ||
        String(cfg?.clipModel || '').trim() ||
        'Xenova/clip-vit-base-patch32'
    );
}

function _timeoutMs() {
    const n = Number(process.env.TGDL_ML_TIMEOUT_MS || 0);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

async function _fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), _timeoutMs());
    try {
        return await globalThis.fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function _postJson(endpoint, body) {
    const url = getTgdlMlUrl();
    if (!url) throw new Error('tgdl-ml URL is not configured');

    const res = await _fetchWithTimeout(`${url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }

    if (!res.ok) {
        const message = data?.error || data?.detail || data?.raw || res.statusText;
        throw new Error(`tgdl-ml HTTP ${res.status}: ${message}`);
    }

    return data;
}

export async function mlEmbedImage(absPath) {
    const bytes = await readFile(absPath);
    const data = await _postJson('/embed-image', {
        image_b64: bytes.toString('base64'),
    });

    const embedding = Array.isArray(data.embedding) ? data.embedding.map(Number) : null;
    if (!embedding?.length) throw new Error('tgdl-ml /embed-image response missing embedding');

    return {
        embedding,
        dim: embedding.length,
        model: data.model ? `tgdl-ml:${data.model}` : getTgdlEmbeddingModelId(),
        provider: 'tgdl-ml',
    };
}

export async function mlEmbedText(text, { language } = {}) {
    const body = { text: String(text) };
    if (language) body.language = language;

    const data = await _postJson('/embed-text', body);

    const embedding = Array.isArray(data.embedding) ? data.embedding.map(Number) : null;
    if (!embedding?.length) throw new Error('tgdl-ml /embed-text response missing embedding');

    return {
        embedding,
        dim: embedding.length,
        model: data.model ? `tgdl-ml:${data.model}` : getTgdlEmbeddingModelId(),
        provider: 'tgdl-ml',
    };
}

export async function mlDetect(absPath, opts = {}) {
    const bytes = await readFile(absPath);
    const body = { image_b64: bytes.toString('base64') };
    if (Number.isFinite(Number(opts.minScore))) body.min_score = Number(opts.minScore);
    if (Number.isFinite(Number(opts.minBoxPx))) body.min_box_px = Number(opts.minBoxPx);
    if (Array.isArray(opts.arRange)) body.ar_range = opts.arRange;

    return _postJson('/detect', body);
}

export async function mlDetectBatch(absPaths, opts = {}) {
    const body = { files: absPaths };
    if (Number.isFinite(Number(opts.minScore))) body.min_score = Number(opts.minScore);
    if (Number.isFinite(Number(opts.minBoxPx))) body.min_box_px = Number(opts.minBoxPx);
    if (Array.isArray(opts.arRange)) body.ar_range = opts.arRange;

    return _postJson('/detect/batch', body);
}

export async function mlTag(absPath, opts = {}) {
    const bytes = await readFile(absPath);
    const body = { image_b64: bytes.toString('base64') };
    if (Array.isArray(opts.vocabulary) && opts.vocabulary.length) body.vocabulary = opts.vocabulary;
    if (Number.isFinite(Number(opts.minScore))) body.min_score = Number(opts.minScore);
    if (Number.isFinite(Number(opts.topK))) body.top_k = Number(opts.topK);

    const data = await _postJson('/tag', body);
    return {
        tags: Array.isArray(data.tags) ? data.tags : [],
        model: data.model || null,
    };
}

export async function mlOcr(absPath, opts = {}) {
    const bytes = await readFile(absPath);
    const body = { image_b64: bytes.toString('base64') };

    if (Number.isFinite(Number(opts.minDetectionScore)))
        body.min_detection_score = Number(opts.minDetectionScore);
    if (Number.isFinite(Number(opts.minRecognitionScore)))
        body.min_recognition_score = Number(opts.minRecognitionScore);
    if (Number.isFinite(Number(opts.maxResolution)))
        body.max_resolution = Number(opts.maxResolution);

    const data = await _postJson('/ocr', body);

    const result = data?.result || {};
    return {
        text: typeof result.text === 'string' ? result.text : '',
        language: result.language ?? null,
        confidence: result.confidence ?? null,
        model: `tgdl-ml-ocr:${getTgdlOcrModelName()}`,
        provider: 'tgdl-ml',
        raw: data?.raw,
    };
}
