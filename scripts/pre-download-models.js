#!/usr/bin/env node
/**
 * Build-time helper: pre-download the default NSFW model artifacts into
 * `data/models` so first-run scans avoid a cold model fetch.
 *
 * Runs during `docker build` via:
 *   RUN node scripts/pre-download-models.js || true
 *
 * Kept resilient by design:
 * - If transformers is absent, skip.
 * - If download fails (offline/blocked), exit non-zero; Dockerfile already
 *   wraps this with `|| true`, so image builds still succeed.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(PROJECT_ROOT, 'data', 'models');

const MODEL_ID = process.env.TGDL_NSFW_PREWARM_MODEL || 'AdamCodd/vit-base-nsfw-detector';
const DTYPE = process.env.TGDL_NSFW_PREWARM_DTYPE || 'q8';

async function main() {
    await fsp.mkdir(CACHE_DIR, { recursive: true });

    let mod;
    try {
        mod = await import('@huggingface/transformers');
    } catch (e) {
        console.log('[pre-download-models] skipping — @huggingface/transformers not installed');
        return;
    }

    const { env, pipeline } = mod;
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    env.cacheDir = CACHE_DIR;

    console.log(
        `[pre-download-models] warming model=${MODEL_ID} dtype=${DTYPE} cacheDir=${CACHE_DIR}`,
    );

    const cls = await pipeline('image-classification', MODEL_ID, {
        dtype: DTYPE,
        cache_dir: CACHE_DIR,
    });

    // Trigger first inference once so model files are actually materialized.
    await cls('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
    console.log('[pre-download-models] complete');
}

main().catch((e) => {
    console.error('[pre-download-models] failed:', e?.message || e);
    process.exit(1);
});
