/**
 * Deferred file deletion.
 *
 * Instead of blocking the event loop on fs.unlink, media files are renamed
 * instantly into data/downloads/.deleted/<uuid>. A background drain loop
 * walks that directory and frees the disk space asynchronously. Boot recovery
 * handles files left behind by a previous crash.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DELETED_DIR = path.resolve(__dirname, '../../data/downloads/.deleted');

let _draining = false;
let _drainTimer = null;

/**
 * Rename filePath into .deleted/ immediately (non-blocking), then return.
 * If rename fails (cross-device, permission), falls back to direct unlink.
 */
export async function deferDelete(filePath) {
    if (!filePath) return;
    try {
        await fs.mkdir(DELETED_DIR, { recursive: true });
        await fs.rename(filePath, path.join(DELETED_DIR, randomUUID()));
    } catch (e) {
        if (e.code === 'ENOENT') return; // file already gone — not an error
        // Cross-device or permission failure: fall back to direct unlink.
        try {
            await fs.unlink(filePath);
        } catch (e2) {
            if (e2.code !== 'ENOENT') {
                logger.warn(
                    { file: filePath, err: e2.message },
                    '[delete-queue] fallback unlink failed',
                );
            }
        }
    }
}

/**
 * Walk .deleted/ and unlink every file. Idempotent; safe to call concurrently
 * (second call is a no-op while drain is in progress).
 */
export async function drainDeleteQueue() {
    if (_draining) return;
    _draining = true;
    try {
        let entries;
        try {
            entries = await fs.readdir(DELETED_DIR);
        } catch {
            return; // directory doesn't exist yet — nothing to drain
        }
        for (const entry of entries) {
            await fs.unlink(path.join(DELETED_DIR, entry)).catch(() => {});
        }
    } finally {
        _draining = false;
    }
}

/**
 * Start the background drain loop. Call once on server boot.
 * Runs an initial drain immediately (crash recovery), then on interval.
 */
export function startDrain(intervalMs = 30_000) {
    if (_drainTimer) return; // already started
    drainDeleteQueue().catch(() => {});
    _drainTimer = setInterval(() => drainDeleteQueue().catch(() => {}), intervalMs);
    _drainTimer.unref?.();
    logger.info('[delete-queue] drain loop started');
}

export function stopDrain() {
    if (_drainTimer) {
        clearInterval(_drainTimer);
        _drainTimer = null;
    }
}
