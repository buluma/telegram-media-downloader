// Maintenance — AI search & smart organisation page.
//
// Drives the four cards on /maintenance/ai:
//   - Settings strip with one toggle + Re-index button per capability
//   - Search panel (delegates to ai-search.js)
//   - People grid (face clusters)
//   - Auto-tag cloud
//   - Near-duplicate groups (perceptual dedup)
//
// All long-running scans are background jobs — we kick them off via POST,
// re-mount progress from the matching /scan/status endpoint, and listen on
// the four `ai_*` WebSocket prefixes for live updates.
//
// Idempotent init() — safe to re-call when the page is re-mounted.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { bindSearchUi } from './ai-search.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _initOnce = false;

const CAPS = [
    { key: 'embeddings', titleKey: 'maintenance.ai.cap.embeddings', titleFb: 'Semantic search (CLIP)',
      scanUrl: '/api/ai/index/scan', wsPrefix: 'ai_index' },
    { key: 'faces',      titleKey: 'maintenance.ai.cap.faces',      titleFb: 'Face clustering (people)',
      scanUrl: '/api/ai/people/scan', wsPrefix: 'ai_people' },
    { key: 'tags',       titleKey: 'maintenance.ai.cap.tags',       titleFb: 'Auto-tag (ImageNet)',
      scanUrl: '/api/ai/tags/scan', wsPrefix: 'ai_tags' },
    { key: 'phash',      titleKey: 'maintenance.ai.cap.phash',      titleFb: 'Perceptual dedup',
      scanUrl: '/api/ai/perceptual-dedup/scan', wsPrefix: 'ai_phash' },
];

function _renderSettings(status) {
    const grid = $('ai-settings-grid');
    if (!grid) return;
    const caps = status?.capabilities || {};
    const counts = status?.counts || {};
    grid.innerHTML = CAPS.map((c) => {
        const enabled = !!caps[c.key];
        const dot = enabled ? 'bg-green-500' : 'bg-gray-500';
        const label = i18nT(c.titleKey, c.titleFb);
        const helpKey = `${c.titleKey}.help`;
        const help = i18nT(helpKey, '');
        return `
            <div class="ai-cap-card bg-tg-bg/30 rounded-lg p-2.5 flex items-start gap-2.5" data-cap="${c.key}">
                <span class="inline-block w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${dot}"></span>
                <div class="flex-1 min-w-0">
                    <div class="text-tg-text font-medium">${escapeHtml(label)}</div>
                    ${help ? `<div class="text-tg-textSecondary text-[11px] leading-snug">${escapeHtml(help)}</div>` : ''}
                    <div class="ai-cap-progress text-[11px] text-tg-textSecondary tabular-nums mt-1"></div>
                </div>
                <button class="ai-cap-scan-btn tg-btn-secondary text-[11px] px-2 py-1 ${enabled ? '' : 'opacity-50 cursor-not-allowed'}"
                        ${enabled ? '' : 'disabled'} data-scan-cap="${c.key}">
                    ${escapeHtml(i18nT('maintenance.ai.scan.start', 'Start scan'))}
                </button>
            </div>
        `;
    }).join('');
    grid.querySelectorAll('[data-scan-cap]').forEach((btn) => {
        btn.addEventListener('click', () => _kickScan(btn.dataset.scanCap));
    });

    const indexedPct = counts.totalEligible
        ? Math.floor((counts.indexed / counts.totalEligible) * 100)
        : 0;
    const meta = $('ai-vec-status');
    if (meta) {
        const parts = [];
        if (counts.totalEligible != null) {
            parts.push(i18nTf('maintenance.ai.indexed_pct',
                { p: indexedPct, n: counts.indexed || 0, t: counts.totalEligible || 0 },
                `${indexedPct}% indexed (${counts.indexed || 0}/${counts.totalEligible || 0})`));
        }
        meta.textContent = parts.join(' · ');
    }
}

async function _kickScan(capKey) {
    const cap = CAPS.find((c) => c.key === capKey);
    if (!cap) return;
    try {
        await api.post(cap.scanUrl, {});
        showToast(i18nT('maintenance.ai.scan.started', 'Scan started'));
    } catch (e) {
        showToast(i18nTf('maintenance.ai.scan.failed', { msg: e.message }, `Failed: ${e.message}`));
    }
}

function _onProgressUpdate(capKey, payload) {
    const card = document.querySelector(`.ai-cap-card[data-cap="${capKey}"] .ai-cap-progress`);
    if (!card) return;
    if (payload?.processed != null && payload?.total != null) {
        card.textContent = i18nTf('maintenance.ai.scan.running',
            { processed: payload.processed, total: payload.total },
            `Scanning… ${payload.processed} / ${payload.total}`);
    } else if (payload?.stage) {
        card.textContent = String(payload.stage);
    }
}

function _onDone(capKey) {
    const card = document.querySelector(`.ai-cap-card[data-cap="${capKey}"] .ai-cap-progress`);
    if (card) card.textContent = i18nT('maintenance.ai.scan.done', 'Done');
    // Refresh the static lists once a scan finishes.
    _refreshAll().catch(() => {});
}

async function _hydrateFromStatus() {
    // Each capability has its own /scan/status; query each in parallel and
    // map progress back into the corresponding card.
    const targets = [
        ['embeddings', '/api/ai/index/scan/status'],
        ['faces',      '/api/ai/people/scan/status'],
        ['tags',       '/api/ai/tags/scan/status'],
        ['phash',      '/api/ai/perceptual-dedup/scan/status'],
    ];
    await Promise.all(targets.map(async ([key, url]) => {
        try {
            const s = await api.get(url);
            if (s?.running) _onProgressUpdate(key, { ...s.progress });
        } catch { /* status endpoints are best-effort during hydrate */ }
    }));
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    for (const cap of CAPS) {
        ws.on(`${cap.wsPrefix}_progress`, (msg) => {
            _onProgressUpdate(cap.key, msg.progress || msg);
        });
        ws.on(`${cap.wsPrefix}_done`, () => _onDone(cap.key));
    }
}

async function _loadPeople() {
    let r;
    try { r = await api.get('/api/ai/people'); } catch { r = null; }
    const grid = $('ai-people-grid');
    const empty = $('ai-people-empty');
    const count = $('ai-people-count');
    if (!grid) return;
    const list = r?.people || [];
    if (!list.length) {
        grid.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = i18nTf('maintenance.ai.people.count', { n: list.length }, `${list.length} clusters`);
    grid.innerHTML = list.map((p) => {
        const cover = p.cover_download_id
            ? `<img src="/api/thumbs/${p.cover_download_id}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none'"/>`
            : '<i class="ri-user-line text-3xl text-tg-textSecondary"></i>';
        const lbl = p.label && p.label.trim()
            ? escapeHtml(p.label)
            : escapeHtml(i18nT('maintenance.ai.people.unnamed', 'Unnamed person'));
        return `
            <div class="ai-person-tile bg-tg-bg/40 rounded-lg overflow-hidden border border-tg-border" data-person-id="${p.id}">
                <div class="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">${cover}</div>
                <div class="p-2">
                    <input class="ai-person-rename w-full bg-transparent text-tg-text text-xs border-none focus:outline-none focus:ring-1 focus:ring-tg-blue/40 rounded px-1 py-0.5"
                           data-person-id="${p.id}"
                           data-i18n-placeholder="maintenance.ai.people.rename_placeholder"
                           placeholder="${escapeHtml(i18nT('maintenance.ai.people.rename_placeholder', 'Add a name…'))}"
                           value="${escapeHtml(p.label || '')}"
                           data-original="${escapeHtml(p.label || '')}"/>
                    <div class="text-[11px] text-tg-textSecondary tabular-nums mt-0.5">${escapeHtml(lbl)} · ${p.face_count || 0}</div>
                </div>
            </div>
        `;
    }).join('');
    grid.querySelectorAll('.ai-person-rename').forEach((inp) => {
        inp.addEventListener('change', async () => {
            const id = Number(inp.dataset.personId);
            const newLabel = inp.value.trim();
            if (newLabel === inp.dataset.original) return;
            try {
                await api.put(`/api/ai/people/${id}`, { label: newLabel || null });
                inp.dataset.original = newLabel;
                showToast(i18nT('maintenance.ai.people.saved', 'Name saved'));
            } catch (e) {
                showToast(i18nTf('maintenance.ai.people.save_failed', { msg: e.message }, `Failed: ${e.message}`));
            }
        });
    });
}

async function _loadTags() {
    let r;
    try { r = await api.get('/api/ai/tags'); } catch { r = null; }
    const cloud = $('ai-tags-cloud');
    const empty = $('ai-tags-empty');
    const count = $('ai-tags-count');
    if (!cloud) return;
    const tags = r?.tags || [];
    if (!tags.length) {
        cloud.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = i18nTf('maintenance.ai.tags.count', { n: tags.length }, `${tags.length} tags`);
    const max = Math.max(...tags.map((t) => t.count));
    cloud.innerHTML = tags.map((t) => {
        const ratio = max ? Math.max(0.7, Math.min(2.0, t.count / max + 0.7)) : 1;
        const size = Math.floor(ratio * 12);
        return `
            <button type="button" class="ai-tag-chip bg-tg-bg/40 hover:bg-tg-blue/15 text-tg-text rounded-full px-2.5 py-0.5"
                    style="font-size: ${size}px"
                    data-tag="${escapeHtml(t.tag)}">
                ${escapeHtml(t.tag)} <span class="text-tg-textSecondary tabular-nums">${t.count}</span>
            </button>
        `;
    }).join('');
}

async function _loadPhashGroups() {
    let r;
    try { r = await api.get('/api/ai/perceptual-dedup/groups?threshold=6'); } catch { r = null; }
    const wrap = $('ai-phash-groups');
    const empty = $('ai-phash-empty');
    const count = $('ai-phash-count');
    if (!wrap) return;
    const groups = r?.groups || [];
    if (!groups.length) {
        wrap.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = i18nTf('maintenance.ai.phash.count', { n: groups.length }, `${groups.length} groups`);
    wrap.innerHTML = groups.slice(0, 30).map((g) => {
        const tiles = (g.rows || []).slice(0, 8).map((row) => `
            <div class="ai-phash-tile bg-tg-bg/40 rounded overflow-hidden border border-tg-border">
                <div class="aspect-square bg-black/40 flex items-center justify-center">
                    <img src="/api/thumbs/${row.id}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none'"/>
                </div>
                <div class="text-[10px] text-tg-textSecondary truncate px-1 py-0.5">${escapeHtml(row.file_name || '')}</div>
            </div>
        `).join('');
        return `
            <div class="ai-phash-group bg-tg-bg/30 rounded-lg p-2">
                <div class="text-[11px] text-tg-textSecondary mb-1.5">${i18nTf('maintenance.ai.phash.group_size', { n: g.size }, `${g.size} similar`)}</div>
                <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5">${tiles}</div>
            </div>
        `;
    }).join('');
}

async function _refreshAll() {
    let s;
    try { s = await api.get('/api/ai/status'); } catch { s = null; }
    if (s) _renderSettings(s);
    await Promise.all([_loadPeople(), _loadTags(), _loadPhashGroups()]).catch(() => {});
}

export async function init() {
    _wireWs();
    if (!_initOnce) {
        // First mount — wire the search box.
        bindSearchUi({
            inputEl: $('ai-search-input'),
            buttonEl: $('ai-search-btn'),
            resultsEl: $('ai-search-results'),
            emptyEl: $('ai-search-empty'),
            metaEl: $('ai-search-meta'),
        });
        _initOnce = true;
    }
    await _refreshAll();
    await _hydrateFromStatus();
}
