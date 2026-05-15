/**
 * Auto-backfill scheduler.
 *
 * Runs a periodic tick (every 15 minutes) and fires a backfill job for each
 * configured group whose `backfillSchedule` is due. No external cron dep —
 * schedule intervals are stored as millisecond thresholds and compared against
 * a per-group `lastRunAt` timestamp persisted in the KV store.
 *
 * Per-group config fields:
 *   backfillSchedule  'off' | '6h' | '12h' | 'daily' | 'weekly'  (default 'off')
 *   backfillLimit     integer > 0  (default 100)
 */

import crypto from 'crypto';
import { kvGet, kvSet } from './db.js';
import { logger } from './logger.js';

const TICK_MS = 15 * 60 * 1000; // check every 15 min
const KV_KEY = 'auto_backfill_state'; // { groupId: lastRunAtMs }

const SCHEDULE_MS = {
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
};

function _loadState() {
    try {
        return kvGet(KV_KEY) || {};
    } catch {
        return {};
    }
}

function _saveState(s) {
    try {
        kvSet(KV_KEY, s);
    } catch {}
}

export class AutoBackfillScheduler {
    constructor({ loadConfig, getAccountManager, broadcast, log, activeBackfillsByGroup }) {
        if (typeof loadConfig !== 'function')
            throw new Error('AutoBackfillScheduler requires loadConfig');
        this._loadConfig = loadConfig;
        this._getAccountManager = getAccountManager;
        this._broadcast = typeof broadcast === 'function' ? broadcast : () => {};
        this._log = typeof log === 'function' ? log : () => {};
        this._activeBackfillsByGroup = activeBackfillsByGroup;
        this._timer = null;
        this._running = false;
    }

    start() {
        this.stop();
        // First tick 2 min after boot (skip immediate to not race with startup I/O).
        const initial = setTimeout(() => this.tick().catch(() => {}), 2 * 60 * 1000);
        initial.unref?.();
        this._timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
        this._timer.unref?.();
        logger.info('[auto-backfill] scheduler started');
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    restart() {
        this.stop();
        this.start();
    }

    async tick() {
        if (this._running) return;
        this._running = true;
        try {
            const cfg = this._loadConfig();
            const groups = (cfg.groups || []).filter(
                (g) =>
                    g.backfillSchedule &&
                    g.backfillSchedule !== 'off' &&
                    SCHEDULE_MS[g.backfillSchedule],
            );
            if (groups.length === 0) return;

            const state = _loadState();
            const now = Date.now();
            let changed = false;

            for (const group of groups) {
                const intervalMs = SCHEDULE_MS[group.backfillSchedule];
                const lastRun = Number(state[String(group.id)]) || 0;
                if (now - lastRun < intervalMs) continue;

                // Skip if a manual backfill is already running for this group.
                if (this._activeBackfillsByGroup?.has(String(group.id))) {
                    logger.info(
                        { groupId: group.id, name: group.name },
                        '[auto-backfill] skipped — manual job running',
                    );
                    continue;
                }

                try {
                    await this._runBackfill(group, cfg);
                    state[String(group.id)] = now;
                    changed = true;
                } catch (e) {
                    logger.warn(
                        { groupId: group.id, err: e.message },
                        '[auto-backfill] job failed',
                    );
                }
            }

            if (changed) _saveState(state);
        } finally {
            this._running = false;
        }
    }

    async _runBackfill(group, cfg) {
        const limit = Math.max(1, Math.min(10000, parseInt(group.backfillLimit, 10) || 100));
        logger.info(
            { groupId: group.id, name: group.name, schedule: group.backfillSchedule, limit },
            '[auto-backfill] starting job',
        );

        const am = await this._getAccountManager();
        if (!am || am.count === 0) {
            throw new Error('no Telegram accounts loaded');
        }

        const { HistoryDownloader } = await import('./history.js');
        const { DownloadManager } = await import('./downloader.js');
        const { RateLimiter } = await import('./security.js');
        const { runtime } = await import('./runtime.js');

        const standalone = !runtime._downloader;
        const downloader =
            runtime._downloader ||
            new DownloadManager(am.getDefaultClient(), cfg, new RateLimiter(cfg.rateLimits));
        if (standalone) {
            await downloader.init();
            downloader.start();
        }

        const history = new HistoryDownloader(am.getDefaultClient(), downloader, cfg, am);

        return new Promise((resolve, reject) => {
            const jobId = crypto.randomBytes(6).toString('hex');
            this._activeBackfillsByGroup?.set(String(group.id), jobId);

            history.on('progress', (s) => {
                this._broadcast({
                    type: 'history_progress',
                    jobId,
                    ...s,
                    group: group.name,
                    groupId: String(group.id),
                    limit,
                    source: 'auto',
                });
            });

            history
                .downloadHistory(group.id, { limit })
                .then((result) => {
                    logger.info(
                        { groupId: group.id, name: group.name, downloaded: result?.downloaded },
                        '[auto-backfill] job done',
                    );
                    this._log({
                        source: 'history',
                        level: 'info',
                        msg: `auto-backfill done: ${group.name} — downloaded ${result?.downloaded ?? 0} files`,
                    });
                    resolve(result);
                })
                .catch(reject)
                .finally(() => {
                    if (this._activeBackfillsByGroup?.get(String(group.id)) === jobId) {
                        this._activeBackfillsByGroup.delete(String(group.id));
                    }
                    if (standalone) {
                        downloader.stop?.();
                    }
                });
        });
    }
}

let _singleton = null;

export function getAutoBackfillScheduler(opts) {
    if (!_singleton && opts) _singleton = new AutoBackfillScheduler(opts);
    return _singleton;
}
