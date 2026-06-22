/**
 * Deferred file deletion.
 *
 * Instead of blocking the event loop on fs.unlink, media files are renamed
 * instantly into data/downloads/.deleted/<uuid>. A background drain loop
 * walks that directory and frees the disk space asynchronously. Boot recovery
 * handles files left behind by a previous crash.
 *
 * The drain loop also sweeps orphaned .part files (incomplete downloads left
 * behind by crashes). Only files older than STALE_PART_MS are removed so
 * in-progress downloads are never interrupted.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DELETED_DIR = path.resolve(__dirname, '../../data/downloads/.deleted');
const DOWNLOADS_DIR = path.resolve(__dirname, '../../data/downloads');

// .part files younger than this are assumed to belong to an active download.
const STALE_PART_MS = 60 * 60 * 1000; // 1 hour
const PART_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // sweep .part files every 10 min

let _draining = false;
let _drainTimer = null;
let _partSweepTimer = null;

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
 * Recursively find and delete .part files under dir that are older than
 * STALE_PART_MS. Skips the .deleted staging directory entirely.
 */
async function sweepStaleParts(dir, cutoff) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== '.deleted') await sweepStaleParts(full, cutoff);
        } else if (entry.name.endsWith('.part')) {
            try {
                const stat = await fs.stat(full);
                if (stat.mtimeMs < cutoff) {
                    await fs.unlink(full);
                    logger.info({ file: full }, '[delete-queue] removed stale .part file');
                }
            } catch {
                // file already gone or stat failed — not an error
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
            await fs.unlink(path.join(DELETED_DIR, entry)).catch((e) => {
                if (e?.code !== 'ENOENT') {
                    logger.warn(
                        { file: entry, err: e?.message },
                        '[delete-queue] drain unlink failed — file leaked on disk',
                    );
                }
            });
        }
    } finally {
        _draining = false;
    }
}

/**
 * Start the background drain loop. Call once on server boot.
 * Runs an initial drain immediately (crash recovery), then on interval.
 * A separate slower timer sweeps orphaned .part files.
 */
export function startDrain(intervalMs = 30_000) {
    if (_drainTimer) return; // already started
    drainDeleteQueue().catch(() => {});
    _drainTimer = setInterval(() => drainDeleteQueue().catch(() => {}), intervalMs);
    _drainTimer.unref?.();

    // .part sweep runs once shortly after boot (crash recovery) then every
    // PART_SWEEP_INTERVAL_MS — decoupled from the fast .deleted/ drain so a
    // large library doesn't get a recursive tree walk every 30 seconds.
    const initialPartSweep = setTimeout(
        () => sweepStaleParts(DOWNLOADS_DIR, Date.now() - STALE_PART_MS).catch(() => {}),
        60_000,
    );
    initialPartSweep.unref?.();
    _partSweepTimer = setInterval(
        () => sweepStaleParts(DOWNLOADS_DIR, Date.now() - STALE_PART_MS).catch(() => {}),
        PART_SWEEP_INTERVAL_MS,
    );
    _partSweepTimer.unref?.();

    logger.info('[delete-queue] drain loop started');
}

export function stopDrain() {
    if (_drainTimer) {
        clearInterval(_drainTimer);
        _drainTimer = null;
    }
    if (_partSweepTimer) {
        clearInterval(_partSweepTimer);
        _partSweepTimer = null;
    }
}
