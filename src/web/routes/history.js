import express from 'express';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { BACKFILL_MAX_LIMIT, HISTORY_JOB_TTL_MS } from '../../core/constants.js';

// jobId → { id, state, processed, downloaded, error, group, groupId, limit,
//           startedAt, finishedAt, cancelled, _runner }
// `_runner` is stripped before serialising to disk (it's the live downloader).
const _historyJobs = new Map();

// Module-level guard: at most ONE backfill per groupId at any time.
// Without this, a fast double-click on Backfill spawns two HistoryDownloader
// instances against the same group → two parallel iterations of the same
// Telegram timeline, two streams of `getMessages` calls, doubled FloodWait
// risk. The instances would still produce no duplicate downloads (the DB's
// UNIQUE(group_id, message_id) catches them), but the API churn is wasted.
const _activeBackfillsByGroup = new Map(); // groupId(string) → jobId(string)

function _historyRetentionMs(loadConfig) {
    try {
        const days = Number(loadConfig().advanced?.history?.retentionDays);
        if (Number.isFinite(days) && days >= 1 && days <= 3650) {
            return days * 24 * 60 * 60 * 1000;
        }
    } catch {}
    return 30 * 24 * 60 * 60 * 1000;
}

async function _loadHistoryJobsFromDisk(historyJobsPath, loadConfig) {
    try {
        const raw = await fs.readFile(historyJobsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - _historyRetentionMs(loadConfig);
        return parsed.filter(j => j && (j.finishedAt || j.startedAt || 0) >= cutoff);
    } catch {
        return [];
    }
}

async function _saveHistoryJobsToDisk(historyJobsPath, dataDir, loadConfig) {
    // Snapshot finished jobs (state !== running) without the _runner ref.
    const finished = Array.from(_historyJobs.values())
        .filter(j => j.state !== 'running')
        .map(({ _runner, ...rest }) => rest);
    // Merge with anything still on disk that isn't in memory (older history).
    const onDisk = await _loadHistoryJobsFromDisk(historyJobsPath, loadConfig);
    const byId = new Map();
    for (const j of onDisk) byId.set(j.id, j);
    for (const j of finished) byId.set(j.id, j);
    const cutoff = Date.now() - _historyRetentionMs(loadConfig);
    const all = Array.from(byId.values())
        .filter(j => (j.finishedAt || j.startedAt || 0) >= cutoff)
        .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
    try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(historyJobsPath, JSON.stringify(all, null, 2), 'utf-8');
    } catch (e) {
        console.error('history-jobs.json write failed:', e?.message || e);
    }
}

/** Returns true if a backfill is already running for the given groupId. */
export function isBackfillActive(groupId) {
    return _activeBackfillsByGroup.has(String(groupId));
}

/**
 * Build and return a bound _spawnInternalBackfill for server.js to use
 * in the catch_up_needed event listener and the groups auto-first backfill.
 *
 * @param {object} ctx  Same ctx as createHistoryRouter
 * @returns {Function}  async ({ groupId, limit, mode, reason }) => jobId | null
 */
export function createSpawnBackfill({ dataDir, loadConfig, getAccountManager, runtime, broadcast, log }) {
    const historyJobsPath = path.join(dataDir, 'history-jobs.json');

    return async function spawnInternalBackfill({ groupId, limit, mode = 'pull-older', reason = 'internal' }) {
        const groupKey = String(groupId);
        if (_activeBackfillsByGroup.has(groupKey)) return null;
        const am = await getAccountManager();
        if (am.count === 0) throw new Error('No Telegram accounts loaded');
        const config = loadConfig();
        const group = (config.groups || []).find(g => String(g.id) === groupKey);
        if (!group) throw new Error('Group not configured');

        const { HistoryDownloader } = await import('../../core/history.js');
        const { DownloadManager } = await import('../../core/downloader.js');
        const { RateLimiter } = await import('../../core/security.js');
        const standalone = !runtime._downloader;
        const downloader = runtime._downloader || new DownloadManager(
            am.getDefaultClient(), config, new RateLimiter(config.rateLimits),
        );
        if (standalone) { await downloader.init(); downloader.start(); }
        const history = new HistoryDownloader(am.getDefaultClient(), downloader, config, am);

        const jobId = crypto.randomBytes(6).toString('hex');
        const lim = (limit === null || limit === 0) ? null : Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Number(limit) || 100));
        const job = {
            id: jobId, state: 'running', processed: 0, downloaded: 0, error: null,
            group: group.name, groupId: groupKey, limit: lim,
            startedAt: Date.now(), finishedAt: null, cancelled: false,
            mode, reason, _runner: history,
        };
        _historyJobs.set(jobId, job);
        _activeBackfillsByGroup.set(groupKey, jobId);
        history.on('progress', (s) => {
            job.processed = s.processed; job.downloaded = s.downloaded;
            broadcast({ type: 'history_progress', jobId, ...s,
                group: group.name, groupId: groupKey, limit: job.limit,
                startedAt: job.startedAt, mode: job.mode });
        });
        history.on('start', (s) => { if (s?.mode) job.mode = s.mode; });
        history.downloadHistory(groupKey, { limit: lim ?? undefined, mode })
            .then(() => {
                job.state = job.cancelled ? 'cancelled' : 'done';
                job.finishedAt = Date.now();
                delete job._runner;
                const evt = job.cancelled ? 'history_cancelled' : 'history_done';
                broadcast({ type: evt, jobId, group: group.name, ...job });
                if (standalone) downloader.stop().catch(() => {});
                _saveHistoryJobsToDisk(historyJobsPath, dataDir, loadConfig).catch(() => {});
                if (_activeBackfillsByGroup.get(groupKey) === jobId) _activeBackfillsByGroup.delete(groupKey);
                setTimeout(() => _historyJobs.delete(jobId), HISTORY_JOB_TTL_MS);
            })
            .catch((err) => {
                job.state = 'error';
                job.error = err?.message || String(err);
                job.finishedAt = Date.now();
                delete job._runner;
                broadcast({ type: 'history_error', jobId, error: job.error, group: group.name, groupId: groupKey });
                // Same hint flow as the user-triggered branch so auto-backfills
                // (first-add bootstrap, post-restart catch-up) get a readable
                // diagnostic when they fail.
                const hint = /no available account/i.test(job.error)
                    ? ' (no logged-in account can read this group — check Settings → Telegram Accounts)'
                    : '';
                log({ source: 'backfill', level: 'error', msg: `auto-backfill failed for "${group.name}" (${groupKey}): ${job.error}${hint}` });
                if (standalone) downloader.stop().catch(() => {});
                _saveHistoryJobsToDisk(historyJobsPath, dataDir, loadConfig).catch(() => {});
                if (_activeBackfillsByGroup.get(groupKey) === jobId) _activeBackfillsByGroup.delete(groupKey);
            });
        return jobId;
    };
}

/**
 * History / backfill routes.
 *
 * @param {object} ctx
 * @param {string}   ctx.dataDir          Path to data directory
 * @param {Function} ctx.loadConfig        () => config (sync, cached)
 * @param {Function} ctx.getAccountManager async () => AccountManager
 * @param {object}   ctx.runtime           Runtime instance
 * @param {Function} ctx.broadcast         WebSocket broadcast
 * @param {Function} ctx.log               Structured logger
 */
export function createHistoryRouter({ dataDir, loadConfig, getAccountManager, runtime, broadcast, log }) {
    const router = express.Router();
    const historyJobsPath = path.join(dataDir, 'history-jobs.json');

    // Run an out-of-band backfill against a configured group. Re-uses the
    // runtime's downloader if it's running so the worker pool isn't doubled;
    // otherwise spins one up just for this request and tears it down on
    // completion.
    //
    // Persistence — past jobs (last 30 days) are written to data/history-jobs.json
    // so the Backfill page can show a rolling history across server restarts.
    // JSON file is enough at this scale; the map below holds active jobs plus a
    // hot copy of recent finished ones; the file is the source of truth for older.
    router.post('/api/history', async (req, res) => {
        try {
            const { groupId, limit = 100, offsetId = 0, mode } = req.body || {};
            if (!groupId) return res.status(400).json({ error: 'groupId required' });
            const groupKey = String(groupId);
            if (_activeBackfillsByGroup.has(groupKey)) {
                return res.status(409).json({
                    error: 'A backfill is already running for this group',
                    code: 'ALREADY_RUNNING',
                    jobId: _activeBackfillsByGroup.get(groupKey),
                });
            }
            // limit === 0 (or "0") means "no limit" → backfill the entire history.
            // Anything else is clamped into a sane positive range.
            const limRaw = parseInt(limit, 10);
            const lim = (limRaw === 0)
                ? null
                : Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Number.isFinite(limRaw) ? limRaw : 100));

            const am = await getAccountManager();
            if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });

            const config = loadConfig();
            const group = (config.groups || []).find(g => String(g.id) === String(groupId));
            if (!group) return res.status(404).json({ error: 'Group not configured' });

            const { HistoryDownloader } = await import('../../core/history.js');
            const { DownloadManager } = await import('../../core/downloader.js');
            const { RateLimiter } = await import('../../core/security.js');

            const standalone = !runtime._downloader;
            const downloader = runtime._downloader || new DownloadManager(
                am.getDefaultClient(), config, new RateLimiter(config.rateLimits),
            );
            if (standalone) {
                await downloader.init();
                downloader.start();
            }

            const history = new HistoryDownloader(am.getDefaultClient(), downloader, config, am);

            const jobId = crypto.randomBytes(6).toString('hex');
            const job = {
                id: jobId,
                state: 'running',
                processed: 0,
                downloaded: 0,
                error: null,
                group: group.name,
                groupId: String(group.id),
                limit: lim, // null = "all"
                startedAt: Date.now(),
                finishedAt: null,
                cancelled: false,
                _runner: history,
            };
            _historyJobs.set(jobId, job);
            _activeBackfillsByGroup.set(groupKey, jobId);

            history.on('progress', (s) => {
                job.processed = s.processed; job.downloaded = s.downloaded;
                broadcast({
                    type: 'history_progress',
                    jobId, ...s,
                    group: group.name,
                    groupId: job.groupId,
                    limit: job.limit,
                    startedAt: job.startedAt,
                    mode: job.mode || 'pull-older',
                });
            });
            // Mirror the chosen mode onto the job so the UI shows it ("pull
            // older" / "catch up" / "rescan") even after the worker exits.
            history.on('start', (s) => { if (s?.mode) job.mode = s.mode; });

            history.downloadHistory(groupId, {
                limit: lim ?? undefined,
                offsetId: parseInt(offsetId, 10) || 0,
                mode: mode === 'catch-up' || mode === 'rescan' ? mode : 'pull-older',
            })
                .then(() => {
                    job.state = job.cancelled ? 'cancelled' : 'done';
                    job.finishedAt = Date.now();
                    delete job._runner;
                    // Two distinct terminal events so the dashboard can flash
                    // green for natural completions and amber for user cancels
                    // without sniffing payload fields.
                    const evt = job.cancelled ? 'history_cancelled' : 'history_done';
                    broadcast({ type: evt, jobId, group: group.name, ...job });
                    if (standalone) downloader.stop().catch(() => {});
                    _saveHistoryJobsToDisk(historyJobsPath, dataDir, loadConfig).catch(() => {});
                    // Release the per-group lock so a new backfill can spawn.
                    if (_activeBackfillsByGroup.get(groupKey) === jobId) {
                        _activeBackfillsByGroup.delete(groupKey);
                    }
                    // Drop the in-memory entry after a grace window so the UI has
                    // time to grab it via /api/history/jobs.
                    setTimeout(() => _historyJobs.delete(jobId), HISTORY_JOB_TTL_MS);
                })
                .catch((err) => {
                    job.state = 'error';
                    job.error = err?.message || String(err);
                    job.finishedAt = Date.now();
                    delete job._runner;
                    broadcast({ type: 'history_error', jobId, error: job.error, group: group.name, groupId: job.groupId });
                    // Surface the failure on the realtime log channel so the
                    // operator sees WHY a backfill flashed red instead of just
                    // "it failed". Hint when the message points at account
                    // access — easy to misread as "downloader is broken" when
                    // the real fix is "log in to a Telegram account that's a
                    // member of the group". Common causes hit by this branch:
                    // session expired, account left the group, FloodWait
                    // bouncing all retries, group went private.
                    const hint = /no available account/i.test(job.error)
                        ? ' (no logged-in account can read this group — check Settings → Telegram Accounts and make sure at least one is a member)'
                        : '';
                    log({ source: 'backfill', level: 'error', msg: `backfill failed for "${group.name}" (${group.id}): ${job.error}${hint}` });
                    if (standalone) downloader.stop().catch(() => {});
                    _saveHistoryJobsToDisk(historyJobsPath, dataDir, loadConfig).catch(() => {});
                    if (_activeBackfillsByGroup.get(groupKey) === jobId) {
                        _activeBackfillsByGroup.delete(groupKey);
                    }
                });

            log({ source: 'backfill', level: 'info', msg: `backfill started for "${group.name}" (${group.id}) — limit=${lim} mode=${job.mode || 'pull-older'}` });
            res.json({ success: true, jobId, group: group.name, limit: lim, mode: job.mode || 'pull-older' });
        } catch (e) {
            console.error('POST /api/history:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // /api/history/jobs returns BOTH the live + recent finished jobs combined.
    // MUST be mounted before /api/history/:jobId so :jobId doesn't swallow "/jobs".
    router.get('/api/history/jobs', async (req, res) => {
        try {
            const onDisk = await _loadHistoryJobsFromDisk(historyJobsPath, loadConfig);
            const live = Array.from(_historyJobs.values()).map(({ _runner, ...rest }) => rest);
            const byId = new Map();
            for (const j of onDisk) byId.set(j.id, j);
            for (const j of live) byId.set(j.id, j); // live overrides disk (same id)
            const all = Array.from(byId.values()).sort(
                (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
            );
            const recent = all.filter(j => j.state !== 'running').slice(0, 30);
            res.json({
                active: all.filter(j => j.state === 'running'),
                // `recent` is the canonical key the dashboard reads; `past` is
                // kept as an alias for any older client still in flight.
                recent,
                past: recent,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/history/:jobId/cancel', (req, res) => {
        const job = _historyJobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.state !== 'running') {
            return res.status(409).json({ error: `Job is ${job.state}, cannot cancel` });
        }
        try {
            job.cancelled = true;
            if (typeof job._runner?.cancel === 'function') job._runner.cancel();
            broadcast({ type: 'history_cancelling', jobId: job.id, group: job.group });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/history/cancel-active', (req, res) => {
        try {
            let cancelled = 0;
            for (const job of _historyJobs.values()) {
                if (job.state !== 'running') continue;
                job.cancelled = true;
                if (typeof job._runner?.cancel === 'function') job._runner.cancel();
                broadcast({ type: 'history_cancelling', jobId: job.id, group: job.group });
                cancelled++;
            }
            res.json({ success: true, cancelled });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/history/:jobId', (req, res) => {
        const job = _historyJobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const { _runner, ...safe } = job;
        res.json(safe);
    });

    // Remove a single finished history entry from the Recent backfills list.
    // Running jobs cannot be deleted — they have to be cancelled first.
    router.delete('/api/history/:jobId', async (req, res) => {
        try {
            const id = req.params.jobId;
            const inMem = _historyJobs.get(id);
            if (inMem && inMem.state === 'running') {
                return res.status(409).json({ error: 'Cannot delete a running job — cancel first.' });
            }
            if (inMem) _historyJobs.delete(id);

            // Drop from on-disk store too. Atomic write via fs.writeFile (the
            // existing saveHistoryJobsToDisk pattern handles concurrency by
            // reading + filtering + writing in one tick).
            const onDisk = await _loadHistoryJobsFromDisk(historyJobsPath, loadConfig);
            const filtered = onDisk.filter(j => j.id !== id);
            try {
                await fs.mkdir(dataDir, { recursive: true });
                await fs.writeFile(historyJobsPath, JSON.stringify(filtered, null, 2), 'utf-8');
            } catch (e) {
                console.error('history-jobs.json write failed:', e?.message || e);
            }

            broadcast({ type: 'history_deleted', jobId: id });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Clear every finished entry from the Recent backfills list. Running jobs
    // are preserved — same posture as the per-row delete (cancel first).
    router.delete('/api/history', async (req, res) => {
        try {
            let removed = 0;
            for (const [id, job] of Array.from(_historyJobs.entries())) {
                if (job.state !== 'running') { _historyJobs.delete(id); removed++; }
            }
            // Wipe the on-disk store of finished jobs.
            try {
                await fs.mkdir(dataDir, { recursive: true });
                await fs.writeFile(historyJobsPath, JSON.stringify([], null, 2), 'utf-8');
            } catch (e) {
                console.error('history-jobs.json wipe failed:', e?.message || e);
            }
            broadcast({ type: 'history_cleared' });
            res.json({ success: true, removed });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/history', (req, res) => {
        res.json(Array.from(_historyJobs.values()).map(({ _runner, ...rest }) => rest));
    });

    return router;
}
