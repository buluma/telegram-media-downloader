import { getDb } from '../db.js';
import { kvGet } from './kv.js';

// ---- Normalized group config CRUD -----------------------------------------

/**
 * @typedef {object} GroupConfigRow
 * @property {string} id
 * @property {string} name
 * @property {string|null} type
 * @property {boolean} enabled
 * @property {import('../../config/manager.js').GroupFilters} filters
 * @property {boolean} trackComments
 * @property {string} rescueMode
 * @property {import('../../config/manager.js').AutoForwardSettings} autoForward
 * @property {{enabled: boolean, ids: number[]}} topics
 */

function _rowToGroupConfig(r) {
    const meta = JSON.parse(r.meta_json || '{}');
    return {
        id: r.id,
        name: r.name,
        ...(r.type ? { type: r.type } : {}),
        enabled: Boolean(r.enabled),
        filters: {
            photos: Boolean(r.photos ?? 1),
            videos: Boolean(r.videos ?? 0),
            files: Boolean(r.files ?? 1),
            links: Boolean(r.links ?? 1),
            voice: Boolean(r.voice ?? 1),
            audio: Boolean(r.audio ?? 0),
            gifs: Boolean(r.gifs ?? 0),
            stickers: Boolean(r.stickers ?? 0),
            urls: Boolean(r.urls ?? 1),
        },
        trackComments: Boolean(r.track_comments ?? 1),
        rescueMode: r.rescue_mode || 'auto',
        autoForward: {
            enabled: Boolean(r.fwd_enabled ?? 0),
            destination: r.destination || null,
            ...(r.account_id ? { account_id: r.account_id } : {}),
            deleteAfterForward: Boolean(r.delete_after ?? 1),
            keepImages: Boolean(r.keep_images ?? 1),
            keepVideos: Boolean(r.keep_videos ?? 0),
        },
        topics: {
            enabled: Boolean(r.topics_enabled ?? 0),
            ids: JSON.parse(r.topic_ids || '[]'),
        },
        ...meta,
    };
}

/**
 * Read all group configs from the normalized tables.
 * Returns an empty array if the groups table is unpopulated.
 *
 * @returns {GroupConfigRow[]}
 */
export function getAllGroupConfigs() {
    const db = getDb();
    const rows = db
        .prepare(
            `SELECT g.id, g.name, g.type, g.enabled,
                    f.photos, f.videos, f.files, f.links, f.voice, f.audio, f.gifs, f.stickers, f.urls,
                    fwd.enabled AS fwd_enabled, fwd.destination, fwd.account_id,
                    fwd.delete_after, fwd.keep_images, fwd.keep_videos,
                    s.track_comments, s.rescue_mode, s.max_disk_mb,
                    s.topics_enabled, s.topic_ids, s.meta_json
               FROM groups g
               LEFT JOIN group_filters  f   ON f.group_id   = g.id
               LEFT JOIN group_forward  fwd ON fwd.group_id = g.id
               LEFT JOIN group_settings s   ON s.group_id   = g.id
              ORDER BY g.created_at ASC, g.id ASC`,
        )
        .all();
    return rows.map(_rowToGroupConfig);
}

// Filter defaults mirror GROUP_DEFAULTS.filters in manager.js.
const _FILTER_DEFAULTS = {
    photos: 1,
    videos: 0,
    files: 1,
    links: 1,
    voice: 1,
    audio: 0,
    gifs: 0,
    stickers: 0,
    urls: 1,
};
function _fb(filters, key) {
    if (!filters || !(key in filters)) return _FILTER_DEFAULTS[key];
    return filters[key] ? 1 : 0;
}

function _upsertGroupTx(db, group) {
    const gid = String(group.id);
    const now = Date.now();
    const f = group.filters;
    const af = group.autoForward || {};
    const topics = group.topics || {};

    const metaKeys = [
        'trackUsers',
        'monitorAccount',
        'ownerPeerId',
        'forwardAccount',
        'backupPeerId',
        'failoverAt',
        'rescueRetentionHours',
        'backfillSchedule',
        'backfillLimit',
        'maxVideoSize',
        '_resolveFailedAt',
        '_resolveFailedReason',
    ];
    const meta = {};
    for (const k of metaKeys) {
        if (group[k] !== undefined) meta[k] = group[k];
    }

    db.prepare(`
        INSERT INTO groups (id, name, type, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name       = excluded.name,
            type       = excluded.type,
            enabled    = excluded.enabled,
            updated_at = excluded.updated_at
    `).run(gid, group.name || '', group.type || null, group.enabled ? 1 : 0, now, now);

    db.prepare(`
        INSERT INTO group_filters (group_id, photos, videos, files, links, voice, audio, gifs, stickers, urls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
            photos=excluded.photos, videos=excluded.videos, files=excluded.files,
            links=excluded.links, voice=excluded.voice, audio=excluded.audio,
            gifs=excluded.gifs, stickers=excluded.stickers, urls=excluded.urls
    `).run(
        gid,
        _fb(f, 'photos'),
        _fb(f, 'videos'),
        _fb(f, 'files'),
        _fb(f, 'links'),
        _fb(f, 'voice'),
        _fb(f, 'audio'),
        _fb(f, 'gifs'),
        _fb(f, 'stickers'),
        _fb(f, 'urls'),
    );

    db.prepare(`
        INSERT INTO group_forward (group_id, enabled, destination, account_id, delete_after, keep_images, keep_videos)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
            enabled=excluded.enabled, destination=excluded.destination,
            account_id=excluded.account_id, delete_after=excluded.delete_after,
            keep_images=excluded.keep_images, keep_videos=excluded.keep_videos
    `).run(
        gid,
        af.enabled ? 1 : 0,
        af.destination || null,
        af.account_id || null,
        af.deleteAfterForward !== false ? 1 : 0,
        af.keepImages !== false ? 1 : 0,
        af.keepVideos ? 1 : 0,
    );

    db.prepare(`
        INSERT INTO group_settings (group_id, track_comments, rescue_mode, max_disk_mb, topics_enabled, topic_ids, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
            track_comments=excluded.track_comments, rescue_mode=excluded.rescue_mode,
            max_disk_mb=excluded.max_disk_mb, topics_enabled=excluded.topics_enabled,
            topic_ids=excluded.topic_ids, meta_json=excluded.meta_json
    `).run(
        gid,
        group.trackComments !== false ? 1 : 0,
        group.rescueMode || 'auto',
        group.maxDiskMb || null,
        topics.enabled ? 1 : 0,
        JSON.stringify(topics.ids || []),
        JSON.stringify(meta),
    );
}

/**
 * Insert or update a single group config in the normalized tables.
 *
 * @param {object} group - GroupConfig shape from manager.js
 */
export function upsertGroupConfig(group) {
    const db = getDb();
    db.transaction(() => _upsertGroupTx(db, group))();
}

/**
 * Atomically sync the full group list to the normalized tables.
 * Groups present in the DB but absent from `groups` are deleted (cascade
 * removes their child rows).
 *
 * @param {object[]} groups
 */
export function syncGroupConfigs(groups) {
    if (!Array.isArray(groups)) return;
    const db = getDb();
    const ids = groups.map((g) => String(g.id));
    db.transaction(() => {
        for (const g of groups) _upsertGroupTx(db, g);
        if (ids.length > 0) {
            const ph = ids.map(() => '?').join(',');
            db.prepare(`DELETE FROM groups WHERE id NOT IN (${ph})`).run(...ids);
        } else {
            db.prepare('DELETE FROM groups').run();
        }
    })();
}

/**
 * Remove a group and all its child settings rows (ON DELETE CASCADE).
 *
 * @param {string|number} groupId
 */
export function deleteGroupConfig(groupId) {
    getDb().prepare('DELETE FROM groups WHERE id = ?').run(String(groupId));
}

/**
 * One-shot migration helper exposed for testing. The runtime migration runs
 * inside initSchema() in db.js; this export lets tests drive it directly
 * against an already-initialized DB without going through initSchema again.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function _migrateGroupsFromKv(db) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
    if (count > 0) return;

    let stored;
    try {
        stored = kvGet('config');
    } catch {
        return;
    }

    const kvGroups = stored?.groups;
    if (!Array.isArray(kvGroups) || kvGroups.length === 0) return;

    const now = Date.now();
    const insGroup = db.prepare(`
        INSERT OR IGNORE INTO groups (id, name, type, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    const insFilters = db.prepare(`
        INSERT OR IGNORE INTO group_filters (group_id, photos, videos, files, links, voice, audio, gifs, stickers, urls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insForward = db.prepare(`
        INSERT OR IGNORE INTO group_forward (group_id, enabled, destination, account_id, delete_after, keep_images, keep_videos)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insSettings = db.prepare(`
        INSERT OR IGNORE INTO group_settings (group_id, track_comments, rescue_mode, max_disk_mb, topics_enabled, topic_ids, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);

    db.transaction(() => {
        for (const g of kvGroups) {
            const gid = String(g.id);
            const f = g.filters || {};
            const af = g.autoForward || {};
            const topics = g.topics || {};
            const meta = {};
            if (g.trackUsers !== undefined) meta.trackUsers = g.trackUsers;
            if (g.monitorAccount !== undefined) meta.monitorAccount = g.monitorAccount;
            if (g.ownerPeerId !== undefined) meta.ownerPeerId = g.ownerPeerId;
            if (g.forwardAccount !== undefined) meta.forwardAccount = g.forwardAccount;

            insGroup.run(gid, g.name || '', g.type || null, g.enabled ? 1 : 0, now, now);
            insFilters.run(
                gid,
                _fb(f, 'photos'),
                _fb(f, 'videos'),
                _fb(f, 'files'),
                _fb(f, 'links'),
                _fb(f, 'voice'),
                _fb(f, 'audio'),
                _fb(f, 'gifs'),
                _fb(f, 'stickers'),
                _fb(f, 'urls'),
            );
            insForward.run(
                gid,
                af.enabled ? 1 : 0,
                af.destination || null,
                af.account_id || null,
                af.deleteAfterForward !== false ? 1 : 0,
                af.keepImages !== false ? 1 : 0,
                af.keepVideos ? 1 : 0,
            );
            insSettings.run(
                gid,
                g.trackComments !== false ? 1 : 0,
                g.rescueMode || 'auto',
                g.maxDiskMb || null,
                topics.enabled ? 1 : 0,
                JSON.stringify(topics.ids || []),
                JSON.stringify(meta),
            );
        }
    })();
}

/**
 * Per-group stats card backing query — single index-only scan over
 * `idx_group_message`. Returns the totals the Group → Data tab renders
 * above its file strip. Cheap enough to call on every modal open.
 *
 * Shape:
 *   { totalFiles, totalBytes, byType: {photo, video, audio, document, sticker, voice},
 *     firstMessageId, lastMessageId, lastDownloadAt }
 */
export function getGroupStats(groupId) {
    const db = getDb();
    const totals =
        db
            .prepare(`
            SELECT COUNT(*) AS totalFiles,
                   COALESCE(SUM(COALESCE(file_size, 0)), 0) AS totalBytes,
                   MIN(message_id) AS firstMessageId,
                   MAX(message_id) AS lastMessageId,
                   MAX(created_at) AS lastDownloadAt
              FROM downloads
             WHERE group_id = ?
        `)
            .get(String(groupId)) || {};
    const rows = db
        .prepare(`
            SELECT file_type, COUNT(*) AS n
              FROM downloads
             WHERE group_id = ?
             GROUP BY file_type
        `)
        .all(String(groupId));
    const byType = {};
    for (const r of rows) byType[r.file_type || 'other'] = Number(r.n) || 0;
    return {
        totalFiles: Number(totals.totalFiles) || 0,
        totalBytes: Number(totals.totalBytes) || 0,
        byType,
        firstMessageId: totals.firstMessageId == null ? null : Number(totals.firstMessageId),
        lastMessageId: totals.lastMessageId == null ? null : Number(totals.lastMessageId),
        lastDownloadAt: totals.lastDownloadAt || null,
    };
}

/**
 * Paginated file list for the Group → Data tab. Uses `idx_group_message`
 * for the WHERE filter + the index's natural ordering for the LIMIT/OFFSET
 * scan, so a 100k-row group still opens the modal in <500 ms.
 */
export function listGroupFiles({
    groupId,
    limit = 50,
    offset = 0,
    type = null,
    textSearch = null,
} = {}) {
    const db = getDb();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    const textTerm = typeof textSearch === 'string' && textSearch.trim() ? textSearch.trim() : null;

    if (textTerm) {
        // Text-search path: JOIN image_text so we can filter by OCR content.
        const typeClause = type ? `AND d.file_type = ?` : '';
        const baseSql = `
            FROM downloads d
            JOIN image_text it ON it.download_id = d.id
           WHERE d.group_id = ?
             AND it.text LIKE ?
             ${typeClause}
        `;
        const baseArgs = [String(groupId), `%${textTerm}%`];
        if (type) baseArgs.push(type);

        const total = db.prepare(`SELECT COUNT(*) AS n ${baseSql}`).get(...baseArgs).n || 0;
        const rows = db
            .prepare(`
                SELECT d.id, d.message_id, d.file_name, d.file_path, d.file_type,
                       d.file_size, d.created_at, d.nsfw_score,
                       SUBSTR(it.text, 1, 200) AS ocr_snippet
                  ${baseSql}
                 ORDER BY d.created_at DESC, d.id DESC
                 LIMIT ? OFFSET ?
            `)
            .all(...baseArgs, lim, off);
        return { rows, total, limit: lim, offset: off, hasMore: off + rows.length < total };
    }

    const where = ['group_id = ?'];
    const args = [String(groupId)];
    if (type && typeof type === 'string') {
        where.push('file_type = ?');
        args.push(type);
    }
    const whereSql = where.join(' AND ');
    const total =
        db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ${whereSql}`).get(...args).n || 0;
    const rows = db
        .prepare(`
            SELECT id, message_id, file_name, file_path, file_type, file_size, created_at, nsfw_score
              FROM downloads
             WHERE ${whereSql}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?
        `)
        .all(...args, lim, off);
    return {
        rows,
        total,
        limit: lim,
        offset: off,
        hasMore: off + rows.length < total,
    };
}

/**
 * Delete download records for a specific group.
 * @param {string} groupId - Telegram group ID
 * @param {{ skipPinned?: boolean, skipPhotos?: boolean }} [opts]
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteGroupDownloads(groupId, { skipPinned = false, skipPhotos = false } = {}) {
    const db = getDb();
    const clauses = ['group_id = ?'];
    if (skipPinned) clauses.push('COALESCE(pinned, 0) = 0');
    if (skipPhotos) clauses.push("COALESCE(file_type, '') != 'photo'");
    const del1 = db
        .prepare(`DELETE FROM downloads WHERE ${clauses.join(' AND ')}`)
        .run(String(groupId));
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
    const stmt = db.prepare(
        'UPDATE downloads SET group_name = ? WHERE group_id = ? AND group_name IS NULL',
    );
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
