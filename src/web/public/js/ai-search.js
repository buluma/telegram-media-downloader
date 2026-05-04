// AI semantic search box — used by the /maintenance/ai page and reusable
// from any future inline gallery search affordance.
//
// Owns:
//   - Debounced text-input handler that hits POST /api/ai/search.
//   - Result rendering as a thumbnail grid (re-uses /api/thumbs/:id).
//   - Empty + error states.
//
// Idempotent — the page module re-calls `bindSearchUi()` every time it
// mounts, which is safe because we attach handlers to elements by id and
// store wired flags on the elements themselves.

import { api } from './api.js';
import { escapeHtml } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const DEBOUNCE_MS = 350;

function _renderThumbCard(r) {
    const score = (Number(r.score) || 0).toFixed(3);
    const fname = escapeHtml(r.file_name || '');
    const groupName = escapeHtml(r.group_name || r.group_id || '');
    return `
        <a class="ai-search-tile block rounded-lg overflow-hidden bg-tg-bg/40 border border-tg-border hover:border-tg-blue/60 transition"
           href="#/viewer/${encodeURIComponent(r.group_id)}" title="${fname}">
            <div class="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                <img src="/api/thumbs/${r.download_id}" alt=""
                     class="w-full h-full object-cover"
                     onerror="this.style.display='none'"/>
            </div>
            <div class="px-2 py-1.5 text-[11px] leading-tight">
                <div class="text-tg-text truncate">${fname}</div>
                <div class="text-tg-textSecondary truncate">${groupName}</div>
                <div class="text-tg-textSecondary tabular-nums mt-0.5">${i18nTf('maintenance.ai.search.score', { n: score }, `score ${score}`)}</div>
            </div>
        </a>
    `;
}

/**
 * Run a single search and render results into the configured DOM nodes.
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.limit=24]
 * @param {string[]} [opts.fileTypes]
 */
export async function runSearch({ query, limit = 24, fileTypes = null,
                                   resultsEl, emptyEl, metaEl } = {}) {
    if (!query || !query.trim()) return;
    if (resultsEl) resultsEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.add('hidden');
    if (metaEl) metaEl.textContent = i18nT('maintenance.ai.search.searching', 'Searching…');
    let r;
    try {
        r = await api.post('/api/ai/search', { query: query.trim(), limit, fileTypes });
    } catch (e) {
        if (metaEl) metaEl.textContent = i18nTf('maintenance.ai.search.error', { msg: e.message }, `Search failed: ${e.message}`);
        return;
    }
    if (!r?.results?.length) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (metaEl) metaEl.textContent = '';
        return;
    }
    if (resultsEl) {
        resultsEl.innerHTML = r.results.map(_renderThumbCard).join('');
    }
    if (metaEl) {
        metaEl.textContent = i18nTf('maintenance.ai.search.found',
            { n: r.results.length },
            `${r.results.length} matches`);
    }
}

/**
 * Wire up the search input + button on the /maintenance/ai page.
 * @returns {() => void} teardown function (removes listeners)
 */
export function bindSearchUi({ inputEl, buttonEl, resultsEl, emptyEl, metaEl }) {
    if (!inputEl || !buttonEl) return () => {};
    if (inputEl._aiSearchWired) return inputEl._aiSearchWired;
    let timer = null;
    const fire = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            runSearch({ query: inputEl.value, resultsEl, emptyEl, metaEl });
        }, DEBOUNCE_MS);
    };
    const onInput = () => fire();
    const onKey = (e) => {
        if (e.key === 'Enter') {
            clearTimeout(timer);
            runSearch({ query: inputEl.value, resultsEl, emptyEl, metaEl });
        }
    };
    const onClick = () => {
        clearTimeout(timer);
        runSearch({ query: inputEl.value, resultsEl, emptyEl, metaEl });
    };
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKey);
    buttonEl.addEventListener('click', onClick);
    const teardown = () => {
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('keydown', onKey);
        buttonEl.removeEventListener('click', onClick);
        inputEl._aiSearchWired = null;
    };
    inputEl._aiSearchWired = teardown;
    return teardown;
}
