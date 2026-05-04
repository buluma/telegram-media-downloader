/**
 * AI model registry + lazy loader.
 *
 * Every AI capability (embeddings / faces / tags / phash) goes through this
 * module to obtain its model handle. Two reasons:
 *
 *   1. **Cross-platform**. The classifier path inherits NSFW's hard-won
 *      Transformers.js / WASM tuning: env.cacheDir override (so weights
 *      land in the project's data/ tree and survive `docker compose down`),
 *      single-thread WASM (works without SharedArrayBuffer), and a defensive
 *      `import('@huggingface/transformers').catch(...)` guard so a Linux/musl
 *      install that lacks the optional native ORT prebuilt fails CLEAN at
 *      scan-time instead of crashing the web process at module-eval.
 *
 *   2. **Cache discipline**. Each model is loaded ONCE per process —
 *      subsequent requests reuse the same pipeline handle. Pulling a 90 MB
 *      CLIP weight every search would obviously be silly; less obviously,
 *      Transformers.js initialises a WASM heap on first use and a second
 *      `pipeline()` call leaks the first heap until the process exits.
 *
 * Default install pulls ZERO model weights — every model is requested on
 * first use of its capability. A fresh container that never touches the AI
 * subsystem boots and serves traffic without downloading anything.
 */

import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `src/core/ai/` -> repo root is three levels up.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Operators can override the on-disk model location through env. Path is
// resolved relative to the repo root if it isn't absolute, so the same value
// works on Windows / macOS / Linux / Docker without quoting headaches.
function _defaultModelsDir() {
    const env = process.env.AI_MODELS_DIR;
    if (env && env.trim()) {
        return path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env);
    }
    return path.resolve(PROJECT_ROOT, 'data', 'models');
}

// `kind` ∈ { 'image-classification', 'image-feature-extraction',
//            'zero-shot-image-classification', 'object-detection', ... }.
// Keyed on `kind:modelId` so two capabilities asking for the same model id
// with different pipeline kinds (e.g. CLIP for image vs text) each get
// their own cached handle.
const _pipelinePromises = new Map();

/**
 * Resolve the absolute models cache directory for a capability config.
 * Honors per-capability `cacheDir` overrides; otherwise falls back to the
 * `AI_MODELS_DIR` env var or `data/models`.
 */
export function resolveCacheDir(cacheDirCfg) {
    if (cacheDirCfg && String(cacheDirCfg).trim()) {
        const raw = String(cacheDirCfg);
        return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
    }
    return _defaultModelsDir();
}

async function _ensureCacheDir(absDir) {
    if (!existsSync(absDir)) {
        await fs.mkdir(absDir, { recursive: true });
    }
}

async function _importTransformers() {
    try {
        return await import('@huggingface/transformers');
    } catch (e) {
        const err = new Error(
            `Failed to load @huggingface/transformers: ${e?.message || e}. `
            + 'Install with `npm install @huggingface/transformers` to enable AI features.'
        );
        err.code = 'AI_LIB_MISSING';
        throw err;
    }
}

/**
 * Configure the Transformers.js env once per import. Idempotent — reads /
 * sets fields that are safe to overwrite repeatedly.
 */
function _configureEnv(env, cacheDirAbs) {
    try { env.cacheDir = cacheDirAbs; } catch { /* noop */ }
    // Force WASM execution on Node — see nsfw.js for the full rationale
    // (musl/glibc + onnxruntime-node prebuilt mess).
    try {
        if (env?.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.numThreads = 1;
        }
    } catch { /* noop */ }
}

/**
 * Lazy-load a Transformers.js pipeline. Cached per (kind, modelId).
 *
 * @param {object} opts
 * @param {string} opts.kind                 Pipeline kind ('image-classification', etc.)
 * @param {string} opts.modelId              HF model id ('Xenova/clip-vit-base-patch32')
 * @param {string} [opts.cacheDir]           Override AI_MODELS_DIR for this load.
 * @param {(p:object) => void} [opts.onProgress]  Progress callback for download.
 * @param {(entry:object) => void} [opts.onLog]   Structured log sink.
 * @returns {Promise<Function>}              The pipeline handle.
 */
export async function getPipeline({ kind, modelId, cacheDir, onProgress, onLog } = {}) {
    if (!kind) throw new Error('getPipeline: kind is required');
    if (!modelId) throw new Error('getPipeline: modelId is required');
    const _log = (level, msg) => {
        try { if (typeof onLog === 'function') onLog({ source: 'ai', level, msg }); }
        catch { /* swallow */ }
    };

    const key = `${kind}::${modelId}`;
    let promise = _pipelinePromises.get(key);
    if (promise) return promise;

    promise = (async () => {
        const cacheDirAbs = resolveCacheDir(cacheDir);
        await _ensureCacheDir(cacheDirAbs);
        _log('info', `loading ${kind} pipeline — model=${modelId} cacheDir=${cacheDirAbs}`);

        const mod = await _importTransformers();
        const { pipeline, env } = mod;
        _configureEnv(env, cacheDirAbs);

        return pipeline(kind, modelId, {
            progress_callback: (p) => {
                try { if (typeof onProgress === 'function') onProgress(p); }
                catch { /* progress callbacks must never crash the loader */ }
            },
        });
    })().catch((e) => {
        // Reset so the next caller retries the load instead of inheriting
        // the rejected promise forever.
        _pipelinePromises.delete(key);
        throw e;
    });

    _pipelinePromises.set(key, promise);
    return promise;
}

/**
 * Best-effort dispose of every cached pipeline. Wired into the graceful-
 * shutdown path so the process can release WASM heap before exit.
 */
export async function disposeAll() {
    const handles = [..._pipelinePromises.values()];
    _pipelinePromises.clear();
    for (const p of handles) {
        try {
            const cls = await p;
            if (cls && typeof cls.dispose === 'function') await cls.dispose();
        } catch { /* best-effort */ }
    }
}

/**
 * Snapshot of which pipelines are currently loaded — feeds the /api/ai/status
 * endpoint so the UI can show "model ready" badges without forcing a load.
 */
export function loadedPipelines() {
    return [..._pipelinePromises.keys()];
}

export const AI_MODEL_DEFAULTS = Object.freeze({
    embeddings: {
        kind: 'image-feature-extraction',
        modelId: 'Xenova/clip-vit-base-patch32',
        textKind: 'feature-extraction',  // text encoder uses the text head
        dim: 512,
    },
    faces: {
        kind: 'object-detection',
        modelId: 'Xenova/yolov5n-face',  // tiny — ~5 MB
        // Face embedding model — used if face_recognition is enabled. Omitted
        // by default; the v2.6 "people" feature relies on bbox-only clustering
        // when the embedding model is unavailable, which is far less accurate
        // but at least functional.
    },
    tags: {
        kind: 'image-classification',
        modelId: 'Xenova/mobilenet_v2',
        topK: 5,
    },
});
