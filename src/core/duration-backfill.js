/**
 * Video duration backfill.
 *
 * `downloads.duration_sec` (migration 027) is only filled for files
 * downloaded after it landed; older rows have NULL until the seekbar
 * sprite generator happens to visit them (opt-in). The "Longest first"
 * sort orders by COALESCE(seekbar duration, downloads.duration_sec), so
 * every un-probed video would sink to the end of the list.
 *
 * This sweep runs `ffprobe` over every video that has neither value and
 * writes the result to `downloads.duration_sec`. Rows whose file is
 * missing or unprobeable stay NULL and are simply retried next run.
 *
 * Caller integration:
 *   - `backfillDurations({ onProgress, signal })` — Maintenance sweep.
 *   - `getDurationStats()` — counts for the Maintenance UI.
 */

import { getDb } from './db.js';
import { hasFfmpeg, probeDuration } from './clip.js';
import { safeResolveDownload } from '../web/lib/resolve-download.js';

// Rows that still need a duration: a catalogued video file with no value
// in either source the gallery reads.
const PENDING_WHERE = `
    d.file_type = 'video' AND d.file_path IS NOT NULL
    AND d.duration_sec IS NULL
    AND NOT EXISTS (
        SELECT 1 FROM seekbar_sprites ss
         WHERE ss.download_id = d.id AND ss.duration_sec IS NOT NULL
    )
`;

const PAGE_SIZE = 50;
// ffprobe reads only the container header, so a few in flight is cheap.
const CONCURRENCY = 4;

export function getDurationStats() {
    const db = getDb();
    const total = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads d WHERE d.file_type = 'video' AND d.file_path IS NOT NULL`,
        )
        .get().n;
    const pending = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads d WHERE ${PENDING_WHERE}`)
        .get().n;
    return { total, pending, known: total - pending, ffmpegAvailable: hasFfmpeg() };
}

async function _probeRow(row) {
    const sr = await safeResolveDownload(row.file_path);
    if (!sr.ok) return 'missing';
    const sec = await probeDuration(sr.real);
    // A zero/negative duration is a probe artefact, not a real length —
    // leave the row NULL rather than pin it to the bottom as "0".
    if (sec === null || sec <= 0) return 'failed';
    getDb().prepare('UPDATE downloads SET duration_sec = ? WHERE id = ?').run(sec, row.id);
    return 'updated';
}

export async function backfillDurations(opts = {}) {
    const { onProgress, signal } = opts;
    if (!hasFfmpeg()) throw new Error('ffprobe not available');
    const db = getDb();
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads d WHERE ${PENDING_WHERE}`)
        .get().n;
    // Keyset-paginated `.all()` (not `.iterate()`): the awaits below would
    // otherwise hold a cursor open and block every concurrent DB writer.
    const pageStmt = db.prepare(
        `SELECT d.id, d.file_path FROM downloads d
          WHERE ${PENDING_WHERE} AND d.id < ?
          ORDER BY d.id DESC LIMIT ?`,
    );
    const counts = { processed: 0, updated: 0, missing: 0, failed: 0 };
    const tick = (stage) => onProgress?.({ stage, total, ...counts });
    tick('probing');

    let beforeId = Number.MAX_SAFE_INTEGER;
    while (!signal?.aborted) {
        const page = pageStmt.all(beforeId, PAGE_SIZE);
        if (!page.length) break;
        for (let i = 0; i < page.length && !signal?.aborted; i += CONCURRENCY) {
            const results = await Promise.all(
                page.slice(i, i + CONCURRENCY).map((row) => _probeRow(row).catch(() => 'failed')),
            );
            for (const r of results) {
                counts.processed++;
                counts[r]++;
            }
            tick('probing');
        }
        beforeId = Number(page[page.length - 1].id);
        await new Promise((r) => setImmediate(r));
    }

    tick('done');
    return { total, ...counts, cancelled: !!signal?.aborted };
}
