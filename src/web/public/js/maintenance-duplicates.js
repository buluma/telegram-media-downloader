// Maintenance — Find duplicate files (admin page).
//
// Shows every set of byte-identical files (SHA-256), lets the admin pick
// which copies to delete, and runs a one-shot delete via
// /api/maintenance/dedup/delete. A "Re-index from disk" button at the top
// rebuilds the catalogue if files exist on disk but the DB is empty (a
// common cause of empty dedup results).
//
// Owns:
//   - One-shot scan + render of duplicate sets.
//   - Bulk-select shortcuts (keep oldest / keep newest / select-all).
//   - Live dedup_progress + reindex_progress / reindex_done WS handlers.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;
let _sets = []; // last scan result

function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _renderRow(file, set) {
    const thumbUrl = `/api/thumbs/${encodeURIComponent(file.id)}?w=120`;
    const fileUrl = `/files/${encodeURIComponent(file.filePath || '')}?inline=1`;
    const when = file.createdAt ? new Date(file.createdAt).toLocaleString() : '—';
    return `
        <label class="flex items-center gap-2 p-2 rounded-md hover:bg-tg-hover cursor-pointer" data-file-row="${file.id}">
            <input type="checkbox" class="dup-del" data-id="${file.id}" data-hash="${escapeHtml(set.hash)}">
            <img loading="lazy" decoding="async"
                 class="w-12 h-12 object-cover rounded-md bg-tg-bg/40"
                 src="${escapeHtml(thumbUrl)}" alt=""
                 onerror="this.style.display='none'">
            <div class="min-w-0 flex-1">
                <div class="text-sm text-tg-text truncate">${escapeHtml(file.fileName || '(unnamed)')}</div>
                <div class="text-xs text-tg-textSecondary truncate">${escapeHtml(file.groupName || file.groupId || '')} · ${when}</div>
            </div>
            <a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener"
               class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
               title="${escapeHtml(i18nT('maintenance.dedup.view', 'View'))}">
                <i class="ri-eye-line"></i>
            </a>
        </label>`;
}

function _renderSet(set) {
    return `
        <div class="bg-tg-bg/40 rounded-lg p-3 mb-3 border border-tg-border/40" data-set="${escapeHtml(set.hash)}">
            <div class="flex items-center justify-between mb-2 gap-2 flex-wrap">
                <div class="text-xs text-tg-textSecondary">
                    ${escapeHtml(i18nTf('maintenance.dedup.set_header',
                        { count: set.count, size: _formatBytes(set.fileSize) },
                        `${set.count} copies · ${_formatBytes(set.fileSize)} each`))}
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" class="text-xs px-2 py-0.5 rounded border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
                            data-keep="oldest" data-hash="${escapeHtml(set.hash)}"
                            data-i18n="maintenance.duplicates.keep_oldest">Keep oldest</button>
                    <button type="button" class="text-xs px-2 py-0.5 rounded border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
                            data-keep="newest" data-hash="${escapeHtml(set.hash)}"
                            data-i18n="maintenance.duplicates.keep_newest">Keep newest</button>
                </div>
            </div>
            <div class="space-y-1">${set.files.map((f) => _renderRow(f, set)).join('')}</div>
        </div>`;
}

function _refreshSummary() {
    const root = $('page-maintenance-duplicates');
    if (!root) return;
    const ids = [...root.querySelectorAll('.dup-del:checked')].map((el) => Number(el.dataset.id));
    let bytes = 0;
    for (const set of _sets) {
        for (const f of set.files) if (ids.includes(f.id)) bytes += Number(f.fileSize) || 0;
    }
    const sum = $('dup-summary');
    if (sum) {
        sum.textContent = i18nTf('maintenance.dedup.selected',
            { count: ids.length, freed: _formatBytes(bytes) },
            `${ids.length} selected · ${_formatBytes(bytes)} will be freed`);
    }
}

function _renderSets(sets) {
    _sets = Array.isArray(sets) ? sets : [];
    const list = $('dup-list');
    const empty = $('dup-empty');
    const totals = $('dup-totals');
    if (!list) return;

    if (!_sets.length) {
        list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        if (totals) totals.textContent = '';
        _refreshSummary();
        return;
    }
    if (empty) empty.classList.add('hidden');

    const totalSets = _sets.length;
    const totalDupes = _sets.reduce((s, x) => s + (x.count - 1), 0);
    const totalReclaim = _sets.reduce((s, x) => s + (x.fileSize * (x.count - 1)), 0);
    if (totals) {
        totals.textContent = i18nTf('maintenance.dedup.summary',
            { sets: totalSets, dupes: totalDupes, freed: _formatBytes(totalReclaim) },
            `${totalSets} duplicate sets · ${totalDupes} extra copies · up to ${_formatBytes(totalReclaim)} reclaimable.`);
    }

    list.innerHTML = _sets.map(_renderSet).join('');

    // Default selection: keep oldest of every set, mark rest for deletion.
    for (const set of _sets) {
        const sortedAsc = [...set.files].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const keepId = sortedAsc[0]?.id;
        for (const f of set.files) {
            const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
            if (cb) cb.checked = (f.id !== keepId);
        }
    }

    // Wire per-row checkbox + per-set keep buttons.
    list.querySelectorAll('.dup-del').forEach((cb) => cb.addEventListener('change', _refreshSummary));
    list.querySelectorAll('[data-keep]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const hash = btn.dataset.hash;
            const keep = btn.dataset.keep;
            const set = _sets.find((s) => s.hash === hash);
            if (!set) return;
            const sortedAsc = [...set.files].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            const keepId = (keep === 'newest' ? sortedAsc[sortedAsc.length - 1] : sortedAsc[0]).id;
            for (const f of set.files) {
                const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
                if (cb) cb.checked = (f.id !== keepId);
            }
            _refreshSummary();
        });
    });

    _refreshSummary();
}

function _setScanUi(running) {
    const btn = $('dup-scan-btn');
    const progress = $('dup-progress');
    const bar = $('dup-progress-bar');
    if (btn) {
        btn.disabled = !!running;
        btn.textContent = running
            ? i18nT('maintenance.dedup.scanning', 'Scanning…')
            : i18nT('maintenance.duplicates.scan', 'Scan');
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running && bar) bar.style.width = '0%';
}

// `POST /api/maintenance/dedup/scan` is fire-and-forget — returns 200
// with `{started:true}` immediately so Cloudflare's 100 s tunnel timeout
// can never bite, and a 50 GB library hashing for minutes doesn't hold
// the request open. Result lands via `dedup_done` WS event; status
// recovery on re-mount via GET /dedup/status.
async function _runScan() {
    _setScanUi(true);
    try {
        const r = await api.post('/api/maintenance/dedup/scan', {});
        if (r?.error) {
            showToast(r.error, 'error');
            _setScanUi(false);
            return;
        }
        // Don't render anything yet — wait for `dedup_done` over WS.
    } catch (e) {
        // 409 = already running on another client. Hydrate from /status
        // so the button stays disabled until the other client finishes.
        if (e?.data?.code === 'ALREADY_RUNNING') {
            _setScanUi(true);
            showToast(i18nT('maintenance.dedup.already_running', 'A dedup scan is already running on another client.'), 'info');
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setScanUi(false);
    }
}

// Recover live state on (re-)entry — the scan keeps running on the
// server even after a tab close, so we re-paint the running UI + the
// last completed result if any. Also hydrates the bulk-delete + reindex
// trackers so a job started on one client disables the buttons on this
// tab until it finishes.
async function _recoverScanState() {
    try {
        const r = await api.get('/api/maintenance/dedup/status');
        if (r?.running) _setScanUi(true);
        if (r?.result?.duplicateSets) _renderSets(r.result.duplicateSets);
    } catch { /* non-fatal */ }
    try {
        const r = await api.get('/api/maintenance/dedup/delete/status');
        if (r?.running) _setDeleteUi(true);
    } catch {}
    try {
        const r = await api.get('/api/maintenance/reindex/status');
        if (r?.running) {
            const btn = $('dup-reindex-btn');
            const progress = $('dup-reindex-progress');
            if (btn) {
                btn.disabled = true;
                btn.textContent = i18nT('maintenance.reindex.running', 'Re-indexing…');
            }
            if (progress) progress.classList.remove('hidden');
        }
    } catch {}
}

function _setDeleteUi(running) {
    const btn = $('dup-delete-btn');
    if (btn) btn.disabled = !!running;
}

async function _deleteSelected() {
    const root = $('page-maintenance-duplicates');
    if (!root) return;
    const ids = [...root.querySelectorAll('.dup-del:checked')].map((el) => Number(el.dataset.id));
    if (!ids.length) {
        showToast(i18nT('maintenance.dedup.nothing', 'Nothing selected'), 'info');
        return;
    }
    const ok = await confirmSheet({
        title: i18nT('maintenance.dedup.confirm_title', 'Delete duplicate files?'),
        message: i18nTf('maintenance.dedup.confirm_body',
            { n: ids.length },
            `Permanently delete ${ids.length} file(s) from disk and database?`),
        confirmLabel: i18nT('maintenance.dedup.confirm_btn', 'Delete'),
        danger: true,
    });
    if (!ok) return;
    // Fire-and-forget — at N=10k disk I/O can run for minutes. The
    // result lands via `dedup_delete_done` (handled in `_wireWs`); a
    // running job started by another client keeps THIS button disabled
    // through `dedup_delete_progress`.
    _setDeleteUi(true);
    try {
        const r = await api.post('/api/maintenance/dedup/delete', { ids });
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setDeleteUi(false);
    }
}

async function _runReindex() {
    const btn = $('dup-reindex-btn');
    const status = $('dup-reindex-status');
    const progress = $('dup-reindex-progress');
    const bar = $('dup-reindex-progress-bar');
    if (btn) {
        btn.disabled = true;
        btn.textContent = i18nT('maintenance.reindex.running', 'Re-indexing…');
    }
    if (progress) progress.classList.remove('hidden');
    if (bar) bar.style.width = '0%';
    if (status) status.textContent = '';
    try {
        await api.post('/api/maintenance/reindex', {});
        // Result lands over WS — handler re-enables the button when done.
    } catch (e) {
        const msg = e?.data?.error || e.message || 'Failed';
        showToast(msg, 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = i18nT('maintenance.reindex.button', 'Re-index from disk');
        }
        if (progress) progress.classList.add('hidden');
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;

    ws.on('dedup_progress', (m) => {
        // Make sure the running UI is visible — handles the case where a
        // sibling client started the scan and we're seeing it second-hand.
        _setScanUi(true);
        const bar = $('dup-progress-bar');
        const stage = $('dup-progress-stage');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round((m.processed || 0) / total * 100));
        bar.style.width = pct + '%';
        if (stage) {
            stage.textContent = i18nTf('maintenance.dedup.progress',
                { stage: m.stage || '', processed: m.processed || 0, total: m.total || 0 },
                `${m.stage || ''} · ${m.processed || 0} / ${m.total || 0}`);
        }
    });

    ws.on('dedup_done', (m) => {
        _setScanUi(false);
        if (m?.error) {
            showToast(i18nTf('maintenance.dedup.scan_failed',
                { msg: m.error }, `Dedup scan failed: ${m.error}`), 'error');
            return;
        }
        const sets = Array.isArray(m?.duplicateSets) ? m.duplicateSets : [];
        _renderSets(sets);
        if (!sets.length) {
            showToast(i18nTf('maintenance.dedup.none',
                { scanned: m?.scanned ?? 0 },
                `No duplicates found — scanned ${m?.scanned ?? 0} files.`),
                'success');
        }
    });

    // dedup_delete_progress / _done — fired by the bulk-delete tracker.
    // Both gallery-selection bulk-delete and the duplicate-finder's
    // delete button share this single tracker, so closing the tab
    // mid-delete and reopening this page still picks up the running
    // state (re-disables the Delete button) until the work finishes.
    ws.on('dedup_delete_progress', () => {
        _setDeleteUi(true);
    });

    ws.on('dedup_delete_done', async (m) => {
        _setDeleteUi(false);
        if (m?.error) {
            showToast(i18nTf('maintenance.failed',
                { msg: m.error }, `Failed: ${m.error}`), 'error');
            return;
        }
        const removed = m?.removed ?? m?.deleted ?? 0;
        const freed = m?.freedBytes ?? 0;
        showToast(i18nTf('maintenance.dedup.deleted',
            { removed, freed: _formatBytes(freed) },
            `Removed ${removed} files — freed ${_formatBytes(freed)}`),
            'success');
        try { await _runScan(); } catch {}
    });

    ws.on('reindex_progress', (m) => {
        const bar = $('dup-reindex-progress-bar');
        const status = $('dup-reindex-status');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round((m.processed || 0) / total * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf('maintenance.reindex.progress',
                { processed: m.processed || 0, total: m.total || 0 },
                `${m.processed || 0} / ${m.total || 0} groups`);
        }
    });

    ws.on('reindex_done', (m) => {
        const btn = $('dup-reindex-btn');
        const progress = $('dup-reindex-progress');
        const status = $('dup-reindex-status');
        if (btn) {
            btn.disabled = false;
            btn.textContent = i18nT('maintenance.reindex.button', 'Re-index from disk');
        }
        if (progress) progress.classList.add('hidden');
        if (m?.error) {
            showToast(i18nTf('maintenance.reindex.failed',
                { msg: m.error }, `Re-index failed: ${m.error}`), 'error');
            if (status) status.textContent = '';
            return;
        }
        const added = m?.added ?? m?.indexed ?? 0;
        const scanned = m?.scanned ?? m?.total ?? 0;
        const msg = i18nTf('maintenance.reindex.done',
            { added, scanned },
            `Re-index done — added ${added} rows from ${scanned} files.`);
        showToast(msg, 'success');
        if (status) status.textContent = msg;
    });
}

export function init() {
    _wireWs();

    if (!_pageWired) {
        _pageWired = true;
        $('dup-scan-btn')?.addEventListener('click', _runScan);
        $('dup-delete-btn')?.addEventListener('click', _deleteSelected);
        $('dup-reindex-btn')?.addEventListener('click', _runReindex);
    }

    // Always re-hydrate state on (re-)entry — covers the close-tab,
    // start-on-mobile-pop-on-pc, and tab-revisit-mid-scan flows. State
    // lives on the server, the front-end is just a renderer.
    _recoverScanState();
}
