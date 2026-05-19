import { getDb } from '../db.js';

const CHUNK = 500;

export function markScanDone(downloadId, scanner, now = Date.now()) {
    getDb()
        .prepare(
            `INSERT INTO media_scan_state
                 (download_id, scanner, status, updated_at, completed_at)
             VALUES (?, ?, 'done', ?, ?)
             ON CONFLICT(download_id, scanner) DO UPDATE SET
                 status       = 'done',
                 locked_by    = NULL,
                 locked_at    = NULL,
                 updated_at   = excluded.updated_at,
                 completed_at = excluded.completed_at`,
        )
        .run(Number(downloadId), String(scanner), now, now);
}

export function markScanSkipped(downloadId, scanner, reason = null, now = Date.now()) {
    getDb()
        .prepare(
            `INSERT INTO media_scan_state
                 (download_id, scanner, status, last_error, updated_at, completed_at)
             VALUES (?, ?, 'skipped', ?, ?, ?)
             ON CONFLICT(download_id, scanner) DO UPDATE SET
                 status       = 'skipped',
                 locked_by    = NULL,
                 locked_at    = NULL,
                 last_error   = excluded.last_error,
                 updated_at   = excluded.updated_at,
                 completed_at = excluded.completed_at`,
        )
        .run(Number(downloadId), String(scanner), reason, now, now);
}

export function markScanFailed(downloadId, scanner, error = null, code = null, now = Date.now()) {
    getDb()
        .prepare(
            `INSERT INTO media_scan_state
                 (download_id, scanner, status, attempts, last_error, last_error_code, locked_by, locked_at, updated_at)
             VALUES (?, ?, 'failed', 1, ?, ?, NULL, NULL, ?)
             ON CONFLICT(download_id, scanner) DO UPDATE SET
                 status          = 'failed',
                 attempts        = attempts + 1,
                 locked_by       = NULL,
                 locked_at       = NULL,
                 last_error      = excluded.last_error,
                 last_error_code = excluded.last_error_code,
                 updated_at      = excluded.updated_at`,
        )
        .run(Number(downloadId), String(scanner), error, code, now);
}

/**
 * Remove scan_state rows for the given download IDs so they can be retried.
 * For WD14, callers must also clear the _wd14_scanned_ sentinel from image_tags_wd14.
 */
export function resetScanState(downloadIds, scanner) {
    if (!Array.isArray(downloadIds) || !downloadIds.length) return 0;
    const db = getDb();
    let deleted = 0;
    for (let i = 0; i < downloadIds.length; i += CHUNK) {
        const slice = downloadIds.slice(i, i + CHUNK);
        const ph = slice.map(() => '?').join(',');
        deleted += db
            .prepare(`DELETE FROM media_scan_state WHERE scanner = ? AND download_id IN (${ph})`)
            .run(String(scanner), ...slice).changes;
    }
    return deleted;
}

/**
 * Reset stale 'processing' locks older than maxAgeMs to 'failed'.
 * Call at scan start to unblock rows that were in-flight when the process last crashed.
 */
export function recoverStaleLocks(scanner, maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    return getDb()
        .prepare(
            `UPDATE media_scan_state
                SET status          = 'failed',
                    locked_by       = NULL,
                    locked_at       = NULL,
                    last_error      = 'recovered from stale lock',
                    updated_at      = ?
              WHERE scanner   = ?
                AND locked_by IS NOT NULL
                AND locked_at < ?`,
        )
        .run(now, String(scanner), now - maxAgeMs).changes;
}

export function getScanStateCounts(scanner) {
    const rows = getDb()
        .prepare(
            `SELECT status, COUNT(*) AS n FROM media_scan_state WHERE scanner = ? GROUP BY status`,
        )
        .all(String(scanner));
    const counts = { done: 0, failed: 0, skipped: 0, processing: 0, pending: 0 };
    for (const r of rows) {
        if (r.status in counts) counts[r.status] = Number(r.n) || 0;
    }
    return counts;
}

export function listScanFailures(scanner, { limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    return getDb()
        .prepare(
            `SELECT ss.download_id, ss.scanner, ss.attempts, ss.last_error, ss.last_error_code, ss.updated_at,
                    d.file_name, d.file_path, d.file_type
               FROM media_scan_state ss
               LEFT JOIN downloads d ON d.id = ss.download_id
              WHERE ss.scanner = ?
                AND ss.status  = 'failed'
              ORDER BY ss.updated_at DESC
              LIMIT ?`,
        )
        .all(String(scanner), lim);
}
