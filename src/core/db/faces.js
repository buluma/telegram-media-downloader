import { getDb } from '../db.js';

// ---- NSFW review (Phase 1: photos only) -----------------------------------
//
// IMPORTANT — semantic note on this whole subsystem:
//
// The library is a curated 18+ collection. The classifier's job is to find
// photos that are NOT 18+ (mistakes that snuck in via auto-download) so the
// admin can purge them. So:
//
//   nsfw_score                          = classifier's "is this 18+" score (0-1)
//   nsfw_score >= threshold             = KEEP (it really is 18+)
//   nsfw_score <  threshold             = DELETE CANDIDATE (likely not 18+)
//   nsfw_whitelist = 1                  = admin manually approved as "really IS 18+, do not surface again"
//
// Don't mix this up — the review sheet and `candidates` count surface
// the LOW-score rows, not the high ones.

/**
 * Headline counts for the Maintenance "Scan images for NSFW" status line.
 *
 * @param {string[]} fileTypes  Telegram file_type values to count over
 *                              (`['photo']` for Phase 1).
 * @param {number}   threshold  Score >= this is treated as 18+ (keep);
 *                              < this is treated as deletion-candidate.
 * @returns {{ totalEligible:number, scanned:number, candidates:number,
 *             keep:number, whitelisted:number, lastCheckedAt:number|null }}
 */
export function getNsfwStats(fileTypes, threshold) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders})`)
        .get(...types).n;
    const scanned = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders}) AND nsfw_checked_at IS NOT NULL`,
        )
        .get(...types).n;
    // candidates = LOW-score rows (likely not 18+) — what the admin reviews.
    const candidates = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0`,
        )
        .get(...types, Number(threshold)).n;
    // keep = HIGH-score rows (likely 18+) — the curated content stays put.
    const keep = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score >= ?`,
        )
        .get(...types, Number(threshold)).n;
    const whitelisted = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE nsfw_whitelist = 1`)
        .get().n;
    const lastCheckedAt = db
        .prepare(
            `SELECT MAX(nsfw_checked_at) AS t FROM downloads WHERE file_type IN (${placeholders})`,
        )
        .get(...types).t;
    return { totalEligible: total, scanned, candidates, keep, whitelisted, lastCheckedAt };
}

/**
 * Pull a batch of rows that haven't been classified yet. Whitelisted rows
 * are skipped — admin already approved them. Sorted oldest-first so the
 * resume-after-restart path picks up backlog rather than newly-arrived
 * downloads.
 */
export function getUnscannedNsfwBatch(fileTypes, limit = 50) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_checked_at IS NULL
           AND nsfw_whitelist = 0
         ORDER BY created_at ASC
         LIMIT ?
    `)
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

/**
 * Persist a classification result. `score` may be NULL when the file
 * couldn't be read (missing on disk, decode failure) — we still set
 * `nsfw_checked_at` so the scan loop doesn't keep retrying the same
 * unreadable row forever.
 */
export function setNsfwResult(id, score, now = Date.now()) {
    const s = score == null ? null : Math.max(0, Math.min(1, Number(score)));
    return getDb()
        .prepare(`
        UPDATE downloads
           SET nsfw_score = ?, nsfw_checked_at = ?
         WHERE id = ?
    `)
        .run(s, Math.floor(now), Number(id)).changes;
}

/**
 * Deletion-candidate rows for the review sheet. Returns photos with a
 * LOW NSFW score (i.e. classifier thinks they're NOT 18+), which is
 * exactly what the admin wants to purge from a curated 18+ library.
 *
 * Excludes whitelisted rows (admin already confirmed they really are
 * 18+ despite the low score — false negative override). Sorted by
 * score ASC so the "most clearly not 18+" rows surface first.
 *
 * @returns {{ rows: object[], total: number, page: number, totalPages: number }}
 */
export function getNsfwDeleteCandidates({ fileTypes, threshold, page = 1, limit = 50 }) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const t = Number(threshold);
    const p = Math.max(1, Number(page) || 1);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const offset = (p - 1) * lim;
    const db = getDb();
    const totalRow = db
        .prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0
    `)
        .get(...types, t);
    const rows = db
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size,
               created_at, nsfw_score, nsfw_checked_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0
         ORDER BY nsfw_score ASC, id ASC
         LIMIT ? OFFSET ?
    `)
        .all(...types, t, lim, offset);
    const total = totalRow.n;
    return { rows, total, page: p, totalPages: Math.max(1, Math.ceil(total / lim)) };
}

/**
 * Mark rows as admin-confirmed-18+. They're hidden from the review
 * sheet forever (until manually un-whitelisted). Use when the
 * classifier's score is misleadingly low for a genuinely 18+ image
 * — admin overrides the false negative.
 */
// Chunk size for `IN (?,?,…)` clauses. SQLite caps bound parameters at
// SQLITE_MAX_VARIABLE_NUMBER (32766 in modern builds, 999 in older ones);
// 500 stays well clear of both. Bulk NSFW ops can pass tens of thousands
// of ids when the operator selects a whole tier.
const _SQL_IN_CHUNK = 500;

function _runChunkedUpdate(sql, ids) {
    const db = getDb();
    let total = 0;
    const tx = db.transaction((all) => {
        for (let i = 0; i < all.length; i += _SQL_IN_CHUNK) {
            const slice = all.slice(i, i + _SQL_IN_CHUNK);
            const ph = slice.map(() => '?').join(',');
            total += db.prepare(sql.replace('${PH}', ph)).run(...slice).changes;
        }
    });
    tx(ids);
    return total;
}

export function whitelistNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    return _runChunkedUpdate(
        'UPDATE downloads SET nsfw_whitelist = 1 WHERE id IN (${PH})',
        cleanIds,
    );
}

// Tier definitions — higher score = more likely 18+ (the convention the
// classifier uses internally). Five tiers give the operator more nuance
// than the original binary "above/below threshold" view, and let the
// review page surface bulk actions like "delete everything in not_18+
// tier" without having to scroll a list of 8000 rows.
//
// Boundaries are inclusive on the LEFT, exclusive on the RIGHT (except
// def_18 which is closed on both sides because 1.0 is the max possible
// score — a row stored at exactly 1.0 must land in def_18, not nowhere).
//
// Names favour readability in the UI over brevity:
//   def_not  — Definitely not 18+      [0.0, 0.3)
//   maybe_not — Probably not 18+       [0.3, 0.5)
//   uncertain — Borderline / review    [0.5, 0.7)
//   maybe    — Probably 18+            [0.7, 0.9)
//   def      — Definitely 18+          [0.9, 1.0]
export const NSFW_TIERS = [
    { id: 'def_not', min: 0.0, max: 0.3, label: 'Definitely not 18+' },
    { id: 'maybe_not', min: 0.3, max: 0.5, label: 'Probably not 18+' },
    { id: 'uncertain', min: 0.5, max: 0.7, label: 'Borderline / review' },
    { id: 'maybe', min: 0.7, max: 0.9, label: 'Probably 18+' },
    { id: 'def', min: 0.9, max: 1.01, label: 'Definitely 18+' },
];

function _tierBounds(tierId) {
    const t = NSFW_TIERS.find((x) => x.id === tierId);
    if (!t) return null;
    return { min: t.min, max: t.max };
}

/**
 * Per-tier counts. `whitelist` rows count toward `whitelistTotal` and are
 * NOT included in tier counts (they were admin-confirmed 18+ even when
 * the score might disagree). The UI uses this to render the stats cards.
 *
 * Single SQL pass — one CASE-SUM aggregation gives all five tier counts
 * plus scanned/totalEligible. The whitelist count is unfiltered by
 * file_type by design (it's a global "how many rows did the operator
 * mark as confirmed-18+", not a per-photo metric) so it stays separate.
 */
export function getNsfwTierCounts(fileTypes) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    // Build the per-tier SUM(CASE...) clauses from NSFW_TIERS so the
    // bucket boundaries stay defined in one place.
    const tierSums = NSFW_TIERS.map(
        (t) =>
            `SUM(CASE WHEN nsfw_score IS NOT NULL AND nsfw_whitelist = 0 AND nsfw_score >= ${t.min} AND nsfw_score < ${t.max} THEN 1 ELSE 0 END) AS tier_${t.id}`,
    ).join(',\n               ');
    const row = db
        .prepare(`
            SELECT
               ${tierSums},
               SUM(CASE WHEN nsfw_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned,
               COUNT(*) AS total_eligible
              FROM downloads
             WHERE file_type IN (${placeholders})
        `)
        .get(...types);
    const tiers = {};
    for (const t of NSFW_TIERS) tiers[t.id] = row[`tier_${t.id}`] || 0;
    const whitelisted = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE nsfw_whitelist = 1`)
        .get().n;
    const scanned = row.scanned || 0;
    const totalEligible = row.total_eligible || 0;
    return {
        tiers,
        scanned,
        unscanned: Math.max(0, totalEligible - scanned),
        whitelisted,
        totalEligible,
    };
}

/**
 * Score histogram — N bins across [0, 1]. Drives the small inline chart
 * on the review page so the operator can spot model bias / clustering at
 * a glance (e.g. classifier scoring everything in 0.4-0.6 = the model is
 * uncertain; consider a different model).
 *
 * SQL-side aggregation: GROUP BY a CAST(score*N AS INTEGER) bin index so
 * the database returns one row per non-empty bin (max 21 rows for the
 * default 20 bins, since the score=1.0 edge case lands in bin N-1). The
 * dense output array is built from the sparse result so callers see a
 * fixed-length counts[] like before.
 */
export function getNsfwHistogram(fileTypes, bins = 20) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const n = Math.max(4, Math.min(50, Number(bins) || 20));
    const out = new Array(n).fill(0);
    // Cap at n-1 so a perfect 1.0 score lands in the last bin instead of
    // an out-of-range bucket. The CASE expression mirrors the JS
    // `Math.floor(score*n); if (idx>=n) idx=n-1` clamp.
    const rows = getDb()
        .prepare(`
            SELECT
               CASE WHEN CAST(nsfw_score * ? AS INTEGER) >= ?
                    THEN ? - 1
                    ELSE CAST(nsfw_score * ? AS INTEGER)
               END AS bin,
               COUNT(*) AS n
              FROM downloads
             WHERE file_type IN (${placeholders})
               AND nsfw_score IS NOT NULL
             GROUP BY bin
        `)
        .all(n, n, n, n, ...types);
    for (const r of rows) {
        const idx = Math.max(0, Math.min(n - 1, Number(r.bin) || 0));
        out[idx] = Number(r.n) || 0;
    }
    return { bins: n, counts: out };
}

/**
 * Paginated list filtered by tier (or score range), file type, and
 * group. The new review page uses this in place of the old
 * delete-candidates query so the operator can step through ANY tier,
 * not only the ones below the deletion threshold.
 */
export function getNsfwListByTier({
    tier = null,
    fileTypes,
    groupId = null,
    includeWhitelisted = false,
    page = 1,
    limit = 50,
}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const where = [`file_type IN (${placeholders})`, 'nsfw_score IS NOT NULL'];
    const params = [...types];
    if (tier) {
        const bounds = _tierBounds(tier);
        if (bounds) {
            where.push('nsfw_score >= ?');
            where.push('nsfw_score < ?');
            params.push(bounds.min, bounds.max);
        }
    }
    if (!includeWhitelisted) where.push('nsfw_whitelist = 0');
    if (groupId) {
        where.push('group_id = ?');
        params.push(String(groupId));
    }
    const p = Math.max(1, Number(page) || 1);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const offset = (p - 1) * lim;
    const whereSql = where.join(' AND ');
    const db = getDb();
    const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ${whereSql}`)
        .get(...params);
    const rows = db
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size,
               created_at, nsfw_score, nsfw_checked_at, nsfw_whitelist
          FROM downloads
         WHERE ${whereSql}
         ORDER BY nsfw_score ASC, id ASC
         LIMIT ? OFFSET ?
    `)
        .all(...params, lim, offset);
    return {
        rows,
        total: totalRow.n,
        page: p,
        totalPages: Math.max(1, Math.ceil(totalRow.n / lim)),
    };
}

/**
 * Resolve a tier-or-range filter to a flat array of row ids in one SQL
 * statement. Replaces the old paginated walker that issued ~75 queries
 * to collect 15k ids on the def_not tier — now it's a single index scan
 * with no LIMIT/OFFSET dance.
 *
 * `scoreMin` / `scoreMax` are pushed into the WHERE clause too so a
 * narrow score band (e.g. 0.55..0.62 for spot-checking) doesn't pull
 * the whole tier into memory and filter post-query.
 */
export function getNsfwIdsByTier({
    tier = null,
    fileTypes,
    groupId = null,
    includeWhitelisted = false,
    scoreMin = null,
    scoreMax = null,
} = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const where = [`file_type IN (${placeholders})`, 'nsfw_score IS NOT NULL'];
    const params = [...types];
    if (tier) {
        const bounds = _tierBounds(tier);
        if (bounds) {
            where.push('nsfw_score >= ?');
            where.push('nsfw_score < ?');
            params.push(bounds.min, bounds.max);
        }
    }
    if (Number.isFinite(scoreMin)) {
        where.push('nsfw_score >= ?');
        params.push(Number(scoreMin));
    }
    if (Number.isFinite(scoreMax)) {
        where.push('nsfw_score < ?');
        params.push(Number(scoreMax));
    }
    if (!includeWhitelisted) where.push('nsfw_whitelist = 0');
    if (groupId) {
        where.push('group_id = ?');
        params.push(String(groupId));
    }
    // Stream — `.all()` over a tier with 100 k+ scored photos materialises
    // the entire id list in JS heap before the bulk-delete consumer touches
    // the first row. Iterator + push keeps the array bounded only by the
    // matched rows, not by a single `Statement::JS_all` allocation spike.
    const ids = [];
    const iter = getDb()
        .prepare(`
            SELECT id FROM downloads
             WHERE ${where.join(' AND ')}
             ORDER BY nsfw_score ASC, id ASC
        `)
        .iterate(...params);
    for (const r of iter) {
        const n = Number(r.id);
        if (Number.isInteger(n) && n > 0) ids.push(n);
    }
    return ids;
}

/**
 * Bulk reclassify — clear `nsfw_checked_at` so the next scan run picks
 * the rows up again. Useful after switching the model or threshold
 * without having to wipe the entire `nsfw_*` column trio.
 */
export function reclassifyNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    return _runChunkedUpdate(
        'UPDATE downloads SET nsfw_checked_at = NULL, nsfw_score = NULL WHERE id IN (${PH})',
        cleanIds,
    );
}

/**
 * Un-whitelist — flip nsfw_whitelist back to 0 so the next scan / review
 * page sees the row again. Counterpart to `whitelistNsfw`.
 */
export function unwhitelistNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    return _runChunkedUpdate(
        'UPDATE downloads SET nsfw_whitelist = 0 WHERE id IN (${PH})',
        cleanIds,
    );
}

// ---- AI subsystem (v2.15.0) ----------------------------------------------
//
// Helper queries for src/core/ai/*. Each capability persists into a
// different table but the read paths are concentrated here so the modules
// stay small. Mirrors the NSFW helper pattern: small, composable, every
// `.all()` over a high-cardinality table either has LIMIT/OFFSET or is
// streamed via `.iterate()` per `CLAUDE.md → Big-data patterns`.

/**
 * Rows that haven't been visited yet by the AI indexer. Photos only — videos
 * + documents are out of scope for the v2.15 subsystem (frame extraction
 * comes later). Sorted oldest-first so a resumed scan picks up backlog
 * before newly-arrived rows.
 */
export function getUnindexedAiBatch({ fileTypes = ['photo'], limit = 50 } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND ai_indexed_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT ?
    `)
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

export function setAiIndexedAt(downloadId, now = Date.now()) {
    return getDb()
        .prepare('UPDATE downloads SET ai_indexed_at = ? WHERE id = ?')
        .run(Math.floor(now), Number(downloadId)).changes;
}

export function getUnscannedOcrBatch({ fileTypes = ['photo'], limit = 50 } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND id NOT IN (SELECT DISTINCT download_id FROM image_text)
           AND LOWER(file_name) NOT LIKE '%.webp' 
         ORDER BY created_at ASC, id ASC
         LIMIT ?
    `)
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

export function getUnscannedTagsBatch({ fileTypes = ['photo'], limit = 50 } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND id NOT IN (SELECT DISTINCT download_id FROM image_tags)
           AND LOWER(file_name) NOT LIKE '%.webp'
         ORDER BY created_at ASC, id ASC
         LIMIT ?
    `)
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

export function countUnscannedTags({ fileTypes = ['photo'] } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb()
        .prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND id NOT IN (SELECT DISTINCT download_id FROM image_tags)
           AND LOWER(file_name) NOT LIKE '%.webp'
    `)
        .get(...types).n;
}

/**
 * Counters for the Maintenance → AI page header. One COUNT per capability
 * + a totalEligible/indexed roll-up so the UI can paint progress bars
 * without per-feature round-trips.
 */
export function getAiCounts({ fileTypes = ['photo'] } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders})`)
        .get(...types).n;
    const indexed = db
        .prepare(
            `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders}) AND ai_indexed_at IS NOT NULL`,
        )
        .get(...types).n;
    const withEmbedding = db.prepare(`SELECT COUNT(*) AS n FROM image_embeddings`).get().n;
    const withFaces = db.prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM faces`).get().n;
    const withTags = db.prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM image_tags`).get().n;
    const withText = db.prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM image_text`).get().n;
    const withTextEmbedding = db.prepare(`SELECT COUNT(*) AS n FROM text_embeddings`).get().n;
    const withWd14Tags = db
        .prepare(
            `SELECT COUNT(DISTINCT download_id) AS n FROM image_tags_wd14 WHERE tag != '_wd14_scanned_'`,
        )
        .get().n;
    const peopleCount = db.prepare(`SELECT COUNT(*) AS n FROM people`).get().n;
    const lastScanAt = db.prepare(`SELECT MAX(ai_indexed_at) AS t FROM downloads`).get().t || null;
    return {
        totalEligible: total,
        indexed,
        unindexed: Math.max(0, total - indexed),
        withEmbedding,
        withTextEmbedding,
        withTags,
        withWd14Tags,
        withText,
        withFaces,
        peopleCount,
        lastScanAt,
    };
}

// ---- Image embeddings -----------------------------------------------------

export function setImageEmbedding(downloadId, embeddingBlob, model, now = Date.now()) {
    return getDb()
        .prepare(`
        INSERT INTO image_embeddings (download_id, embedding, model, indexed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(download_id) DO UPDATE SET
            embedding  = excluded.embedding,
            model      = excluded.model,
            indexed_at = excluded.indexed_at
    `)
        .run(Number(downloadId), embeddingBlob, String(model), Math.floor(now)).changes;
}

/**
 * Stream every embedding row for the in-memory cosine-sim path. JOINs
 * `downloads` so the search caller can return file metadata in one round
 * trip. Iterator-based — see `CLAUDE.md → Big-data patterns rule 1`. The
 * caller (vector-store.topK) materialises only the top-K results, so even
 * a 1M-row library scans linearly without holding everything in heap.
 */
export function iterateAllImageEmbeddings({ fileTypes = null } = {}) {
    let where = '';
    const params = [];
    if (Array.isArray(fileTypes) && fileTypes.length) {
        where = ` WHERE d.file_type IN (${fileTypes.map(() => '?').join(',')})`;
        params.push(...fileTypes);
    }
    return getDb()
        .prepare(`
        SELECT e.download_id, e.embedding, e.model, e.indexed_at,
               d.id, d.group_id, d.group_name, d.file_name, d.file_path,
               d.file_type, d.file_size, d.created_at
          FROM image_embeddings e
          JOIN downloads d ON d.id = e.download_id
          ${where}
    `)
        .iterate(...params);
}

/**
 * Cosine-similarity search over all stored image embeddings. Loads every
 * row matching the optional filters into memory, computes cosine similarity
 * against the query embedding, and returns the top-K results with file
 * metadata. Uses iterators so only the top-K are materialised in the heap.
 *
 * @param {Float32Array|number[]} queryEmbedding - L2-normalised query vector
 * @param {object} [opts]
 * @param {number} [opts.topK=50] - Max results to return
 * @param {number} [opts.minScore=0.0] - Minimum cosine similarity threshold
 * @param {string[]} [opts.fileTypes] - Filter by file type(s)
 * @param {string} [opts.model] - Only match rows with this embedding model
 * @returns {{ id, groupId, groupName, fileName, filePath, fileType, fileSize, createdAt, score }[]}
 */
export function searchEmbeddings(queryEmbedding, opts = {}) {
    const { topK = 50, minScore = 0.0, fileTypes = null, model = null } = opts;

    const q =
        queryEmbedding instanceof Float32Array ? queryEmbedding : Float32Array.from(queryEmbedding);
    const qNorm = (() => {
        const s = q.reduce((a, b) => a + b * b, 0);
        return Math.sqrt(s) || 1;
    })();
    const qNormalized = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) qNormalized[i] = q[i] / qNorm;

    // Min-heap of size topK: [-score, id, ...]
    const heap = [];

    const iter = iterateAllImageEmbeddings({ fileTypes });
    for (const row of iter) {
        // Optional model filter
        if (model && row.model !== model) continue;

        // Decode embedding blob
        const dim = row.embedding.byteLength / 4;
        const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dim);

        // Cosine similarity (both are L2-normalised)
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += qNormalized[i] * emb[i];
        const score = Math.min(1, Math.max(-1, dot));

        if (score < minScore) continue;

        // Push [-score, id, ...] for min-heap behaviour
        if (heap.length < topK) {
            heap.push([-score, row.download_id, row]);
            heap.sort((a, b) => a[0] - b[0]);
        } else if (-score < heap[topK - 1][0]) {
            heap[topK - 1] = [-score, row.download_id, row];
            heap.sort((a, b) => a[0] - b[0]);
        }
    }

    // Extract results sorted by score descending
    heap.sort((a, b) => a[0] - b[0]); // lowest neg-score first = highest score first
    return heap.map(([negScore, , row]) => ({
        id: row.download_id,
        groupId: row.group_id,
        groupName: row.group_name,
        fileName: row.file_name,
        filePath: row.file_path,
        fileType: row.file_type,
        fileSize: row.file_size,
        createdAt: row.created_at,
        score: Math.round(-negScore * 1000) / 1000, // round to 3 decimal places
    }));
}

/**
 * Distinct embedding-model values currently stored. Used by
 * `clearStaleEmbeddings` after a model swap.
 */
export function listEmbeddingModels() {
    return getDb()
        .prepare(`
        SELECT model, COUNT(*) AS count
          FROM image_embeddings
         GROUP BY model
    `)
        .all();
}

/**
 * Nuke every AI artefact and reset every download's `ai_indexed_at`
 * stamp so the next scan reprocesses the entire library from scratch.
 * Used by the "Re-index everything" button when the operator changes
 * model, dtype, or label list and wants a clean baseline. Returns
 * counts so the UI can show what was reset.
 */
export function resetAllAiData() {
    const db = getDb();
    const tx = db.transaction(() => {
        const embeddings = db.prepare('DELETE FROM image_embeddings').run().changes;
        const textEmbeddings = db.prepare('DELETE FROM text_embeddings').run().changes;
        const tags = db.prepare('DELETE FROM image_tags').run().changes;
        const wd14Tags = db.prepare('DELETE FROM image_tags_wd14').run().changes;
        const faces = db.prepare('DELETE FROM faces').run().changes;
        const people = db.prepare('DELETE FROM people').run().changes;
        const text = db.prepare('DELETE FROM image_text').run().changes;
        const requeued = db
            .prepare('UPDATE downloads SET ai_indexed_at = NULL WHERE ai_indexed_at IS NOT NULL')
            .run().changes;
        return {
            embeddings,
            textEmbeddings,
            tags,
            wd14Tags,
            faces,
            people,
            text,
            requeued,
        };
    });
    return tx();
}

/**
 * Drop every embedding row whose `model` differs from `currentModelId`,
 * then reset `downloads.ai_indexed_at = NULL` for the affected rows so
 * the next scan re-embeds them. Wrapped in one transaction so a partial
 * state can never linger.
 */
export function clearStaleEmbeddings(currentModelId) {
    const target = String(currentModelId || '').trim();
    if (!target) return { dropped: 0, requeued: 0 };
    const db = getDb();
    const tx = db.transaction((modelId) => {
        const dropped = db
            .prepare(`DELETE FROM image_embeddings WHERE model != ?`)
            .run(modelId).changes;
        const requeued = db
            .prepare(`
                UPDATE downloads
                   SET ai_indexed_at = NULL
                 WHERE id NOT IN (SELECT download_id FROM image_embeddings)
                   AND ai_indexed_at IS NOT NULL
            `)
            .run().changes;
        return { dropped, requeued };
    });
    return tx(target);
}

// ---- LLM text embeddings --------------------------------------------------

/**
 * Upsert a text embedding (LLM-generated) for a download. Used by the
 * background pregenerate hook as a fallback semantic search index when
 * the CLIP sidecar is not available.
 */
export function setTextEmbedding(downloadId, embeddingBlob, model, now = Date.now()) {
    return getDb()
        .prepare(`
        INSERT INTO text_embeddings (download_id, embedding, model, indexed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(download_id) DO UPDATE SET
            embedding  = excluded.embedding,
            model      = excluded.model,
            indexed_at = excluded.indexed_at
    `)
        .run(Number(downloadId), embeddingBlob, String(model), Math.floor(now / 1000)).changes;
}

/**
 * Cosine-similarity search over stored LLM text embeddings. Returns the
 * top-K results ranked by similarity. Min-heap keeps memory bounded.
 *
 * @param {Float32Array|number[]} queryEmbedding
 * @param {object} [opts]
 * @param {number} [opts.topK=50]
 * @param {number} [opts.minScore=0.0]
 * @param {string[]} [opts.fileTypes]
 * @returns {{ id: number, score: number }[]}
 */
export function searchTextEmbeddings(queryEmbedding, opts = {}) {
    const { topK = 50, minScore = 0.0, fileTypes = null } = opts;

    const q =
        queryEmbedding instanceof Float32Array ? queryEmbedding : Float32Array.from(queryEmbedding);
    const qNorm = Math.sqrt(q.reduce((a, b) => a + b * b, 0)) || 1;
    const qn = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) qn[i] = q[i] / qNorm;

    let sql = `SELECT e.download_id, e.embedding FROM text_embeddings e`;
    const params = [];
    if (Array.isArray(fileTypes) && fileTypes.length) {
        sql += ` JOIN downloads d ON d.id = e.download_id WHERE d.file_type IN (${fileTypes.map(() => '?').join(',')})`;
        params.push(...fileTypes);
    }

    const heap = [];
    for (const row of getDb()
        .prepare(sql)
        .iterate(...params)) {
        if (!row.embedding?.byteLength) continue;
        const dim = row.embedding.byteLength / 4;
        const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dim);
        if (emb.length !== qn.length) continue;

        let embNorm = 0;
        for (let i = 0; i < dim; i++) embNorm += emb[i] * emb[i];
        embNorm = Math.sqrt(embNorm) || 1;
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += qn[i] * emb[i];
        const score = Math.min(1, Math.max(0, dot / embNorm));

        if (score < minScore) continue;

        if (heap.length < topK) {
            heap.push([-score, Number(row.download_id)]);
            heap.sort((a, b) => a[0] - b[0]);
        } else if (heap.length >= topK && -score < heap[topK - 1][0]) {
            heap[topK - 1] = [-score, Number(row.download_id)];
            heap.sort((a, b) => a[0] - b[0]);
        }
    }

    return heap.map(([negScore, id]) => ({
        id,
        score: Math.round(-negScore * 1000) / 1000,
    }));
}

/**
 * Build a human-readable metadata string for a download from its tags,
 * OCR text, and filename. This text is embedded by the
 * LLM and stored in `text_embeddings` so query embeddings can be matched
 * against it via cosine similarity.
 *
 * @param {number} downloadId
 * @returns {string}
 */
export function buildMetadataText(downloadId) {
    const db = getDb();
    const id = Number(downloadId);
    const parts = [];
    const seen = new Set();

    const add = (term) => {
        const k = String(term || '')
            .toLowerCase()
            .trim();
        if (k && !seen.has(k)) {
            seen.add(k);
            parts.push(k);
        }
    };

    // Top CLIP tags (threshold 0.2 keeps only meaningful labels)
    const tags = db
        .prepare(
            `SELECT tag FROM image_tags WHERE download_id = ? AND score >= 0.2 ORDER BY score DESC LIMIT 30`,
        )
        .all(id);
    for (const r of tags) add(r.tag);

    // WD14 tags (separate table; sentinel rows excluded by tag filter)
    const wd14Tags = db
        .prepare(
            `SELECT tag FROM image_tags_wd14 WHERE download_id = ? AND score >= 0.2 AND tag != '_wd14_scanned_' ORDER BY score DESC LIMIT 30`,
        )
        .all(id);
    for (const r of wd14Tags) add(r.tag);

    // Filename tokens (split on non-alphanumeric, skip very short tokens)
    const row = db.prepare(`SELECT file_name, group_name FROM downloads WHERE id = ?`).get(id);
    if (row?.file_name) {
        for (const tok of row.file_name.split(/[^a-z0-9]+/i)) {
            if (tok.length > 2) add(tok);
        }
    }
    if (row?.group_name) {
        for (const tok of row.group_name.split(/[^a-z0-9]+/i)) {
            if (tok.length > 2) add(tok);
        }
    }

    // OCR text appended as-is (truncated) so the embedding model sees full
    // phrases rather than individual tokens.
    const ocr = db.prepare(`SELECT text FROM image_text WHERE download_id = ?`).get(id);
    const ocrText = ocr?.text ? String(ocr.text).slice(0, 300).trim() : '';

    const base = parts.join(' ');
    return ocrText ? `${base} ${ocrText}` : base;
}

// ---- Faces & people -------------------------------------------------------

export function insertFace({
    downloadId,
    x,
    y,
    w,
    h,
    embeddingBlob,
    personId = null,
    qualityScore = null,
}) {
    return getDb()
        .prepare(`
        INSERT INTO faces (download_id, x, y, w, h, embedding, person_id, quality_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
        .run(
            Number(downloadId),
            Number(x),
            Number(y),
            Number(w),
            Number(h),
            embeddingBlob,
            personId == null ? null : Number(personId),
            qualityScore == null ? null : Number(qualityScore),
        );
}

export function deleteFacesForDownload(downloadId) {
    return getDb().prepare('DELETE FROM faces WHERE download_id = ?').run(Number(downloadId))
        .changes;
}

/** Streamed iterator for the clustering pass — see Big-data rule 1. */
// Chunked face iterator. Reconciles two competing constraints:
//
//   1. better-sqlite3's `.iterate()` holds the DB connection open for
//      the lifetime of the JS-side loop. If the caller yields to the
//      event loop mid-iteration, an incoming POST /api/config writer
//      collides and gets "This database connection is busy" — visible
//      to operators as a "config save failed" toast.
//   2. Loading ALL rows via `.all()` is fine for a 50k-face library
//      but blows up at million-face scale (~2 GB Node heap).
//
// Solution: paginate via LIMIT/OFFSET in 1 000-row chunks. Each chunk's
// `.all()` releases the connection immediately, so any pending writer
// (config save, faststart stamp, faces.insert from Phase A's parallel
// detect) can run between chunks. The caller's `setImmediate` yields
// land in those windows naturally.
//
// 1 000-row chunk × 2 KB/row = 2 MB working set per pull, well within
// V8 heap limits at any library size. Total wall time is comparable to
// a single `.iterate()` walk; the only overhead is one extra SQL parse
// per chunk (~µs).
export function* iterateAllFaces({ chunkSize = 1000 } = {}) {
    const db = getDb();
    const stmt = db.prepare(
        `SELECT id, download_id, x, y, w, h, embedding, person_id FROM faces
         ORDER BY id LIMIT ? OFFSET ?`,
    );
    for (let offset = 0; ; offset += chunkSize) {
        const chunk = stmt.all(chunkSize, offset);
        if (!chunk.length) return;
        for (const row of chunk) yield row;
        if (chunk.length < chunkSize) return;
    }
}

/**
 * Update only the `quality_score` column on an existing face row. Used
 * by the v2.16 quality filter so the UI can show "low confidence"
 * warnings on borderline detections without re-running the scan.
 */
export function setFaceQualityScore(faceId, qualityScore) {
    return getDb()
        .prepare('UPDATE faces SET quality_score = ? WHERE id = ?')
        .run(Number(qualityScore), Number(faceId)).changes;
}

/**
 * Backfill missing `faces.quality_score` rows using bbox-only heuristics.
 *
 * We don't have detector confidence persisted for legacy rows, so the
 * confidence term falls back to 0.3 and we derive the rest from bbox size
 * and aspect-ratio sanity.
 */
export function backfillMissingFaceQualityScores({
    chunkSize = 1000,
    minFaceSizePx = 48,
    confidenceFallback = 0.3,
} = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(10000, Number(chunkSize) || 1000));
    const minBox = Math.max(1, Number(minFaceSizePx) || 48);
    const conf = Math.max(0, Math.min(1, Number(confidenceFallback) || 0.3));
    const pick = db.prepare(
        `SELECT id, w, h FROM faces WHERE quality_score IS NULL ORDER BY id ASC LIMIT ?`,
    );
    const upd = db.prepare(`UPDATE faces SET quality_score = ? WHERE id = ?`);
    let scanned = 0;
    let updated = 0;
    while (true) {
        const rows = pick.all(lim);
        if (!rows.length) break;
        const tx = db.transaction((batch) => {
            let n = 0;
            for (const r of batch) {
                const w = Math.max(0, Number(r.w) || 0);
                const h = Math.max(0, Number(r.h) || 0);
                const sizeNorm = Math.max(0, Math.min(1, Math.min(w, h) / (minBox * 2.5)));
                const ratio = w > 0 && h > 0 ? w / h : 1;
                const aspectNorm = Math.max(
                    0,
                    Math.min(1, 1 - Math.min(1, Math.abs(Math.log(ratio)))),
                );
                const q = conf * 0.5 + sizeNorm * 0.35 + aspectNorm * 0.15;
                n += upd.run(q, Number(r.id)).changes;
            }
            return n;
        });
        scanned += rows.length;
        updated += tx(rows);
    }
    return { scanned, updated };
}

/**
 * Merge cluster `otherId` into `targetId`. Every face previously
 * assigned to `otherId` is reassigned to `targetId`; the empty
 * cluster row is deleted. Face counts are recalculated from the live
 * row count so they stay accurate across operations.
 *
 * Returns `{ moved, deleted }` so the UI can show a precise toast.
 */
export function mergeFacePerson(targetId, otherId) {
    const t = Number(targetId);
    const o = Number(otherId);
    if (!Number.isFinite(t) || !Number.isFinite(o) || t === o) {
        return { moved: 0, deleted: 0 };
    }
    const db = getDb();
    const tx = db.transaction(() => {
        const moved = db
            .prepare('UPDATE faces SET person_id = ? WHERE person_id = ?')
            .run(t, o).changes;
        const newCount = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(t).n;
        db.prepare('UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?').run(
            newCount,
            Date.now(),
            t,
        );
        const deleted = db.prepare('DELETE FROM people WHERE id = ?').run(o).changes;
        return { moved, deleted };
    });
    return tx();
}

/**
 * Pull a set of face ids out of their current cluster(s) and create a
 * fresh cluster containing only those faces. The new cluster's
 * centroid is computed from the moved faces' embeddings. Useful when
 * DBSCAN over-grouped two similar-looking people.
 *
 * Returns `{ personId, moved }` where personId is the new cluster's id.
 */
export function splitFacePerson(faceIds, label = null) {
    const ids = (Array.isArray(faceIds) ? faceIds : [])
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0);
    if (!ids.length) return { personId: null, moved: 0 };
    const db = getDb();
    const tx = db.transaction(() => {
        const placeholders = ids.map(() => '?').join(',');
        const rows = db
            .prepare(`SELECT id, embedding, person_id FROM faces WHERE id IN (${placeholders})`)
            .all(...ids);
        if (!rows.length) return { personId: null, moved: 0 };
        // Compute centroid from the picked faces. Float32 sum then
        // divide — avoids the spread + Math.max pattern the OOM guard
        // rejects.
        const dim = rows[0].embedding.byteLength / 4;
        const acc = new Float32Array(dim);
        for (const r of rows) {
            const view = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dim);
            for (let i = 0; i < dim; i++) acc[i] += view[i];
        }
        for (let i = 0; i < dim; i++) acc[i] /= rows.length;
        const centroidBlob = Buffer.from(acc.buffer);
        const now = Date.now();
        const r = db
            .prepare(`
                INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `)
            .run(label, centroidBlob, rows.length, now, now);
        const newPersonId = r.lastInsertRowid;
        const moved = db
            .prepare(`UPDATE faces SET person_id = ? WHERE id IN (${placeholders})`)
            .run(newPersonId, ...ids).changes;
        // Update each source cluster's face_count + drop those whose
        // count hit zero.
        const oldPersonIds = [...new Set(rows.map((r) => r.person_id).filter((x) => x))];
        for (const pid of oldPersonIds) {
            const n = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(pid).n;
            if (n === 0) {
                db.prepare('DELETE FROM people WHERE id = ?').run(pid);
            } else {
                db.prepare('UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?').run(
                    n,
                    now,
                    pid,
                );
            }
        }
        return { personId: Number(newPersonId), moved };
    });
    return tx();
}

/**
 * Move a single face to a different cluster (or to no cluster if
 * `personId` is null). Updates both the source and destination
 * cluster's `face_count`. The source cluster is deleted if its count
 * hits zero.
 */
export function reassignFace(faceId, personId) {
    const fid = Number(faceId);
    const pid = personId == null ? null : Number(personId);
    if (!Number.isFinite(fid)) return { ok: false };
    const db = getDb();
    const tx = db.transaction(() => {
        const before = db.prepare('SELECT person_id FROM faces WHERE id = ?').get(fid);
        if (!before) return { ok: false };
        const oldPid = before.person_id;
        db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(pid, fid);
        const now = Date.now();
        for (const p of [oldPid, pid]) {
            if (p == null) continue;
            const n = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(p).n;
            if (n === 0 && p === oldPid) {
                db.prepare('DELETE FROM people WHERE id = ?').run(p);
            } else {
                db.prepare('UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?').run(
                    n,
                    now,
                    p,
                );
            }
        }
        return { ok: true, oldPersonId: oldPid, newPersonId: pid };
    });
    return tx();
}

/**
 * Find the closest persisted (labelled) cluster to a freshly computed
 * centroid. Used by the v2.16 re-cluster label-preservation flow: when
 * a new DBSCAN pass produces cluster X with centroid C, this returns
 * the existing labelled cluster within `eps` so its label can carry
 * over. Returns null when no match is within `eps`.
 *
 * Walks `people` once (small table — number of unique humans, typically
 * dozens). Streams with `.iterate()` defensively in case a power user
 * has tens of thousands of clusters.
 */
export function matchClusterToPersistedLabel(centroid, eps = 0.4) {
    if (!(centroid instanceof Float32Array)) return null;
    const dim = centroid.length;
    const stmt = getDb().prepare(
        'SELECT id, label, embedding_centroid FROM people WHERE label IS NOT NULL',
    );
    let bestId = null;
    let bestDist = Infinity;
    let bestLabel = null;
    for (const row of stmt.iterate()) {
        if (row.embedding_centroid.byteLength !== dim * 4) continue;
        const other = new Float32Array(
            row.embedding_centroid.buffer,
            row.embedding_centroid.byteOffset,
            dim,
        );
        let sum = 0;
        for (let i = 0; i < dim; i++) {
            const d = centroid[i] - other[i];
            sum += d * d;
        }
        const dist = Math.sqrt(sum);
        if (dist < bestDist && dist <= eps) {
            bestDist = dist;
            bestId = row.id;
            bestLabel = row.label;
        }
    }
    return bestId == null ? null : { id: bestId, label: bestLabel, distance: bestDist };
}

export function setFacePerson(faceId, personId) {
    return getDb()
        .prepare('UPDATE faces SET person_id = ? WHERE id = ?')
        .run(personId == null ? null : Number(personId), Number(faceId)).changes;
}

export function clearAllPeople() {
    const db = getDb();
    const tx = db.transaction(() => {
        db.prepare('UPDATE faces SET person_id = NULL').run();
        db.prepare('DELETE FROM people').run();
    });
    tx();
}

export function insertPerson({ label = null, centroidBlob, faceCount = 0 }) {
    const now = Date.now();
    const r = getDb()
        .prepare(`
        INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `)
        .run(label, centroidBlob, Math.max(0, Number(faceCount) || 0), now, now);
    return r.lastInsertRowid;
}

export function listPeople({ limit = 500, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(1000, Number(limit) || 500));
    const off = Math.max(0, Number(offset) || 0);
    const db = getDb();
    const rows = db
        .prepare(`
        SELECT p.id, p.label, p.face_count, p.created_at, p.updated_at,
               f.download_id AS cover_download_id,
               f.id AS cover_face_id,
               f.x AS cover_x, f.y AS cover_y, f.w AS cover_w, f.h AS cover_h
          FROM people p
          LEFT JOIN faces f ON f.id = (
            SELECT ff.id
              FROM faces ff
             WHERE ff.person_id = p.id
             ORDER BY COALESCE(ff.quality_score, 0) DESC, ff.w * ff.h DESC
             LIMIT 1
          )
         ORDER BY p.face_count DESC, p.id ASC
         LIMIT ? OFFSET ?
    `)
        .all(lim, off);
    const total = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
    return { people: rows, total };
}

export function renamePerson(id, label) {
    return getDb()
        .prepare(`UPDATE people SET label = ?, updated_at = ? WHERE id = ?`)
        .run(label == null ? null : String(label), Date.now(), Number(id)).changes;
}

export function deletePerson(id) {
    // ON DELETE SET NULL on faces.person_id keeps face rows around so a
    // re-cluster can re-assign them — we don't lose embeddings.
    return getDb().prepare('DELETE FROM people WHERE id = ?').run(Number(id)).changes;
}

export function listPhotosForPerson(personId, { limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const db = getDb();
    const rows = db
        .prepare(`
        SELECT d.id, d.file_name, d.file_path, d.file_type, d.file_size,
               d.created_at, d.group_id, d.group_name, d.message_id,
               f.id AS face_id,
               f.x AS face_x, f.y AS face_y, f.w AS face_w, f.h AS face_h,
               COALESCE(f.quality_score, 0) AS face_quality
          FROM (
            SELECT f2.download_id, f2.id, f2.x, f2.y, f2.w, f2.h, f2.quality_score,
                   ROW_NUMBER() OVER (
                     PARTITION BY f2.download_id
                     ORDER BY COALESCE(f2.quality_score, 0) DESC, f2.w * f2.h DESC
                   ) AS rn
              FROM faces f2
             WHERE f2.person_id = ?
          ) f
          JOIN downloads d ON d.id = f.download_id
         WHERE f.rn = 1
         ORDER BY face_quality DESC, d.created_at DESC, d.id DESC
         LIMIT ? OFFSET ?
    `)
        .all(Number(personId), lim, off);
    const total = db
        .prepare(`SELECT COUNT(DISTINCT download_id) AS n FROM faces WHERE person_id = ?`)
        .get(Number(personId)).n;
    return { files: rows, total };
}

// ---- Image tags -----------------------------------------------------------

export function setImageTags(downloadId, tags) {
    if (!Array.isArray(tags) || !tags.length) return 0;
    const db = getDb();
    const ins = db.prepare(`
        INSERT INTO image_tags (download_id, tag, score) VALUES (?, ?, ?)
        ON CONFLICT(download_id, tag) DO UPDATE SET score = excluded.score
    `);
    const tx = db.transaction(() => {
        let n = 0;
        for (const t of tags) {
            if (!t || !t.tag) continue;
            ins.run(Number(downloadId), String(t.tag).slice(0, 80), Number(t.score) || 0);
            n += 1;
        }
        return n;
    });
    return tx();
}

export function clearImageTagsForDownload(downloadId) {
    return getDb().prepare('DELETE FROM image_tags WHERE download_id = ?').run(Number(downloadId))
        .changes;
}

export function listAllTags({ minCount = 1 } = {}) {
    return getDb()
        .prepare(`
        SELECT tag, COUNT(*) AS count, AVG(score) AS avg_score
          FROM image_tags
         WHERE tag != '_scanned_'
         GROUP BY tag
        HAVING count >= ?
         ORDER BY count DESC, tag ASC
         LIMIT 1000
    `)
        .all(Math.max(1, Number(minCount) || 1));
}

export function listPhotosForTag(tag, { limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = getDb()
        .prepare(`
        SELECT d.*, t.score AS tag_score,
               substr(it.text, 1, 200) AS ocr_text
          FROM image_tags t
          JOIN downloads d ON d.id = t.download_id
          LEFT JOIN image_text it ON it.download_id = d.id
         WHERE t.tag = ?
         ORDER BY t.score DESC, d.created_at DESC
         LIMIT ? OFFSET ?
    `)
        .all(String(tag), lim, off);
    const total = getDb()
        .prepare('SELECT COUNT(*) AS n FROM image_tags WHERE tag = ?')
        .get(String(tag)).n;
    return { files: rows, total };
}

/**
 * Find tag pairs that appear together frequently. Suggests which tags
 * might be redundant/similar and could be merged.
 *
 * Returns array of { tag1, tag2, cooccurrence_rate, images_together,
 * images_tag1, images_tag2 } sorted by cooccurrence_rate DESC.
 *
 * @param {number} minCooccurrenceRate - Include pairs above this rate (0-1, default 0.6)
 * @param {number} minImagesPerTag - Exclude tags appearing in fewer than N images (default 2)
 * @returns {Array} Suggested tag merges
 */
/**
 * Return details for a single tag: count, average score, source(s),
 * and related co-occurring tags.
 */
export function getTagDetails(tag, { limit = 20 } = {}) {
    const db = getDb();
    const safeTag = String(tag || '');
    if (!safeTag) return null;

    // Determine source(s) — check which tables contain this tag
    const sources = [];
    const clipCount = db
        .prepare('SELECT COUNT(*) AS n FROM image_tags WHERE tag = ?')
        .get(safeTag).n;
    if (clipCount > 0) sources.push({ source: 'clip', count: clipCount });

    const wd14Count = db
        .prepare('SELECT COUNT(*) AS n FROM image_tags_wd14 WHERE tag = ?')
        .get(safeTag).n;
    if (wd14Count > 0) sources.push({ source: 'wd14', count: wd14Count });

    // Average score from CLIP (if available)
    const clipStats = db
        .prepare('SELECT AVG(score) AS avg_score, COUNT(*) AS count FROM image_tags WHERE tag = ?')
        .get(safeTag);

    // Total unique photos across all sources
    const totalCount = db
        .prepare(
            `SELECT COUNT(*) AS n FROM (
            SELECT download_id FROM image_tags WHERE tag = ?
            UNION
            SELECT download_id FROM image_tags_wd14 WHERE tag = ?
        )`,
        )
        .get(safeTag, safeTag).n;

    // Related co-occurring tags (from CLIP image_tags)
    const related = db
        .prepare(`
        SELECT t2.tag, COUNT(*) AS together, AVG(t2.score) AS avg_score
          FROM image_tags t1
          JOIN image_tags t2 ON t1.download_id = t2.download_id AND t2.tag != t1.tag
         WHERE t1.tag = ? AND t2.tag != '_scanned_'
         GROUP BY t2.tag
         ORDER BY together DESC, avg_score DESC
         LIMIT ?
    `)
        .all(safeTag, Math.max(1, Math.min(100, Number(limit) || 20)));

    return {
        tag: safeTag,
        count: totalCount,
        avgScore: clipStats.avg_score ? Math.round(clipStats.avg_score * 1000) / 1000 : 0,
        sources,
        related,
    };
}

export function getTagCooccurrenceSuggestions({
    minCooccurrenceRate = 0.6,
    minImagesPerTag = 2,
} = {}) {
    const db = getDb();
    const minRate = Math.max(0, Math.min(1, Number(minCooccurrenceRate) || 0.6));
    const minImages = Math.max(1, Number(minImagesPerTag) || 2);

    // Get all tags with counts, filter by minImages
    const tags = db
        .prepare(`
        SELECT tag, COUNT(DISTINCT download_id) AS count
          FROM image_tags
         WHERE tag != '_scanned_'
         GROUP BY tag
        HAVING count >= ?
         ORDER BY count DESC
    `)
        .all(minImages);

    if (tags.length < 2) return [];

    // For each tag pair, calculate co-occurrence
    const suggestions = [];
    for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
            const t1 = tags[i].tag;
            const t2 = tags[j].tag;
            const count1 = tags[i].count;
            const count2 = tags[j].count;

            const together = db
                .prepare(`
                SELECT COUNT(DISTINCT t1.download_id) AS n
                  FROM image_tags t1
                  JOIN image_tags t2 ON t1.download_id = t2.download_id
                 WHERE t1.tag = ? AND t2.tag = ?
            `)
                .get(t1, t2).n;

            // Co-occurrence rate: how often they appear together vs apart
            const union = count1 + count2 - together;
            const rate = union > 0 ? together / union : 0;

            if (rate >= minRate && together >= minImages) {
                suggestions.push({
                    tag1: t1,
                    tag2: t2,
                    cooccurrence_rate: Math.round(rate * 100) / 100,
                    images_together: together,
                    images_tag1: count1,
                    images_tag2: count2,
                });
            }
        }
    }

    // Sort by cooccurrence rate DESC
    return suggestions.sort((a, b) => b.cooccurrence_rate - a.cooccurrence_rate);
}

// ---- WD14 tags ------------------------------------------------------------
//
// Stored in `image_tags_wd14` — separate from CLIP `image_tags` so the two
// sources can be independently scanned, cleared, and counted without schema
// migration on the existing tags table.
//
// Sidecar endpoint contract:
//   POST /tag-wd14  { path: "/abs/path.jpg" } OR { image_b64: "..." }
//   → 200 { tags: [{ tag: string, score: number }, …], rating?: string }
//   rating: "explicit" | "questionable" | "safe" (when the model emits it)
//
// The scan writes a `_wd14_scanned_` sentinel row with score=0 when the
// sidecar returns an empty tag list so the batch query skips this download
// on subsequent runs.

/**
 * Upsert WD14 tags for a download. Clears existing WD14 tags first so a
 * re-run produces a clean slate. Writes a sentinel row for empty results
 * so the download is marked as scanned.
 *
 * @param {number} downloadId
 * @param {{ tag: string, score: number }[]} tags
 */
export function setWd14Tags(downloadId, tags) {
    const db = getDb();
    const id = Number(downloadId);
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM image_tags_wd14 WHERE download_id = ?').run(id);
        if (Array.isArray(tags) && tags.length) {
            const stmt = db.prepare(
                `INSERT OR REPLACE INTO image_tags_wd14 (download_id, tag, score) VALUES (?, ?, ?)`,
            );
            for (const t of tags) {
                stmt.run(id, String(t.tag), Math.max(0, Math.min(1, Number(t.score) || 0)));
            }
        } else {
            // Sentinel — marks download as processed with no results
            db.prepare(
                `INSERT OR REPLACE INTO image_tags_wd14 (download_id, tag, score) VALUES (?, '_wd14_scanned_', 0)`,
            ).run(id);
        }
    });
    return tx();
}

/**
 * Remove all WD14 tags for a download (including the sentinel if present).
 */
export function clearWd14Tags(downloadId) {
    return getDb()
        .prepare('DELETE FROM image_tags_wd14 WHERE download_id = ?')
        .run(Number(downloadId)).changes;
}

/**
 * Return downloads that have no WD14 tag rows yet (i.e., not yet scanned).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.fileTypes=['photo']]
 * @param {number} [opts.limit=50]
 * @returns {{ id, file_path, file_type }[]}
 */
export function getUnscannedWd14Batch({ fileTypes = ['photo'], limit = 50 } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const ph = types.map(() => '?').join(',');
    return getDb()
        .prepare(
            `SELECT id, file_path, file_type
               FROM downloads
              WHERE file_type IN (${ph})
                AND id NOT IN (SELECT DISTINCT download_id FROM image_tags_wd14)
                AND LOWER(file_name) NOT LIKE '%.webp'
              ORDER BY created_at ASC
              LIMIT ?`,
        )
        .all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

/**
 * Count downloads that have no WD14 tag rows.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.fileTypes=['photo']]
 * @returns {number}
 */
export function countUnscannedWd14({ fileTypes = ['photo'] } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const ph = types.map(() => '?').join(',');
    return getDb()
        .prepare(
            `SELECT COUNT(*) AS n
               FROM downloads
              WHERE file_type IN (${ph})
                AND id NOT IN (SELECT DISTINCT download_id FROM image_tags_wd14)
                AND LOWER(file_name) NOT LIKE '%.webp'`,
        )
        .get(...types).n;
}

export function listWd14Tags({ minCount = 1, minScore = 0.2, limit = 500 } = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
    const ms = Math.max(0, Math.min(1, Number(minScore) || 0.2));
    const mc = Math.max(1, Number(minCount) || 1);
    return db
        .prepare(
            `SELECT tag, COUNT(*) AS count, ROUND(AVG(score), 4) AS avg_score
               FROM image_tags_wd14
              WHERE tag != '_wd14_scanned_' AND score >= ?
              GROUP BY tag
             HAVING COUNT(*) >= ?
              ORDER BY COUNT(*) DESC, tag ASC
              LIMIT ?`,
        )
        .all(ms, mc, lim);
}

export function listPhotosForWd14Tag(tag, { limit = 50, offset = 0, minScore = 0.2 } = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const ms = Math.max(0, Math.min(1, Number(minScore) || 0.2));
    const rows = db
        .prepare(
            `SELECT d.*, w.score AS tag_score
               FROM image_tags_wd14 w
               JOIN downloads d ON d.id = w.download_id
              WHERE w.tag = ? AND w.score >= ?
              ORDER BY w.score DESC, d.created_at DESC
              LIMIT ? OFFSET ?`,
        )
        .all(tag, ms, lim, off);
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM image_tags_wd14 WHERE tag = ? AND score >= ?`)
        .get(tag, ms).n;
    return { files: rows, total };
}

// ---- Image Text (OCR) --------------------------------------------------

export function setImageText(downloadId, text, language = null, confidence = null) {
    if (!downloadId) return 0;
    return getDb()
        .prepare(`
        INSERT INTO image_text (download_id, text, language, confidence, scanned_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(download_id) DO UPDATE SET text = excluded.text, language = excluded.language, confidence = excluded.confidence, scanned_at = excluded.scanned_at
    `)
        .run(
            Number(downloadId),
            String(text || '').slice(0, 50000),
            language,
            confidence,
            Math.floor(Date.now() / 1000),
        ).changes;
}

export function getImageText(downloadId) {
    return getDb()
        .prepare(
            `SELECT text, language, confidence, scanned_at FROM image_text WHERE download_id = ?`,
        )
        .get(Number(downloadId));
}

export function clearImageText(downloadId) {
    return getDb().prepare('DELETE FROM image_text WHERE download_id = ?').run(Number(downloadId))
        .changes;
}

export function getImagesWithText({ minLength = 10, limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const minLen = Math.max(1, Number(minLength) || 10);

    const rows = getDb()
        .prepare(`
        SELECT d.*, t.text, t.language, t.confidence
          FROM image_text t
          JOIN downloads d ON d.id = t.download_id
         WHERE LENGTH(t.text) >= ?
         ORDER BY t.scanned_at DESC
         LIMIT ? OFFSET ?
    `)
        .all(minLen, lim, off);

    const total = getDb()
        .prepare('SELECT COUNT(*) AS n FROM image_text WHERE LENGTH(text) >= ?')
        .get(minLen).n;

    return { files: rows, total };
}

/**
 * Return unique words extracted from OCR text, sorted by frequency descending.
 * Words are lowercased, stripped of non-alphanumeric, filtered by min length.
 * Returns [{ word, count }].
 */
export function listOcrWords({ minLength = 3, minCount = 1, limit = 100 } = {}) {
    const db = getDb();
    const rows = db.prepare('SELECT text FROM image_text WHERE length(text) > 0').all();
    const freq = {};
    for (const r of rows) {
        if (!r.text) continue;
        const seen = new Set();
        const words = r.text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length >= minLength);
        for (const w of words) {
            if (!seen.has(w)) {
                seen.add(w);
                freq[w] = (freq[w] || 0) + 1;
            }
        }
    }
    return Object.entries(freq)
        .filter(([, c]) => c >= minCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(1, Number(limit) || 100))
        .map(([word, cnt]) => ({ word, cnt }));
}

export function listPhotosForOcrWord(word, { limit = 50, offset = 0 } = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const pattern = `%${String(word).toLowerCase()}%`;
    const rows = db
        .prepare(
            `SELECT d.*, it.text AS ocr_text
               FROM image_text it
               JOIN downloads d ON d.id = it.download_id
              WHERE LOWER(it.text) LIKE ?
              ORDER BY d.created_at DESC
              LIMIT ? OFFSET ?`,
        )
        .all(pattern, lim, off);
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM image_text WHERE LOWER(text) LIKE ?`)
        .get(pattern).n;
    return { files: rows, total };
}

// ---- Smart Albums --------------------------------------------------------

/**
 * Allowed sub-rule types for compound smart album rules.
 */
const COMPOUND_RULE_TYPES = new Set([
    'tags_contains',
    'people_count',
    'semantic',
    'text_contains',
    'date',
    'file_type',
]);

/**
 * Normalise a smart album rule. v1 only accepted `tags_contains`;
 * v2 introduces `compound` (an AND/OR container of sub-rules) plus
 * several new leaf rule types.
 *
 * Throws on invalid rules — never return partial / silently-corrected
 * structures so the operator knows their input was rejected.
 */
export function _normalizeSmartAlbumRule(rule) {
    const type = String(rule?.type || '').trim();

    // --- v1 backward-compatible single rule ---------------------------
    if (type === 'tags_contains') {
        const tag = String(rule?.tag || '')
            .trim()
            .slice(0, 80);
        if (!tag) throw new Error('tags_contains: tag is required');
        const minScore = Math.max(0, Math.min(1, Number(rule?.minScore) || 0));
        return { type, tag, minScore };
    }

    // --- v2 compound rule ---------------------------------------------
    if (type === 'compound') {
        const all = Array.isArray(rule?.all) ? rule.all : [];
        const any = Array.isArray(rule?.any) ? rule.any : [];
        if (!all.length && !any.length) {
            throw new Error('compound: at least one of `all` or `any` is required');
        }
        const normalizedAll = all.map((sr) => _normalizeSmartAlbumSubRule(sr, 'all'));
        const normalizedAny = any.map((sr) => _normalizeSmartAlbumSubRule(sr, 'any'));
        return {
            type: 'compound',
            all: normalizedAll.length ? normalizedAll : undefined,
            any: normalizedAny.length ? normalizedAny : undefined,
            sort: String(rule?.sort || 'score_desc').slice(0, 30),
        };
    }

    throw new Error(
        `unsupported rule type "${escapeForError(type)}"; expected tags_contains or compound`,
    );
}

/** Normalise a single sub-rule inside a compound. */
function _normalizeSmartAlbumSubRule(sr, container) {
    const t = String(sr?.type || '').trim();
    if (!COMPOUND_RULE_TYPES.has(t)) {
        throw new Error(`${container}: unsupported sub-rule type "${escapeForError(t)}"`);
    }
    switch (t) {
        case 'tags_contains': {
            const tag = String(sr?.tag || '')
                .trim()
                .slice(0, 80);
            if (!tag) throw new Error('tags_contains: tag is required');
            const minScore = Math.max(0, Math.min(1, Number(sr?.minScore) || 0));
            return { type: t, tag, minScore };
        }
        case 'people_count': {
            const min = Math.max(0, Math.floor(Number(sr?.min) || 0));
            return { type: t, min };
        }
        case 'semantic': {
            const query = String(sr?.query || '')
                .trim()
                .slice(0, 200);
            if (!query) throw new Error('semantic: query is required');
            const minScore = Math.max(0, Math.min(1, Number(sr?.minScore) || 0));
            return { type: t, query, minScore };
        }
        case 'text_contains': {
            const substr = String(sr?.substring || '')
                .trim()
                .slice(0, 100);
            if (!substr) throw new Error('text_contains: substring is required');
            return { type: t, substring: substr };
        }
        case 'date': {
            const from =
                String(sr?.from || '')
                    .trim()
                    .slice(0, 20) || undefined;
            const to =
                String(sr?.to || '')
                    .trim()
                    .slice(0, 20) || undefined;
            if (!from && !to) throw new Error('date: at least one of from/to is required');
            return { type: t, from, to };
        }
        case 'file_type': {
            const ft = String(sr?.fileType || '')
                .trim()
                .toLowerCase()
                .slice(0, 10);
            if (!['photo', 'video', 'audio', 'file', 'voice'].includes(ft)) {
                throw new Error(`file_type: unsupported type "${escapeForError(ft)}"`);
            }
            return { type: t, fileType: ft };
        }
        default:
            throw new Error(`${container}: unhandled sub-rule type "${escapeForError(t)}"`);
    }
}

/** Minimal HTML/JSON-safe string for error messages. */
function escapeForError(s) {
    return String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function listSmartAlbums() {
    const db = getDb();
    return db
        .prepare(`
        SELECT a.id, a.name, a.rule_json, a.enabled, a.sort_key, a.created_at, a.updated_at,
               COUNT(i.download_id) AS item_count,
               MAX(i.matched_at) AS last_matched_at
          FROM smart_albums a
          LEFT JOIN smart_album_items i ON i.album_id = a.id
         GROUP BY a.id
         ORDER BY a.updated_at DESC, a.id DESC
    `)
        .all()
        .map((r) => ({
            ...r,
            enabled: Number(r.enabled) === 1,
            rule: (() => {
                try {
                    return JSON.parse(r.rule_json || '{}');
                } catch {
                    return {};
                }
            })(),
        }));
}

export function upsertSmartAlbum({
    id = null,
    name,
    rule,
    enabled = true,
    sortKey = 'created_at_desc',
}) {
    const db = getDb();
    const safeName = String(name || '')
        .trim()
        .slice(0, 120);
    if (!safeName) throw new Error('name is required');
    const normalizedRule = _normalizeSmartAlbumRule(rule);
    const now = Date.now();
    if (id == null) {
        const r = db
            .prepare(
                `INSERT INTO smart_albums (name, rule_json, enabled, sort_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                safeName,
                JSON.stringify(normalizedRule),
                enabled ? 1 : 0,
                String(sortKey || 'created_at_desc'),
                now,
                now,
            );
        return Number(r.lastInsertRowid);
    }
    const albumId = Number(id);
    if (!Number.isFinite(albumId) || albumId <= 0) throw new Error('invalid album id');
    const changed = db
        .prepare(
            `UPDATE smart_albums
                SET name = ?, rule_json = ?, enabled = ?, sort_key = ?, updated_at = ?
              WHERE id = ?`,
        )
        .run(
            safeName,
            JSON.stringify(normalizedRule),
            enabled ? 1 : 0,
            String(sortKey || 'created_at_desc'),
            now,
            albumId,
        ).changes;
    if (!changed) throw new Error('album not found');
    return albumId;
}

export function deleteSmartAlbum(id) {
    return getDb().prepare(`DELETE FROM smart_albums WHERE id = ?`).run(Number(id)).changes;
}

/**
 * Rebuild a smart album's materialised item list by matching every
 * download against the album's (possibly compound) rule. Handles
 * both v1 `tags_contains` rules and v2 `compound` rules with
 * sub-rules connected by `all` (intersection) or `any` (union).
 *
 * For semantic sub-rules the sidecar must be reachable — if it is
 * not, those sub-rules silently produce zero matches so the operator
 * sees an empty album rather than a crash.
 *
 * Now **async** — semantic sub-rules need an async embedding call
 * before the transaction starts. Existing callers must `await`.
 */
export async function rebuildSmartAlbum(id) {
    const db = getDb();
    const albumId = Number(id);
    if (!Number.isFinite(albumId) || albumId <= 0) throw new Error('invalid album id');
    const row = db
        .prepare(`SELECT id, rule_json, enabled FROM smart_albums WHERE id = ?`)
        .get(albumId);
    if (!row) throw new Error('album not found');
    const rule = _normalizeSmartAlbumRule(JSON.parse(row.rule_json || '{}'));

    // Pre-compute text embeddings for semantic sub-rules (async, outside txn)
    const embCache = new Map();
    if (rule.type === 'compound') {
        await _precomputeSemanticEmbeddings(rule, embCache);
    }

    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM smart_album_items WHERE album_id = ?`).run(albumId);
        if (Number(row.enabled) !== 1) return { matched: 0 };

        const matchedAt = Date.now();
        let matched = 0;
        let downloadIds;

        if (rule.type === 'tags_contains') {
            // v1 simple rule — existing path; spread Set → Array so .length works below
            downloadIds = [..._matchTagsContains(rule.tag, rule.minScore)];
        } else if (rule.type === 'compound') {
            downloadIds = _matchCompound(rule, embCache);
        } else {
            return { matched: 0 };
        }

        if (!downloadIds || !downloadIds.length) {
            db.prepare(`UPDATE smart_albums SET updated_at = ? WHERE id = ?`).run(
                Date.now(),
                albumId,
            );
            return { matched: 0 };
        }

        const ins = db.prepare(
            `INSERT OR IGNORE INTO smart_album_items (album_id, download_id, matched_at)
             VALUES (?, ?, ?)`,
        );
        for (const id of downloadIds) {
            matched += ins.run(albumId, id, matchedAt).changes;
        }
        db.prepare(`UPDATE smart_albums SET updated_at = ? WHERE id = ?`).run(Date.now(), albumId);
        return { matched };
    });
    return tx();
}

/**
 * Walk all sub-rules in a compound rule, find `semantic` ones, and
 * pre-compute their text embeddings via the sidecar. Populates
 * `embCache` keyed by the sub-rule index ("all-0", "any-1", etc.).
 */
async function _precomputeSemanticEmbeddings(rule, cache) {
    const tasks = [];
    if (Array.isArray(rule.all)) {
        for (let i = 0; i < rule.all.length; i++) {
            if (rule.all[i].type === 'semantic') {
                const idx = `all-${i}`;
                tasks.push(
                    _fetchEmbedding(rule.all[i].query)
                        .then((emb) => emb && cache.set(idx, emb))
                        .catch(() => {}),
                );
            }
        }
    }
    if (Array.isArray(rule.any)) {
        for (let i = 0; i < rule.any.length; i++) {
            if (rule.any[i].type === 'semantic') {
                const idx = `any-${i}`;
                tasks.push(
                    _fetchEmbedding(rule.any[i].query)
                        .then((emb) => emb && cache.set(idx, emb))
                        .catch(() => {}),
                );
            }
        }
    }
    await Promise.allSettled(tasks);
}

/**
 * Fetch a text embedding from the sidecar. Returns null if the
 * sidecar is unavailable.
 */
async function _fetchEmbedding(query) {
    try {
        const { embedText } = await import('../../core/ai/faces-client.js');
        const r = await embedText(query);
        if (r?.embedding?.length) return Float32Array.from(r.embedding);
    } catch {}
    return null;
}

/**
 * Evaluate a compound rule and return the set of matching download IDs.
 * `all` sub-rules are intersected, `any` sub-rules are unioned.
 */
function _matchCompound(rule, embCache = new Map()) {
    let allSet = null; // intersection accumulator
    let anySet = null; // union accumulator

    // `all` — every sub-rule must match (intersection)
    if (Array.isArray(rule.all) && rule.all.length) {
        for (let i = 0; i < rule.all.length; i++) {
            const ids = _matchSubRule(rule.all[i], embCache, `all-${i}`);
            if (!ids || !ids.size) {
                // One sub-rule matched nothing → intersection is empty
                allSet = new Set();
                break;
            }
            if (allSet === null) {
                allSet = new Set(ids);
            } else {
                allSet = new Set([...allSet].filter((id) => ids.has(id)));
            }
        }
    }

    // `any` — at least one sub-rule must match (union)
    if (Array.isArray(rule.any) && rule.any.length) {
        for (let i = 0; i < rule.any.length; i++) {
            const ids = _matchSubRule(rule.any[i], embCache, `any-${i}`);
            if (ids && ids.size) {
                if (anySet === null) {
                    anySet = new Set(ids);
                } else {
                    for (const id of ids) anySet.add(id);
                }
            }
        }
    }

    // Combine: (all) AND (any)
    if (allSet !== null && anySet !== null) {
        return [...allSet].filter((id) => anySet.has(id));
    }
    if (allSet !== null) return [...allSet];
    if (anySet !== null) return [...anySet];
    return [];
}

/**
 * Execute a single sub-rule and return a Set of matching download IDs.
 */
function _matchSubRule(sr, embCache = new Map(), cacheKey = '') {
    const db = getDb();
    switch (sr.type) {
        case 'tags_contains':
            return _matchTagsContains(sr.tag, sr.minScore);

        case 'people_count': {
            const rows = db
                .prepare(
                    `SELECT download_id
                       FROM faces
                      GROUP BY download_id
                     HAVING COUNT(*) >= ?`,
                )
                .all(sr.min);
            return new Set(rows.map((r) => Number(r.download_id)));
        }

        case 'semantic': {
            const embedding = embCache.get(cacheKey);
            if (!embedding) return new Set();
            return _matchEmbedding(embedding, sr.minScore);
        }

        case 'text_contains': {
            const like = `%${sr.substring}%`;
            const rows = db
                .prepare(
                    `SELECT DISTINCT download_id
                       FROM image_text
                      WHERE text LIKE ?`,
                )
                .all(like);
            return new Set(rows.map((r) => Number(r.download_id)));
        }

        case 'date': {
            let sql = `SELECT id FROM downloads WHERE 1=1`;
            const params = [];
            if (sr.from) {
                sql += ` AND created_at >= ?`;
                params.push(new Date(sr.from).getTime());
            }
            if (sr.to) {
                const toDate = new Date(sr.to);
                toDate.setDate(toDate.getDate() + 1);
                sql += ` AND created_at < ?`;
                params.push(toDate.getTime());
            }
            const rows = db.prepare(sql).all(...params);
            return new Set(rows.map((r) => Number(r.id)));
        }

        case 'file_type': {
            const rows = db
                .prepare(`SELECT id FROM downloads WHERE file_type = ?`)
                .all(sr.fileType);
            return new Set(rows.map((r) => Number(r.id)));
        }

        default:
            return new Set();
    }
}

/** Match a tags_contains sub-rule — returns a Set of download IDs. */
function _matchTagsContains(tag, minScore) {
    const db = getDb();
    const rows = db
        .prepare(
            `SELECT DISTINCT t.download_id
               FROM image_tags t
               JOIN downloads d ON d.id = t.download_id
              WHERE t.tag = ? AND t.score >= ?`,
        )
        .all(tag, minScore);
    return new Set(rows.map((r) => Number(r.download_id)));
}

/**
 * Match a pre-computed embedding against stored image embeddings using
 * cosine similarity. Returns a Set of download IDs whose similarity
 * is >= minScore.
 */
function _matchEmbedding(queryEmbedding, minScore) {
    const db = getDb();

    // Model hygiene: never mix semantic scores across different embedding
    // models. Use the most common stored model as the active one.
    const modelRow = db
        .prepare(
            `SELECT model, COUNT(*) AS cnt
               FROM image_embeddings
              GROUP BY model
              ORDER BY cnt DESC
              LIMIT 1`,
        )
        .get();
    const activeModel = modelRow?.model || null;
    const rows = activeModel
        ? db
              .prepare(`SELECT download_id, embedding FROM image_embeddings WHERE model = ?`)
              .all(activeModel)
        : db.prepare(`SELECT download_id, embedding FROM image_embeddings`).all();

    const q =
        queryEmbedding instanceof Float32Array ? queryEmbedding : Float32Array.from(queryEmbedding);
    const qNorm = Math.sqrt(q.reduce((a, b) => a + b * b, 0)) || 1;
    const qn = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) qn[i] = q[i] / qNorm;
    const dim = q.length;

    const matches = new Set();
    for (const row of rows) {
        if (!row.embedding || !row.embedding.byteLength) continue;
        const emb = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
        );
        if (emb.length !== dim) continue;
        const embNorm = Math.sqrt(emb.reduce((a, b) => a + b * b, 0)) || 1;
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += qn[i] * (emb[i] / embNorm);
        const score = Math.min(1, Math.max(-1, dot));
        if (score >= minScore) {
            matches.add(Number(row.download_id));
        }
    }
    return matches;
}

/**
 * Preview a smart-album rule without persisting anything.
 * Returns paged matching files + total count, mirroring listSmartAlbumItems.
 */
export async function previewSmartAlbumRule(rule, { limit = 50, offset = 0 } = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const normalized = _normalizeSmartAlbumRule(rule || {});

    // Precompute embeddings for semantic sub-rules.
    const embCache = new Map();
    if (normalized.type === 'compound') {
        await _precomputeSemanticEmbeddings(normalized, embCache);
    }

    let ids = [];
    if (normalized.type === 'tags_contains') {
        ids = [..._matchTagsContains(normalized.tag, normalized.minScore)];
    } else if (normalized.type === 'compound') {
        ids = _matchCompound(normalized, embCache);
    }

    if (!ids.length) {
        return { total: 0, files: [], rule: normalized };
    }

    // Materialise matched IDs into a temp table so pagination stays in SQL.
    // This avoids giant `IN (...)` statements and sidesteps SQLite's host
    // parameter limits on broad rules.
    const uniqIds = [
        ...new Set(ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)),
    ];
    if (!uniqIds.length) return { total: 0, files: [], rule: normalized };

    const tmpTable = `tmp_preview_ids_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.exec(`CREATE TEMP TABLE ${tmpTable} (id INTEGER PRIMARY KEY)`);
    try {
        const CHUNK = 500;
        const tx = db.transaction((arr) => {
            for (let i = 0; i < arr.length; i += CHUNK) {
                const chunk = arr.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => '(?)').join(',');
                db.prepare(`INSERT OR IGNORE INTO ${tmpTable} (id) VALUES ${placeholders}`).run(
                    ...chunk,
                );
            }
        });
        tx(uniqIds);

        const total =
            db
                .prepare(
                    `SELECT COUNT(*) AS n
                       FROM downloads d
                       JOIN ${tmpTable} t ON t.id = d.id`,
                )
                .get()?.n || 0;

        const files = db
            .prepare(
                `SELECT d.*
                   FROM downloads d
                   JOIN ${tmpTable} t ON t.id = d.id
                  ORDER BY d.created_at DESC, d.id DESC
                  LIMIT ? OFFSET ?`,
            )
            .all(lim, off);

        return { total, files, rule: normalized };
    } finally {
        db.exec(`DROP TABLE IF EXISTS ${tmpTable}`);
    }
}

export function listSmartAlbumItems(id, { limit = 50, offset = 0 } = {}) {
    const db = getDb();
    const albumId = Number(id);
    if (!Number.isFinite(albumId) || albumId <= 0) throw new Error('invalid album id');
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = db
        .prepare(
            `SELECT d.*, i.matched_at
               FROM smart_album_items i
               JOIN downloads d ON d.id = i.download_id
              WHERE i.album_id = ?
              ORDER BY d.created_at DESC, d.id DESC
              LIMIT ? OFFSET ?`,
        )
        .all(albumId, lim, off);
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM smart_album_items WHERE album_id = ?`)
        .get(albumId).n;
    return { files: rows, total };
}
