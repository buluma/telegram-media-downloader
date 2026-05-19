/**
 * Durable job model for AI maintenance scans.
 *
 * Each long-running scan (faces, tags, ocr, objects, wd14) creates a
 * `maintenance_jobs` row that persists across restarts. The in-memory
 * `_scans` map in scan-runner.js still tracks the current run; this
 * module provides the DB-backed record so the UI can show job history
 * and resume tracking after a server restart.
 */

import { getDb } from '../db.js';
import crypto from 'crypto';

/**
 * Create a new job record and return the job ID.
 *
 * @param {object} opts
 * @param {string} opts.type      Job type key (e.g. 'scan', 'recluster')
 * @param {string} opts.feature   Feature name (faces, tags, ocr, objects, wd14)
 * @param {object} [opts.params]  Arbitrary JSON-serialisable params
 * @param {string} [opts.requestedBy]  Who requested the job (e.g. 'admin')
 * @param {number} [opts.total]   Total items to process
 * @returns {string} jobId
 */
export function createJob({ type, feature, params, requestedBy, total } = {}) {
    const db = getDb();
    const jobId = `${feature}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    db.prepare(`
        INSERT INTO maintenance_jobs (id, type, feature, status, request_json, requested_by, total, started_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
        jobId,
        type || 'scan',
        feature,
        params ? JSON.stringify(params) : null,
        requestedBy || 'system',
        total || 0,
        now,
    );
    return jobId;
}

/**
 * Update a job's progress counters.
 */
export function updateJobProgress(jobId, { processed, skipped, failed, error } = {}) {
    if (!jobId) return;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get(jobId);
    if (!existing) return;
    db.prepare(`
        UPDATE maintenance_jobs
        SET processed = ?, skipped = ?, failed = ?,
            error = COALESCE(?, error),
            finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
        WHERE id = ?
    `).run(
        processed ?? existing.processed,
        skipped ?? existing.skipped,
        failed ?? existing.failed,
        error ?? null,
        error ? 1 : 0,
        error ? Date.now() : 0,
        jobId,
    );
}

/**
 * Mark a job as finished (completed, cancelled, or failed).
 */
export function finishJob(jobId, status, error = null) {
    if (!jobId) return;
    const db = getDb();
    const now = Date.now();
    db.prepare(`
        UPDATE maintenance_jobs
        SET status = ?, error = COALESCE(?, error), finished_at = COALESCE(finished_at, ?)
        WHERE id = ?
    `).run(status || 'completed', error, now, jobId);
}

/**
 * List recent jobs, ordered by most recent first.
 */
export function listJobs({ feature, status, limit = 50, offset = 0 } = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (feature) {
        conditions.push('feature = ?');
        params.push(feature);
    }
    if (status) {
        conditions.push('status = ?');
        params.push(status);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = db
        .prepare(`
        SELECT * FROM maintenance_jobs ${where}
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?
    `)
        .all(
            ...params,
            Math.min(500, Math.max(1, Number(limit) || 50)),
            Math.max(0, Number(offset) || 0),
        );
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM maintenance_jobs ${where}`)
        .get(...params).n;
    return { jobs: rows, total };
}

/**
 * Get a single job by ID.
 */
export function getJob(jobId) {
    if (!jobId) return null;
    return getDb().prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get(jobId) || null;
}

/**
 * Cancel a running job (marks as cancelled).
 */
export function cancelJob(jobId) {
    finishJob(jobId, 'cancelled');
}

/**
 * Clean up old jobs, keeping the most recent N per feature.
 */
export function pruneJobs(keepPerFeature = 50) {
    const db = getDb();
    const features = db
        .prepare('SELECT DISTINCT feature FROM maintenance_jobs WHERE feature IS NOT NULL')
        .all();
    let pruned = 0;
    for (const { feature } of features) {
        const ids = db
            .prepare(`
            SELECT id FROM maintenance_jobs
            WHERE feature = ?
            ORDER BY started_at DESC
            LIMIT -1 OFFSET ?
        `)
            .all(feature, Math.max(1, Number(keepPerFeature) || 50));
        if (ids.length) {
            const placeholders = ids.map(() => '?').join(',');
            const r = db
                .prepare(`DELETE FROM maintenance_jobs WHERE id IN (${placeholders})`)
                .run(...ids.map((r) => r.id));
            pruned += r.changes;
        }
    }
    return pruned;
}

// ---- Stale job recovery --------------------------------------------------

/**
 * Reset stale maintenance_jobs and media_scan_state rows at startup.
 *
 * Faces and OCR scans that crash mid-batch leave `processing` rows in
 * media_scan_state and `running` rows in maintenance_jobs indefinitely —
 * blocking retries and polluting the job history UI. Call once at server
 * startup (after initDb) to recover all scanners generically.
 *
 * @param {import('better-sqlite3').Database} [dbArg] - optional, defaults to getDb()
 * @param {object} [opts]
 * @param {number} [opts.staleAfterMs=1800000] - rows locked longer than this are stale (default 30 min)
 */
export function recoverStaleJobs(dbArg, { staleAfterMs = 30 * 60 * 1000 } = {}) {
    const db = dbArg || getDb();
    const cutoff = Date.now() - staleAfterMs;
    const now = Date.now();

    const jobs = db
        .prepare(
            `UPDATE maintenance_jobs
             SET status = 'failed', error = 'recovered: stale at startup', finished_at = ?
             WHERE status = 'running' AND started_at < ?`,
        )
        .run(now, cutoff);

    const locks = db
        .prepare(
            `UPDATE media_scan_state
             SET status = 'failed', last_error = 'recovered: stale lock at startup', updated_at = ?
             WHERE status = 'processing' AND updated_at < ?`,
        )
        .run(now, cutoff);

    if (jobs.changes > 0 || locks.changes > 0) {
        // eslint-disable-next-line no-console
        console.log(
            `[recovery] reset ${jobs.changes} stale jobs, ${locks.changes} stale scan locks`,
        );
    }

    return { jobs: jobs.changes, locks: locks.changes };
}

// ---- Media scan state ----------------------------------------------------

/**
 * Upsert a row in media_scan_state.
 */
export function upsertScanState(downloadId, scanner, { status, attempts, error, errorCode } = {}) {
    const db = getDb();
    const now = Date.now();
    const existing = db
        .prepare('SELECT * FROM media_scan_state WHERE download_id = ? AND scanner = ?')
        .get(downloadId, scanner);
    if (existing) {
        db.prepare(`
            UPDATE media_scan_state
            SET status = COALESCE(?, status),
                attempts = COALESCE(?, attempts + 1),
                last_error = COALESCE(?, last_error),
                last_error_code = COALESCE(?, last_error_code),
                locked_by = NULL,
                locked_at = NULL,
                updated_at = ?,
                completed_at = CASE WHEN ? = 'completed' OR ? = 'failed' THEN COALESCE(completed_at, ?) ELSE completed_at END
            WHERE download_id = ? AND scanner = ?
        `).run(
            status,
            attempts !== undefined ? attempts : null,
            error,
            errorCode,
            now,
            status,
            status,
            now,
            downloadId,
            scanner,
        );
    } else {
        db.prepare(`
            INSERT INTO media_scan_state (download_id, scanner, status, attempts, last_error, last_error_code, updated_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            downloadId,
            scanner,
            status || 'pending',
            attempts ?? 1,
            error || null,
            errorCode || null,
            now,
            status === 'completed' || status === 'failed' ? now : null,
        );
    }
}

/**
 * Mark a download as locked for processing by a scanner.
 */
export function lockScanItem(downloadId, scanner, lockId) {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
        INSERT INTO media_scan_state (download_id, scanner, status, locked_by, locked_at, updated_at)
        VALUES (?, ?, 'processing', ?, ?, ?)
        ON CONFLICT(download_id, scanner) DO UPDATE SET
            status = 'processing',
            locked_by = excluded.locked_by,
            locked_at = excluded.locked_at,
            updated_at = excluded.updated_at
    `).run(downloadId, scanner, lockId, now, now);
}

/**
 * Release a lock (mark as completed or return to pending).
 */
export function unlockScanItem(downloadId, scanner, { status, error, errorCode } = {}) {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
        UPDATE media_scan_state
        SET status = ?,
            locked_by = NULL,
            locked_at = NULL,
            last_error = COALESCE(?, last_error),
            last_error_code = COALESCE(?, last_error_code),
            attempts = attempts + 1,
            updated_at = ?,
            completed_at = CASE WHEN ? = 'completed' OR ? = 'failed' THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE download_id = ? AND scanner = ?
    `).run(status || 'completed', error, errorCode, now, status, status, now, downloadId, scanner);
}

/**
 * Find stale locks — items locked longer than `maxAgeMs` ago.
 */
export function findStaleLocks(scanner, maxAgeMs = 300_000) {
    const db = getDb();
    const cutoff = Date.now() - maxAgeMs;
    if (scanner) {
        return db
            .prepare(`
            SELECT * FROM media_scan_state
            WHERE scanner = ? AND locked_by IS NOT NULL AND locked_at < ?
            ORDER BY locked_at ASC
        `)
            .all(scanner, cutoff);
    }
    return db
        .prepare(`
        SELECT * FROM media_scan_state
        WHERE locked_by IS NOT NULL AND locked_at < ?
        ORDER BY locked_at ASC
    `)
        .all(cutoff);
}

/**
 * Release all stale locks for a scanner, returning them to 'pending'.
 * Returns the number of locks released.
 */
export function releaseStaleLocks(scanner, maxAgeMs = 300_000) {
    const stale = findStaleLocks(scanner, maxAgeMs);
    if (!stale.length) return 0;
    const db = getDb();
    const now = Date.now();
    let count = 0;
    for (const row of stale) {
        db.prepare(`
            UPDATE media_scan_state
            SET status = 'pending',
                locked_by = NULL,
                locked_at = NULL,
                attempts = attempts + 1,
                last_error = 'stale_lock',
                updated_at = ?
            WHERE download_id = ? AND scanner = ?
        `).run(now, row.download_id, row.scanner);
        count++;
    }
    return count;
}

/**
 * Get scan state summary for a scanner: counts by status.
 */
export function getScanStateSummary(scanner) {
    const db = getDb();
    const rows = db
        .prepare(`
        SELECT status, COUNT(*) AS count
        FROM media_scan_state
        WHERE scanner = ?
        GROUP BY status
    `)
        .all(scanner);
    const summary = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    for (const r of rows) {
        if (r.status === 'completed') summary.completed = r.count;
        else if (r.status === 'failed') summary.failed = r.count;
        else if (r.status === 'processing') summary.processing = r.count;
        else summary.pending = r.count;
    }
    summary.total = summary.pending + summary.processing + summary.completed + summary.failed;
    return summary;
}
