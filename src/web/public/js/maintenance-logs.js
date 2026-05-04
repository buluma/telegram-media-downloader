// Maintenance — Realtime log viewer (admin page).
//
// Boots from /api/maintenance/logs/recent (newest 200) then tails the
// `log` WS stream live. DOM is capped at 1000 lines (oldest evicted) so
// a chatty failure mode doesn't blow up memory.
//
// Filters: source (multi-select chip group), level (radio), free-text
// search. Pause + Clear + Download .log + auto-scroll toggle.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { t as i18nT } from './i18n.js';

const $ = (id) => document.getElementById(id);

const SOURCES = ['app', 'nsfw', 'thumbs', 'dedup', 'integrity', 'gramjs', 'downloader', 'monitor'];
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
const MAX_LINES = 1000;

let _wsWired = false;
let _pageWired = false;
let _paused = false;
let _autoscroll = true;
const _filter = {
    sources: new Set(SOURCES),
    minLevel: 'info',
    search: '',
};
const _lines = []; // ring buffer of {ts,source,level,msg}

function _formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function _matchesFilter(entry) {
    if (!_filter.sources.has(entry.source)) return false;
    const rank = LEVEL_RANK[entry.level] ?? 0;
    if (rank < (LEVEL_RANK[_filter.minLevel] ?? 0)) return false;
    if (_filter.search) {
        const needle = _filter.search.toLowerCase();
        if (!String(entry.msg || '').toLowerCase().includes(needle)) return false;
    }
    return true;
}

function _renderLine(entry) {
    const cls = entry.level === 'error'
        ? 'text-red-400'
        : entry.level === 'warn'
            ? 'text-yellow-400'
            : 'text-tg-text';
    return `<div class="${cls}">[${_formatTime(entry.ts)}] [${escapeHtml(entry.source)}] [${escapeHtml(entry.level)}] ${escapeHtml(entry.msg)}</div>`;
}

function _renderAll() {
    const pre = $('logs-stream');
    if (!pre) return;
    const html = _lines.filter(_matchesFilter).map(_renderLine).join('');
    pre.innerHTML = html;
    if (_autoscroll) pre.scrollTop = pre.scrollHeight;
}

function _appendOne(entry) {
    _lines.push(entry);
    if (_lines.length > MAX_LINES) _lines.shift();
    if (_paused) return;
    if (!_matchesFilter(entry)) return;
    const pre = $('logs-stream');
    if (!pre) return;
    pre.insertAdjacentHTML('beforeend', _renderLine(entry));
    // Cap rendered lines too — if filters keep most, the DOM can still
    // bloat past MAX_LINES. Drop the oldest visible line.
    while (pre.children.length > MAX_LINES) pre.removeChild(pre.firstChild);
    if (_autoscroll) pre.scrollTop = pre.scrollHeight;
}

function _wireFilters() {
    const sourceWrap = $('logs-filter-sources');
    if (sourceWrap) {
        sourceWrap.innerHTML = SOURCES.map((s) => `
            <label class="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-tg-border text-xs cursor-pointer hover:bg-tg-hover">
                <input type="checkbox" class="logs-source-chip" data-source="${escapeHtml(s)}" checked>
                <span>${escapeHtml(s)}</span>
            </label>`).join('');
        sourceWrap.querySelectorAll('.logs-source-chip').forEach((cb) => {
            cb.addEventListener('change', () => {
                if (cb.checked) _filter.sources.add(cb.dataset.source);
                else _filter.sources.delete(cb.dataset.source);
                _renderAll();
            });
        });
    }
    const levelWrap = $('logs-filter-level');
    if (levelWrap) {
        levelWrap.querySelectorAll('input[name="logs-level"]').forEach((rb) => {
            rb.addEventListener('change', () => {
                if (rb.checked) _filter.minLevel = rb.value;
                _renderAll();
            });
        });
    }
    const searchInput = $('logs-search');
    if (searchInput) {
        // Debounce — at 1 000 buffered lines a full re-render on every
        // keystroke turned a 12-character query into 12 sluggish renders
        // on mid-tier mobile.
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                _filter.search = String(searchInput.value || '');
                _renderAll();
            }, 150);
        });
    }
    const autoCb = $('logs-autoscroll');
    if (autoCb) {
        autoCb.addEventListener('change', () => { _autoscroll = autoCb.checked; });
    }
    const pauseBtn = $('logs-pause-btn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            _paused = !_paused;
            pauseBtn.textContent = _paused
                ? i18nT('maintenance.logs.resume', 'Resume')
                : i18nT('maintenance.logs.pause', 'Pause');
            pauseBtn.dataset.paused = _paused ? '1' : '0';
            if (!_paused) _renderAll();
        });
    }
    const clearBtn = $('logs-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            _lines.length = 0;
            const pre = $('logs-stream');
            if (pre) pre.innerHTML = '';
            showToast(i18nT('maintenance.logs.cleared', 'Cleared (visual only — server buffer untouched).'), 'info');
        });
    }
    const dlBtn = $('logs-download-btn');
    if (dlBtn) {
        dlBtn.addEventListener('click', () => {
            const filtered = _lines.filter(_matchesFilter);
            const text = filtered.map((e) => {
                const ts = new Date(e.ts).toISOString();
                return `[${ts}] [${e.source}] [${e.level}] ${e.msg}`;
            }).join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tgdl-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 0);
        });
    }
}

async function _loadBackfill() {
    try {
        const r = await api.get('/api/maintenance/logs/recent?limit=200');
        const logs = Array.isArray(r.logs) ? r.logs : [];
        _lines.length = 0;
        for (const e of logs) _lines.push(e);
        _renderAll();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed to load logs', 'error');
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('log', (m) => {
        // m has shape { type:'log', ts, source, level, msg } per server.js
        _appendOne({
            ts: m.ts || Date.now(),
            source: m.source || 'app',
            level: m.level || 'info',
            msg: m.msg || '',
        });
    });
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        _wireFilters();
    }
    // Refresh backfill every time the user opens the page so they're not
    // staring at a stale tail from a previous visit.
    _loadBackfill();
}
