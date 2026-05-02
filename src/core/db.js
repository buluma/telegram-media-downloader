import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

// Singleton connection
let db;

export function getDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Performance tuning
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // Without busy_timeout, a long write (sweeper bulk delete) makes
    // concurrent readers fail INSTANTLY with SQLITE_BUSY instead of
    // waiting. 5 s gives us plenty of headroom for the longest write
    // we currently issue (rescue sweeper batches 5000 rows).
    db.pragma('busy_timeout = 5000');
    // Tame WAL growth on sustained writes — checkpoint every ~1000 pages.
    db.pragma('wal_autocheckpoint = 1000');
    // Per-connection FK enforcement — required for ON DELETE CASCADE on
    // share_links (and any future FK we add). Set BEFORE initSchema so the
    // first row insert / migration honors it.
    db.pragma('foreign_keys = ON');

    initSchema();
    return db;
}

function initSchema() {
    // Downloads Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            group_name TEXT,
            message_id INTEGER NOT NULL,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT, -- photo, video, document
            file_path TEXT,
            status TEXT DEFAULT 'completed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_id ON downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_created_at ON downloads(created_at);
    `);

    // Forward-compatible column migrations. Each ALTER is wrapped in its own
    // try/catch so adding column N+1 doesn't get blocked by column N already
    // existing.
    const migrations = [
        'ALTER TABLE downloads ADD COLUMN group_name TEXT',
        'ALTER TABLE downloads ADD COLUMN ttl_seconds INTEGER',
        'ALTER TABLE downloads ADD COLUMN file_hash TEXT',
        // pinned: rows with pinned=1 are protected from auto-rotation sweeps.
        'ALTER TABLE downloads ADD COLUMN pinned INTEGER DEFAULT 0',
        // Rescue Mode: rows with a non-null pending_until are auto-pruned by
        // the rescue sweeper after that timestamp UNLESS the source message
        // was deleted on Telegram first (in which case rescued_at gets set
        // and pending_until is cleared, keeping the file forever).
        'ALTER TABLE downloads ADD COLUMN pending_until INTEGER',
        'ALTER TABLE downloads ADD COLUMN rescued_at INTEGER',
        // NSFW review (Phase 1: photos only).
        //   nsfw_score        — REAL 0..1 from the classifier (NULL = never scanned).
        //   nsfw_checked_at   — unix-ms of the last successful classification;
        //                       set even when score is NULL (e.g. file missing on
        //                       disk) so we don't keep retrying forever.
        //   nsfw_whitelist    — admin clicked "Mark as not 18+"; persistent so
        //                       re-scans skip the row and the review sheet
        //                       hides it.
        'ALTER TABLE downloads ADD COLUMN nsfw_score REAL',
        'ALTER TABLE downloads ADD COLUMN nsfw_checked_at INTEGER',
        'ALTER TABLE downloads ADD COLUMN nsfw_whitelist INTEGER DEFAULT 0',
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch { /* column already exists */ }
    }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_filename_size ON downloads(group_id, file_name, file_size)'); } catch {}
    // Speeds up the rescue sweeper's expired-pending scan and the per-message
    // markRescued lookup. Both are cheap CREATE-IF-NOT-EXISTS calls.
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_pending_until ON downloads(pending_until) WHERE pending_until IS NOT NULL'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_group_message ON downloads(group_id, message_id)'); } catch {}
    // Indexes that drive the NSFW review sheet's hot queries:
    //   - "what's left to scan" (file_type='photo' AND nsfw_checked_at IS NULL)
    //   - "show flagged sorted by score desc" (whitelist=0 AND score >= threshold)
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_nsfw_unscanned ON downloads(file_type, nsfw_checked_at) WHERE nsfw_checked_at IS NULL'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_nsfw_review ON downloads(nsfw_score, nsfw_whitelist) WHERE nsfw_score IS NOT NULL'); } catch {}

    // Smoke-test every column the rest of the code path depends on. The
    // ALTER TABLE migrations above swallow "column already exists" so they
    // also swallow real failures (out-of-disk, locked DB, corrupt schema).
    // A failed migration was previously discovered at query time —
    // halfway through a download — as a generic "no such column" runtime
    // error. Forcing the SELECT here makes us fail at boot instead.
    try {
        db.prepare('SELECT pinned, pending_until, rescued_at, ttl_seconds, file_hash, nsfw_score, nsfw_checked_at, nsfw_whitelist FROM downloads LIMIT 0').all();
    } catch (e) {
        throw new Error(`DB schema migration incomplete — column missing after ALTER TABLE: ${e.message}. Inspect data/db.sqlite or restore from backup.`);
    }

    // Queue/Pending Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            meta TEXT, -- JSON payload
            priority INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending', -- pending, processing, failed
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Share Links — admin-issued tokens that let a non-user (e.g. friend
    // with the URL) stream/download a single download without logging in.
    // The HMAC-signed URL is the cryptographic gate; this table is what
    // makes per-link revocation + audit possible (the row is the source
    // of truth for revoked_at, and the access counters surface usage in
    // the admin "Active share links" sheet).
    //
    // ON DELETE CASCADE on download_id means deleting/purging a file
    // automatically kills every outstanding share link for that file —
    // critical so a revoked file doesn't keep streaming bytes from disk.
    db.exec(`
        CREATE TABLE IF NOT EXISTS share_links (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id      INTEGER NOT NULL,
            created_at       INTEGER NOT NULL,
            expires_at       INTEGER NOT NULL,
            revoked_at       INTEGER,
            label            TEXT,
            last_accessed_at INTEGER,
            access_count     INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_share_links_download ON share_links(download_id);
        CREATE INDEX IF NOT EXISTS idx_share_links_expiry ON share_links(expires_at);
    `);
    // FK enforcement is per-connection in SQLite — flip it on once we know
    // the table exists. Without this, ON DELETE CASCADE silently no-ops.
    try { db.pragma('foreign_keys = ON'); } catch {}
}

// ---- Share links ----------------------------------------------------------

/**
 * Insert a new share-link row and return its id + creation timestamp.
 * The signed URL itself is built by `share.js` after this returns; this
 * table is purely the revocation/audit source of truth.
 */
export function createShareLink({ downloadId, expiresAt, label = null }) {
    const now = Date.now();
    const stmt = getDb().prepare(`
        INSERT INTO share_links (download_id, created_at, expires_at, label, access_count)
        VALUES (?, ?, ?, ?, 0)
    `);
    const r = stmt.run(Number(downloadId), now, Number(expiresAt), label || null);
    return { id: r.lastInsertRowid, createdAt: now };
}

/**
 * Lookup the row that backs a /share/<id> request. Returns null when the
 * row doesn't exist OR is revoked OR is expired — the verifier treats
 * "not found" as 401 across the board so an attacker can't tell the
 * three apart by timing/response shape.
 */
export function getShareLinkForServe(id, now = Date.now()) {
    const row = getDb().prepare(`
        SELECT s.*, d.file_path, d.file_name, d.file_type, d.file_size
          FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         WHERE s.id = ?
    `).get(Number(id));
    if (!row) return null;
    if (row.revoked_at != null) return { row, reason: 'revoked' };
    // expires_at === 0 is the "never expires" sentinel — the admin opted
    // out of the time-based gate at mint time. Revocation still works.
    if (row.expires_at !== 0 && row.expires_at <= now) {
        return { row, reason: 'expired' };
    }
    return { row, reason: null };
}

/**
 * Bump the access counter + last_accessed_at after a successful serve.
 * Cheap single-row UPDATE; safe to call inside the request handler.
 */
export function bumpShareLinkAccess(id) {
    try {
        getDb().prepare(`
            UPDATE share_links
               SET access_count = access_count + 1,
                   last_accessed_at = ?
             WHERE id = ?
        `).run(Date.now(), Number(id));
    } catch { /* non-fatal — bytes already on the wire */ }
}

export function revokeShareLink(id) {
    const r = getDb().prepare(`
        UPDATE share_links
           SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL
    `).run(Date.now(), Number(id));
    return r.changes > 0;
}

/**
 * List share-links. Pass `{ downloadId }` to filter to one file (used by
 * the per-file Share sheet); omit it for the admin's "all shares" sheet.
 * Joins the underlying download so the UI can render the file name +
 * group context without a second round-trip.
 */
export function listShareLinks({ downloadId = null, includeRevoked = true, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (downloadId != null) { where.push('s.download_id = ?'); args.push(Number(downloadId)); }
    if (!includeRevoked) where.push('s.revoked_at IS NULL');
    const sql = `
        SELECT s.id, s.download_id, s.created_at, s.expires_at, s.revoked_at,
               s.label, s.last_accessed_at, s.access_count,
               d.file_name, d.file_type, d.file_size, d.group_id, d.group_name
          FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY s.created_at DESC
         LIMIT ?
    `;
    return getDb().prepare(sql).all(...args, Math.max(1, Math.min(2000, limit)));
}

export function insertDownload(data) {
    const row = {
        groupId: data.groupId,
        groupName: data.groupName ?? null,
        messageId: data.messageId,
        fileName: data.fileName ?? null,
        fileSize: data.fileSize ?? null,
        fileType: data.fileType ?? null,
        filePath: data.filePath ?? null,
        ttlSeconds: data.ttlSeconds ?? null,
        fileHash: data.fileHash ?? null,
        // Rescue Mode: when set, the rescue sweeper auto-deletes this row
        // after the timestamp unless the source is deleted first.
        pendingUntil: data.pendingUntil ?? null,
    };
    const stmt = getDb().prepare(`
        INSERT OR IGNORE INTO downloads (
            group_id, group_name, message_id, file_name, file_size, file_type, file_path, ttl_seconds, file_hash, pending_until
        ) VALUES (
            @groupId, @groupName, @messageId, @fileName, @fileSize, @fileType, @filePath, @ttlSeconds, @fileHash, @pendingUntil
        )
    `);
    return stmt.run(row);
}

/**
 * Mark a row as rescued — the source message was deleted on Telegram, so
 * the local file gets to live forever. Clears pending_until so the rescue
 * sweeper skips it. Idempotent: a second call with the same id is a no-op.
 *
 * @param {string|number} groupId
 * @param {number} messageId
 * @returns {number} rows updated (0 or 1; >1 only if duplicate inserts exist)
 */
export function markRescued(groupId, messageId) {
    const now = Date.now();
    const r = getDb()
        .prepare(`
            UPDATE downloads
               SET rescued_at = ?, pending_until = NULL
             WHERE group_id = ? AND message_id = ?
               AND rescued_at IS NULL
        `)
        .run(now, String(groupId), Number(messageId));
    return r.changes;
}

/**
 * Rows whose pending window has elapsed without a source-delete event.
 * The rescue sweeper unlinks the file + drops the row for each one.
 */
export function getExpiredPending(now = Date.now()) {
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, pending_until
              FROM downloads
             WHERE pending_until IS NOT NULL
               AND pending_until < ?
               AND rescued_at IS NULL
             ORDER BY pending_until ASC
             LIMIT 5000
        `)
        .all(Number(now));
}

/**
 * Counters for the Rescue panel in the SPA. `lastSweepCleared` is updated
 * by the sweeper via setRescueLastSweep().
 */
let _rescueLastSwept = 0;
export function setRescueLastSweep(n) {
    _rescueLastSwept = Number(n) || 0;
}
export function getRescueStats() {
    const db = getDb();
    const pending = db
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE pending_until IS NOT NULL AND rescued_at IS NULL`)
        .get().c;
    const rescued = db
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE rescued_at IS NOT NULL`)
        .get().c;
    return { pending, rescued, lastSweepCleared: _rescueLastSwept };
}

/**
 * Lightweight dedup that catches the same file re-uploaded under a new
 * message_id. Returns true if (group_id, file_name, file_size) already
 * exists. Cheap thanks to the (group_id, file_name, file_size) index.
 */
export function fileAlreadyStored(groupId, fileName, fileSize) {
    if (!fileName || !fileSize) return false;
    const r = _prep('SELECT 1 FROM downloads WHERE group_id = ? AND file_name = ? AND file_size = ? LIMIT 1')
        .get(String(groupId), String(fileName), Number(fileSize));
    return !!r;
}

// Hot-path prepared-statement cache. `isDownloaded()` is called per message
// in every monitor pass and per row by the dedup pre-check, so re-preparing
// the same SQL each call was a measurable parse cost. The cache is lazily
// populated on first DB access since `getDb()` is also lazy.
const _stmtCache = new Map();
function _prep(sql) {
    let s = _stmtCache.get(sql);
    if (!s) {
        s = getDb().prepare(sql);
        _stmtCache.set(sql, s);
    }
    return s;
}

export function isDownloaded(groupId, messageId) {
    return !!_prep('SELECT 1 FROM downloads WHERE group_id = ? AND message_id = ? LIMIT 1')
        .get(String(groupId), Number(messageId));
}

/**
 * Min + max message_id for one group in the downloads table.
 *
 * Powers the v2.3.34 smart-resume path in the history backfill: we tell
 * gramJS `iterMessages({ maxId: minMessageId - 1 })` so the iterator
 * skips every message we already have on disk and resumes from the
 * oldest hole. Same idea in reverse with `minId: maxMessageId + 1` for
 * the post-monitor-restart catch-up flow.
 *
 * Returns `{ minMessageId: null, maxMessageId: null, count: 0 }` for an
 * empty group so the caller can default to "first-time backfill" (no
 * range filter, iterate from newest).
 */
export function getMessageIdRange(groupId) {
    const r = getDb().prepare(`
        SELECT MIN(message_id) AS min_id, MAX(message_id) AS max_id, COUNT(*) AS n
          FROM downloads
         WHERE group_id = ?
    `).get(String(groupId));
    return {
        minMessageId: r?.min_id ?? null,
        maxMessageId: r?.max_id ?? null,
        count: r?.n ?? 0,
    };
}

/**
 * All-Media query — same shape as getDownloads() but spans every group, with
 * the per-row group_id + group_name preserved so the gallery can paint the
 * right tile and the viewer can route back to the source chat. Powers the
 * `/api/downloads/all` endpoint that the All-Media surface uses for true
 * infinite-scroll across the full library (previous All-Media path was
 * capped at 20 groups × 20 files = ~400 max — see v2.3.6 blocker).
 */
export function getAllDownloads(limit = 50, offset = 0, type = 'all') {
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeMap = { images: 'photo', videos: 'video', documents: 'document', audio: 'audio' };
    const params = [];
    let where = '';
    if (type !== 'all' && typeMap[type]) {
        where = ' WHERE file_type = ?';
        params.push(typeMap[type]);
    }
    const rows = getDb()
        .prepare(`SELECT * FROM downloads${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, lim, off);
    const total = getDb()
        .prepare(`SELECT COUNT(*) AS c FROM downloads${where}`)
        .get(...params).c;
    return { files: rows, total };
}

export function getDownloads(groupId, limit = 50, offset = 0, type = 'all') {
    let query = 'SELECT * FROM downloads WHERE group_id = ?';
    const params = [groupId];

    if (type !== 'all') {
        const typeMap = {
            'images': 'photo',
            'videos': 'video',
            'documents': 'document',
            'audio': 'audio'
        };
        // Use LIKE for flexibility or map precisely
        if (typeMap[type]) {
             query += ' AND file_type = ?';
             params.push(typeMap[type]);
        }
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = getDb().prepare(query);
    const rows = stmt.all(...params);
    
    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM downloads WHERE group_id = ?';
    const countParams = [groupId];
    
    // We reuse the type filter logic for count but it's cleaner to separate or build dynamically
    // For simplicity here:
    if (params.length > 3) { // If type filter was added
         countQuery += ' AND file_type = ?';
         countParams.push(params[1]); // existing type param
    }
    
    const total = getDb().prepare(countQuery).get(...countParams).total;

    return { files: rows, total };
}

/**
 * Full-text-ish search over downloaded files. LIKE-based; cheap on the
 * sub-100k row counts we expect.
 *
 * @param {string} query  user input
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.groupId]  optional restrict to one group
 */
export function searchDownloads(query, opts = {}) {
    const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const q = `%${String(query || '').trim()}%`;
    const params = [q, q];
    let where = '(file_name LIKE ? OR group_name LIKE ?)';
    if (opts.groupId) { where += ' AND group_id = ?'; params.push(String(opts.groupId)); }
    const rows = getDb()
        .prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    const total = getDb()
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE ${where}`)
        .get(...params).c;
    return { files: rows, total };
}

/** Bulk-delete by ids (preferred) or file_paths. Returns the number removed. */
export function deleteDownloadsBy(opts) {
    const db = getDb();
    if (Array.isArray(opts?.ids) && opts.ids.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE id = ?');
        const tx = db.transaction(() => opts.ids.reduce((n, id) => n + stmt.run(id).changes, 0));
        return tx();
    }
    if (Array.isArray(opts?.filePaths) && opts.filePaths.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE file_path = ?');
        const tx = db.transaction(() => opts.filePaths.reduce((n, p) => n + stmt.run(p).changes, 0));
        return tx();
    }
    return 0;
}

export function getStats() {
    const db = getDb();
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM downloads').get().count;
    const totalSize = db.prepare('SELECT SUM(file_size) as size FROM downloads').get().size || 0;
    return { totalFiles, totalSize };
}

/**
 * Sum of file_size across all download rows (NULL sizes are treated as 0).
 * Used by the disk rotator to decide whether the cap is exceeded.
 */
export function getTotalSizeBytes() {
    const r = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as size FROM downloads').get();
    return Number(r?.size || 0);
}

/**
 * Returns the N oldest download rows (created_at ASC), skipping pinned ones.
 * The rotator pulls from this list and deletes file + row until the cap is
 * back under the limit.
 */
export function getOldestDownloads(count = 50) {
    const limit = Math.max(1, Math.min(10000, parseInt(count, 10) || 50));
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, created_at, pinned
            FROM downloads
            WHERE COALESCE(pinned, 0) = 0
            ORDER BY datetime(created_at) ASC, id ASC
            LIMIT ?
        `)
        .all(limit);
}

/**
 * Delete all download records for a specific group
 * @param {string} groupId - Telegram group ID
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteGroupDownloads(groupId) {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads WHERE group_id = ?').run(String(groupId));
    const del2 = db.prepare('DELETE FROM queue WHERE group_id = ?').run(String(groupId));
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Delete ALL download and queue records
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteAllDownloads() {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads').run();
    const del2 = db.prepare('DELETE FROM queue').run();
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Backfill group_name for existing records using config groups.
 * Call once on startup after config is loaded.
 * @param {Array<{id: string|number, name: string}>} groups - Config groups
 * @returns {number} Number of records updated
 */
export function backfillGroupNames(groups) {
    if (!groups || groups.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare('UPDATE downloads SET group_name = ? WHERE group_id = ? AND group_name IS NULL');
    let updated = 0;
    const tx = db.transaction(() => {
        for (const g of groups) {
            if (g.name) {
                const result = stmt.run(g.name, String(g.id));
                updated += result.changes;
            }
        }
    });
    tx();
    return updated;
}

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
    const types = (Array.isArray(fileTypes) && fileTypes.length) ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const db = getDb();
    const total = db.prepare(
        `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders})`
    ).get(...types).n;
    const scanned = db.prepare(
        `SELECT COUNT(*) AS n FROM downloads WHERE file_type IN (${placeholders}) AND nsfw_checked_at IS NOT NULL`
    ).get(...types).n;
    // candidates = LOW-score rows (likely not 18+) — what the admin reviews.
    const candidates = db.prepare(
        `SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0`
    ).get(...types, Number(threshold)).n;
    // keep = HIGH-score rows (likely 18+) — the curated content stays put.
    const keep = db.prepare(
        `SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score >= ?`
    ).get(...types, Number(threshold)).n;
    const whitelisted = db.prepare(
        `SELECT COUNT(*) AS n FROM downloads WHERE nsfw_whitelist = 1`
    ).get().n;
    const lastCheckedAt = db.prepare(
        `SELECT MAX(nsfw_checked_at) AS t FROM downloads WHERE file_type IN (${placeholders})`
    ).get(...types).t;
    return { totalEligible: total, scanned, candidates, keep, whitelisted, lastCheckedAt };
}

/**
 * Pull a batch of rows that haven't been classified yet. Whitelisted rows
 * are skipped — admin already approved them. Sorted oldest-first so the
 * resume-after-restart path picks up backlog rather than newly-arrived
 * downloads.
 */
export function getUnscannedNsfwBatch(fileTypes, limit = 50) {
    const types = (Array.isArray(fileTypes) && fileTypes.length) ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    return getDb().prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_checked_at IS NULL
           AND nsfw_whitelist = 0
         ORDER BY created_at ASC
         LIMIT ?
    `).all(...types, Math.max(1, Math.min(500, Number(limit) || 50)));
}

/**
 * Persist a classification result. `score` may be NULL when the file
 * couldn't be read (missing on disk, decode failure) — we still set
 * `nsfw_checked_at` so the scan loop doesn't keep retrying the same
 * unreadable row forever.
 */
export function setNsfwResult(id, score, now = Date.now()) {
    const s = score == null ? null : Math.max(0, Math.min(1, Number(score)));
    return getDb().prepare(`
        UPDATE downloads
           SET nsfw_score = ?, nsfw_checked_at = ?
         WHERE id = ?
    `).run(s, Math.floor(now), Number(id)).changes;
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
    const types = (Array.isArray(fileTypes) && fileTypes.length) ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const t = Number(threshold);
    const p = Math.max(1, Number(page) || 1);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const offset = (p - 1) * lim;
    const db = getDb();
    const totalRow = db.prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0
    `).get(...types, t);
    const rows = db.prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size,
               created_at, nsfw_score, nsfw_checked_at
          FROM downloads
         WHERE file_type IN (${placeholders})
           AND nsfw_score IS NOT NULL
           AND nsfw_score < ?
           AND nsfw_whitelist = 0
         ORDER BY nsfw_score ASC, id ASC
         LIMIT ? OFFSET ?
    `).all(...types, t, lim, offset);
    const total = totalRow.n;
    return { rows, total, page: p, totalPages: Math.max(1, Math.ceil(total / lim)) };
}

/**
 * Mark rows as admin-confirmed-18+. They're hidden from the review
 * sheet forever (until manually un-whitelisted). Use when the
 * classifier's score is misleadingly low for a genuinely 18+ image
 * — admin overrides the false negative.
 */
export function whitelistNsfw(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const cleanIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return 0;
    const ph = cleanIds.map(() => '?').join(',');
    return getDb().prepare(
        `UPDATE downloads SET nsfw_whitelist = 1 WHERE id IN (${ph})`
    ).run(...cleanIds).changes;
}
