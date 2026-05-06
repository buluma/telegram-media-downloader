import express from 'express';
import fs from 'fs/promises';
import fsSync, { existsSync } from 'fs';
import path from 'path';
import { getDb, deleteGroupDownloads, deleteAllDownloads,
    getNsfwTierCounts, getNsfwHistogram, getNsfwListByTier,
    reclassifyNsfw, unwhitelistNsfw, NSFW_TIERS } from '../../core/db.js';
import { sanitizeName } from '../../core/downloader.js';
import * as integrity from '../../core/integrity.js';
import { findDuplicates as dedupFindDuplicates, deleteByIds as dedupDeleteByIds } from '../../core/dedup.js';
import { getOrCreateThumb, purgeThumbsForDownload, purgeAllThumbs,
    getThumbsCacheStats, buildAllThumbnails, hasFfmpeg,
    ALLOWED_WIDTHS as THUMB_WIDTHS } from '../../core/thumbs.js';
import { startScan as nsfwStartScan, cancelScan as nsfwCancelScan,
    isScanRunning as nsfwIsScanRunning, getScanState as nsfwGetScanState,
    preloadClassifier as nsfwPreloadClassifier, clearClassifierCache as nsfwClearCache,
    classifierReady as nsfwClassifierReady,
    NSFW_DEFAULTS, getNsfwStats, getNsfwDeleteCandidates,
    whitelistNsfw } from '../../core/nsfw.js';
import { isAuthConfigured, loginVerify, revokeAllSessions } from '../../core/web-auth.js';
import { SESSION_COOKIE_OPTS } from './auth.js';

function tgAuthErrorBody(e) {
    if (e?.code === 'NO_API_CREDS') {
        return {
            status: 503,
            body: { error: 'Telegram API credentials not configured. Add telegram.apiId and telegram.apiHash in Settings first.', code: 'NO_API_CREDS' },
        };
    }
    return { status: 400, body: { error: e?.message || 'Bad request' } };
}

/**
 * Maintenance, purge, thumbnails, NSFW, and log routes.
 *
 * @param {object} ctx
 * @param {string}   ctx.configPath
 * @param {string}   ctx.downloadsDir
 * @param {string}   ctx.photosDir
 * @param {string}   ctx.logsDir
 * @param {string}   ctx.sessionsDir
 * @param {Function} ctx.getAccountManager
 * @param {object}   ctx.runtime
 * @param {Function} ctx.loadConfig
 * @param {Function} ctx.readConfigSafe
 * @param {Function} ctx.writeConfigAtomic
 * @param {Function} ctx.broadcast
 * @param {Function} ctx.log
 * @param {Function} ctx.resolveEntityAcrossAccounts
 * @param {Function} ctx.downloadProfilePhoto
 * @param {Function} ctx.resetDialogsCaches
 * @param {Function} ctx.clearEntityCache
 * @param {Function} ctx.getSecureSession   () => SecureSession instance
 * @param {Function} ctx.getJobTracker      (key) => JobTracker
 * @param {Function} ctx.getGroupPurgeTracker (groupId) => JobTracker
 * @param {Function} ctx.getLogBuffer       () => log entry array
 */
export function createMaintenanceRouter({
    configPath, downloadsDir, photosDir, logsDir, sessionsDir,
    getAccountManager, runtime, loadConfig, readConfigSafe, writeConfigAtomic,
    broadcast, log,
    resolveEntityAcrossAccounts, downloadProfilePhoto, resetDialogsCaches, clearEntityCache,
    getSecureSession, getJobTracker, getGroupPurgeTracker, getLogBuffer,
}) {
    const router = express.Router();

    function _requireConfirm(req, res) {
        if (req.body?.confirm !== true) {
            res.status(400).json({ error: 'Pass {"confirm": true} in the request body to proceed.' });
            return false;
        }
        return true;
    }

    // Stronger guard for irreversible / sensitive ops (export Telegram session,
    // sign-out-everywhere). Forces the user to retype their dashboard password
    // in the request body — the cookie alone isn't enough because a session
    // hijacker would already have it.
    async function _requirePassword(req, res) {
        const supplied = req.body?.password;
        if (typeof supplied !== 'string' || !supplied) {
            res.status(400).json({ error: 'Password required' });
            return false;
        }
        try {
            const config = await readConfigSafe();
            if (!isAuthConfigured(config.web)) {
                res.status(403).json({ error: 'Auth not configured' });
                return false;
            }
            // SECURITY: loginVerify returns `{ok: boolean, upgrade?: boolean}`,
            // NOT a bare boolean. Treating the object as truthy (the previous
            // bug) made any non-empty string a valid "password" — turning
            // Export-Session into a full account-takeover surface for anyone
            // who already holds a session cookie.
            const result = loginVerify(supplied, config.web);
            if (!result?.ok) {
                res.status(403).json({ error: 'Invalid password' });
                return false;
            }
        } catch {
            res.status(500).json({ error: 'Internal error' });
            return false;
        }
        return true;
    }

    function _nsfwCfg() {
        try {
            const cfg = loadConfig().advanced?.nsfw || {};
            return {
                enabled: cfg.enabled === true,
                model: cfg.model || NSFW_DEFAULTS.model,
                threshold: Number.isFinite(cfg.threshold) ? cfg.threshold : NSFW_DEFAULTS.threshold,
                concurrency: Number.isFinite(cfg.concurrency) ? cfg.concurrency : NSFW_DEFAULTS.concurrency,
                batchSize: Number.isFinite(cfg.batchSize) ? cfg.batchSize : NSFW_DEFAULTS.batchSize,
                fileTypes: (Array.isArray(cfg.fileTypes) && cfg.fileTypes.length)
                    ? cfg.fileTypes : NSFW_DEFAULTS.fileTypes,
                cacheDir: cfg.cacheDir || NSFW_DEFAULTS.cacheDir,
            };
        } catch {
            return { ...NSFW_DEFAULTS, enabled: false };
        }
    }

    function _nsfwStateLight() {
        try {
            const cfg = _nsfwCfg();
            const s = getNsfwStats(cfg.fileTypes, cfg.threshold);
            return { ...s, running: nsfwIsScanRunning() };
        } catch { return {}; }
    }

    // Resolve a bulk-action filter into an explicit id list, then run the
    // requested action. Single funnel keeps the four bulk endpoints (delete /
    // whitelist / unwhitelist / reclassify) consistent.
    async function _resolveBulkIds(body) {
        if (Array.isArray(body?.ids) && body.ids.length) {
            return body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        }
        const cfg = _nsfwCfg();
        const fileTypes = Array.isArray(body?.fileTypes) && body.fileTypes.length
            ? body.fileTypes
            : cfg.fileTypes;
        // Walk the entire matching set page-by-page so very large tiers (15 000
        // rows in `def_not`) don't exceed any single-query limit.
        const all = [];
        let page = 1;
        while (true) {
            const r = getNsfwListByTier({
                tier: body?.tier || null,
                fileTypes,
                groupId: body?.groupId || null,
                includeWhitelisted: body?.includeWhitelisted === true,
                page,
                limit: 200,
            });
            for (const row of r.rows) {
                const sc = Number(row.nsfw_score);
                if (Number.isFinite(body?.scoreMax) && sc >= body.scoreMax) continue;
                if (Number.isFinite(body?.scoreMin) && sc < body.scoreMin) continue;
                all.push(row.id);
            }
            if (page >= r.totalPages) break;
            page += 1;
        }
        return all;
    }

    // Module-level state scoped to the factory closure.
    let _reindexBgRunning = false;

    let _dedupRunning = false;
    let _dedupState = {
        running: false, stage: 'idle',
        processed: 0, total: 0, hashed: 0, groups: 0,
        startedAt: 0, finishedAt: 0,
        result: null, error: null,
    };

    const THUMB_MISS_WINDOW_MS = 15 * 60_000;
    const THUMB_MISS_FLOOR = 200;
    const THUMB_MISS_COOLDOWN_MS = 30 * 60_000;
    let _thumbMissBatch = { count: 0, resetAt: 0, lastWarnedAt: 0 };

    let _thumbBuildRunning = false;
    let _thumbBuildState = {
        running: false,
        stage: 'idle',
        processed: 0, total: 0,
        built: 0, skipped: 0, errored: 0, scanned: 0,
        startedAt: 0, finishedAt: 0, error: null,
    };

    // ── Purge: group ──────────────────────────────────────────────────────────

    // Fire-and-forget — a chat with 10k files takes minutes of disk I/O to
    // rm. POST returns immediately; per-group tracker key (`group_purge_*`)
    // allows multi-flight across distinct groups while preventing a
    // double-click on the same row from firing twice.
    router.delete('/api/groups/:id/purge', async (req, res) => {
        const groupId = req.params.id;
        const tracker = getGroupPurgeTracker(groupId);
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
            const dbRow = getDb().prepare('SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(String(groupId));
            const groupName = configGroup?.name || dbRow?.group_name || 'unknown';
            const folderName = sanitizeName(groupName);
            onProgress({ stage: 'counting', groupId });

            // 1. Delete files on disk.
            const folderPath = path.join(downloadsDir, folderName);
            let filesDeleted = 0;
            if (existsSync(folderPath)) {
                const countFiles = (dir) => {
                    let count = 0;
                    const items = fsSync.readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
                        else count++;
                    }
                    return count;
                };
                filesDeleted = countFiles(folderPath);
                onProgress({ stage: 'deleting_files', groupId, total: filesDeleted, processed: 0 });
                await fs.rm(folderPath, { recursive: true, force: true });
                onProgress({ stage: 'deleting_files', groupId, total: filesDeleted, processed: filesDeleted });
            }

            // 2. Delete DB records
            onProgress({ stage: 'deleting_rows', groupId });
            const dbResult = deleteGroupDownloads(groupId);

            // 3. Remove from config
            config.groups = (config.groups || []).filter(g => String(g.id) !== String(groupId));
            await writeConfigAtomic(config);

            // 4. Delete profile photo
            const photoPath = path.join(photosDir, `${groupId}.jpg`);
            if (existsSync(photoPath)) await fs.unlink(photoPath);

            console.log(`PURGED: ${groupName} — ${filesDeleted} files, ${dbResult.deletedDownloads} DB records`);
            broadcast({ type: 'group_purged', groupId });
            return {
                groupId,
                deleted: {
                    files: filesDeleted,
                    dbRecords: dbResult.deletedDownloads,
                    queueRecords: dbResult.deletedQueue,
                    group: groupName,
                },
            };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A purge for this group is already running', code: 'ALREADY_RUNNING', snapshot: r.snapshot });
        }
        res.json({ success: true, started: true, groupId });
    });

    router.get('/api/groups/:id/purge/status', async (req, res) => {
        const groupId = req.params.id;
        const tracker = getGroupPurgeTracker(groupId);
        res.json(tracker.getStatus());
    });

    // ── Purge: all ────────────────────────────────────────────────────────────

    // Fire-and-forget — a full library wipe is the slowest, most destructive
    // admin action we have. Returns 200 immediately; final counts via
    // `purge_all_done`. Single-flight via the shared tracker.
    router.delete('/api/purge/all', async (req, res) => {
        const tracker = getJobTracker('purgeAll');
        const r = tracker.tryStart(async ({ onProgress }) => {
            let totalFiles = 0;
            const dirs = existsSync(downloadsDir)
                ? fsSync.readdirSync(downloadsDir, { withFileTypes: true })
                : [];
            const groupDirs = dirs.filter(d => d.isDirectory());
            const totalGroups = groupDirs.length;
            let processed = 0;
            onProgress({ processed: 0, total: totalGroups, stage: 'deleting_files' });
            for (const dir of groupDirs) {
                const dirPath = path.join(downloadsDir, dir.name);
                try {
                    totalFiles += fsSync.readdirSync(dirPath, { recursive: true }).length;
                } catch {}
                await fs.rm(dirPath, { recursive: true, force: true });
                processed += 1;
                onProgress({ processed, total: totalGroups, stage: 'deleting_files' });
            }

            onProgress({ stage: 'deleting_rows' });
            const dbResult = deleteAllDownloads();

            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            config.groups = [];
            await writeConfigAtomic(config);

            if (existsSync(photosDir)) {
                const photos = fsSync.readdirSync(photosDir);
                for (const photo of photos) {
                    await fs.unlink(path.join(photosDir, photo)).catch(() => {});
                }
            }

            console.log(`PURGE ALL: ${totalFiles} files, ${dbResult.deletedDownloads} DB records`);
            broadcast({ type: 'purge_all' });
            return {
                deleted: {
                    files: totalFiles,
                    dbRecords: dbResult.deletedDownloads,
                    queueRecords: dbResult.deletedQueue,
                },
            };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A factory reset is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/purge/all/status', async (req, res) => {
        res.json(getJobTracker('purgeAll').getStatus());
    });

    // ── Resync dialogs ────────────────────────────────────────────────────────

    // Force re-resolve every group entity (name + photo) against Telegram.
    // Fire-and-forget — with many accounts × big dialog lists this is multi-
    // second. Progress streams via `resync_dialogs_progress`, final result via
    // `resync_dialogs_done`.
    router.post('/api/maintenance/resync-dialogs', async (req, res) => {
        let am;
        try {
            am = await getAccountManager();
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            return res.status(status === 400 ? 500 : status).json(body.error ? body : { error: e.message });
        }
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
        const tracker = getJobTracker('resyncDialogs');
        const r = tracker.tryStart(async ({ onProgress }) => {
            try { clearEntityCache(); } catch {}
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const ids = new Set((config.groups || []).map(g => String(g.id)));
            try {
                const rows = getDb().prepare('SELECT DISTINCT group_id FROM downloads').all();
                for (const rr of rows) ids.add(String(rr.group_id));
            } catch {}

            let updated = 0;
            let mutated = false;
            const total = ids.size;
            let processed = 0;
            const pendingDbUpdates = [];
            onProgress({ processed: 0, total, updated: 0, stage: 'resolving' });
            for (const id of ids) {
                const resolved = await resolveEntityAcrossAccounts(id);
                if (resolved) {
                    const e = resolved.entity;
                    const realName = e?.title
                        || (e?.firstName && (e.firstName + (e.lastName ? ' ' + e.lastName : '')))
                        || e?.username || null;
                    if (realName) {
                        const cg = (config.groups || []).find(g => String(g.id) === id);
                        if (cg && (!cg.name || cg.name === 'Unknown' || cg.name === id || cg.name.startsWith('Group '))) {
                            cg.name = realName;
                            mutated = true;
                        }
                        pendingDbUpdates.push([realName, id]);
                        updated++;
                    }
                    await downloadProfilePhoto(id).catch(() => {});
                }
                processed++;
                onProgress({ processed, total, updated, stage: 'resolving' });
            }
            if (pendingDbUpdates.length > 0) {
                try {
                    const db = getDb();
                    const stmt = db.prepare(`UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`);
                    const tx = db.transaction((rows) => {
                        for (const [name, gid] of rows) stmt.run(name, gid, gid);
                    });
                    tx(pendingDbUpdates);
                } catch (err) {
                    console.warn('[resync-dialogs] batch update failed:', err.message);
                }
            }
            if (mutated) await writeConfigAtomic(config);
            resetDialogsCaches();
            broadcast({ type: 'config_updated' });
            return { scanned: total, updated };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'Resync already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/resync-dialogs/status', async (req, res) => {
        res.json(getJobTracker('resyncDialogs').getStatus());
    });

    // ── Restart monitor ───────────────────────────────────────────────────────

    // Restart the realtime monitor: stop → start. Useful after settings changes
    // (proxy, accounts, rate limits) without needing to bounce the container.
    // Fire-and-forget for consistency with the other Settings → Maintenance
    // buttons; final status broadcast via `restart_monitor_done`.
    router.post('/api/maintenance/restart-monitor', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        const t = getJobTracker('restartMonitor');
        const r = t.tryStart(async () => {
            const wasRunning = runtime.state === 'running';
            if (runtime.state !== 'stopped') {
                try { await runtime.stop(); } catch (e) { console.warn('restart-monitor stop:', e.message); }
            }
            if (!wasRunning) {
                return { restarted: false, note: 'Monitor was not running; nothing to restart.' };
            }
            const am = await getAccountManager();
            if (am.count === 0) {
                const err = new Error('No Telegram accounts loaded');
                err.code = 'NO_ACCOUNTS';
                throw err;
            }
            await runtime.start({ config: loadConfig(), accountManager: am });
            return { restarted: true, status: runtime.status() };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'Restart already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/restart-monitor/status', async (req, res) => {
        res.json(getJobTracker('restartMonitor').getStatus());
    });

    // ── DB integrity ──────────────────────────────────────────────────────────

    // SQLite integrity check (PRAGMA integrity_check). Returns "ok" on a clean DB
    // or a list of corruption messages. Read-only.
    //
    // Usually fast (~seconds) but on a corrupt DB can spin for a long time —
    // converted to fire-and-forget for symmetry + Cloudflare safety.
    router.post('/api/maintenance/db/integrity', async (req, res) => {
        const t = getJobTracker('dbIntegrity');
        const r = t.tryStart(async () => {
            const db = getDb();
            const rows = db.prepare('PRAGMA integrity_check').all();
            const messages = rows.map(rr => rr.integrity_check).filter(Boolean);
            const ok = messages.length === 1 && messages[0] === 'ok';
            return { ok, messages };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'An integrity check is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/db/integrity/status', async (req, res) => {
        res.json(getJobTracker('dbIntegrity').getStatus());
    });

    // ── Files verify ──────────────────────────────────────────────────────────

    // Walk every download row, drop the ones whose file is missing or
    // 0 bytes. Same logic as the periodic boot-time sweep, surfaced as a
    // button so users can force-clean stale entries on demand.
    //
    // Fire-and-forget — a 50k-row library can take a minute, well past
    // Cloudflare's 100 s tunnel timeout when the user has had the dashboard
    // open for a while. POST returns 200 immediately; progress + result land
    // over WS as `files_verify_progress` / `files_verify_done`.
    router.post('/api/maintenance/files/verify', async (req, res) => {
        const t = getJobTracker('filesVerify');
        const r = t.tryStart(async ({ onProgress }) => {
            return await integrity.sweep(onProgress);
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A verify is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/files/verify/status', async (req, res) => {
        res.json(getJobTracker('filesVerify').getStatus());
    });

    // ── Reindex ───────────────────────────────────────────────────────────────

    // Re-index from disk — the inverse of /files/verify. Walks
    // data/downloads/ and inserts rows for files the catalogue doesn't
    // know about. Idempotent (INSERT OR IGNORE on (group_id, message_id)).
    // Used to recover a wiped DB (Purge all, fresh install over an existing
    // downloads/ tree, restore from backups/ snapshot) without re-downloading
    // from Telegram.
    router.post('/api/maintenance/reindex', async (req, res) => {
        if (_reindexBgRunning || integrity.isReindexRunning()) {
            return res.status(409).json({ error: 'already_running' });
        }
        _reindexBgRunning = true;
        res.json({ ok: true, started: true });
        // Fire-and-forget — the result lands over WS.
        (async () => {
            try {
                const cfg = await readConfigSafe();
                const groups = Array.isArray(cfg?.groups) ? cfg.groups : [];
                const result = await integrity.reindexFromDisk(groups, (p) => {
                    try { broadcast({ type: 'reindex_progress', ...p }); } catch {}
                });
                try { broadcast({ type: 'reindex_done', ...result }); } catch {}
            } catch (e) {
                try { broadcast({ type: 'reindex_done', error: e?.message || String(e) }); } catch {}
            } finally {
                _reindexBgRunning = false;
            }
        })();
    });

    router.get('/api/maintenance/reindex/status', async (req, res) => {
        res.json({ running: _reindexBgRunning || integrity.isReindexRunning() });
    });

    // ── DB vacuum ─────────────────────────────────────────────────────────────

    // VACUUM the SQLite database. Reclaims space after lots of deletions.
    // Locks the DB briefly — guard with confirm so the user can't trigger it by
    // accident in the middle of a heavy backfill.
    //
    // Fire-and-forget: VACUUM blocks the process for the duration of the
    // rebuild (multiple minutes on a multi-GB library), well past Cloudflare's
    // edge timeout.
    router.post('/api/maintenance/db/vacuum', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        const t = getJobTracker('dbVacuum');
        const r = t.tryStart(async () => {
            const db = getDb();
            const beforePages = db.pragma('page_count', { simple: true });
            const pageSize = db.pragma('page_size', { simple: true });
            db.exec('VACUUM');
            const afterPages = db.pragma('page_count', { simple: true });
            return {
                beforeBytes: Number(beforePages) * Number(pageSize),
                afterBytes: Number(afterPages) * Number(pageSize),
                reclaimedBytes: Math.max(0, (Number(beforePages) - Number(afterPages)) * Number(pageSize)),
            };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A vacuum is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/db/vacuum/status', async (req, res) => {
        res.json(getJobTracker('dbVacuum').getStatus());
    });

    // ── Dedup ─────────────────────────────────────────────────────────────────

    // One-shot scan that:
    //   1. Computes SHA-256 for every download row missing a hash.
    //   2. Groups by hash and returns sets where COUNT > 1.
    //
    // Fire-and-forget — on a 50 GB library the SHA-256 sweep can take minutes.
    // Clients learn about progress and the final duplicate sets via WS
    // (`dedup_progress`, `dedup_done`) and can recover the in-flight state via
    // GET `/dedup/status` after a tab close.
    router.post('/api/maintenance/dedup/scan', async (req, res) => {
        if (_dedupRunning) {
            return res.status(409).json({ error: 'A dedup scan is already running', code: 'ALREADY_RUNNING' });
        }
        _dedupRunning = true;
        _dedupState = {
            running: true, stage: 'starting',
            processed: 0, total: 0, hashed: 0, groups: 0,
            startedAt: Date.now(), finishedAt: 0,
            result: null, error: null,
        };
        res.json({ success: true, started: true });
        try { broadcast({ type: 'dedup_progress', ..._dedupState }); } catch {}
        log({ source: 'dedup', level: 'info', msg: 'dedup scan starting' });
        (async () => {
            try {
                const result = await dedupFindDuplicates({
                    onProgress: (p) => {
                        Object.assign(_dedupState, p, { running: true });
                        try { broadcast({ type: 'dedup_progress', ...p, running: true }); } catch {}
                    },
                });
                _dedupState = {
                    ..._dedupState, ...result,
                    running: false, stage: 'done',
                    finishedAt: Date.now(),
                    result,
                };
                try { broadcast({ type: 'dedup_done', ...result }); } catch {}
                log({ source: 'dedup', level: 'info',
                    msg: `dedup scan done — groups=${result?.groups?.length ?? 0} duplicates=${result?.totalDuplicates ?? 0}` });
            } catch (e) {
                _dedupState = {
                    ..._dedupState,
                    running: false, stage: 'error',
                    error: e?.message || String(e),
                    finishedAt: Date.now(),
                };
                try { broadcast({ type: 'dedup_done', error: e?.message || String(e) }); } catch {}
                log({ source: 'dedup', level: 'error', msg: `dedup scan failed: ${e?.message || e}` });
            } finally {
                _dedupRunning = false;
            }
        })();
    });

    // Status endpoint — returns the latest scan state including the result
    // payload from the most recent completed run, so a re-opened page can
    // render the duplicate-sets table without re-running the scan.
    router.get('/api/maintenance/dedup/status', async (req, res) => {
        res.json({ ..._dedupState, running: _dedupRunning });
    });

    // Bulk-delete N files. Used by both the duplicate finder and the gallery
    // selection bar. At N=10k disk I/O can run for minutes — fire-and-forget.
    router.post('/api/maintenance/dedup/delete', async (req, res) => {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(400).json({ error: 'ids array required' });
        }
        const cleanIds = ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
        if (!cleanIds.length) {
            return res.status(400).json({ error: 'No valid ids supplied' });
        }
        const tracker = getJobTracker('dedupDelete');
        const r = tracker.tryStart(async ({ onProgress }) => {
            const total = cleanIds.length;
            onProgress({ processed: 0, total, stage: 'deleting' });
            const result = dedupDeleteByIds(cleanIds);
            let processed = 0;
            for (const id of cleanIds) {
                try { await purgeThumbsForDownload(id); } catch {}
                processed += 1;
                if (processed % 50 === 0 || processed === total) {
                    onProgress({ processed, total, stage: 'purging_thumbs' });
                }
            }
            try { broadcast({ type: 'bulk_delete', ids: cleanIds }); } catch {}
            return { ...result, requested: cleanIds.length, ids: cleanIds };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A bulk delete is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true, queued: cleanIds.length });
    });

    router.get('/api/maintenance/dedup/delete/status', async (req, res) => {
        res.json(getJobTracker('dedupDelete').getStatus());
    });

    // ── Thumbnails ────────────────────────────────────────────────────────────

    // `GET /api/thumbs/:id?w=240` returns a small WebP thumbnail for an
    // image or video download row. Cache-first: hits stat in microseconds
    // and stream from disk; misses fork sharp / ffmpeg once and the result
    // lives in `data/thumbs/`. The frontend uses these for every gallery tile.
    router.get('/api/thumbs/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).type('text/plain').send('Bad id');
            }
            const thumb = await getOrCreateThumb(id, req.query.w);
            if (!thumb) {
                const now = Date.now();
                if (now - _thumbMissBatch.resetAt > THUMB_MISS_WINDOW_MS) {
                    // Window rollover — emit a consolidated warning if (a) the
                    // burst crossed the floor AND (b) we're past the cooldown
                    // since the last emission. Both gates have to pass; either
                    // alone leaves it quiet.
                    let warnMisses = true;
                    try {
                        const cfg = loadConfig();
                        warnMisses = cfg?.advanced?.thumbs?.warnMisses !== false;
                    } catch { /* no config yet → default on */ }
                    if (warnMisses
                        && _thumbMissBatch.count >= THUMB_MISS_FLOOR
                        && (now - _thumbMissBatch.lastWarnedAt) >= THUMB_MISS_COOLDOWN_MS) {
                        const mins = Math.round(THUMB_MISS_WINDOW_MS / 60_000);
                        log({ source: 'thumbs', level: 'warn', msg: `${_thumbMissBatch.count} thumb misses in the last ${mins} min (DB row missing, file off disk, or source not thumbnailable). Try Maintenance → Verify files / Re-index.` });
                        _thumbMissBatch.lastWarnedAt = now;
                    }
                    _thumbMissBatch.count = 1;
                    _thumbMissBatch.resetAt = now;
                } else {
                    _thumbMissBatch.count += 1;
                }
                return res.status(404).type('text/plain').send('No thumb');
            }

            res.setHeader('Content-Type', 'image/webp');
            // Aggressive cache — the URL embeds id+width which is content-
            // stable. If the source is replaced, purgeThumbsForDownload()
            // wipes the cache entry so the next request regenerates.
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            const lastMod = new Date(thumb.mtime).toUTCString();
            res.setHeader('Last-Modified', lastMod);
            if (req.headers['if-modified-since'] === lastMod) {
                return res.status(304).end();
            }
            return res.sendFile(thumb.path, (err) => {
                if (err && !res.headersSent) res.status(500).end();
            });
        } catch (e) {
            console.error('thumb serve:', e);
            if (!res.headersSent) res.status(500).type('text/plain').send('Internal error');
        }
    });

    // Maintenance — wipe the entire thumbnail cache. Used by the
    // "Rebuild thumbnails" UI to force regeneration. Fire-and-forget.
    router.post('/api/maintenance/thumbs/rebuild', async (req, res) => {
        const tracker = getJobTracker('thumbsRebuild');
        const r = tracker.tryStart(async () => {
            const removed = await purgeAllThumbs();
            return { removed };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A thumbnail wipe is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/thumbs/rebuild/status', async (req, res) => {
        res.json(getJobTracker('thumbsRebuild').getStatus());
    });

    // Maintenance — generate thumbnails for every download row that doesn't
    // already have one cached at the default width.
    //
    // Fire-and-forget: returns 200 with `started: true` immediately. The
    // actual build runs in the background, broadcasting `thumbs_progress`
    // over WS and a final `thumbs_done`.
    router.post('/api/maintenance/thumbs/build-all', async (req, res) => {
        if (_thumbBuildRunning) {
            return res.status(409).json({ error: 'A thumbnail build is already running' });
        }
        _thumbBuildRunning = true;
        _thumbBuildState = {
            running: true, stage: 'starting',
            processed: 0, total: 0,
            built: 0, skipped: 0, errored: 0, scanned: 0,
            startedAt: Date.now(), finishedAt: 0, error: null,
        };
        res.json({ success: true, started: true });
        log({ source: 'thumbs', level: 'info', msg: 'thumbs build-all starting' });
        (async () => {
            try {
                const r = await buildAllThumbnails({
                    onProgress: (p) => {
                        // Server-side state stays the source of truth for the
                        // /build/status endpoint; broadcast forwards the same
                        // shape to WS subscribers.
                        Object.assign(_thumbBuildState, p, { running: true });
                        try { broadcast({ type: 'thumbs_progress', ...p }); } catch {}
                    },
                });
                _thumbBuildState = {
                    ..._thumbBuildState, ...r,
                    running: false, stage: 'done',
                    finishedAt: Date.now(),
                };
                try { broadcast({ type: 'thumbs_done', ...r }); } catch {}
                log({ source: 'thumbs', level: 'info',
                    msg: `thumbs build-all done — scanned=${r?.scanned ?? 0} built=${r?.built ?? 0} skipped=${r?.skipped ?? 0} errored=${r?.errored ?? 0}` });
            } catch (e) {
                _thumbBuildState = {
                    ..._thumbBuildState,
                    running: false, stage: 'error',
                    error: e?.message || String(e),
                    finishedAt: Date.now(),
                };
                try { broadcast({ type: 'thumbs_done', error: e?.message || String(e) }); } catch {}
                log({ source: 'thumbs', level: 'error', msg: `thumbs build-all failed: ${e?.message || e}` });
            } finally {
                _thumbBuildRunning = false;
            }
        })();
    });

    router.get('/api/maintenance/thumbs/build/status', async (req, res) => {
        res.json({ ..._thumbBuildState, running: _thumbBuildRunning });
    });

    // Probe which ffmpeg hardware-acceleration backends actually work on
    // this host. Runs `ffmpeg -hide_banner -hwaccels` and returns the parsed
    // list. Used by Settings → Advanced → Video thumb hardware acceleration
    // → "Detect available" so the admin doesn't have to SSH in to find out
    // whether VAAPI/QSV/CUDA/etc. are available on the host's ffmpeg build.
    router.get('/api/maintenance/thumbs/hwaccel-probe', async (req, res) => {
        try {
            const { spawn } = await import('child_process');
            const thumbs = await import('../../core/thumbs.js');
            const bin = thumbs.resolveFfmpegBin?.() || 'ffmpeg';
            const out = await new Promise((resolve, reject) => {
                const p = spawn(bin, ['-hide_banner', '-hwaccels'], { windowsHide: true });
                const chunks = [];
                p.stdout.on('data', (c) => chunks.push(c));
                p.stderr.on('data', () => {});
                p.on('error', reject);
                p.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
            }).catch(() => '');
            // Output shape (ffmpeg ≥4.x):
            //   Hardware acceleration methods:\nvaapi\nqsv\ncuda\nvideotoolbox\n
            const KNOWN = new Set(['vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va', 'dxva2', 'opencl', 'vulkan', 'drm']);
            const available = out.split(/\r?\n/)
                .map((s) => s.trim().toLowerCase())
                .filter((s) => KNOWN.has(s));
            res.json({
                available,
                ffmpegPath: bin,
                // The dropdown only exposes options we have UI rows for; the
                // others come back so docs / debugging surface them.
                recommended: available.find((b) => ['vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va'].includes(b)) || null,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e), available: [] });
        }
    });

    // Maintenance — cache footprint (count + bytes) and capability check
    // (whether ffmpeg is present). Drives the "Thumbnail cache" admin panel.
    router.get('/api/maintenance/thumbs/stats', async (req, res) => {
        try {
            const r = await getThumbsCacheStats();
            res.json({
                success: true,
                ffmpegAvailable: hasFfmpeg(),
                allowedWidths: THUMB_WIDTHS,
                ...r,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Video faststart optimiser ─────────────────────────────────────────────
    // MP4s with their `moov` atom at the end of the file confuse the
    // browser's HTML5 player — seek breaks, audio appears missing, the
    // "loaded" range stalls until the entire `mdat` has streamed in.
    // Three endpoints mirror the thumbs build/rebuild pattern.

    let _faststartRunning = false;
    let _faststartState = {
        running: false,
        stage: 'idle',
        processed: 0, total: 0,
        optimized: 0, already: 0, skipped: 0, errored: 0, scanned: 0,
        startedAt: 0, finishedAt: 0, error: null,
    };

    router.post('/api/maintenance/faststart/scan', async (req, res) => {
        if (_faststartRunning) {
            return res.status(409).json({ error: 'A faststart sweep is already running', code: 'ALREADY_RUNNING' });
        }
        _faststartRunning = true;
        _faststartState = {
            running: true, stage: 'starting',
            processed: 0, total: 0,
            optimized: 0, already: 0, skipped: 0, errored: 0, scanned: 0,
            startedAt: Date.now(), finishedAt: 0, error: null,
        };
        res.json({ success: true, started: true });
        log({ source: 'faststart', level: 'info', msg: 'faststart sweep starting' });
        (async () => {
            try {
                const { optimizeAll } = await import('../../core/faststart.js');
                const r = await optimizeAll({
                    onProgress: (p) => {
                        Object.assign(_faststartState, p, { running: true });
                        try { broadcast({ type: 'faststart_progress', ...p }); } catch {}
                    },
                });
                _faststartState = {
                    ..._faststartState, ...r,
                    running: false, stage: 'done',
                    finishedAt: Date.now(),
                };
                try { broadcast({ type: 'faststart_done', ...r }); } catch {}
                log({ source: 'faststart', level: 'info',
                    msg: `faststart sweep done — scanned=${r?.scanned ?? 0} optimized=${r?.optimized ?? 0} already=${r?.already ?? 0} skipped=${r?.skipped ?? 0} errored=${r?.errored ?? 0}` });
            } catch (e) {
                _faststartState = {
                    ..._faststartState,
                    running: false, stage: 'error',
                    error: e?.message || String(e),
                    finishedAt: Date.now(),
                };
                try { broadcast({ type: 'faststart_done', error: e?.message || String(e) }); } catch {}
                log({ source: 'faststart', level: 'error', msg: `faststart sweep failed: ${e?.message || e}` });
            } finally {
                _faststartRunning = false;
            }
        })();
    });

    router.get('/api/maintenance/faststart/status', async (req, res) => {
        res.json({ ..._faststartState, running: _faststartRunning });
    });

    router.get('/api/maintenance/faststart/stats', async (req, res) => {
        try {
            const { getStats } = await import('../../core/faststart.js');
            const r = await getStats();
            res.json({ success: true, ffmpegAvailable: hasFfmpeg(), ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── NSFW review ───────────────────────────────────────────────────────────

    router.get('/api/maintenance/nsfw/status', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const state = nsfwGetScanState(cfg);
            res.json({
                enabled: cfg.enabled,
                running: state.running,
                scanned: state.scanned,
                total: state.total,
                candidates: state.candidates,
                keep: state.keep,
                whitelisted: state.whitelisted,
                totalEligible: state.totalEligible,
                lastCheckedAt: state.lastCheckedAt,
                startedAt: state.startedAt,
                finishedAt: state.finishedAt,
                error: state.error,
                model: cfg.model,
                threshold: cfg.threshold,
                fileTypes: cfg.fileTypes,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/maintenance/nsfw/scan', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            if (!cfg.enabled) {
                return res.status(503).json({
                    error: 'NSFW review is disabled. Open Maintenance → NSFW review and toggle it on first.',
                    code: 'NSFW_DISABLED',
                });
            }
            if (nsfwIsScanRunning()) {
                return res.status(409).json({ error: 'A scan is already running', code: 'ALREADY_RUNNING' });
            }
            log({ source: 'nsfw', level: 'info', msg: `scan starting — model=${cfg.model} threshold=${cfg.threshold} fileTypes=[${(cfg.fileTypes || []).join(',')}] concurrency=${cfg.concurrency}` });
            let _lastLoggedScanned = 0;
            const r = await nsfwStartScan(cfg,
                (p) => {
                    try { broadcast({ type: 'nsfw_progress', ...p }); } catch {}
                    // Throttle log spam — emit at most every 25 rows so a 10 000
                    // row library doesn't pump 10 000 lines into the web log.
                    if (typeof p?.scanned === 'number' && (p.scanned - _lastLoggedScanned) >= 25) {
                        _lastLoggedScanned = p.scanned;
                        log({ source: 'nsfw', level: 'info', msg: `scan progress — ${p.scanned}/${p.total} (candidates=${p.candidates ?? 0}, keep=${p.keep ?? 0})` });
                    }
                },
                (p) => {
                    try { broadcast({ type: 'nsfw_done', ...p }); } catch {}
                    if (p?.error) {
                        log({ source: 'nsfw', level: 'error', msg: `scan finished with error: ${p.error}` });
                    } else {
                        log({ source: 'nsfw', level: 'info', msg: `scan done — scanned=${p?.scanned ?? 0} candidates=${p?.candidates ?? 0} keep=${p?.keep ?? 0} elapsed=${p?.finishedAt && p?.startedAt ? Math.round((p.finishedAt - p.startedAt) / 1000) + 's' : 'n/a'}` });
                    }
                },
                (p) => {
                    try { broadcast({ type: 'nsfw_model_downloading', ...p }); } catch {}
                    log({ source: 'nsfw', level: 'info', msg: `model load — ${p?.status || 'progress'} ${p?.file || ''} ${p?.progress != null ? Math.round(p.progress) + '%' : ''}` });
                },
                // onLog — internal nsfw.js events flow into the same realtime
                // log stream the v2 page subscribes to.
                (entry) => log(entry),
            );
            if (r?.alreadyRunning) {
                log({ source: 'nsfw', level: 'warn', msg: 'scan request rejected — already running' });
            }
            res.json({ success: true, ...r });
        } catch (e) {
            log({ source: 'nsfw', level: 'error', msg: `scan failed to start: ${e?.message || e} (code=${e?.code || 'UNKNOWN'})` });
            console.error('nsfw/scan:', e);
            const status = e.code === 'NSFW_LIB_MISSING' ? 503 : 500;
            res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    router.post('/api/maintenance/nsfw/scan/cancel', async (req, res) => {
        const ok = nsfwCancelScan();
        res.json({ success: true, cancelled: ok });
    });

    // Pre-fetch the classifier weights without scanning a single file. Lets
    // the operator warm the cache from the UI so the next scan starts
    // instantly. Returns immediately; download progress flows over the
    // existing `nsfw_model_downloading` WS event + realtime log channel.
    router.post('/api/maintenance/nsfw/preload', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const r = await nsfwPreloadClassifier(cfg,
                (p) => { try { broadcast({ type: 'nsfw_model_downloading', ...p }); } catch {} },
                (entry) => log(entry),
            );
            res.json({ success: true, ...r });
        } catch (e) {
            log({ source: 'nsfw', level: 'error', msg: `preload failed to start: ${e?.message || e}` });
            const status = e.code === 'NSFW_LIB_MISSING' ? 503 : 500;
            res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    // Snapshot of the in-process classifier load state. Polled by the
    // /maintenance/nsfw page so the model-status pill reflects reality
    // even between WS messages.
    router.get('/api/maintenance/nsfw/model-status', async (req, res) => {
        res.json({ success: true, ...nsfwClassifierReady() });
    });

    // Wipe the cached weights on disk. Confirm-gated in the UI; safe-by-
    // design here (the cache dir is allow-listed via _resolveCacheDirAbs
    // inside nsfw.js — there's no caller-supplied path).
    router.delete('/api/maintenance/nsfw/cache', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const r = await nsfwClearCache(cfg);
            log({ source: 'nsfw', level: 'info', msg: `cleared model cache — removed ${r.files} file(s) / ${r.bytes} bytes` });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/maintenance/nsfw/results', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
            const r = getNsfwDeleteCandidates({
                fileTypes: cfg.fileTypes,
                threshold: cfg.threshold,
                page,
                limit,
            });
            res.json({
                success: true,
                ...r,
                threshold: cfg.threshold,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete reviewed candidates. Reuses the dedup-delete pathway (which
    // removes file from disk + DB row) and purges the corresponding
    // thumbnail cache entries so a stale WebP doesn't keep serving.
    router.post('/api/maintenance/nsfw/delete', async (req, res) => {
        try {
            const { ids } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) {
                return res.status(400).json({ error: 'ids array required' });
            }
            const cleanIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
            if (!cleanIds.length) {
                return res.status(400).json({ error: 'No valid ids supplied' });
            }
            const r = dedupDeleteByIds(cleanIds);
            for (const id of cleanIds) {
                try { await purgeThumbsForDownload(id); } catch {}
            }
            try { broadcast({ type: 'bulk_delete', ids: cleanIds }); } catch {}
            try { broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() }); } catch {}
            res.json({ success: true, ...r });
        } catch (e) {
            console.error('nsfw/delete:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Mark rows as admin-confirmed-18+ (keep, never re-flag). Use when the
    // classifier produced a false negative — i.e. the photo IS 18+ but
    // scored low. Future scans skip these rows entirely.
    router.post('/api/maintenance/nsfw/whitelist', async (req, res) => {
        try {
            const { ids } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) {
                return res.status(400).json({ error: 'ids array required' });
            }
            const cleanIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
            if (!cleanIds.length) {
                return res.status(400).json({ error: 'No valid ids supplied' });
            }
            const updated = whitelistNsfw(cleanIds);
            try { broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() }); } catch {}
            res.json({ success: true, updated });
        } catch (e) {
            console.error('nsfw/whitelist:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ── NSFW v2 (tier-aware review) ───────────────────────────────────────────

    // Expose the tier dictionary so the front-end doesn't have to hard-code
    // the boundaries — change the bands in db.js and the UI follows.
    router.get('/api/maintenance/nsfw/v2/tiers-meta', async (req, res) => {
        res.json({ tiers: NSFW_TIERS });
    });

    router.get('/api/maintenance/nsfw/v2/tiers', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const counts = getNsfwTierCounts(cfg.fileTypes);
            log({ source: 'nsfw', level: 'info', msg: `tier counts polled — scanned=${counts.scanned}/${counts.totalEligible}` });
            res.json({ ...counts, threshold: cfg.threshold, tiers_meta: NSFW_TIERS });
        } catch (e) {
            log({ source: 'nsfw', level: 'error', msg: `nsfw/v2/tiers failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/maintenance/nsfw/v2/histogram', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const bins = Number(req.query.bins) || 20;
            res.json(getNsfwHistogram(cfg.fileTypes, bins));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/maintenance/nsfw/v2/list', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const list = getNsfwListByTier({
                tier: req.query.tier || null,
                fileTypes: cfg.fileTypes,
                groupId: req.query.group || null,
                includeWhitelisted: req.query.include_whitelisted === '1',
                page: Number(req.query.page) || 1,
                limit: Number(req.query.limit) || 50,
            });
            res.json(list);
        } catch (e) {
            log({ source: 'nsfw', level: 'error', msg: `nsfw/v2/list failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message });
        }
    });

    // All four NSFW v2 bulk endpoints share a single `nsfwBulk` tracker so
    // they're mutually exclusive — the operations all touch the same review
    // queue and racing them would produce inconsistent counts. Each endpoint
    // returns 200 with `{started:true}` immediately; the resolved id list +
    // final result land via `nsfw_bulk_done`.
    router.post('/api/maintenance/nsfw/v2/bulk-delete', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        const body = req.body || {};
        const tracker = getJobTracker('nsfwBulk');
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'delete' });
            const ids = await _resolveBulkIds(body);
            if (!ids.length) return { op: 'delete', deleted: 0, ids: [] };
            log({ source: 'nsfw', level: 'warn', msg: `bulk-delete starting: ${ids.length} rows` });
            const total = ids.length;
            onProgress({ stage: 'deleting', op: 'delete', processed: 0, total });
            const result = dedupDeleteByIds(ids);
            let processed = 0;
            for (const id of ids) {
                try { await purgeThumbsForDownload(id); } catch {}
                processed += 1;
                if (processed % 50 === 0 || processed === total) {
                    onProgress({ stage: 'purging_thumbs', op: 'delete', processed, total });
                }
            }
            try { broadcast({ type: 'bulk_delete', ids }); } catch {}
            try { broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() }); } catch {}
            log({ source: 'nsfw', level: 'info', msg: `bulk-delete done: removed=${result?.deleted ?? result?.removed ?? ids.length}` });
            return { op: 'delete', deleted: ids.length, ids, ...result };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.post('/api/maintenance/nsfw/v2/bulk-whitelist', async (req, res) => {
        const body = req.body || {};
        const tracker = getJobTracker('nsfwBulk');
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'whitelist' });
            const ids = await _resolveBulkIds(body);
            if (!ids.length) return { op: 'whitelist', updated: 0, ids: [] };
            onProgress({ stage: 'updating', op: 'whitelist', total: ids.length });
            const updated = whitelistNsfw(ids);
            try { broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() }); } catch {}
            log({ source: 'nsfw', level: 'info', msg: `bulk-whitelist: marked ${updated} rows as 18+` });
            return { op: 'whitelist', updated, ids };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.post('/api/maintenance/nsfw/v2/unwhitelist', async (req, res) => {
        const ids = (req.body?.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) return res.status(400).json({ error: 'ids array required' });
        const tracker = getJobTracker('nsfwBulk');
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'updating', op: 'unwhitelist', total: ids.length });
            const updated = unwhitelistNsfw(ids);
            try { broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() }); } catch {}
            log({ source: 'nsfw', level: 'info', msg: `unwhitelist: ${ids.length > 1 ? ids.length + ' rows' : 'row'} back into review` });
            return { op: 'unwhitelist', updated, ids };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.post('/api/maintenance/nsfw/v2/reclassify', async (req, res) => {
        const body = req.body || {};
        const tracker = getJobTracker('nsfwBulk');
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'reclassify' });
            const ids = await _resolveBulkIds(body);
            if (!ids.length) return { op: 'reclassify', cleared: 0, ids: [] };
            onProgress({ stage: 'clearing', op: 'reclassify', total: ids.length });
            const cleared = reclassifyNsfw(ids);
            log({ source: 'nsfw', level: 'info', msg: `reclassify: cleared ${cleared} rows for re-scan` });
            return { op: 'reclassify', cleared, ids };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'A bulk NSFW operation is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/maintenance/nsfw/v2/bulk/status', async (req, res) => {
        res.json(getJobTracker('nsfwBulk').getStatus());
    });

    // ── Logs ──────────────────────────────────────────────────────────────────

    // List logfiles under data/logs/ with size + mtime — used by the SPA to
    // populate the "Download log" picker.
    router.get('/api/maintenance/logs', async (req, res) => {
        try {
            if (!existsSync(logsDir)) return res.json({ files: [] });
            const names = fsSync.readdirSync(logsDir).filter(f => f.endsWith('.log'));
            const files = names.map(name => {
                try {
                    const st = fsSync.statSync(path.join(logsDir, name));
                    return { name, size: st.size, modified: st.mtime.toISOString() };
                } catch { return null; }
            }).filter(Boolean);
            files.sort((a, b) => b.modified.localeCompare(a.modified));
            res.json({ files });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Stream the tail of a logfile as plain text. `name` is restricted to a single
    // path segment so a malicious caller can't traverse out of logsDir.
    router.get('/api/maintenance/logs/download', async (req, res) => {
        try {
            const name = String(req.query.name || '');
            if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || !name.endsWith('.log')) {
                return res.status(400).json({ error: 'Invalid log name' });
            }
            const lines = Math.max(10, Math.min(100000, parseInt(req.query.lines, 10) || 5000));
            const filePath = path.join(logsDir, name);
            if (!existsSync(filePath)) return res.status(404).json({ error: 'Log not found' });

            // Realpath check defends against symlink escapes that the basename
            // filter can't catch (e.g. logs/foo.log -> /etc/passwd).
            try {
                const realFile = fsSync.realpathSync(filePath);
                const realLogs = fsSync.realpathSync(logsDir);
                if (realFile !== realLogs && !realFile.startsWith(realLogs + path.sep)) {
                    return res.status(400).json({ error: 'Path escape detected' });
                }
            } catch {
                return res.status(400).json({ error: 'Invalid log name' });
            }

            // Naive tail — read whole file (logs are bounded), keep last N lines.
            const raw = await fs.readFile(filePath, 'utf8');
            const all = raw.split(/\r?\n/);
            const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            res.send(tail);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Snapshot for GET /api/maintenance/logs/recent — newest first, capped.
    router.get('/api/maintenance/logs/recent', async (req, res) => {
        const logBuffer = getLogBuffer();
        const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
        const sources = (req.query.source ? String(req.query.source).split(',') : null);
        const minLevel = req.query.level || null;
        const levelOrder = { info: 0, warn: 1, error: 2 };
        const minLvl = minLevel ? (levelOrder[minLevel] ?? 0) : 0;
        const filtered = logBuffer.filter((e) => {
            if (sources && !sources.includes(e.source)) return false;
            if ((levelOrder[e.level] ?? 0) < minLvl) return false;
            return true;
        });
        res.json({ logs: filtered.slice(-limit) });
    });

    // ── Session / account management ──────────────────────────────────────────

    // Export a Telegram account session as a portable string. The session is
    // AES-256 encrypted on disk under data/sessions/<id>.enc; this endpoint
    // decrypts it with the local SecureSession key and returns the raw gramJS
    // string. The user can paste this into another instance to migrate without
    // re-doing the OTP flow.
    router.post('/api/maintenance/session/export', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        if (!(await _requirePassword(req, res))) return;
        try {
            const { accountId } = req.body || {};
            if (typeof accountId !== 'string' || !accountId) {
                return res.status(400).json({ error: 'accountId required' });
            }
            // Path-segment guard — accountId becomes a filename.
            if (accountId.includes('/') || accountId.includes('\\') || accountId.includes('..') || accountId.includes('\0')) {
                return res.status(400).json({ error: 'Invalid accountId' });
            }
            const sessionFile = path.join(sessionsDir, `${accountId}.enc`);
            if (!existsSync(sessionFile)) {
                return res.status(404).json({ error: 'Session file not found for that account' });
            }
            const raw = await fs.readFile(sessionFile, 'utf8');
            const encrypted = JSON.parse(raw);
            const sessionString = getSecureSession().decrypt(encrypted);
            res.json({ success: true, accountId, session: sessionString });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Revoke every dashboard session token. Forces every browser (including the
    // caller) back to the login page. Useful after a suspected compromise or
    // after rotating the password from another device.
    router.post('/api/maintenance/sessions/revoke-all', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        if (!(await _requirePassword(req, res))) return;
        try {
            revokeAllSessions();
            res.clearCookie('tg_dl_session', SESSION_COOKIE_OPTS);
            broadcast({ type: 'sessions_revoked' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Config raw view ───────────────────────────────────────────────────────

    // Surface the raw config.json (with secrets redacted) so power users can
    // review what's on disk without SSHing into the container.
    router.get('/api/maintenance/config/raw', async (req, res) => {
        try {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            if (config.telegram?.apiHash) config.telegram.apiHash = '••••••• (redacted)';
            if (config.web?.passwordHash) config.web.passwordHash = '••••••• (redacted)';
            if (config.web?.password) config.web.password = '••••••• (redacted)';
            if (config.proxy?.password) config.proxy.password = '••••••• (redacted)';
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.send(JSON.stringify(config, null, 2));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
