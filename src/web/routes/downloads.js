import express from 'express';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getDb, getDownloads, getAllDownloads, searchDownloads, deleteDownloadsBy,
    setDownloadPinned, getDownloadById } from '../../core/db.js';
import { sanitizeName } from '../../core/downloader.js';
import { purgeThumbsForDownload } from '../../core/thumbs.js';

/**
 * Downloads listing, search, pin, bulk-delete, bulk-zip, and single-file delete routes.
 *
 * @param {object} ctx
 * @param {string}   ctx.configPath
 * @param {string}   ctx.downloadsDir
 * @param {string}   ctx.photosDir
 * @param {Function} ctx.broadcast
 * @param {Function} ctx.getJobTracker        (key) => JobTracker
 * @param {Function} ctx.getDialogsNameCache  async () => Map<id, name>
 * @param {Function} ctx.bestGroupName        (id, configName, dbName, dialogsName) => string
 * @param {Function} ctx.dialogsTypeFor       (id) => string|null
 * @param {Function} ctx.safeResolveDownload  async (userPath) => {ok, real?, reason?}
 * @param {Function} ctx.formatBytes          (bytes) => string
 */
export function createDownloadsRouter({
    configPath, downloadsDir, photosDir, broadcast,
    getJobTracker, getDialogsNameCache, bestGroupName, dialogsTypeFor,
    safeResolveDownload, formatBytes,
}) {
    const router = express.Router();

    router.get('/api/downloads', async (req, res) => {
        try {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const configGroups = config.groups || [];
            const db = getDb();

            // CASE-filter "Unknown" / numeric-id placeholders BEFORE MAX so
            // a group with mixed rows ["Cool Channel", "Unknown"] returns
            // "Cool Channel" instead of the lexically-larger "Unknown".
            const rows = db.prepare(`
                SELECT group_id,
                       MAX(CASE
                             WHEN group_name IS NOT NULL
                              AND group_name != ''
                              AND group_name != 'Unknown'
                              AND group_name != 'unknown'
                              AND group_name NOT GLOB '-?[0-9]*'
                              AND group_name NOT GLOB 'Group [0-9]*'
                           THEN group_name END) AS best_name,
                       MAX(group_name) AS any_name,
                       COUNT(*) as count,
                       SUM(file_size) as size
                  FROM downloads
                 GROUP BY group_id
            `).all();

            const dialogsNames = await getDialogsNameCache();

            const results = rows.map(r => {
                const cfg = configGroups.find(g => String(g.id) === r.group_id);
                const name = bestGroupName(
                    r.group_id,
                    cfg?.name,
                    r.best_name || r.any_name,
                    dialogsNames.get(String(r.group_id)),
                );
                const hasPhoto = existsSync(path.join(photosDir, `${r.group_id}.jpg`));

                return {
                    id: r.group_id,
                    name: name,
                    // Type drives the sidebar avatar's corner badge
                    // (channel = megaphone / group = group icon / user / bot).
                    type: cfg?.type || dialogsTypeFor(r.group_id),
                    totalFiles: r.count,
                    sizeFormatted: formatBytes(r.size || 0),
                    photoUrl: hasPhoto ? `/photos/${r.group_id}.jpg` : null,
                    enabled: cfg ? cfg.enabled : false
                };
            }).filter(Boolean);

            res.json(results);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 5a. All-Media: paginated cross-group feed. Pre-v2.3.6 the SPA simulated
    // this by fanning out 20 per-group queries × 20 files = a hard cap of 400
    // files visible regardless of how big the library actually was. Now the DB
    // does the ORDER BY across every group, the SPA gets clean infinite-scroll,
    // and per-tab type filters (`?type=images|videos|documents|audio`) produce
    // accurate counts.
    router.get('/api/downloads/all', async (req, res) => {
        try {
            const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
            const type  = req.query.type || 'all';
            const offset = (page - 1) * limit;
            const pinnedOnly  = req.query.pinned === '1' || req.query.pinned === 'true';
            const pinnedFirst = req.query.pinnedFirst === '1' || req.query.pinnedFirst === 'true';
            const result = getAllDownloads(limit, offset, type, { pinnedOnly, pinnedFirst });

            let config = {};
            try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch { /* fall back to row.group_name */ }
            const configGroups = new Map((config.groups || []).map(g => [String(g.id), g]));
            const files = result.files.map(row => {
                const typeFolder = row.file_type === 'photo' ? 'images'
                    : row.file_type === 'video' ? 'videos'
                    : row.file_type === 'audio' ? 'audio'
                    : row.file_type === 'sticker' ? 'stickers'
                    : 'documents';
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const fallbackFolder = sanitizeName(
                    configGroups.get(String(row.group_id))?.name
                    || row.group_name
                    || String(row.group_id)
                );
                const fullPath = stored && stored.includes('/')
                    ? stored
                    : `${fallbackFolder}/${typeFolder}/${row.file_name}`;
                return {
                    id: row.id,
                    name: row.file_name,
                    path: row.file_path,
                    fullPath,
                    size: row.file_size,
                    sizeFormatted: formatBytes(row.file_size),
                    type: typeFolder,
                    extension: path.extname(row.file_name || ''),
                    modified: row.created_at,
                    groupId: row.group_id,
                    groupName: configGroups.get(String(row.group_id))?.name || row.group_name || null,
                    pendingUntil: row.pending_until || null,
                    rescuedAt: row.rescued_at || null,
                    pinned: !!row.pinned,
                };
            });

            res.json({ files, total: result.total, page, totalPages: Math.ceil(result.total / limit) });
        } catch (e) {
            console.error('GET /api/downloads/all:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 5. Downloads Per Group (SQLite Pagination).
    // Reject the literal "search" segment up-front — Express matches routes in
    // declaration order, and there's a `GET /api/downloads/search` further down
    // that the SPA calls for free-text search. Without this guard the search
    // route would be shadowed and always return an empty group payload.
    router.get('/api/downloads/:groupId', async (req, res, next) => {
        if (req.params.groupId === 'search') return next();
        try {
            const { groupId } = req.params;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const type = req.query.type || 'all';
            const offset = (page - 1) * limit;

            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
            const dbRow = getDb().prepare('SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(String(groupId));
            const groupFolder = sanitizeName(configGroup?.name || dbRow?.group_name || 'unknown');

            const pinnedOnly  = req.query.pinned === '1' || req.query.pinned === 'true';
            const pinnedFirst = req.query.pinnedFirst === '1' || req.query.pinnedFirst === 'true';
            const result = getDownloads(groupId, limit, offset, type, { pinnedOnly, pinnedFirst });

            // DB `file_path` stores the path RELATIVE to data/downloads (set
            // by downloader.js via path.relative(DOWNLOADS_DIR, …)). USE that
            // as the source of truth — re-deriving from sanitize(group.name)
            // breaks every file that was downloaded under a different folder
            // name (e.g. "Unknown" before the group was named, or a renamed
            // group whose old folder still has the old files).
            const files = result.files.map(row => {
                const typeFolder = row.file_type === 'photo' ? 'images'
                    : row.file_type === 'video' ? 'videos'
                    : row.file_type === 'audio' ? 'audio'
                    : row.file_type === 'sticker' ? 'stickers'
                    : 'documents';

                const stored = (row.file_path || '').replace(/\\/g, '/');
                const fullPath = stored && stored.includes('/')
                    ? stored
                    : `${groupFolder}/${typeFolder}/${row.file_name}`;

                return {
                    id: row.id,
                    name: row.file_name,
                    path: row.file_path,
                    fullPath,
                    size: row.file_size,
                    sizeFormatted: formatBytes(row.file_size),
                    type: typeFolder,
                    extension: path.extname(row.file_name),
                    modified: row.created_at,
                    pendingUntil: row.pending_until || null,
                    rescuedAt: row.rescued_at || null,
                    pinned: !!row.pinned,
                };
            });

            res.json({
                files,
                total: result.total,
                page,
                totalPages: Math.ceil(result.total / limit)
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Search across all downloads (filename + group name).
    router.get('/api/downloads/search', async (req, res) => {
        try {
            const q = String(req.query.q || '').trim();
            if (!q) return res.json({ files: [], total: 0, page: 1, totalPages: 0 });
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
            const groupId = req.query.groupId ? String(req.query.groupId) : undefined;
            const r = searchDownloads(q, { limit, offset: (page - 1) * limit, groupId });

            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const groupFolderById = new Map();
            for (const g of (config.groups || [])) groupFolderById.set(String(g.id), sanitizeName(g.name));

            const files = r.files.map(row => {
                const folder = groupFolderById.get(String(row.group_id)) || sanitizeName(row.group_name || 'unknown');
                const typeFolder = row.file_type === 'photo' ? 'images'
                    : row.file_type === 'video' ? 'videos'
                    : row.file_type === 'audio' ? 'audio'
                    : row.file_type === 'sticker' ? 'stickers' : 'documents';
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const fullPath = stored && stored.includes('/')
                    ? stored
                    : `${folder}/${typeFolder}/${row.file_name}`;
                return {
                    id: row.id,
                    groupId: row.group_id,
                    groupName: row.group_name,
                    name: row.file_name,
                    fullPath,
                    size: row.file_size,
                    sizeFormatted: formatBytes(row.file_size),
                    type: typeFolder,
                    modified: row.created_at,
                    pendingUntil: row.pending_until || null,
                    rescuedAt: row.rescued_at || null,
                };
            });
            res.json({ files, total: r.total, page, totalPages: Math.ceil(r.total / limit), q });
        } catch (e) {
            console.error('GET /api/downloads/search:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Bulk delete by id list or fullPath list.
    // At N=5000 the unlink loop runs minutes; converted to fire-and-forget
    // so a Cloudflare timeout can't kill the request mid-stream. Shares the
    // `dedupDelete` tracker with the duplicate finder + gallery selection.
    router.post('/api/downloads/bulk-delete', async (req, res) => {
        const { ids, paths } = req.body || {};
        const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
        const pathList = Array.isArray(paths) ? paths : [];
        if (!idList.length && !pathList.length) {
            return res.status(400).json({ error: 'ids or paths required' });
        }
        const tracker = getJobTracker('dedupDelete');
        const r = tracker.tryStart(async ({ onProgress }) => {
            const total = idList.length + pathList.length;
            let processed = 0;
            let unlinked = 0;
            onProgress({ processed: 0, total, stage: 'deleting_files' });
            for (const p of pathList) {
                const sr = await safeResolveDownload(p);
                if (sr.ok) {
                    try { await fs.unlink(sr.real); unlinked++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
                processed += 1;
                if (processed % 50 === 0 || processed === total) {
                    onProgress({ processed, total, stage: 'deleting_files' });
                }
            }
            if (idList.length) {
                const db = getDb();
                const rows = db.prepare(`SELECT id, group_id, group_name, file_name, file_type FROM downloads WHERE id IN (${idList.map(() => '?').join(',')})`).all(...idList);
                const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
                const folderById = new Map();
                for (const g of (config.groups || [])) folderById.set(String(g.id), sanitizeName(g.name));
                for (const row of rows) {
                    const folder = folderById.get(String(row.group_id)) || sanitizeName(row.group_name || 'unknown');
                    const typeFolder = row.file_type === 'photo' ? 'images'
                        : row.file_type === 'video' ? 'videos'
                        : row.file_type === 'audio' ? 'audio'
                        : row.file_type === 'sticker' ? 'stickers' : 'documents';
                    const candidate = `${folder}/${typeFolder}/${row.file_name}`;
                    const sr = await safeResolveDownload(candidate);
                    if (sr.ok) {
                        try { await fs.unlink(sr.real); unlinked++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
                    }
                    processed += 1;
                    if (processed % 50 === 0 || processed === total) {
                        onProgress({ processed, total, stage: 'deleting_files' });
                    }
                }
            }
            const dbDeleted = deleteDownloadsBy({ ids: idList, filePaths: pathList });
            onProgress({ processed: total, total, stage: 'purging_thumbs' });
            for (const id of idList) {
                try { await purgeThumbsForDownload(id); } catch {}
            }
            broadcast({ type: 'bulk_delete', unlinked, dbDeleted });
            return { unlinked, dbDeleted, requested: total };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A bulk delete is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true, queued: idList.length + pathList.length });
    });

    // Toggle the `pinned` flag on a single download row. Pinned rows survive
    // auto-rotation and (optionally) sort to the top of the gallery.
    router.post('/api/downloads/:id/pin', async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
        const { pinned } = req.body || {};
        if (typeof pinned !== 'boolean') {
            return res.status(400).json({ error: 'Body must include `pinned` (boolean)' });
        }
        const row = getDownloadById(id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        const ok = setDownloadPinned(id, pinned);
        if (!ok) return res.status(500).json({ error: 'Update failed' });
        broadcast({ type: 'download_pinned', id, pinned });
        res.json({ success: true, id, pinned });
    });

    // Streaming bulk download as a ZIP. Body: `{ ids: [1,2,3] }`. Server walks
    // each id, resolves its on-disk file via the same safe-resolver every other
    // route uses, and pipes a STORE-mode (no compression) ZIP to the response.
    // Filename: `tgdl-<groupNameOr"library">-<count>files-<timestamp>.zip`.
    //
    // Cross-platform: pure JS, no native deps, no archiver package. Streams
    // each file from disk so a 5 GB selection doesn't OOM the server.
    router.post('/api/downloads/bulk-zip', async (req, res) => {
        try {
            const { ids } = req.body || {};
            const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
            if (idList.length === 0) return res.status(400).json({ error: 'ids required' });

            const { ZipStream, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, safeArchiveName }
                = await import('../../core/zip-stream.js');

            if (idList.length > ZIP_MAX_ENTRIES) {
                return res.status(413).json({ error: `Too many files in one ZIP (cap ${ZIP_MAX_ENTRIES}). Split into smaller batches.` });
            }

            const db = getDb();
            const placeholders = idList.map(() => '?').join(',');
            const rows = db.prepare(`SELECT id, group_id, group_name, file_name, file_size, file_type, file_path FROM downloads WHERE id IN (${placeholders})`)
                .all(...idList);

            if (rows.length === 0) return res.status(404).json({ error: 'No matching files' });

            let configGroups = new Map();
            try {
                const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
                for (const g of (cfg.groups || [])) configGroups.set(String(g.id), g);
            } catch { /* fall back to row.group_name */ }

            const entries = [];
            let totalBytes = 0;
            const seenNames = new Set();
            for (const row of rows) {
                const folder = sanitizeName(configGroups.get(String(row.group_id))?.name
                    || row.group_name
                    || String(row.group_id || 'group'));
                const typeFolder = row.file_type === 'photo' ? 'images'
                    : row.file_type === 'video' ? 'videos'
                    : row.file_type === 'audio' ? 'audio'
                    : row.file_type === 'sticker' ? 'stickers' : 'documents';
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const candidate = stored && stored.includes('/')
                    ? stored
                    : `${folder}/${typeFolder}/${row.file_name}`;
                const sr = await safeResolveDownload(candidate);
                if (!sr.ok) continue;

                const baseName = safeArchiveName(row.file_name || `file-${row.id}`);
                // Name collisions get a numeric suffix so two photos with the
                // same Telegram filename land as `foo.jpg` and `foo (1).jpg`.
                let archiveName = `${folder}/${baseName}`;
                let n = 1;
                while (seenNames.has(archiveName)) {
                    const ext = path.extname(baseName);
                    const stem = baseName.slice(0, baseName.length - ext.length);
                    archiveName = `${folder}/${stem} (${n})${ext}`;
                    n++;
                }
                seenNames.add(archiveName);
                entries.push({ absPath: sr.real, archiveName, size: row.file_size || 0 });
                totalBytes += row.file_size || 0;
            }

            if (entries.length === 0) {
                return res.status(404).json({ error: 'No accessible files in selection' });
            }
            if (totalBytes > ZIP_MAX_BYTES) {
                return res.status(413).json({
                    error: `Selection exceeds 4 GiB ZIP cap (${formatBytes(totalBytes)}). Split into smaller batches.`,
                });
            }

            const firstGroup = entries[0].archiveName.split('/')[0];
            const allSameGroup = entries.every(e => e.archiveName.startsWith(firstGroup + '/'));
            const labelGroup = allSameGroup ? firstGroup : 'library';
            const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
            const archiveBase = `tgdl-${safeArchiveName(labelGroup)}-${entries.length}files-${ts}.zip`;

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${archiveBase}"`);
            // Streaming archive — no Content-Length, must disable any
            // intermediate buffering.
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Transfer-Encoding', 'chunked');

            const zip = new ZipStream();
            zip.pipe(res);
            try {
                for (const e of entries) {
                    if (res.destroyed || res.writableEnded) break;
                    await zip.addFile(e.absPath, e.archiveName);
                }
                await zip.finalize();
            } catch (err) {
                if (!res.headersSent) res.status(500).json({ error: err.message });
                else res.destroy(err);
            }
        } catch (err) {
            console.error('POST /api/downloads/bulk-zip:', err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
            else res.destroy(err);
        }
    });

    // 6. Delete File (Physical + DB)
    router.delete('/api/file', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) return res.status(400).json({ error: 'Path required' });

            const r = await safeResolveDownload(filePath);
            if (!r.ok) {
                const status = r.reason === 'missing' ? 404 : 403;
                return res.status(status).json({ error: r.reason === 'missing' ? 'File not found' : 'Access denied' });
            }

            await fs.unlink(r.real);
            console.log(`🗑️ Deleted: ${filePath}`);

            // Remove from DB (by basename — the DB stores filenames, not paths).
            // Capture matching ids first so we can wipe their cached thumbnails;
            // a stale thumb pointing at a deleted file would otherwise serve
            // bytes from cache until the next "Rebuild thumbnails".
            const db = getDb();
            const fileName = path.basename(r.real);
            const matchingIds = db.prepare('SELECT id FROM downloads WHERE file_name = ?')
                .all(fileName).map(row => row.id);
            db.prepare('DELETE FROM downloads WHERE file_name = ?').run(fileName);
            for (const id of matchingIds) {
                try { await purgeThumbsForDownload(id); } catch {}
            }

            broadcast({ type: 'file_deleted', path: filePath });
            res.json({ success: true });
        } catch (error) {
            if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
            console.error('DELETE /api/file:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    return router;
}
