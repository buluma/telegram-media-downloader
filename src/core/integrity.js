// Periodic + boot-time integrity sweep over the downloads DB.
//
// Goal: after a crash, a manual delete, an auto-rotator pass, or any
// event that leaves the DB referencing a path that no longer exists on
// disk, the gallery should self-heal — no manual SQL, no SSH. We walk
// every row, stat the file at row.file_path (relative to DOWNLOADS_DIR),
// and delete the row if the file is missing or zero bytes.
//
// Counterpart guards already in place:
//   - downloader.js verifies file size after every fs.rename
//   - server.js auto-prunes a single 404 served from /files
// This module is the catch-all that runs without a request to trigger it.

import fs from 'fs/promises';
import path from 'path';

const ts = () => new Date().toISOString();
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, '../../data/downloads');

let _running = false;
let _timer = null;
let _broadcast = () => {};

// Cached batch size, refreshed from config on each start() call.
let _batchSize = 64;

/**
 * Walk every row, stat each file, drop rows where the file is missing
 * or zero-bytes. Returns `{ scanned, pruned }`. Concurrency-guarded —
 * a second call while the first is in-flight is a no-op.
 */
export async function sweep() {
    if (_running) return { scanned: 0, pruned: 0, skipped: true };
    _running = true;
    const result = { scanned: 0, pruned: 0 };
    try {
        // Pull file_size too so we can repair NULL / 0 sizes from old
        // downloader versions that didn't always stat the file before
        // INSERT — that's the source of the "Disk: 1 MB for 8000 files"
        // status-bar nonsense the user kept seeing.
        const rows = getDb().prepare(
            `SELECT id, file_path, file_name, group_id, file_size FROM downloads WHERE file_path IS NOT NULL`
        ).all();
        result.scanned = rows.length;

        // Limit concurrency so a 100k-row DB doesn't fork 100k stat() calls.
        // Tunable via config.advanced.integrity.batchSize (read at start()).
        const BATCH = Math.max(1, _batchSize | 0) || 64;
        const deleteIds = [];
        // [{id, size}, ...] — rows whose actual on-disk size differs from
        // the stored value (or whose stored value is null/0). Backfilled
        // in one transaction at the end.
        const sizeFixes = [];
        for (let i = 0; i < rows.length; i += BATCH) {
            const slice = rows.slice(i, i + BATCH);
            const checks = await Promise.all(slice.map(async (r) => {
                let rel = String(r.file_path || '').replace(/\\/g, '/');
                if (!rel) return null;
                // Tolerate the legacy `data/downloads/` prefix that some
                // older rows still carry — same fix that
                // safeResolveDownload() does in the request path.
                while (rel.startsWith('data/downloads/')) rel = rel.slice('data/downloads/'.length);
                // Defence-in-depth: refuse to stat anything that walks outside
                // DOWNLOADS_DIR. Rows with bogus paths get pruned.
                if (rel.includes('..') || path.isAbsolute(rel)) return r.id;
                const abs = path.join(DOWNLOADS_DIR, rel);
                try {
                    const st = await fs.stat(abs);
                    if (st.size <= 0) return r.id;
                    // Backfill or correct the stored file_size if it's
                    // null / 0 / wrong. Tolerance > 0 for the rare case
                    // an editor / re-encode legitimately changed bytes.
                    const stored = Number(r.file_size) || 0;
                    if (stored !== st.size) sizeFixes.push({ id: r.id, size: st.size });
                    return null;
                } catch {
                    return r.id;
                }
            }));
            for (const id of checks) if (id) deleteIds.push(id);
        }

        if (sizeFixes.length) {
            const upd = getDb().prepare('UPDATE downloads SET file_size = ? WHERE id = ?');
            const tx = getDb().transaction((items) => {
                for (const it of items) upd.run(it.size, it.id);
            });
            tx(sizeFixes);
            result.sizeFixed = sizeFixes.length;
        }

        if (deleteIds.length) {
            const stmt = getDb().prepare(
                `DELETE FROM downloads WHERE id IN (${deleteIds.map(() => '?').join(',')})`
            );
            const r = stmt.run(...deleteIds);
            result.pruned = r.changes;
            try { _broadcast({ type: 'integrity_swept', pruned: result.pruned, scanned: result.scanned }); } catch {}
        }
    } finally {
        _running = false;
    }
    return result;
}

/**
 * Schedule the sweep on boot (after a small delay so the server has time
 * to finish its other startup tasks) and then every `intervalMin`
 * minutes thereafter. Idempotent — safe to call multiple times.
 *
 * `batchSize` is also accepted to override stat() concurrency per pass
 * (keeps the consumer-reads-config pattern in server.js consistent).
 */
export function start({ broadcast, intervalMin = 60, batchSize = 64 } = {}) {
    if (broadcast) _broadcast = broadcast;
    if (Number.isFinite(batchSize) && batchSize > 0) _batchSize = Math.floor(batchSize);
    if (_timer) clearInterval(_timer);
    setTimeout(() => {
        sweep().then(({ scanned, pruned }) => {
            if (pruned > 0) {
                console.log(`${ts()} [integrity] boot sweep — pruned ${pruned} dead rows out of ${scanned}`);
            }
        }).catch((e) => console.warn(`${ts()} [integrity] boot sweep failed:`, e.message));
    }, 30 * 1000);
    _timer = setInterval(() => {
        sweep().then(({ scanned, pruned }) => {
            if (pruned > 0) {
                console.log(`[integrity] periodic sweep — pruned ${pruned} dead rows out of ${scanned}`);
            }
        }).catch(() => {});
    }, Math.max(60, intervalMin) * 60 * 1000);
    _timer.unref?.();
}

export function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}
