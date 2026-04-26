// Sticky status bar — runtime state, queue, active workers, disk usage, WS link.

import { api } from './api.js';
import { ws } from './ws.js';
import { formatBytes } from './utils.js';

const $ = (id) => document.getElementById(id);
let pollHandle = null;

function applyState(state) {
    const dot = $('status-dot');
    const lbl = $('status-state');
    const map = {
        running: { color: 'bg-tg-green', text: 'Monitor running' },
        starting: { color: 'bg-tg-blue', text: 'Starting…' },
        stopping: { color: 'bg-tg-orange', text: 'Stopping…' },
        stopped: { color: 'bg-gray-500', text: 'Idle' },
        error: { color: 'bg-tg-red', text: 'Error' },
    };
    const m = map[state] || map.stopped;
    if (dot) dot.className = `w-2 h-2 rounded-full ${m.color}`;
    if (lbl) lbl.textContent = m.text;
}

async function refresh() {
    try {
        const [mon, stats] = await Promise.all([
            api.get('/api/monitor/status').catch(() => null),
            api.get('/api/stats').catch(() => null),
        ]);
        if (mon) {
            applyState(mon.state);
            $('status-queue').textContent = mon.queue ?? 0;
            $('status-active').textContent = mon.active ?? 0;
        }
        if (stats) {
            $('status-files').textContent = stats.totalFiles ?? 0;
            $('status-disk').textContent = stats.diskUsageFormatted || formatBytes(stats.diskUsage || 0);
        }
    } catch { /* keep last values */ }
}

export function initStatusBar() {
    refresh();
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(refresh, 5000);

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
            refresh();
        }
    });
}
