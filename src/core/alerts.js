// ntfy alerting bridge — pushes operator-facing alerts to an ntfy topic
// (self-hosted or ntfy.sh) for the two failure modes that otherwise go
// unnoticed for days:
//
//   1. download failure streaks — N consecutive download_error events with
//      no completion in between (Telegram auth expiry, dead disk, network
//      partition all look like this);
//   2. silent groups — a monitor-enabled group that hasn't produced a single
//      download in N days (dead entity, revoked membership, or a monitor
//      wedged on one group while others flow).
//
// Config lives under `alerts` in config.json:
//   alerts: {
//     enabled: false,
//     ntfy: { url: 'https://ntfy.sh', topic: '', authToken: '' },
//     failureStreak: 5,        // 0 disables streak alerts
//     silentGroupDays: 0,      // 0 disables silent-group alerts
//   }
//
// Reads config through a getter on every decision so Settings changes apply
// without a restart (same hot-reload contract as the rest of runtime.js).

import { getDb } from './db.js';
import { logger } from './logger.js';
import { swallow } from './util/swallow.js';

/**
 * Fire a single ntfy notification. Never throws — returns true on 2xx,
 * false on any failure (missing topic, network error, non-2xx).
 *
 * @param {{url?: string, topic?: string, authToken?: string}} ntfyCfg
 * @param {{title: string, message: string, priority?: number, tags?: string}} n
 */
export async function sendNtfy(ntfyCfg, { title, message, priority, tags }) {
    const base = String(ntfyCfg?.url || '').replace(/\/+$/, '');
    const topic = String(ntfyCfg?.topic || '').trim();
    if (!base || !topic) return false;
    const headers = { Title: title };
    if (priority) headers.Priority = String(priority);
    if (tags) headers.Tags = tags;
    if (ntfyCfg.authToken) headers.Authorization = `Bearer ${ntfyCfg.authToken}`;
    try {
        const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
            method: 'POST',
            headers,
            body: message,
        });
        if (!res.ok) {
            logger.warn({ status: res.status }, '[alerts] ntfy rejected notification');
            return false;
        }
        return true;
    } catch (e) {
        swallow(e, 'alerts:sendNtfy');
        return false;
    }
}

/**
 * Create an alerter bound to a config getter. Call `.attach(runtime)` to
 * subscribe to download events, and `.startSilentGroupTimer()` to begin the
 * daily silent-group sweep.
 *
 * @param {{ getConfig: () => object }} deps
 */
export function createAlerter({ getConfig }) {
    let _streak = 0;
    let _streakAlerted = false;
    // groupId -> epoch-ms of last silent alert; prevents re-alerting the
    // same group on every sweep while it stays silent.
    const _silentAlertedAt = new Map();
    const SILENT_REALERT_MS = 24 * 60 * 60 * 1000;
    let _timer = null;

    function _alertsCfg() {
        const cfg = getConfig() || {};
        return cfg.alerts || {};
    }

    function _onEvent(evt) {
        const a = _alertsCfg();
        if (!a.enabled) return;
        const threshold = Number(a.failureStreak) || 0;
        if (evt?.type === 'download_complete') {
            _streak = 0;
            _streakAlerted = false;
            return;
        }
        if (evt?.type !== 'download_error') return;
        _streak += 1;
        if (threshold > 0 && _streak >= threshold && !_streakAlerted) {
            _streakAlerted = true;
            const lastErr = evt?.payload?.error ? `\nLast error: ${evt.payload.error}` : '';
            sendNtfy(a.ntfy || {}, {
                title: `tgdl: download failure streak (${_streak})`,
                message: `${_streak} consecutive download failures with no success in between.${lastErr}`,
                priority: 4,
                tags: 'warning,tgdl',
            });
        }
    }

    /**
     * Find monitor-enabled groups whose newest download is older than
     * `alerts.silentGroupDays` days (or that have no downloads at all) and
     * push one ntfy alert covering all of them. Re-alerts a still-silent
     * group at most once per 24 h. Returns the flagged groups.
     */
    async function checkSilentGroups() {
        const cfg = getConfig() || {};
        const a = cfg.alerts || {};
        const days = Number(a.silentGroupDays) || 0;
        if (!a.enabled || days <= 0) return [];

        const enabledGroups = (cfg.groups || []).filter((g) => g.enabled);
        if (enabledGroups.length === 0) return [];

        let lastByGroup = new Map();
        try {
            const rows = getDb()
                .prepare(
                    `SELECT group_id, MAX(created_at) AS last_at
                       FROM downloads
                      GROUP BY group_id`,
                )
                .all();
            lastByGroup = new Map(rows.map((r) => [String(r.group_id), r.last_at]));
        } catch (e) {
            swallow(e, 'alerts:checkSilentGroups');
            return [];
        }

        const now = Date.now();
        const cutoff = now - days * 24 * 60 * 60 * 1000;
        const flagged = [];
        for (const g of enabledGroups) {
            const lastAt = lastByGroup.get(String(g.id));
            const lastMs = lastAt ? Date.parse(lastAt) : 0;
            if (lastMs >= cutoff) continue;
            const alertedAt = _silentAlertedAt.get(String(g.id)) || 0;
            if (now - alertedAt < SILENT_REALERT_MS) continue;
            flagged.push({
                id: String(g.id),
                name: g.name || String(g.id),
                lastAt: lastMs ? new Date(lastMs).toISOString() : null,
            });
        }

        if (flagged.length > 0) {
            const lines = flagged.map(
                (g) => `• ${g.name} — last download ${g.lastAt ? g.lastAt.slice(0, 10) : 'never'}`,
            );
            const ok = await sendNtfy(a.ntfy || {}, {
                title: `tgdl: ${flagged.length} silent group${flagged.length === 1 ? '' : 's'}`,
                message: `No downloads in ${days}+ days from:\n${lines.join('\n')}`,
                priority: 3,
                tags: 'hourglass_flowing_sand,tgdl',
            });
            if (ok) {
                for (const g of flagged) _silentAlertedAt.set(g.id, now);
            }
        }
        return flagged;
    }

    return {
        /** Subscribe to a runtime-style EventEmitter's 'event' stream. */
        attach(runtimeEmitter) {
            runtimeEmitter.on('event', _onEvent);
        },
        checkSilentGroups,
        /** Hourly sweep — cheap query, and the 24 h per-group dedupe makes
         *  the effective alert cadence daily regardless of sweep frequency. */
        startSilentGroupTimer(intervalMs = 60 * 60 * 1000) {
            if (_timer) return;
            _timer = setInterval(() => {
                checkSilentGroups().catch((e) => swallow(e, 'alerts:silent-sweep'));
            }, intervalMs);
            if (_timer.unref) _timer.unref();
        },
        stop() {
            if (_timer) clearInterval(_timer);
            _timer = null;
        },
    };
}
