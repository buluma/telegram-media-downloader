// Sticky status bar — runtime state, queue, active workers, disk usage, WS link.

import { api } from './api.js';
import { ws } from './ws.js';
import { formatBytes } from './utils.js';
import { t as i18nT } from './i18n.js';
import { subscribe as subscribeMonitorStatus, refreshNow as refreshMonitorStatus } from './monitor-status.js';

const $ = (id) => document.getElementById(id);
let statsPollHandle = null;

function applyState(state) {
    const dot = $('status-dot');
    const lbl = $('status-state');
    const map = {
        running: { color: 'bg-tg-green', text: i18nT('status.monitor_running', 'Monitor running') },
        starting: { color: 'bg-tg-blue', text: i18nT('status.starting', 'Starting…') },
        stopping: { color: 'bg-tg-orange', text: i18nT('status.stopping', 'Stopping…') },
        stopped: { color: 'bg-gray-500', text: i18nT('status.idle', 'Idle') },
        error: { color: 'bg-tg-red', text: i18nT('status.error', 'Error') },
    };
    const m = map[state] || map.stopped;
    if (dot) dot.className = `w-2 h-2 rounded-full ${m.color}`;
    if (lbl) lbl.textContent = m.text;
}

function applyMonitor(mon) {
    if (!mon) return;
    applyState(mon.state);
    const q = $('status-queue'); if (q) q.textContent = mon.queue ?? 0;
    const a = $('status-active'); if (a) a.textContent = mon.active ?? 0;
}

async function refreshStats() {
    try {
        const stats = await api.get('/api/stats').catch(() => null);
        if (stats) {
            const f = $('status-files'); if (f) f.textContent = stats.totalFiles ?? 0;
            const d = $('status-disk'); if (d) d.textContent = stats.diskUsageFormatted || formatBytes(stats.diskUsage || 0);
        }
    } catch { /* keep last values */ }
}

export function initStatusBar() {
    // Monitor state/queue/active: piggy-back on the shared monitor-status
    // poller (one /api/monitor/status fetch, three subscribers).
    subscribeMonitorStatus(applyMonitor);

    // Stats are heavier (disk walk on the server) and change slowly — keep
    // a separate, slower cadence so we don't hammer it.
    refreshStats();
    if (statsPollHandle) clearInterval(statsPollHandle);
    statsPollHandle = setInterval(refreshStats, 15000);

    // Live cues from the WebSocket
    ws.on('__ws_open', () => {
        const dot = $('status-ws'); if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-tg-green mr-1';
    });
    ws.on('__ws_close', () => {
        const dot = $('status-ws'); if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-tg-red mr-1';
    });
    ws.on('monitor_state', (m) => applyState(m.state));
    ws.on('*', (m) => {
        // refresh counters on relevant events; ignore most chatter to avoid stalls
        if (m.type && /^(download_complete|history_done|file_deleted|group_purged|purge_all|monitor_event)$/.test(m.type)) {
            refreshMonitorStatus();
            refreshStats();
        }
    });
}
