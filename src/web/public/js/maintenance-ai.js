/* Maintenance → AI page module.
 *
 * AI maintenance surface for local-only analysis: face clustering,
 * image tagging, OCR, people management, tag
 * browsing, and smart albums.
 *
 * Init contract: `init()` is called every time the SPA navigates to
 * `#/maintenance/ai`. It must be idempotent — repeated calls re-bind
 * listeners but don't double-fire requests.
 */

import { api } from './api.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { showToast, escapeHtml } from './utils.js';
import { ws } from './ws.js';
import { confirmSheet, openSheet, promptSheet } from './sheet.js';
import { openMediaViewerForReview } from './viewer.js';
import { createStore } from './store.js';

const $ = (sel) => document.querySelector(sel);

// Module state.
let _initOnce = false;

const aiStore = createStore({
    status: null,
    // People panel selection (pagination vars stay module-level)
    selectedPerson: null,
    selectedPersonName: '',
    // Tags panel selection
    tagSelected: '',
    // Smart albums panel selection
    smartAlbumSelected: null,
    smartAlbumSelectedName: '',
});
let _peoplePhotosPage = 1;
let _peoplePhotosTotal = 0;
let _peoplePhotosTotalPages = 1;
const _peoplePhotosLimit = 50;
let _peoplePhotoRows = [];
let _doctorScanReady = true;
let _peopleCache = []; // full people list (un-filtered) for client-side search
const _peopleFilter = { query: '', unlabeledOnly: false, minFaces: 1, recentFirst: false };
let _tagListCache = [];
let _tagFilterQuery = '';
let _tagSortMode = 'count_desc';
let _ocrWordFilter = ''; // when set, only show photos whose ocr_text contains this word
let _tagPhotosTotal = 0;
let _tagPhotosPage = 1;
let _tagPhotosTotalPages = 1;
const _tagPhotosLimit = 50;
let _tagCurrentRows = [];
let _lastTagsChangedAt = 0;
let _smartAlbumItemsPage = 1;
let _smartAlbumItemsTotal = 0;
let _smartAlbumItemsTotalPages = 1;
const _smartAlbumItemsLimit = 50;
let _smartAlbumCurrentRows = [];
const LS_FACES_COLLAPSED = 'tgdl.ai.faces.collapsed';
const LS_TAGS_COLLAPSED = 'tgdl.ai.tags.collapsed';
const LS_PEOPLE_COLLAPSED = 'tgdl.ai.people.collapsed';
const LS_TAG_BROWSER_COLLAPSED = 'tgdl.ai.tagBrowser.collapsed';
const LS_TAG_SUGGESTIONS_COLLAPSED = 'tgdl.ai.tagSuggestions.collapsed';
const LS_SMART_ALBUMS_COLLAPSED = 'tgdl.ai.smartAlbums.collapsed';
const LS_LLM_COLLAPSED = 'tgdl.ai.llm.collapsed';
const LS_EMBEDDINGS_COLLAPSED = 'tgdl.ai.embeddings.collapsed';

/* ----------------------------------------------------------------------
 * Capability registry.
 *
 * Legacy capability-grid registry retained for the hidden compatibility
 * host at #ai-capabilities-grid. The visible AI page uses explicit
 * panels below; keep this registry accurate enough for old extensions
 * or bookmarks that still touch the legacy host.
 *
 * Shape:
 *   id            — internal key, matches `models.<id>` in /api/ai/status
 *   i18n          — { title, desc, scanLabel } translation keys
 *   defaults      — fallback strings used when the i18n key is absent
 *   statusKey     — dotted path into /api/ai/status (e.g. 'models.faces')
 *   scanFeature   — POST /api/ai/scan/start `body.feature` value
 *   autoToggleKey — config.advanced.ai.<key> for the per-cap toggle
 *   controls      — array of slider/number controls bound to config keys
 * ------------------------------------------------------------------- */
const CAPABILITIES = [
    {
        id: 'faces',
        icon: 'ri-user-smile-line',
        i18n: {
            title: 'maintenance.ai.faces.title',
            desc: 'maintenance.ai.faces.desc',
            scanLabel: 'maintenance.ai.faces.scan',
            cancelLabel: 'common.cancel',
        },
        defaults: {
            title: 'Face clustering',
            desc: 'Detects faces with insightface buffalo_l, groups recurring people into clusters via DBSCAN.',
            scanLabel: 'Scan now',
            cancelLabel: 'Cancel',
        },
        statusKey: 'models.faces',
        scanFeature: 'faces',
        autoToggleKey: 'faceClustering',
        controls: [
            {
                type: 'select',
                cfgKey: 'facesDetectorModel',
                labelKey: 'maintenance.ai.faces.model',
                labelDefault: 'Detector model',
                default: 'buffalo_l',
                options: [
                    {
                        value: 'buffalo_l',
                        labelKey: 'maintenance.ai.faces.model_buffalo_l',
                        labelDefault: 'buffalo_l — balanced (99.5% LFW, default)',
                    },
                    {
                        value: 'antelopev2',
                        labelKey: 'maintenance.ai.faces.model_antelopev2',
                        labelDefault: 'antelopev2 — best accuracy (99.6%, Glint360K)',
                    },
                    {
                        value: 'buffalo_m',
                        labelKey: 'maintenance.ai.faces.model_buffalo_m',
                        labelDefault: 'buffalo_m — faster (99.3%)',
                    },
                    {
                        value: 'buffalo_s',
                        labelKey: 'maintenance.ai.faces.model_buffalo_s',
                        labelDefault: 'buffalo_s — fastest (99.0%)',
                    },
                ],
                helpKey: 'maintenance.ai.faces.model_help',
                helpDefault:
                    'Switching the model requires a Re-cluster — embedding spaces differ across presets.',
            },
            {
                type: 'slider',
                cfgKey: 'facesEpsilon',
                labelKey: 'maintenance.ai.faces.threshold',
                labelDefault: 'Cluster threshold (DBSCAN ε)',
                // Calibrated against real 926-photo / 689-face data:
                //   0.8-1.0 = strict (78 clusters, high precision)
                //   1.05    = PEAK (80 clusters, balanced) ← default
                //   1.10    = starting to merge (top cluster jumps)
                //   1.15+   = mega-merge — DON'T
                min: 0.3,
                max: 1.5,
                step: 0.01,
                default: 1.05,
            },
            {
                type: 'number',
                cfgKey: 'facesMinPoints',
                labelKey: 'maintenance.ai.faces.min_points',
                labelDefault: 'Min cluster size',
                min: 2,
                max: 20,
                step: 1,
                default: 2,
            },
        ],
    },
    {
        id: 'tags',
        icon: 'ri-price-tag-3-line',
        i18n: {
            title: 'maintenance.ai.tags.title',
            desc: 'maintenance.ai.tags.desc',
            scanLabel: 'maintenance.ai.tags.scan',
            cancelLabel: 'common.cancel',
        },
        defaults: {
            title: 'Image tagging',
            desc: 'Zero-shot CLIP tagging — detects objects, scenes, concepts in every photo. Runs via the Python sidecar.',
            scanLabel: 'Tag all',
            cancelLabel: 'Cancel',
        },
        statusKey: 'models.tags',
        scanFeature: 'tags',
        autoToggleKey: 'imageTagging',
        customHtml: true, // renders extra tag-labels editor + tag browser
        controls: [
            {
                type: 'custom',
                cfgKey: 'tagLabels',
                labelKey: 'maintenance.ai.tags.labels',
                labelDefault: 'Custom tags (comma-separated, leave empty for defaults)',
                placeholder: 'e.g. cat, dog, sunset, document, screenshot',
            },
        ],
    },
];

// ---- Tag browser ----------------------------------------------------------

/**
 * Fetch all detected tags from the server and render chip buttons.
 * Shows the tag browser section when tags exist, hides it otherwise.
 */
async function _renderTagBrowser(forceReload = true) {
    const section = $('#ai-tag-browser');
    const chips = $('#ai-tag-chips');
    const empty = $('#ai-tag-empty');
    const photos = $('#ai-tag-photos');
    if (!section || !chips) return;

    try {
        if (forceReload || !_tagListCache.length) {
            const r = await api.get('/api/ai/tags/list');
            _tagListCache = Array.isArray(r?.tags) ? r.tags : [];
        }
        const tagCount = $('#ai-tag-browser-count');
        if (tagCount)
            tagCount.textContent = _tagListCache.length ? `(${_tagListCache.length})` : '';
        section.classList.remove('hidden');
        if (!_tagListCache.length) {
            chips.innerHTML = '';
            if (photos) {
                photos.innerHTML =
                    '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">No tags yet — run a tag scan to populate.</p>';
            }
            if (empty) empty.classList.remove('hidden');
            aiStore.set('tagSelected', '');
            _renderTagDetails('');
            _tagPhotosTotal = 0;
            _tagPhotosPage = 1;
            _tagPhotosTotalPages = 1;
            _tagCurrentRows = [];
            _syncTagPager();
            return;
        }
        if (empty) empty.classList.add('hidden');
        const tags = _getVisibleTags();
        chips.innerHTML = tags
            .map(
                (t) =>
                    `<button type="button" class="tg-btn-input text-[11px] px-2.5 py-1 inline-flex items-center gap-1 tag-chip" data-tag="${escapeHtml(t.tag)}" aria-pressed="false">
                        ${escapeHtml(t.tag)}
                        <span class="text-[10px] text-tg-textSecondary tabular-nums">${t.count}</span>
                    </button>`,
            )
            .join('');

        // ---- OCR words chips ----
        _renderOcrChips();

        // Wire chip clicks — load photos for the selected tag
        chips.querySelectorAll('.tag-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                chips.querySelectorAll('.tag-chip').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const tag = btn.dataset.tag;
                btn.setAttribute('aria-pressed', 'true');
                if (tag) {
                    aiStore.set('tagSelected', tag);
                }
            });
            btn.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    _moveTagChipFocus(btn, 1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    _moveTagChipFocus(btn, -1);
                } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    btn.click();
                }
            });
        });
        chips.querySelectorAll('.tag-chip').forEach((b) => {
            if (b.dataset.tag !== aiStore.get('tagSelected'))
                b.setAttribute('aria-pressed', 'false');
        });

        // Keep selected tag if it still exists after refresh/filtering.
        const selectedBtn = aiStore.get('tagSelected')
            ? Array.from(chips.querySelectorAll('.tag-chip')).find(
                  (el) => el.dataset.tag === aiStore.get('tagSelected'),
              )
            : null;
        const pick = selectedBtn || chips.querySelector('.tag-chip');
        if (pick) {
            pick.classList.add('active');
            pick.setAttribute('aria-pressed', 'true');
            const tag = pick.dataset.tag || '';
            if (tag) {
                if (aiStore.get('tagSelected') !== tag) {
                    aiStore.set('tagSelected', tag); // watcher fires _loadTagPhotos
                } else {
                    _loadTagPhotos(tag); // same tag: watcher won't re-fire, load directly
                }
            }
            return;
        }
        // No tags match current filter.
        if (photos) {
            photos.innerHTML =
                '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">No tags match the current filter.</p>';
        }
        _tagPhotosTotal = 0;
        _tagPhotosPage = 1;
        _tagPhotosTotalPages = 1;
        _tagCurrentRows = [];
        _syncTagPager();
    } catch (e) {
        console.warn('tag browser:', e);
        section.classList.add('hidden');
    }
}

/**
 * Load photos for a specific tag and render them as a grid.
 */
async function _loadTagPhotos(tag) {
    const photos = $('#ai-tag-photos');
    if (!photos) return;
    _tagPhotosPage = 1;
    _tagPhotosTotal = 0;
    _tagPhotosTotalPages = 1;
    _tagCurrentRows = [];
    _syncTagPager();
    await _loadTagPhotoPage();
}

async function _loadTagPhotoPage() {
    const photos = $('#ai-tag-photos');
    const tag = aiStore.get('tagSelected');
    if (!photos || !tag) return;
    photos.innerHTML =
        '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6"><i class="ri-loader-4-line animate-spin mr-1"></i>Loading…</p>';
    try {
        const offset = Math.max(0, (_tagPhotosPage - 1) * _tagPhotosLimit);
        const r = await api.get(
            `/api/ai/tags/photos?tag=${encodeURIComponent(tag)}&limit=${_tagPhotosLimit}&offset=${offset}`,
        );
        const files = Array.isArray(r?.files) ? r.files : [];
        let filtered = files;
        if (_ocrWordFilter) {
            const lowerWord = _ocrWordFilter.toLowerCase();
            filtered = files.filter((f) => {
                const txt = (f.ocr_text || '').toLowerCase();
                return txt.includes(lowerWord);
            });
        }
        _tagCurrentRows = filtered;
        if (_ocrWordFilter) {
            // OCR filter is client-side only; server total reflects unfiltered
            // pages so use the filtered count to avoid phantom pages.
            _tagPhotosTotal = filtered.length;
            _tagPhotosTotalPages = 1;
        } else {
            _tagPhotosTotal = Number(r?.total) || files.length;
            _tagPhotosTotalPages = Math.max(1, Math.ceil(_tagPhotosTotal / _tagPhotosLimit));
        }
        if (!filtered.length) {
            photos.innerHTML = `<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">${_ocrWordFilter ? `No photos with this tag containing "${escapeHtml(_ocrWordFilter)}".` : 'No photos with this tag.'}</p>`;
            _syncTagPager();
            return;
        }
        photos.innerHTML = filtered.map((f, i) => _renderTagPhotoTile(f, i)).join('');
        _wireTagPhotoClicks();
        _syncTagPager();
    } catch (e) {
        _tagCurrentRows = [];
        _syncTagPager();
        photos.innerHTML = `<p class="text-[11px] text-red-400 col-span-full text-center py-6">Failed: ${escapeHtml(e?.message || 'unknown')}</p>`;
    }
}

function _renderTagPhotoTile(file, index) {
    const thumb = `/api/thumbs/${encodeURIComponent(file.id)}?w=320`;
    const scorePct = file.tag_score ? Math.round(file.tag_score * 100) : 0;
    const ocrSnippet = file.ocr_text ? String(file.ocr_text).slice(0, 100).trim() : '';
    return `<button type="button" data-tag-tile-index="${index}" data-id="${file.id}"
            class="nsfw-tile group relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 focus:outline-none focus:ring-2 focus:ring-tg-blue">
        <img loading="lazy" decoding="async"
             class="absolute inset-0 w-full h-full object-cover"
             src="${escapeHtml(thumb)}" alt=""
             onerror="this.style.display='none'">
        <span class="hidden sm:block absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-mono rounded bg-tg-blue/85 text-white tabular-nums">${scorePct}%</span>
        ${ocrSnippet ? `<span class="absolute bottom-1 left-1 right-1 px-1.5 py-0.5 text-[9px] leading-tight rounded bg-black/60 text-white/80 truncate">${escapeHtml(ocrSnippet)}</span>` : ''}
        <span class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition flex items-end p-2 pointer-events-none">
            <span class="text-[11px] text-white truncate w-full text-left">${escapeHtml(file.file_name || '')}</span>
        </span>
    </button>`;
}

function _wireTagPhotoClicks() {
    const photos = $('#ai-tag-photos');
    if (!photos) return;
    photos.querySelectorAll('[data-tag-tile-index]').forEach((tile) => {
        if (tile.dataset.wired) return;
        tile.dataset.wired = '1';
        tile.addEventListener('click', () => {
            const idx = Number(tile.dataset.tagTileIndex);
            if (Number.isFinite(idx)) _openTagLightbox(idx);
        });
    });
}

function _tagRowToViewerFile(row) {
    const sizeMb = row.file_size ? (row.file_size / (1024 * 1024)).toFixed(1) : '0';
    return {
        fullPath: row.file_path || '',
        type: row.file_type === 'video' ? 'videos' : 'images',
        name: row.file_name || '',
        sizeFormatted: `${sizeMb} MB`,
        modified: row.created_at || Date.now(),
        _tagRow: row,
    };
}

function _tagReviewMetaFor(file) {
    const row = file?._tagRow;
    const score = Math.round((Number(row?.tag_score) || 0) * 100);
    return `<span class="inline-flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-tg-blue"></span>
        <span>${escapeHtml(aiStore.get('tagSelected') || '')}</span>
        <span class="font-mono tabular-nums">${score}%</span>
    </span>`;
}

function _openTagLightbox(startIndex) {
    if (!_tagCurrentRows.length) return;
    openMediaViewerForReview(_tagCurrentRows.map(_tagRowToViewerFile), startIndex, {
        actions: [],
        metaRender: _tagReviewMetaFor,
    });
}

function _syncTagPager() {
    const pageInfo = $('#ai-tag-page-info');
    const prevBtn = $('#ai-tag-prev-btn');
    const nextBtn = $('#ai-tag-next-btn');
    const hasTag = !!aiStore.get('tagSelected');
    if (pageInfo) {
        pageInfo.textContent = hasTag
            ? `Page ${_tagPhotosPage} / ${_tagPhotosTotalPages} · ${_tagPhotosTotal.toLocaleString()} photos`
            : '';
    }
    const createBtn = $('#ai-tag-create-album');
    if (createBtn) createBtn.disabled = !hasTag;
    if (prevBtn) prevBtn.disabled = !hasTag || _tagPhotosPage <= 1;
    if (nextBtn) nextBtn.disabled = !hasTag || _tagPhotosPage >= _tagPhotosTotalPages;
}

function _moveTagChipFocus(currentBtn, dir) {
    const chips = $('#ai-tag-chips');
    if (!chips || !currentBtn) return;
    const list = Array.from(chips.querySelectorAll('.tag-chip'));
    if (!list.length) return;
    const idx = list.indexOf(currentBtn);
    if (idx < 0) return;
    let next = idx + dir;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    list[next]?.focus();
}

/**
 * Fetch and render tag details panel (count, avg score, sources,
 * related tags). Hidden when tag is null/empty.
 */
async function _renderTagDetails(tag) {
    const panel = $('#ai-tag-details');
    if (!panel) return;
    if (!tag) {
        panel.classList.add('hidden');
        return;
    }
    try {
        const r = await api.get(`/api/ai/tags/details?tag=${encodeURIComponent(tag)}`);
        if (!r.success || !r.details) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        const d = r.details;

        const nameEl = $('#ai-tag-details-name');
        if (nameEl) nameEl.textContent = d.tag;

        const metaEl = $('#ai-tag-details-meta');
        if (metaEl) {
            const pct = d.avgScore ? Math.round(d.avgScore * 100) : 0;
            metaEl.textContent = `${d.count.toLocaleString()} photos \u00b7 avg confidence ${pct}%`;
        }

        // Source badges
        const sourcesEl = $('#ai-tag-details-sources');
        if (sourcesEl) {
            const labels = { clip: 'CLIP', wd14: 'WD14' };
            sourcesEl.innerHTML = (Array.isArray(d.sources) ? d.sources : [])
                .map(
                    (s) =>
                        `<span class="inline-block rounded px-1.5 py-0.5 border text-[9px] font-medium leading-none ${s.source === 'clip' ? 'border-green-500/30 bg-green-500/10 text-green-200' : s.source === 'wd14' ? 'border-purple-500/30 bg-purple-500/10 text-purple-200' : 'border-blue-500/30 bg-blue-500/10 text-blue-200'}">${escapeHtml(labels[s.source] || s.source)} \u00b7 ${s.count.toLocaleString()}</span>`,
                )
                .join('');
        }

        // Related tags (clickable)
        const relatedEl = $('#ai-tag-details-related');
        if (relatedEl) {
            const related = Array.isArray(d.related) ? d.related.slice(0, 12) : [];
            if (related.length) {
                relatedEl.innerHTML = `Related: ${related
                    .map(
                        (r) =>
                            `<button type="button" class="ai-related-tag-link text-tg-blue hover:underline inline" data-tag="${escapeHtml(r.tag)}">${escapeHtml(r.tag)}</button>`,
                    )
                    .join(', ')}`;
                relatedEl.querySelectorAll('.ai-related-tag-link').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const t = btn.dataset.tag;
                        if (t) _selectTagChip(t);
                    });
                });
            } else {
                relatedEl.textContent = '';
            }
        }
    } catch (e) {
        console.warn('tag details:', e);
        panel.classList.add('hidden');
    }
}

/** Programmatically select and click a tag chip by tag name */
function _selectTagChip(tag) {
    const chips = $('#ai-tag-chips');
    if (!chips) return;
    const btn = Array.from(chips.querySelectorAll('.tag-chip')).find(
        (el) => el.dataset.tag === tag,
    );
    if (btn) {
        btn.click();
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ---- OCR word chips -----------------------------------------------------

let _ocrWordsCache = [];

async function _renderOcrChips() {
    const section = $('#ai-tag-ocr-section');
    const chips = $('#ai-tag-ocr-chips');
    const countEl = $('#ai-tag-ocr-count');
    const clearBtn = $('#ai-tag-ocr-clear');
    if (!chips) return;
    try {
        if (!_ocrWordsCache.length) {
            const r = await api.get('/api/ai/ocr/words?minLength=3&minCount=2&limit=60');
            _ocrWordsCache = Array.isArray(r?.words) ? r.words : [];
        }
        if (!_ocrWordsCache.length) {
            section?.classList.add('hidden');
            return;
        }
        section?.classList.remove('hidden');
        if (countEl) countEl.textContent = `(${_ocrWordsCache.length})`;
        if (clearBtn) {
            clearBtn.classList.toggle('hidden', !_ocrWordFilter);
            clearBtn.onclick = () => {
                _ocrWordFilter = '';
                _renderOcrChips();
                if (aiStore.get('tagSelected')) _loadTagPhotos(aiStore.get('tagSelected'));
            };
        }
        chips.innerHTML = _ocrWordsCache
            .map(
                (w) =>
                    `<button type="button" class="tg-btn-input text-[10px] px-2 py-0.5 inline-flex items-center gap-1 ocr-chip${_ocrWordFilter === w.word ? ' active' : ''}" data-word="${escapeHtml(w.word)}">
                        ${escapeHtml(w.word)}
                        <span class="text-[9px] text-tg-textSecondary tabular-nums">${w.cnt}</span>
                    </button>`,
            )
            .join('');
        chips.querySelectorAll('.ocr-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const word = btn.dataset.word;
                _ocrWordFilter = _ocrWordFilter === word ? '' : word;
                _renderOcrChips();
                if (aiStore.get('tagSelected')) _loadTagPhotos(aiStore.get('tagSelected'));
            });
        });
    } catch {
        section?.classList.add('hidden');
    }
}

// ---- Tag suggestions ---------------------------------------------------

/**
 * Fetch tag co-occurrence suggestions and render them.
 */
async function _renderTagSuggestions(forceReload = true) {
    const section = $('#ai-tag-suggestions');
    const list = $('#ai-tag-suggestions-list');
    const empty = $('#ai-tag-suggestions-empty');
    if (!section || !list) return;

    try {
        const r = await api.get('/api/ai/tags/suggestions?minRate=0.6&minImages=2');
        const suggestions = Array.isArray(r?.suggestions) ? r.suggestions : [];

        if (!suggestions.length) {
            section.classList.remove('hidden');
            list.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
            return;
        }

        section.classList.remove('hidden');
        if (empty) empty.classList.add('hidden');

        list.innerHTML = suggestions
            .map(
                (s) =>
                    `<div class="bg-tg-panelOverlay rounded p-3 text-xs space-y-1.5">
                        <div class="flex items-start justify-between gap-2">
                            <div>
                                <span class="font-mono text-tg-text">${escapeHtml(s.tag1)}</span>
                                <span class="text-tg-textSecondary">←→</span>
                                <span class="font-mono text-tg-text">${escapeHtml(s.tag2)}</span>
                            </div>
                            <span class="text-tg-textSecondary tabular-nums">${Math.round(s.cooccurrence_rate * 100)}%</span>
                        </div>
                        <p class="text-[10px] text-tg-textSecondary">
                            Appear together in ${s.images_together} images
                            (${s.tag1}: ${s.images_tag1}, ${s.tag2}: ${s.images_tag2})
                        </p>
                        <button type="button" class="tg-btn-secondary text-[10px] px-2 py-1 merge-suggestion-btn" data-tag1="${escapeHtml(s.tag1)}" data-tag2="${escapeHtml(s.tag2)}">
                            Merge → keep first
                        </button>
                    </div>`,
            )
            .join('');

        // Wire merge buttons
        list.querySelectorAll('.merge-suggestion-btn').forEach((btn) => {
            btn.addEventListener('click', () => _applyTagMerge(btn.dataset.tag1, btn.dataset.tag2));
        });
    } catch (e) {
        console.warn('tag suggestions:', e);
        section.classList.add('hidden');
    }
}

/**
 * Apply a tag merge by updating the tagLabels config to remove tag2 and keep tag1.
 */
async function _applyTagMerge(tag1, tag2) {
    try {
        // Fetch current config to get existing tagLabels
        const cfgRes = await api.get('/api/config');
        const labels = Array.isArray(cfgRes?.advanced?.ai?.tagLabels)
            ? cfgRes.advanced.ai.tagLabels
            : [];

        // Remove tag2, keep tag1
        const updated = labels.filter((t) => String(t).trim() !== String(tag2).trim());

        // Make sure tag1 is still there
        if (!updated.find((t) => String(t).trim() === String(tag1).trim())) {
            updated.push(tag1);
        }

        // Save config
        const saveRes = await api.post('/api/config', {
            advanced: { ai: { tagLabels: updated } },
        });
        if (!saveRes.success) throw new Error(saveRes.error || 'save failed');

        showToast(`Merged "${tag2}" into "${tag1}". Refresh suggestions to see the change.`);
        _renderTagSuggestions(true);
    } catch (e) {
        console.error('merge failed:', e);
        showToast(`Error merging tags: ${e.message}`, 'error');
    }
}

// ---- Smart albums -------------------------------------------------------

async function _renderSmartAlbums() {
    const list = $('#ai-smart-albums-list');
    if (!list) return;
    _renderSmartAlbumsRuntime().catch(() => {});
    try {
        const r = await api.get('/api/ai/smart-albums');
        const albums = Array.isArray(r?.albums) ? r.albums : [];
        const countEl = $('#ai-smart-albums-count');
        if (countEl) countEl.textContent = albums.length ? `(${albums.length})` : '';
        if (!albums.length) {
            list.innerHTML =
                '<p class="text-[11px] text-tg-textSecondary text-center py-3">No smart albums yet. Add one above.</p>';
            $('#ai-smart-album-items')?.classList.add('hidden');
            aiStore.set('smartAlbumSelected', null);
            aiStore.set('smartAlbumSelectedName', '');
            _smartAlbumItemsPage = 1;
            _smartAlbumItemsTotal = 0;
            _smartAlbumItemsTotalPages = 1;
            _smartAlbumCurrentRows = [];
            _syncSmartAlbumPager();
            return;
        }
        list.innerHTML = albums
            .map((a) => {
                const rule = a?.rule || {};
                const stale =
                    _lastTagsChangedAt > 0 && Number(a.updated_at || 0) < _lastTagsChangedAt;
                const staleBadge = stale
                    ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-tg-orange/15 text-tg-orange">Needs rebuild</span>'
                    : '';
                const subtitle =
                    rule.type === 'tags_contains'
                        ? `tag:${rule.tag} (min ${Math.round((Number(rule.minScore) || 0) * 100)}%)`
                        : rule.type || 'unknown';
                return `<div class="bg-tg-panelOverlay rounded p-2.5">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="min-w-0 flex-1">
                            <div class="text-xs text-tg-text font-medium truncate inline-flex items-center gap-1.5 max-w-full">
                                <span class="truncate">${escapeHtml(a.name || `Album #${a.id}`)}</span>${staleBadge}
                            </div>
                            <div class="text-[10px] text-tg-textSecondary truncate">${escapeHtml(subtitle)} · ${Number(a.item_count) || 0} items</div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                            <button class="tg-btn-secondary text-[10px] px-2 py-1" data-sa-open="${a.id}" data-sa-name="${escapeHtml(a.name || `Album #${a.id}`)}">Open</button>
                            <button class="tg-btn-secondary text-[10px] px-2 py-1" data-sa-rebuild="${a.id}">Rebuild</button>
                            <button class="tg-btn-secondary text-[10px] px-2 py-1 text-red-300" data-sa-delete="${a.id}">Delete</button>
                        </div>
                    </div>
                </div>`;
            })
            .join('');
        list.querySelectorAll('[data-sa-open]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-sa-open');
                const name = btn.getAttribute('data-sa-name');
                aiStore.set('smartAlbumSelectedName', String(name || `#${id}`));
                aiStore.set('smartAlbumSelected', id); // watcher fires _loadSmartAlbumItems
            });
        });
        list.querySelectorAll('[data-sa-rebuild]').forEach((btn) => {
            btn.addEventListener('click', () =>
                _rebuildSmartAlbum(btn.getAttribute('data-sa-rebuild')),
            );
        });
        list.querySelectorAll('[data-sa-delete]').forEach((btn) => {
            btn.addEventListener('click', () =>
                _deleteSmartAlbum(btn.getAttribute('data-sa-delete')),
            );
        });
    } catch (e) {
        list.innerHTML = `<p class="text-[11px] text-red-300 text-center py-3">Failed: ${escapeHtml(e?.message || 'unknown')}</p>`;
    }
}

async function _renderSmartAlbumsRuntime() {
    const el = $('#ai-smart-albums-runtime');
    if (!el) return;
    try {
        const r = await api.get('/api/ai/smart-albums/runtime');
        if (!r?.success) throw new Error(r?.error || 'runtime failed');
        const cfg = r.config || {};
        const rt = r.runtime || {};
        const mode = cfg.enabled === false ? 'disabled' : `every ${cfg.refreshIntervalMin || 15}m`;
        const last = rt.lastRunAt ? new Date(rt.lastRunAt).toLocaleString() : 'never';
        const state = rt.running ? 'running' : 'idle';
        const lastInfo = rt.lastRunAt
            ? ` · last: ${last} (${rt.lastAlbums || 0} albums, ${rt.lastMatched || 0} matches)`
            : '';
        const err = rt.lastError ? ` · error: ${rt.lastError}` : '';
        el.textContent = `Auto rebuild: ${mode} · state: ${state}${lastInfo}${err}`;
    } catch (e) {
        el.textContent = 'Auto rebuild: unavailable';
    }
}

async function _rebuildAllSmartAlbums() {
    const btn = $('#ai-smart-albums-rebuild-all');
    if (btn) btn.disabled = true;
    try {
        const r = await api.post('/api/ai/smart-albums/rebuild-all', {});
        if (!r.success) throw new Error(r.error || 'rebuild-all failed');
        if (r.skipped) {
            showToast(`Skipped: ${r.reason || 'already running'}`, 'info');
        } else {
            showToast(`Rebuilt ${r.rebuilt || 0} albums (${r.matched || 0} matches)`, 'success');
        }
        await _renderSmartAlbums();
    } catch (e) {
        showToast(`Rebuild-all failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _loadSmartAlbumItems(id, name) {
    const section = $('#ai-smart-album-items');
    const nameEl = $('#ai-smart-album-items-name');
    const grid = $('#ai-smart-album-items-grid');
    if (!section || !grid) return;
    _smartAlbumItemsPage = 1;
    _smartAlbumItemsTotal = 0;
    _smartAlbumItemsTotalPages = 1;
    _smartAlbumCurrentRows = [];
    section.classList.remove('hidden');
    if (nameEl) nameEl.textContent = aiStore.get('smartAlbumSelectedName');
    _syncSmartAlbumPager();
    await _loadSmartAlbumItemsPage();
}

async function _loadSmartAlbumItemsPage() {
    const grid = $('#ai-smart-album-items-grid');
    if (!grid || !aiStore.get('smartAlbumSelected')) return;
    grid.innerHTML =
        '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-3">Loading…</p>';
    try {
        const offset = Math.max(0, (_smartAlbumItemsPage - 1) * _smartAlbumItemsLimit);
        const r = await api.get(
            `/api/ai/smart-albums/${encodeURIComponent(aiStore.get('smartAlbumSelected'))}/items?limit=${_smartAlbumItemsLimit}&offset=${offset}`,
        );
        const files = Array.isArray(r?.files) ? r.files : [];
        _smartAlbumCurrentRows = files;
        _smartAlbumItemsTotal = Number(r?.total) || files.length;
        _smartAlbumItemsTotalPages = Math.max(
            1,
            Math.ceil(_smartAlbumItemsTotal / _smartAlbumItemsLimit),
        );
        if (!files.length) {
            grid.innerHTML =
                '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-3">No items matched.</p>';
            _syncSmartAlbumPager();
            return;
        }
        grid.innerHTML = files.map((f, i) => _renderSmartAlbumTile(f, i)).join('');
        _wireSmartAlbumClicks();
        _syncSmartAlbumPager();
    } catch (e) {
        _smartAlbumCurrentRows = [];
        _syncSmartAlbumPager();
        grid.innerHTML = `<p class="text-[11px] text-red-300 col-span-full text-center py-3">Failed: ${escapeHtml(e?.message || 'unknown')}</p>`;
    }
}

function _renderSmartAlbumTile(file, index) {
    const thumb = `/api/thumbs/${encodeURIComponent(file.id)}?w=320`;
    return `<button type="button" data-smart-album-tile-index="${index}" data-id="${file.id}"
            class="nsfw-tile group relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 focus:outline-none focus:ring-2 focus:ring-tg-blue">
        <img loading="lazy" decoding="async"
             class="absolute inset-0 w-full h-full object-cover"
             src="${escapeHtml(thumb)}" alt="${escapeHtml(file.file_name || String(file.id))}"
             onerror="this.style.display='none'">
        <span class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition flex items-end p-2 pointer-events-none">
            <span class="text-[11px] text-white truncate w-full text-left">${escapeHtml(file.file_name || '')}</span>
        </span>
    </button>`;
}

function _wireSmartAlbumClicks() {
    const grid = $('#ai-smart-album-items-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-smart-album-tile-index]').forEach((tile) => {
        if (tile.dataset.wired) return;
        tile.dataset.wired = '1';
        tile.addEventListener('click', () => {
            const idx = Number(tile.dataset.smartAlbumTileIndex);
            if (Number.isFinite(idx)) _openSmartAlbumLightbox(idx);
        });
    });
}

function _smartAlbumRowToViewerFile(row) {
    const sizeMb = row.file_size ? (row.file_size / (1024 * 1024)).toFixed(1) : '0';
    return {
        fullPath: row.file_path || '',
        type: row.file_type === 'video' ? 'videos' : 'images',
        name: row.file_name || '',
        sizeFormatted: `${sizeMb} MB`,
        modified: row.created_at || Date.now(),
        _smartAlbumRow: row,
    };
}

function _smartAlbumMetaFor() {
    return `<span class="inline-flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-tg-blue"></span>
        <span>${escapeHtml(aiStore.get('smartAlbumSelectedName') || 'Smart album')}</span>
    </span>`;
}

function _openSmartAlbumLightbox(startIndex) {
    if (!_smartAlbumCurrentRows.length) return;
    openMediaViewerForReview(_smartAlbumCurrentRows.map(_smartAlbumRowToViewerFile), startIndex, {
        actions: [],
        metaRender: _smartAlbumMetaFor,
    });
}

function _syncSmartAlbumPager() {
    const pageInfo = $('#ai-smart-album-page-info');
    const prevBtn = $('#ai-smart-album-prev-btn');
    const nextBtn = $('#ai-smart-album-next-btn');
    const hasAlbum = !!aiStore.get('smartAlbumSelected');
    if (pageInfo) {
        pageInfo.textContent = hasAlbum
            ? `Page ${_smartAlbumItemsPage} / ${_smartAlbumItemsTotalPages} · ${_smartAlbumItemsTotal.toLocaleString()} photos`
            : '';
    }
    if (prevBtn) prevBtn.disabled = !hasAlbum || _smartAlbumItemsPage <= 1;
    if (nextBtn) {
        nextBtn.disabled = !hasAlbum || _smartAlbumItemsPage >= _smartAlbumItemsTotalPages;
    }
}

async function _createSmartAlbum(prefillTag = '') {
    if (!_tagListCache.length) {
        try {
            const r = await api.get('/api/ai/tags/list');
            _tagListCache = Array.isArray(r?.tags) ? r.tags : [];
        } catch {}
    }
    if (!_tagListCache.length) {
        showToast('No tags yet. Run image tagging first.', 'info');
        return;
    }
    const choice = await _smartAlbumPickerSheet(
        prefillTag || aiStore.get('tagSelected') || _tagListCache[0]?.tag,
    );
    if (!choice) return;
    try {
        const r = await api.post('/api/ai/smart-albums', {
            name: choice.name,
            rule: {
                type: 'tags_contains',
                tag: choice.tag,
                minScore: choice.minScore,
            },
        });
        if (!r.success) throw new Error(r.error || 'create failed');
        showToast('Smart album created', 'success');
        await _renderSmartAlbums();
    } catch (e) {
        showToast(`Create failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

function _smartAlbumPickerSheet(preferredTag = '') {
    return new Promise((resolve) => {
        const tags = _tagListCache
            .slice()
            .sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
        const selected = tags.find((t) => t.tag === preferredTag)?.tag || tags[0]?.tag || '';
        let decided = false;
        const settle = (value) => {
            if (decided) return;
            decided = true;
            resolve(value);
        };
        const options = tags
            .map((t) => {
                const tag = String(t.tag || '');
                const count = Number(t.count) || 0;
                return `<option value="${escapeHtml(tag)}" ${tag === selected ? 'selected' : ''}>${escapeHtml(tag)} (${count.toLocaleString()})</option>`;
            })
            .join('');
        const sheet = openSheet({
            title: 'New smart album',
            size: 'sm',
            content: `
                <label class="text-tg-text text-xs block mb-1" for="smart-album-name">Album name</label>
                <input id="smart-album-name" class="tg-input w-full text-sm mb-3" value="${escapeHtml(selected ? `${selected} photos` : 'Smart album')}" autocomplete="off">
                <label class="text-tg-text text-xs block mb-1" for="smart-album-tag">Tag</label>
                <select id="smart-album-tag" class="tg-input w-full text-sm mb-3">${options}</select>
                <div class="flex items-center justify-between gap-3 mb-1">
                    <label class="text-tg-text text-xs" for="smart-album-score">Minimum confidence</label>
                    <output id="smart-album-score-out" class="text-xs text-tg-textSecondary font-mono tabular-nums">0%</output>
                </div>
                <input id="smart-album-score" type="range" min="0" max="1" step="0.05" value="0" class="w-full">
                <p class="text-[10px] text-tg-textSecondary mt-1">Higher values make the album stricter.</p>
                <div class="flex items-center justify-end gap-2 mt-4">
                    <button data-sa-cancel class="px-4 py-2 rounded-lg text-tg-textSecondary hover:bg-tg-hover transition text-sm">Cancel</button>
                    <button data-sa-create class="px-4 py-2 rounded-lg bg-tg-blue text-white hover:bg-opacity-90 font-medium text-sm transition">Create</button>
                </div>`,
            onClose: () => settle(null),
        });
        setTimeout(() => {
            const root = sheet.root;
            const nameEl = root?.querySelector('#smart-album-name');
            const tagEl = root?.querySelector('#smart-album-tag');
            const scoreEl = root?.querySelector('#smart-album-score');
            const scoreOut = root?.querySelector('#smart-album-score-out');
            const syncScore = () => {
                if (scoreOut)
                    scoreOut.textContent = `${Math.round((Number(scoreEl?.value) || 0) * 100)}%`;
            };
            const syncName = () => {
                if (!nameEl || !tagEl) return;
                const cur = String(nameEl.value || '').trim();
                if (!cur || tags.some((t) => cur === `${t.tag} photos`)) {
                    nameEl.value = `${tagEl.value} photos`;
                }
            };
            scoreEl?.addEventListener('input', syncScore);
            tagEl?.addEventListener('change', syncName);
            root?.querySelector('[data-sa-cancel]')?.addEventListener('click', () => sheet.close());
            root?.querySelector('[data-sa-create]')?.addEventListener('click', () => {
                const tag = String(tagEl?.value || '').trim();
                const name = String(nameEl?.value || '').trim() || `${tag} photos`;
                if (!tag) return;
                settle({
                    name,
                    tag,
                    minScore: Math.max(0, Math.min(1, Number(scoreEl?.value) || 0)),
                });
                sheet.close();
            });
            syncScore();
            nameEl?.focus();
            nameEl?.select?.();
        }, 60);
    });
}

async function _rebuildSmartAlbum(id) {
    try {
        const r = await api.post(`/api/ai/smart-albums/${encodeURIComponent(id)}/rebuild`, {});
        if (!r.success) throw new Error(r.error || 'rebuild failed');
        showToast(`Rebuilt: ${r?.rebuilt?.matched || 0} matches`, 'success');
        await _renderSmartAlbums();
    } catch (e) {
        showToast(`Rebuild failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

async function _deleteSmartAlbum(id) {
    const ok = await confirmSheet({
        title: 'Delete smart album?',
        message: 'This removes the album and its materialized items.',
        confirmText: 'Delete',
        destructive: true,
    });
    if (!ok) return;
    try {
        const r = await api.delete(`/api/ai/smart-albums/${encodeURIComponent(id)}`);
        if (!r.success) throw new Error(r.error || 'delete failed');
        showToast('Deleted', 'success');
        await _renderSmartAlbums();
    } catch (e) {
        showToast(`Delete failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

// ---- Natural-language album builder (v2) --------------------------------

/** Current parsed rule from the NL builder, or null. */
let _nlAlbumRule = null;
let _nlAlbumPreviewTotal = null;

function _renderNlPreviewCount(total, label = 'Preview matches') {
    const el = $('#ai-album-nl-preview-count');
    if (!el) return;
    if (total == null || Number.isNaN(Number(total))) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.remove('hidden');
    el.textContent = `${label}: ${Number(total).toLocaleString()}`;
}

async function _previewNlAlbumRule(rule) {
    const r = await api.post('/api/ai/smart-albums/preview', { rule, limit: 1, offset: 0 });
    if (!r?.success) throw new Error(r?.error || 'preview failed');
    _nlAlbumPreviewTotal = Number(r.total) || 0;
    return _nlAlbumPreviewTotal;
}

function _applyCommonNlRuleFixes(rule) {
    if (!rule || typeof rule !== 'object') return rule;
    const out = JSON.parse(JSON.stringify(rule));

    const mapFileType = (v) => {
        const ft = String(v || '')
            .trim()
            .toLowerCase();
        if (ft === 'image') return 'photo';
        if (ft === 'images') return 'photo';
        if (ft === 'videos') return 'video';
        if (ft === 'audios') return 'audio';
        return ft;
    };

    const fixSubRule = (sr) => {
        if (!sr || typeof sr !== 'object') return sr;
        if (sr.type === 'text_contains' && !sr.substring && sr.text) {
            sr.substring = String(sr.text);
            delete sr.text;
        }
        if (sr.type === 'semantic' && (sr.minScore == null || Number.isNaN(Number(sr.minScore)))) {
            sr.minScore = 0;
        }
        if (
            sr.type === 'tags_contains' &&
            (sr.minScore == null || Number.isNaN(Number(sr.minScore)))
        ) {
            sr.minScore = 0;
        }
        if (sr.type === 'people_count' && (sr.min == null || Number(sr.min) < 0)) {
            sr.min = 1;
        }
        if (sr.type === 'file_type') {
            if (!sr.fileType && sr.typeName) sr.fileType = sr.typeName;
            sr.fileType = mapFileType(sr.fileType);
        }
        return sr;
    };

    if (out.type === 'compound') {
        if (Array.isArray(out.all)) out.all = out.all.map(fixSubRule);
        if (Array.isArray(out.any)) out.any = out.any.map(fixSubRule);
        return out;
    }

    // Wrap a single leaf rule into compound for compatibility with v2 flow.
    const leafTypes = new Set([
        'tags_contains',
        'people_count',
        'semantic',
        'text_contains',
        'date',
        'file_type',
    ]);
    if (leafTypes.has(String(out.type || '').trim())) {
        return { type: 'compound', all: [fixSubRule(out)], sort: 'score_desc' };
    }

    return out;
}

/** Parse the NL description via the LLM provider and show a preview. */
async function _parseAlbumWithAi() {
    const input = $('#ai-album-nl-input');
    const preview = $('#ai-album-nl-preview');
    const status = $('#ai-album-nl-status');
    const actions = $('#ai-album-nl-actions');
    const btn = $('#ai-album-nl-parse-btn');
    if (!input || !preview || !btn) return;

    const description = String(input.value || '').trim();
    if (!description) {
        showToast('Describe the album in plain English first.', 'info');
        return;
    }

    btn.disabled = true;
    preview.classList.remove('hidden');
    preview.textContent = 'Parsing with AI\u2026';
    status?.classList.remove('hidden');
    if (status) status.textContent = '\u2022 waiting for model';
    actions?.classList.add('hidden');
    _nlAlbumRule = null;
    _nlAlbumPreviewTotal = null;
    _renderNlPreviewCount(null);

    try {
        const r = await api.post('/api/ai/smart-albums/parse', { description });
        if (!r.success) {
            preview.textContent = `Error: ${r.error || 'unknown'}`;
            preview.classList.add('text-red-400');
            if (status) status.textContent = 'Failed';
            return;
        }

        _nlAlbumRule = r.rule;
        preview.classList.remove('text-red-400');
        preview.textContent = JSON.stringify(r.rule, null, 2);

        try {
            const total = await _previewNlAlbumRule(_nlAlbumRule);
            _renderNlPreviewCount(total);
            if (status)
                status.textContent = `\u2713 Parsed · preview ${total.toLocaleString()} matches`;
        } catch (e) {
            _renderNlPreviewCount(null);
            if (status) status.textContent = '\u2713 Parsed · preview unavailable';
        }

        actions?.classList.remove('hidden');
    } catch (e) {
        _renderNlPreviewCount(null);
        preview.textContent = `Error: ${e?.data?.error || e?.message || 'unknown'}`;
        preview.classList.add('text-red-400');
        if (status) status.textContent = 'Failed';
    } finally {
        btn.disabled = false;
    }
}

async function _fixNlRuleAndPreview() {
    const preview = $('#ai-album-nl-preview');
    const status = $('#ai-album-nl-status');
    if (!_nlAlbumRule) {
        showToast('Parse a description first.', 'info');
        return;
    }
    _nlAlbumRule = _applyCommonNlRuleFixes(_nlAlbumRule);
    if (preview) {
        preview.classList.remove('text-red-400');
        preview.textContent = JSON.stringify(_nlAlbumRule, null, 2);
    }
    try {
        const total = await _previewNlAlbumRule(_nlAlbumRule);
        _renderNlPreviewCount(total, 'Preview matches (after fix)');
        if (status) status.textContent = `\u2713 Fixed · preview ${total.toLocaleString()} matches`;
        showToast('Applied recommended rule fixes', 'success');
    } catch (e) {
        _renderNlPreviewCount(null);
        if (status) status.textContent = '\u2713 Fixed · preview unavailable';
        showToast(
            `Preview failed after fix: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

/** Create a smart album from the previously parsed NL rule. */
async function _createAlbumFromNl() {
    if (!_nlAlbumRule) {
        showToast('Parse a description first.', 'info');
        return;
    }

    // Prompt for a name
    const suggested =
        _nlAlbumPreviewTotal != null ? `Smart album (${_nlAlbumPreviewTotal})` : 'Smart album';
    const name = prompt('Album name:', suggested);
    if (!name || !name.trim()) return;

    try {
        const r = await api.post('/api/ai/smart-albums', {
            name: name.trim(),
            rule: _nlAlbumRule,
        });
        if (!r.success) throw new Error(r.error || 'create failed');
        showToast('Smart album created', 'success');
        await _renderSmartAlbums();
        _clearAlbumNlBuilder();
    } catch (e) {
        const details = e?.data?.details?.section ? ` (${e.data.details.section})` : '';
        showToast(`Create failed${details}: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

/** Reset the NL builder inputs. */
function _clearAlbumNlBuilder() {
    _nlAlbumRule = null;
    _nlAlbumPreviewTotal = null;
    _renderNlPreviewCount(null);
    const input = $('#ai-album-nl-input');
    const preview = $('#ai-album-nl-preview');
    const status = $('#ai-album-nl-status');
    const actions = $('#ai-album-nl-actions');
    if (input) input.value = '';
    if (preview) {
        preview.classList.add('hidden');
        preview.textContent = '';
        preview.classList.remove('text-red-400');
    }
    if (status) {
        status.classList.add('hidden');
        status.textContent = '';
    }
    if (actions) actions.classList.add('hidden');
}

function _getVisibleTags() {
    const q = _tagFilterQuery.trim().toLowerCase();
    let tags = _tagListCache.slice();
    if (q)
        tags = tags.filter((t) =>
            String(t?.tag || '')
                .toLowerCase()
                .includes(q),
        );
    if (_tagSortMode === 'avg_score_desc') {
        tags.sort((a, b) => (Number(b.avg_score) || 0) - (Number(a.avg_score) || 0));
    } else if (_tagSortMode === 'tag_asc') {
        tags.sort((a, b) => String(a.tag || '').localeCompare(String(b.tag || '')));
    } else {
        tags.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
    }
    return tags;
}

function _initDetailsCollapsedState({ detailsId, storageKey, defaultOpen = false }) {
    const details = document.getElementById(detailsId);
    if (!details) return;
    const stored = localStorage.getItem(storageKey);
    const open = stored === null ? defaultOpen : stored === '0';
    details.open = open;
    details.addEventListener('toggle', () => {
        try {
            localStorage.setItem(storageKey, details.open ? '0' : '1');
        } catch {}
    });
}

// ---- LLM provider status ------------------------------------------------

/**
 * Fetch LLM provider status from the server and render the provider
 * health panel, active provider details, and test-prompt section.
 */
async function _renderLlmStatus() {
    const section = $('#ai-pane-llm');
    const summary = $('#ai-llm-summary');
    const providersEl = $('#ai-llm-providers');
    const activeEl = $('#ai-llm-active');
    const activeDetails = $('#ai-llm-active-details');
    const testSection = $('#ai-llm-test');
    if (!section || !providersEl) return;

    try {
        const r = await api.get('/api/ai/llm/status');
        const providers = Array.isArray(r?.providers) ? r.providers : [];
        const active = r?.active || null;

        // Summary badge
        const availableCount = providers.filter((p) => p.available).length;
        if (summary) {
            summary.textContent = active?.available
                ? `${active.label} \u2713`
                : availableCount > 0
                  ? `${availableCount} available (none active)`
                  : 'Not configured';
        }

        // Provider rows
        providersEl.innerHTML = providers
            .map(
                (p) =>
                    `<div class="flex items-center justify-between gap-2 text-xs py-1">
                        <div class="flex items-center gap-1.5 min-w-0">
                            <span class="inline-block w-2 h-2 rounded-full shrink-0 ${
                                p.available ? 'bg-tg-green' : 'bg-tg-red/60'
                            }"></span>
                            <span class="text-tg-text">${escapeHtml(p.label)}</span>
                            ${
                                p.version
                                    ? `<span class="text-[10px] text-tg-textSecondary tabular-nums">${escapeHtml(p.version)}</span>`
                                    : ''
                            }
                        </div>
                        ${
                            p.available
                                ? '<span class="text-tg-green text-[10px]">Available</span>'
                                : `<span class="text-tg-textSecondary text-[10px]">${escapeHtml(p.error || 'Unavailable')}</span>`
                        }
                    </div>`,
            )
            .join('');

        // Populate the inline config form from the current active config
        _populateLlmConfig(r);

        // Active provider details + test prompt (only when a provider is active)
        if (active?.available && activeDetails) {
            activeEl?.classList.remove('hidden');
            activeDetails.innerHTML = `
                <div class="flex justify-between"><span>Provider</span><span class="text-tg-text font-medium">${escapeHtml(active.label)}</span></div>
                <div class="flex justify-between"><span>Vision support</span><span class="text-tg-text font-medium">${active.supportsVision ? '\u2713 Yes' : '\u2014'}</span></div>
            `;
            testSection?.classList.remove('hidden');
        } else {
            activeEl?.classList.add('hidden');
            testSection?.classList.add('hidden');
        }
    } catch (e) {
        console.warn('llm status:', e);
        if (summary) summary.textContent = 'Error';
        providersEl.innerHTML =
            '<p class="text-[11px] text-red-400">Failed to load LLM status.</p>';
    }
}

/**
 * Run a test prompt through the active LLM provider and display
 * the result in the test output area.
 */
async function _runLlmTest() {
    const promptEl = $('#ai-llm-test-prompt');
    const outputEl = $('#ai-llm-test-output');
    const btn = $('#ai-llm-test-btn');
    if (!promptEl || !outputEl || !btn) return;

    const prompt = String(promptEl.value || '').trim() || 'Say hello in one word';
    outputEl.classList.remove('hidden');
    outputEl.textContent = 'Running\u2026';
    btn.disabled = true;

    try {
        const r = await api.post('/api/ai/llm/test', { prompt, maxTokens: 50 });
        if (r.text !== undefined) {
            outputEl.textContent = r.text;
            outputEl.classList.remove('text-red-400');
        } else if (r.error) {
            outputEl.textContent = `Error: ${r.error}`;
            outputEl.classList.add('text-red-400');
        } else {
            outputEl.textContent = JSON.stringify(r, null, 2);
        }
    } catch (e) {
        outputEl.textContent = `Request failed: ${e?.message || 'unknown'}`;
        outputEl.classList.add('text-red-400');
    } finally {
        btn.disabled = false;
    }
}

// ---- LLM config form -----------------------------------------------------

/**
 * Populate the inline config form from the status response's `config` block.
 * Called every time the panel is refreshed.
 */
function _populateLlmConfig(status) {
    const cfg = status?.config || {};
    const configEl = $('#ai-llm-config');
    if (!configEl) return;

    // Always show the config form
    configEl.classList.remove('hidden');

    // Provider selector
    const sel = $('#ai-llm-provider-select');
    if (sel) {
        sel.value = cfg.provider || 'disabled';
        _toggleLlmProviderFields(cfg.provider || 'disabled');
    }

    // Ollama fields
    const ollamaUrl = $('#ai-llm-ollama-url');
    const ollamaModel = $('#ai-llm-ollama-model');
    if (ollamaUrl) ollamaUrl.value = cfg.ollama?.baseUrl || 'http://localhost:11434';
    if (ollamaModel) ollamaModel.value = cfg.ollama?.model || 'qwen3-vl:235b-cloud';

    // OpenAI fields
    const openaiKey = $('#ai-llm-openai-key');
    const openaiModel = $('#ai-llm-openai-model');
    const openaiUrl = $('#ai-llm-openai-url');
    if (openaiKey) openaiKey.value = cfg.openai?.apiKey || '';
    if (openaiModel) openaiModel.value = cfg.openai?.model || 'gpt-4o-mini';
    if (openaiUrl) openaiUrl.value = cfg.openai?.baseUrl || '';

    // Defaults
    const temp = $('#ai-llm-temperature');
    const mt = $('#ai-llm-max-tokens');
    if (temp) temp.value = String(cfg.defaults?.temperature ?? 0.7);
    if (mt) mt.value = String(cfg.defaults?.maxTokens ?? 512);
}

/**
 * Toggle which provider-specific field sections are visible based on
 * the selected provider.
 */
function _toggleLlmProviderFields(provider) {
    const ollamaFields = $('#ai-llm-ollama-fields');
    const openaiFields = $('#ai-llm-openai-fields');
    if (ollamaFields) ollamaFields.classList.toggle('hidden', provider !== 'ollama');
    if (openaiFields) openaiFields.classList.toggle('hidden', provider !== 'openai');
}

/** Called when the provider dropdown changes — toggle field visibility. */
function _onLlmProviderChange(e) {
    _toggleLlmProviderFields(e?.target?.value || 'disabled');
}

/**
 * Save the inline config form values to the server and refresh status.
 */
async function _saveLlmConfig() {
    const btn = $('#ai-llm-config-save');
    if (btn) btn.disabled = true;

    try {
        const provider = $('#ai-llm-provider-select')?.value || 'disabled';
        const body = {
            advanced: {
                ai: {
                    llm: {
                        provider,
                        ollama: {
                            baseUrl: $('#ai-llm-ollama-url')?.value || 'http://localhost:11434',
                            model: $('#ai-llm-ollama-model')?.value || 'qwen3-vl:235b-cloud',
                        },
                        openai: {
                            apiKey: $('#ai-llm-openai-key')?.value || '',
                            model: $('#ai-llm-openai-model')?.value || 'gpt-4o-mini',
                            baseUrl: $('#ai-llm-openai-url')?.value || '',
                        },
                        defaults: {
                            temperature: Number($('#ai-llm-temperature')?.value ?? 0.7),
                            maxTokens: Number($('#ai-llm-max-tokens')?.value ?? 512),
                        },
                    },
                },
            },
        };

        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');

        showToast('LLM config saved', 'success');

        // Refresh the panel to reflect the new active provider state
        await _renderLlmStatus();
    } catch (e) {
        showToast(`Save failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ---- Semantic search / embeddings status ---------------------------------

/**
 * Fetch embedding stats from the server and update the semantic-search
 * pane on the AI maintenance page.
 */
async function _renderEmbeddingsStatus() {
    const summary = $('#ai-embeddings-summary');
    const countEl = $('#ai-embeddings-count');
    const modelEl = $('#ai-embeddings-model');

    try {
        const r = await api.get('/api/ai/embeddings/stats');
        const total = r?.total ?? 0;
        const models = Array.isArray(r?.models) ? r.models : [];
        const configuredModel = r?.configuredModel || '';
        const staleRows = Number(r?.staleRows || 0);

        if (summary) {
            summary.textContent = total > 0 ? `${total} indexed` : 'No embeddings';
        }
        if (countEl) {
            countEl.textContent = total > 0 ? String(total) : 'No embeddings stored';
        }
        if (modelEl) {
            if (models.length === 1) {
                modelEl.textContent = `Model: ${models[0].model}`;
            } else if (models.length > 1) {
                modelEl.textContent = `Models: ${models.map((m) => `${m.model} (${m.count})`).join(', ')}`;
            } else {
                modelEl.textContent = 'No embedding model active — run a re-index first.';
            }
            if (configuredModel) {
                modelEl.textContent += ` • configured: ${configuredModel}`;
            }
            if (staleRows > 0) {
                modelEl.textContent += ` • stale rows: ${staleRows}`;
            }
        }
    } catch (e) {
        console.warn('embeddings stats:', e);
        if (summary) summary.textContent = 'Error';
        if (countEl) countEl.textContent = 'Failed to load';
    }
}

/**
 * Re-index missing image embeddings. Calls the API in a batch loop
 * so the operator can watch progress on the AI maintenance page.
 */
async function _reindexEmbeddings() {
    const btn = $('#ai-embeddings-reindex-btn');
    const statusEl = $('#ai-embeddings-reindex-status');
    const logEl = $('#ai-embeddings-reindex-log');
    if (!btn) return;

    btn.disabled = true;
    statusEl?.classList.remove('hidden');
    logEl?.classList.remove('hidden');
    if (statusEl) statusEl.textContent = 'Re-indexing\u2026';
    if (logEl) logEl.textContent = '';

    let total = 0;
    let errors = 0;
    let remaining = 1;

    try {
        while (remaining > 0) {
            const r = await api.post('/api/ai/embeddings/reindex', { limit: 100 });
            if (!r.success) throw new Error(r.error || 'reindex failed');

            total += r.processed || 0;
            errors += r.errors || 0;
            remaining = r.remaining || 0;

            const msg =
                `Processed ${total}, errors ${errors}, remaining ${remaining}` +
                (r.done ? ' \u2014 Done!' : '');
            if (statusEl) statusEl.textContent = msg;
            if (logEl) {
                logEl.textContent += `Batch: +${r.processed} processed, ${r.errors} errors, ${r.remaining} remaining\n`;
                logEl.scrollTop = logEl.scrollHeight;
            }

            if (r.done) break;
            if (remaining <= 0) break;

            // Small yield so the UI stays responsive
            await new Promise((r) => setTimeout(r, 100));
        }

        // Refresh stats once done
        await _renderEmbeddingsStatus();
        showToast('Embedding re-index complete', 'success');
    } catch (e) {
        if (statusEl) statusEl.textContent = `Error: ${e?.message || 'unknown'}`;
        if (logEl) logEl.textContent += `\nError: ${e?.message || e}\n`;
        showToast(`Re-index failed: ${e?.message || 'unknown'}`, 'error');
    } finally {
        btn.disabled = false;
    }
}

// ---- Shared search service for two independent grids -------------------
// Each grid stores its own results + query via dataset. The lightbox
// opener reads from the parent grid, so the embedding pane and unified
// bar never clobber each other's state.

/**
 * Shared search-result renderer. Fills a grid with thumbnail tiles and
 * writes a meta line with result count, query, and modality breakdown.
 * Tiles open the media viewer for browsing.
 */
function _renderSearchResults(results, query, modalities, grid, meta) {
    // Store per-grid so two grids don't share state
    grid.dataset.searchResults = JSON.stringify(results);
    grid.dataset.searchQuery = query;

    if (!results.length) {
        grid.classList.remove('hidden');
        grid.innerHTML = `<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">No matches for &quot;${escapeHtml(query)}&quot;. Try a different query.</p>`;
        if (meta) {
            meta.classList.remove('hidden');
            meta.textContent = `0 results for &quot;${escapeHtml(query)}&quot;`;
        }
        return;
    }

    grid.classList.remove('hidden');
    grid.innerHTML = results
        .map(
            (res, i) =>
                `<button type="button" data-search-idx="${i}" data-id="${res.id}"
                        class="nsfw-tile group relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 focus:outline-none focus:ring-2 focus:ring-tg-blue">
            <img loading="lazy" decoding="async"
                 class="absolute inset-0 w-full h-full object-cover"
                 src="/api/thumbs/${encodeURIComponent(res.id)}?w=320" alt=""
                 onerror="this.style.display='none'">
            <span class="hidden sm:block absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-mono rounded bg-tg-blue/85 text-white tabular-nums">${String(Math.round(res.score * 100)).padStart(2)}%</span>
            <span class="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition flex items-end p-1.5 pointer-events-none overflow-hidden">
                <span class="text-[10px] text-white/90 truncate w-full text-left leading-tight">${_formatMatchExplanations(res.explanations)}</span>
            </span>
        </button>`,
        )
        .join('');

    if (meta) {
        meta.classList.remove('hidden');
        const mods =
            Array.isArray(modalities) && modalities.length
                ? ` \u2014 via ${modalities.join(', ')}`
                : '';
        // Show how many results have explanations
        const withExpl = results.filter(
            (r) => Array.isArray(r.explanations) && r.explanations.length,
        ).length;
        const explSuffix = withExpl > 0 ? ` \u2022 ${withExpl} with match details` : '';
        meta.innerHTML = `${results.length} results for &quot;${escapeHtml(query)}&quot;${mods}${explSuffix}`;
    }

    // Wire click events — open media viewer against this grid's data
    grid.querySelectorAll('[data-search-idx]').forEach((tile) => {
        tile.addEventListener('click', () => {
            const idx = Number(tile.dataset.searchIdx);
            if (Number.isFinite(idx)) _openSearchLightbox(tile, idx);
        });
    });
}

/**
 * Format match explanations into a compact single-line string.
 * E.g. "semantic 92% · tags 74% · filename 30%"
 */
function _formatMatchExplanations(explanations) {
    if (!Array.isArray(explanations) || !explanations.length) return '';
    const labels = {
        semantic: 'semantic',
        tags: 'tags',
        people: 'people',
        text: 'OCR',
        filename: 'filename',
    };
    return explanations
        .map((e) => {
            const name = labels[e.source] || e.source;
            return `${name} ${Math.round(e.score * 100)}%`;
        })
        .join(' \u00b7 ');
}

/**
 * Open the media viewer for a result tile, reading the parent grid's
 * own stored data so two grids never cross-contaminate.
 */
function _openSearchLightbox(tile, startIndex) {
    const grid = tile?.closest('[data-search-results]');
    if (!grid) return;
    let rows;
    try {
        rows = JSON.parse(grid.dataset.searchResults || '[]');
    } catch {
        return;
    }
    if (!Array.isArray(rows) || !rows.length) return;
    const query = grid.dataset.searchQuery || '';
    const files = rows.map((row) => {
        const sizeMb = row.fileSize ? (row.fileSize / (1024 * 1024)).toFixed(1) : '0';
        return {
            fullPath: row.filePath || '',
            type: row.fileType === 'video' ? 'videos' : 'images',
            name: row.fileName || '',
            sizeFormatted: `${sizeMb} MB`,
            modified: row.createdAt || Date.now(),
            _searchRow: row,
        };
    });
    openMediaViewerForReview(files, startIndex, {
        actions: [],
        metaRender: (file) => {
            const row = file?._searchRow;
            const score = row?.score ? Math.round(row.score * 100) : 0;
            const expl = Array.isArray(row?.explanations) ? row.explanations : [];
            const explStr = expl.length ? ` \u2022 ${_formatMatchExplanations(expl)}` : '';
            return `<span class="inline-flex items-center gap-2 flex-wrap">
                <span class="inline-block w-2.5 h-2.5 rounded-full bg-tg-blue"></span>
                <span>Search: &quot;${escapeHtml(query)}&quot;</span>
                <span class="font-mono tabular-nums">${score}%</span>
                ${explStr ? `<span class="text-[10px] text-tg-textSecondary">${explStr}</span>` : ''}
            </span>`;
        },
    });
}

/**
 * Run a semantic search and render results as a thumbnail grid (same
 * visual pattern as the tag / people browsers). Clicking a tile opens
 * the media viewer for browsing through results.
 */
async function _runEmbeddingSearch() {
    const input = $('#ai-embeddings-search-query');
    const grid = $('#ai-embeddings-search-grid');
    const meta = $('#ai-embeddings-search-meta');
    const btn = $('#ai-embeddings-search-btn');
    if (!input || !grid || !btn) return;

    const query = String(input.value || '').trim();
    if (!query) return;

    grid.classList.add('hidden');
    meta?.classList.add('hidden');
    grid.innerHTML = '';
    if (meta) meta.textContent = '';
    btn.disabled = true;

    try {
        const qs = new URLSearchParams({ q: query, topK: '50' }).toString();
        const r = await api.get('/api/ai/search?' + qs);
        if (!r.success) {
            grid.classList.remove('hidden');
            grid.innerHTML = `<p class="text-[11px] text-red-400 col-span-full text-center py-6">Error: ${escapeHtml(r.error || 'unknown')}</p>`;
            return;
        }

        _renderSearchResults(
            Array.isArray(r.results) ? r.results : [],
            r.query || query,
            r.modalities,
            grid,
            meta,
        );
    } catch (e) {
        grid.classList.remove('hidden');
        grid.innerHTML = `<p class="text-[11px] text-red-400 col-span-full text-center py-6">Error: ${escapeHtml(e?.message || 'unknown')}</p>`;
    } finally {
        btn.disabled = false;
    }
}

// ---- Unified query bar --------------------------------------------------

/** Run a cross-modal search from the unified query bar. */
async function _runUnifiedQuery() {
    const input = $('#ai-query-input');
    const grid = $('#ai-query-grid');
    const meta = $('#ai-query-meta');
    const searchBtn = $('#ai-query-search-btn');
    const albumBtn = $('#ai-query-album-btn');
    if (!input || !grid || !searchBtn) return;

    const query = String(input.value || '').trim();
    if (!query) return;

    grid.classList.add('hidden');
    meta?.classList.add('hidden');
    grid.innerHTML = '';
    if (meta) meta.textContent = '';
    searchBtn.disabled = true;
    if (albumBtn) {
        albumBtn.disabled = true;
        albumBtn.classList.add('opacity-50');
    }

    // Gather active source filters
    const activeSources = [];
    const chips = document.querySelectorAll('.ai-source-chip[data-active="1"]');
    chips.forEach((chip) => activeSources.push(chip.dataset.source));

    try {
        const params = { q: query, topK: '50' };
        const totalSourceChips = document.querySelectorAll('.ai-source-chip[data-source]').length;
        if (activeSources.length && activeSources.length < Math.max(1, totalSourceChips)) {
            params.sources = activeSources.join(',');
        }
        const qs = new URLSearchParams(params).toString();
        const r = await api.get('/api/ai/search?' + qs);
        if (!r.success) {
            grid.classList.remove('hidden');
            grid.innerHTML = `<p class="text-[11px] text-red-400 col-span-full text-center py-6">Error: ${escapeHtml(r.error || 'unknown')}</p>`;
            return;
        }

        const results = Array.isArray(r.results) ? r.results : [];

        // Enable the "Create album" button only when there are results
        if (albumBtn && results.length) {
            albumBtn.disabled = false;
            albumBtn.classList.remove('opacity-50');
        }

        _renderSearchResults(results, r.query || query, r.modalities, grid, meta);
    } catch (e) {
        grid.classList.remove('hidden');
        grid.innerHTML = `<p class="text-[11px] text-red-400 col-span-full text-center py-6">Error: ${escapeHtml(e?.message || 'unknown')}</p>`;
    } finally {
        searchBtn.disabled = false;
    }
}

/** Parse the current unified query via LLM and create a smart album. */
async function _createAlbumFromUnifiedQuery() {
    const query = String($('#ai-query-input')?.value || '').trim();
    if (!query) {
        showToast('Type a query first.', 'info');
        return;
    }

    const albumBtn = $('#ai-query-album-btn');
    if (albumBtn) {
        albumBtn.disabled = true;
        albumBtn.classList.add('opacity-50');
    }

    try {
        // 1. Parse the natural-language query into a compound rule
        const parseRes = await api.post('/api/ai/smart-albums/parse', {
            description: query,
        });
        if (!parseRes.success) {
            throw new Error(parseRes.error || 'parse failed');
        }

        const rule = parseRes.rule;
        if (!rule) {
            throw new Error('LLM returned an empty rule');
        }

        // 2. Prompt for album name
        const name = prompt('Smart album name:', query.slice(0, 60));
        if (!name || !name.trim()) return;

        // 3. Create the smart album
        const createRes = await api.post('/api/ai/smart-albums', {
            name: name.trim(),
            rule,
        });
        if (!createRes.success) {
            throw new Error(createRes.error || 'create failed');
        }

        showToast(`Smart album &quot;${escapeHtml(name.trim())}&quot; created`, 'success');
        await _renderSmartAlbums();
    } catch (e) {
        showToast(`Album creation failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    } finally {
        if (albumBtn) {
            albumBtn.disabled = false;
            albumBtn.classList.remove('opacity-50');
        }
    }
}

export async function init() {
    if (!_initOnce) {
        _bindOnce();
        _initOnce = true;
    }
    await refreshStatus();
    _refreshDoctor().catch(() => {});
    _loadPeople().catch(() => {});
}

// Public refresher — exported so the SPA shell can poke us after a
// settings save lands somewhere else (Settings → Advanced → AI).
export async function refreshStatus() {
    try {
        const r = await api.get('/api/ai/status');
        if (!r.success) return;
        aiStore.set('status', r);
        api.get('/api/ai/issues')
            .then((issues) => {
                if (!issues?.success || aiStore.get('status') !== r) return;
                r.issues = issues;
                _renderQuickOps(r);
            })
            .catch(() => {
                /* status should still render if issue audit fails */
            });
        _renderTagBrowser().catch(() => {});
        _renderTagSuggestions().catch(() => {});
        _renderSmartAlbums().catch(() => {});
        _renderLlmStatus().catch(() => {});
        _renderEmbeddingsStatus().catch(() => {});
    } catch (e) {
        console.warn('ai/status:', e);
    }
}

// ---- Wire-once listeners --------------------------------------------------

function _bindOnce() {
    // Header action buttons. All three follow the maintenance/thumbs
    // pattern: a primary `Scan now`, an always-rendered `Cancel`
    // (disabled while idle), and a secondary destructive `Reindex from
    // scratch`. The legacy `#ai-master-badge` + `#ai-recluster-btn`
    // hosts live as hidden no-op spans so old bookmarks / extensions
    // don't crash on missing nodes.
    $('#ai-scan-btn')?.addEventListener('click', () => _startScan('faces'));
    $('#ai-cancel-btn')?.addEventListener('click', () => _cancelScan('faces'));
    $('#ai-reindex-btn')?.addEventListener('click', _reindexFromScratch);
    $('#ai-backfill-quality-btn')?.addEventListener('click', _backfillFaceQuality);
    // Re-cluster button — runs Phase B only (DBSCAN over existing
    // embeddings, no re-detect). Fast (seconds, not minutes) — useful
    // for tweaking ε / minPoints + seeing the new cluster count
    // immediately without waiting for a full re-scan.
    $('#ai-recluster-btn')?.addEventListener('click', _recluster);
    $('#ai-copy-diagnostics-btn')?.addEventListener('click', _copyAiDiagnostics);
    // Scanner card action buttons — delegated listener on the container
    // so it survives innerHTML swaps on every status refresh.
    $('#ai-scanner-cards')?.addEventListener('click', _onScannerCardClick);

    // Master + auto toggles — both live as labelled rows in the Face
    // clustering settings section. Click-anywhere on the toggle flips
    // the underlying config flag and immediately re-renders so the
    // visual state matches the API result.
    $('#ai-master-toggle')?.addEventListener('click', _onMasterToggle);
    $('#ai-master-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onMasterToggle();
        }
    });
    $('#ai-auto-toggle')?.addEventListener('click', _onAutoToggle);
    $('#ai-auto-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onAutoToggle();
        }
    });

    // Settings inputs — model / threshold / minPoints / provider.
    // `change` (not `input`) so dragging the slider doesn't spam saves.
    $('#ai-faces-model')?.addEventListener('change', (e) =>
        _saveSetting('facesDetectorModel', String(e.target.value || 'buffalo_l'), {
            restartSidecar: true,
        }),
    );
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    if (epsInp) {
        // Live readout: update the <output> as the slider moves so the
        // operator can see the value before letting go.
        epsInp.addEventListener('input', () => {
            if (epsOut) epsOut.textContent = Number(epsInp.value).toFixed(2);
        });
        epsInp.addEventListener('change', () => _saveSetting('facesEpsilon', Number(epsInp.value)));
    }
    $('#ai-faces-min-points')?.addEventListener('change', (e) =>
        _saveSetting('facesMinPoints', Number(e.target.value || 3)),
    );
    $('#ai-faces-include-videos')?.addEventListener('click', _onIncludeVideosToggle);
    $('#ai-faces-include-videos')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onIncludeVideosToggle();
        }
    });
    $('#ai-faces-video-interval')?.addEventListener('change', (e) => {
        const v = Number(e.target.value || 8);
        if (!Number.isFinite(v)) return;
        _saveSetting('videoFrameIntervalSec', Math.max(1, Math.min(120, Math.round(v))));
    });
    $('#ai-faces-video-max-frames')?.addEventListener('change', (e) => {
        const v = Number(e.target.value || 24);
        if (!Number.isFinite(v)) return;
        _saveSetting('videoMaxFrames', Math.max(1, Math.min(200, Math.round(v))));
    });

    // Hardware-acceleration sub-card — same UX as the thumbs page.
    $('#ai-faces-provider-probe-btn')?.addEventListener('click', _runFacesProviderProbe);
    $('#ai-faces-provider')?.addEventListener('change', _onFacesProviderChange);

    // Image tagging card — toggle, labels textarea, scan + cancel.
    $('#ai-tags-toggle')?.addEventListener('click', async () => {
        const el = $('#ai-tags-toggle');
        if (!el) return;
        const cur = el.classList.contains('active');
        const next = !cur;
        el.classList.toggle('active', next);
        el.setAttribute('aria-checked', String(next));
        try {
            const r = await api.post('/api/config', {
                advanced: { ai: { imageTagging: next } },
            });
            if (!r.success) throw new Error(r.error || 'save failed');
            showToast(i18nT('common.saved', 'Saved'), 'success');
            await refreshStatus();
        } catch (e) {
            el.classList.toggle('active', cur);
            el.setAttribute('aria-checked', String(cur));
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
                'error',
            );
        }
    });
    $('#ai-tags-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            $('#ai-tags-toggle')?.click();
        }
    });
    $('#ai-tags-labels')?.addEventListener('change', async (e) => {
        const raw = String(e.target?.value || '');
        const parts = raw
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        const value = parts.length ? parts : [];
        try {
            const r = await api.post('/api/config', {
                advanced: { ai: { tagLabels: value } },
            });
            if (!r.success) throw new Error(r.error || 'save failed');
            showToast(i18nT('common.saved', 'Saved'), 'success');
        } catch (e) {
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
                'error',
            );
        }
    });
    $('#ai-tags-scan-btn')?.addEventListener('click', () => _startScan('tags'));
    $('#ai-tags-cancel-btn')?.addEventListener('click', () => _cancelScan('tags'));
    $('#ai-tags-confidence')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 0.35;
        const display = $('#ai-tags-confidence-value');
        if (display) display.textContent = val.toFixed(2);
    });

    // "Scan everything" — fires all scan features sequentially.
    // Each _startScan is independent (own tracker/endpoint), but we
    // fire them one after the other to avoid hammering the sidecar.
    $('#ai-scan-all-btn')?.addEventListener('click', async () => {
        const btn = $('#ai-scan-all-btn');
        const statusEl = $('#ai-scan-all-status');
        if (btn) btn.disabled = true;
        const features = ['faces', 'tags', 'ocr'];
        let started = 0;
        for (const f of features) {
            try {
                await _startScan(f);
                started++;
            } catch {
                /* individual scan errors are toasted inside _startScan */
            }
        }
        if (statusEl) {
            statusEl.textContent = i18nTf(
                'maintenance.ai.scan_all_queued',
                { n: started },
                `${started} scan${started !== 1 ? 's' : ''} started`,
            );
            statusEl.classList.remove('hidden');
            setTimeout(() => statusEl.classList.add('hidden'), 4000);
        }
        if (btn) btn.disabled = false;
    });

    // OCR — toggle + scan/cancel buttons.
    $('#ai-ocr-toggle')?.addEventListener('click', async () => {
        const el = $('#ai-ocr-toggle');
        const was = el.getAttribute('aria-checked') === 'true';
        const next = !was;
        try {
            el.style.pointerEvents = 'none';
            await api.post('/api/config', {
                advanced: { ai: { imageOcr: next } },
            });
            el.setAttribute('aria-checked', String(next));
            el.classList.toggle('bg-tg-blue', next);
            el.classList.toggle('bg-tg-bg/40', !next);
        } catch (e) {
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message}`,
                'error',
            );
        } finally {
            el.style.pointerEvents = '';
        }
    });
    $('#ai-ocr-toggle')?.addEventListener('keydown', (e) => {
        if (e.code === 'Space' || e.code === 'Enter') {
            e.preventDefault();
            $('#ai-ocr-toggle')?.click();
        }
    });
    $('#ai-ocr-scan-btn')?.addEventListener('click', () => _startScan('ocr'));
    $('#ai-ocr-cancel-btn')?.addEventListener('click', () => _cancelScan('ocr'));

    // Doctor refresh
    $('#ai-doctor-refresh-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _refreshDoctor().catch(() => {});
    });

    // People — search + filter chip + refresh.
    $('#ai-people-search')?.addEventListener('input', (e) => {
        _peopleFilter.query = String(e.target.value || '').toLowerCase();
        _renderPeopleGrid();
    });
    $('#ai-people-unlabeled')?.addEventListener('change', (e) => {
        _peopleFilter.unlabeledOnly = !!e.target.checked;
        _renderPeopleGrid();
    });
    $('#ai-people-min-faces')?.addEventListener('change', (e) => {
        _peopleFilter.minFaces = Number(e.target.value) || 1;
        _renderPeopleGrid();
    });
    $('#ai-people-recent')?.addEventListener('change', (e) => {
        _peopleFilter.recentFirst = !!e.target.checked;
        _renderPeopleGrid();
    });
    $('#ai-people-refresh-btn')?.addEventListener('click', () => _loadPeople());

    // Tag browser — refresh + chip clicks.
    $('#ai-tag-browser-refresh')?.addEventListener('click', () => _renderTagBrowser());
    $('#ai-tag-filter')?.addEventListener('input', (e) => {
        _tagFilterQuery = String(e.target?.value || '');
        _renderTagBrowser(false);
    });
    $('#ai-tag-sort')?.addEventListener('change', (e) => {
        _tagSortMode = String(e.target?.value || 'count_desc');
        _renderTagBrowser(false);
    });
    $('#ai-tag-prev-btn')?.addEventListener('click', () => {
        if (!aiStore.get('tagSelected') || _tagPhotosPage <= 1) return;
        _tagPhotosPage -= 1;
        _loadTagPhotoPage();
    });
    $('#ai-tag-next-btn')?.addEventListener('click', () => {
        if (!aiStore.get('tagSelected') || _tagPhotosPage >= _tagPhotosTotalPages) return;
        _tagPhotosPage += 1;
        _loadTagPhotoPage();
    });
    $('#ai-tag-create-album')?.addEventListener('click', () =>
        _createSmartAlbum(aiStore.get('tagSelected')),
    );
    $('#ai-tag-details-album-btn')?.addEventListener('click', () =>
        _createSmartAlbum(aiStore.get('tagSelected')),
    );
    $('#ai-tag-suggestions-refresh')?.addEventListener('click', () => _renderTagSuggestions());
    $('#ai-smart-albums-refresh')?.addEventListener('click', () => _renderSmartAlbums());
    $('#ai-smart-albums-rebuild-all')?.addEventListener('click', () => _rebuildAllSmartAlbums());
    $('#ai-album-nl-parse-btn')?.addEventListener('click', _parseAlbumWithAi);
    $('#ai-album-nl-create-btn')?.addEventListener('click', _createAlbumFromNl);
    $('#ai-album-nl-fix-btn')?.addEventListener('click', _fixNlRuleAndPreview);
    $('#ai-album-nl-cancel-btn')?.addEventListener('click', _clearAlbumNlBuilder);
    $('#ai-smart-albums-add')?.addEventListener('click', () => _createSmartAlbum());
    $('#ai-smart-album-prev-btn')?.addEventListener('click', () => {
        if (!aiStore.get('smartAlbumSelected') || _smartAlbumItemsPage <= 1) return;
        _smartAlbumItemsPage -= 1;
        _loadSmartAlbumItemsPage();
    });
    $('#ai-smart-album-next-btn')?.addEventListener('click', () => {
        if (
            !aiStore.get('smartAlbumSelected') ||
            _smartAlbumItemsPage >= _smartAlbumItemsTotalPages
        )
            return;
        _smartAlbumItemsPage += 1;
        _loadSmartAlbumItemsPage();
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-faces',
        storageKey: LS_FACES_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-tags',
        storageKey: LS_TAGS_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-people',
        storageKey: LS_PEOPLE_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-tag-browser',
        storageKey: LS_TAG_BROWSER_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-tag-suggestions',
        storageKey: LS_TAG_SUGGESTIONS_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-smart-albums',
        storageKey: LS_SMART_ALBUMS_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-llm',
        storageKey: LS_LLM_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-embeddings',
        storageKey: LS_EMBEDDINGS_COLLAPSED,
        defaultOpen: false,
    });

    // Person action buttons.
    $('#ai-person-rename-btn')?.addEventListener('click', _renameSelectedPerson);
    $('#ai-person-merge-btn')?.addEventListener('click', _mergeSelectedPerson);
    $('#ai-person-split-btn')?.addEventListener('click', _splitSelectedPerson);
    $('#ai-person-delete-btn')?.addEventListener('click', _deleteSelectedPerson);

    // Keyboard nav in the people grid. Event delegation on the stable
    // grid container so it survives re-renders.
    _wirePeopleGridKeyboard();
    $('#ai-people-photos-prev-btn')?.addEventListener('click', () => {
        if (!aiStore.get('selectedPerson') || _peoplePhotosPage <= 1) return;
        _peoplePhotosPage -= 1;
        _loadPersonPhotosPage();
    });
    $('#ai-people-photos-next-btn')?.addEventListener('click', () => {
        if (!aiStore.get('selectedPerson') || _peoplePhotosPage >= _peoplePhotosTotalPages) return;
        _peoplePhotosPage += 1;
        _loadPersonPhotosPage();
    });

    // LLM provider pane
    $('#ai-llm-refresh-btn')?.addEventListener('click', () => _renderLlmStatus());
    $('#ai-llm-test-btn')?.addEventListener('click', _runLlmTest);
    $('#ai-llm-test-prompt')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _runLlmTest();
    });
    $('#ai-llm-provider-select')?.addEventListener('change', _onLlmProviderChange);
    $('#ai-llm-config-save')?.addEventListener('click', _saveLlmConfig);

    // Semantic search / embeddings pane
    $('#ai-embeddings-refresh-btn')?.addEventListener('click', () => _renderEmbeddingsStatus());
    $('#ai-embeddings-reindex-btn')?.addEventListener('click', _reindexEmbeddings);
    $('#ai-embeddings-search-btn')?.addEventListener('click', _runEmbeddingSearch);
    $('#ai-embeddings-search-query')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _runEmbeddingSearch();
    });

    // Unified query bar — one input to search + create albums
    $('#ai-query-search-btn')?.addEventListener('click', _runUnifiedQuery);
    $('#ai-query-album-btn')?.addEventListener('click', _createAlbumFromUnifiedQuery);
    $('#ai-query-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _runUnifiedQuery();
    });
    // Source chips — toggle active state on click
    $('#ai-query-sources')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.ai-source-chip');
        if (!chip) return;
        const active = chip.dataset.active === '1';
        chip.dataset.active = active ? '0' : '1';
        chip.classList.toggle('opacity-40', active);
        chip.classList.toggle('border-tg-border/20', active);
        chip.classList.toggle('border-tg-blue/40', !active);
        // Refire the search if there's already a result visible
        const grid = $('#ai-query-grid');
        if (grid && !grid.classList.contains('hidden') && grid.dataset.searchQuery) {
            _runUnifiedQuery();
        }
    });

    // WebSocket — scan events for all capabilities.
    // ai_faces_status surfaces sidecar lifecycle changes so the header badge updates without a polling loop.
    ws.on('ai_people_progress', (m) => _onScanProgress('faces', m));
    ws.on('ai_people_done', (m) => _onScanDone('faces', m));
    ws.on('ai_tags_progress', (m) => _onScanProgress('tags', m));
    ws.on('ai_tags_done', (m) => _onScanDone('tags', m));
    ws.on('ai_ocr_progress', (m) => _onScanProgress('ocr', m));
    ws.on('ai_ocr_done', (m) => _onScanDone('ocr', m));
    ws.on('ai_faces_status', () => refreshStatus());

    // Auto-installer feedback. Streams stdout from `python -m
    // tgdl_faces.install` line-by-line so the operator sees pip progress
    // (downloading wheels, resolving deps, etc.) without leaving the
    // page. `ai_faces_install_done` flips the spinner off + reveals the
    // result toast.
    $('#ai-install-btn')?.addEventListener('click', _runInstaller);
    ws.on('ai_faces_install_progress', _onInstallProgress);
    ws.on('ai_faces_install_done', _onInstallDone);

    // Overflow menu -> AI runtime setup. Reveals the install card
    // even when the sidecar is healthy (so operators can switch EP),
    // closes the <details> menu, scrolls the card into view.
    $('#ai-open-install-btn')?.addEventListener('click', () => {
        const card = document.getElementById('ai-install-card');
        if (card) {
            card.classList.remove('hidden');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        const menu = document.getElementById('ai-more-menu');
        if (menu instanceof HTMLDetailsElement) menu.open = false;
    });

    // Single status watcher — fires whenever refreshStatus() stores a new
    // API response. All render paths driven by status go here; callers
    // only need to call aiStore.set('status', ...) and this handles the rest.
    aiStore.watch('status', (v) => _renderStatus(v || {}));

    // People panel — sync tile highlight when selection changes.
    // Photo loading is kept imperative (click handlers call _showPersonPhotos
    // explicitly) because dblclick → rename and click → show-photos share the
    // same selectedPerson write and need different follow-up actions.
    aiStore.watch('selectedPerson', () => _syncSelectedPersonTile());

    // Smart albums panel — album selection drives item load reactively.
    aiStore.watch('smartAlbumSelected', (id) => {
        if (id != null) _loadSmartAlbumItems(id, aiStore.get('smartAlbumSelectedName'));
    });

    // Tags panel — chip selection drives photo load reactively.
    // Also resets the OCR word filter so photos show unfiltered for the new tag.
    aiStore.watch('tagSelected', (tag) => {
        if (tag) {
            _ocrWordFilter = '';
            _renderOcrChips();
            _renderTagDetails(tag).catch(() => {});
            _loadTagPhotos(tag);
        }
    });
}

async function _runInstaller() {
    const btn = $('#ai-install-btn');
    const sel = $('#ai-install-force');
    const force = String(sel?.value || '').trim() || undefined;
    const wrap = $('#ai-install-progress');
    const log = $('#ai-install-log');
    const status = $('#ai-install-status');
    if (log) log.textContent = '';
    if (wrap) wrap.classList.remove('hidden');
    if (status) status.textContent = i18nT('maintenance.ai.install.running', 'Installing…');
    if (btn) {
        btn.disabled = true;
        btn.dataset.busy = '1';
    }
    try {
        const r = await api.post('/api/ai/faces/install-deps', force ? { force } : {});
        if (!r.started && r.error) throw new Error(r.error);
    } catch (e) {
        if (status) status.textContent = i18nT('common.error', 'Error');
        if (log) log.textContent += `\n${e?.message || e}\n`;
        if (btn) {
            btn.disabled = false;
            delete btn.dataset.busy;
        }
        showToast(
            `${i18nT('maintenance.ai.install.failed', 'Install failed')}: ${e?.message || e}`,
            'error',
        );
    }
}

function _onInstallProgress(m) {
    const wrap = $('#ai-install-progress');
    const log = $('#ai-install-log');
    if (wrap) wrap.classList.remove('hidden');
    if (log && m && typeof m.line === 'string') {
        log.textContent += m.line + '\n';
        log.scrollTop = log.scrollHeight;
    }
}

function _onInstallDone(m) {
    const btn = $('#ai-install-btn');
    const status = $('#ai-install-status');
    if (btn) {
        btn.disabled = false;
        delete btn.dataset.busy;
    }
    if (m?.ok) {
        if (status)
            status.textContent = i18nT(
                'maintenance.ai.install.done',
                'Install complete — restarting sidecar…',
            );
        showToast(
            i18nT('maintenance.ai.install.done', 'Install complete — restarting sidecar…'),
            'success',
        );
        // Server kicks startSidecar() automatically; refresh status so
        // the badge flips to healthy as soon as the probe lands.
        setTimeout(() => refreshStatus().catch(() => {}), 1500);
    } else {
        const reason = m?.reason || i18nT('common.error', 'Error');
        if (status) status.textContent = reason;
        showToast(
            `${i18nT('maintenance.ai.install.failed', 'Install failed')}: ${reason}`,
            'error',
        );
    }
}

/**
 * Save a single config key + its nested `faces.*` alias (per Track I's
 * dual-write rule so `_mergeAi` doesn't quietly revert the value). For
 * keys not in the alias map this just writes the flat path.
 * `restartSidecar=true` (used for `facesDetectorModel`) also fire-and-
 * forgets a `/api/ai/faces/restart` so the new model loads next /detect.
 */
async function _saveSetting(cfgKey, value, { restartSidecar = false } = {}) {
    try {
        const body = { advanced: { ai: {} } };
        const map = _CTRL_SAVE_PATHS[cfgKey];
        if (map) {
            body.advanced.ai[map[0]] = value;
            body.advanced.ai.faces = { [map[2]]: value };
        } else {
            body.advanced.ai[cfgKey] = value;
        }
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        if (restartSidecar) {
            try {
                await api.post('/api/ai/faces/restart', {});
            } catch (e) {
                console.warn('faces/restart on setting change:', e);
            }
        }
    } catch (e) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

async function _onAutoToggle() {
    const el = $('#ai-auto-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip so the click feels instant.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: { ai: { faceClustering: next } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        // Roll back optimistic flip.
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

async function _onIncludeVideosToggle() {
    const el = $('#ai-faces-include-videos');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip so the click feels instant.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: {
                ai: {
                    includeVideos: next,
                    faces: {
                        includeVideos: next,
                    },
                },
            },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        // Roll back optimistic flip.
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Status / settings ----------------------------------------------------

function _featurePill(label, state, detail = '') {
    const tone =
        state === 'ready'
            ? 'border-green-500/30 bg-green-500/10 text-green-200'
            : state === 'disabled'
              ? 'border-tg-border/30 bg-tg-bg/30 text-tg-textSecondary'
              : state === 'warn'
                ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200'
                : 'border-red-500/30 bg-red-500/10 text-red-200';
    const icon =
        state === 'ready'
            ? 'ri-checkbox-circle-line'
            : state === 'disabled'
              ? 'ri-pause-circle-line'
              : state === 'warn'
                ? 'ri-error-warning-line'
                : 'ri-close-circle-line';
    return `<div class="rounded-md border ${tone} px-2 py-1.5 min-w-0">
        <div class="flex items-center gap-1.5 text-[11px] font-medium"><i class="${icon}"></i><span>${escapeHtml(label)}</span></div>
        <div class="text-[10px] opacity-80 truncate mt-0.5" title="${escapeHtml(detail)}">${escapeHtml(detail || (state === 'ready' ? 'Ready' : state))}</div>
    </div>`;
}

function _scanLabel(feature) {
    return (
        {
            faces: 'Faces',
            tags: 'CLIP tags',
            ocr: 'OCR',
            wd14: 'WD14',
        }[feature] || feature
    );
}

function _renderQuickOps(status) {
    const grid = $('#ai-readiness-grid');
    const meta = $('#ai-readiness-meta');
    const jobsCard = $('#ai-active-jobs-card');
    const jobsList = $('#ai-active-jobs-list');
    const issuesCard = $('#ai-issues-card');
    const issuesList = $('#ai-issues-list');
    const cfg = status?.config || {};
    const models = status?.models || {};
    const sidecar = status?.sidecar || {};
    const mlSidecar = status?.mlSidecar || {};
    const scans = status?.scans || {};

    if (grid) {
        const sidecarState = sidecar.url && sidecar.ok !== false ? 'ready' : 'error';
        const facesReady = models.faces?.loaded === true;
        const tagsReady = models.tags?.loaded === true;
        const ocrEnabled = cfg.imageOcr === true;
        const pills = [
            _featurePill('Sidecar', sidecarState, sidecar.url || 'Offline'),
            _featurePill('Faces', facesReady ? 'ready' : 'error', models.faces?.id || 'Not ready'),
            _featurePill(
                'CLIP tags',
                tagsReady ? 'ready' : 'error',
                models.tags?.id || 'Not ready',
            ),
            _featurePill(
                'OCR',
                !ocrEnabled ? 'disabled' : models.ocr?.ready ? 'ready' : 'warn',
                !ocrEnabled
                    ? 'Disabled'
                    : models.ocr?.error || (models.ocr?.ready ? 'Ready' : 'Not ready'),
            ),
        ];
        grid.innerHTML = pills.join('');
    }
    if (meta) {
        const parts = [
            sidecar.version ? `version ${sidecar.version}` : null,
            sidecar.platform || null,
            Array.isArray(sidecar.providers) && sidecar.providers.length
                ? sidecar.providers.map((p) => _PROVIDER_LABEL[p] || p).join(', ')
                : null,
        ].filter(Boolean);
        meta.textContent = parts.length
            ? parts.join(' · ')
            : 'Capability status updates on refresh.';
        meta.title = meta.textContent;
    }

    const active = Object.entries(scans).filter(([, s]) => s?.running);
    if (jobsCard && jobsList) {
        jobsCard.classList.toggle('hidden', !active.length);
        jobsList.innerHTML = active
            .map(([feature, s]) => {
                const scanned = Number(s.scanned) || 0;
                const total = Number(s.total) || 0;
                const pct = total ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
                return `<div>
                    <div class="flex items-center justify-between gap-2 text-[11px] text-tg-text">
                        <span>${escapeHtml(_scanLabel(feature))}</span>
                        <span class="tabular-nums text-tg-textSecondary">${total ? `${scanned.toLocaleString()} / ${total.toLocaleString()} · ${pct}%` : `${scanned.toLocaleString()} processed`}</span>
                    </div>
                    <div class="h-1.5 bg-tg-bg/60 rounded overflow-hidden mt-1"><div class="h-full bg-tg-blue" style="width:${pct}%"></div></div>
                </div>`;
            })
            .join('');
    }

    const issues = [];
    if (!sidecar.url && !mlSidecar.url)
        issues.push({
            severity: 'error',
            title: 'Sidecar offline',
            count: 1,
            detail: 'AI scans that need the Python service cannot start.',
        });
    for (const [feature, s] of Object.entries(scans)) {
        if (s?.error)
            issues.push({
                severity: 'error',
                title: `${_scanLabel(feature)} failed`,
                count: 1,
                detail: s.error,
            });
    }
    if (models.ocr?.error)
        issues.push({
            severity: 'warn',
            title: 'OCR not ready',
            count: 1,
            detail: models.ocr.error,
        });
    if (models.tags && models.tags.loaded === false)
        issues.push({
            severity: 'warn',
            title: 'CLIP tagger not ready',
            count: 1,
            detail: 'Tag scans are disabled until the sidecar reports clip_ready.',
        });
    const auditedIssues = Array.isArray(status?.issues?.issues)
        ? status.issues.issues.filter((i) => Number(i.count) > 0 && i.severity !== 'info')
        : [];
    issues.push(...auditedIssues);
    if (issuesCard && issuesList) {
        issuesCard.classList.toggle('hidden', !issues.length);
        issuesList.innerHTML = issues
            .slice(0, 8)
            .map((issue) => {
                const sevCls =
                    issue.severity === 'error'
                        ? 'text-red-200'
                        : issue.severity === 'info'
                          ? 'text-tg-textSecondary'
                          : 'text-yellow-100';
                const count =
                    Number(issue.count) > 1 ? ` (${Number(issue.count).toLocaleString()})` : '';
                return `<div><span class="${sevCls} font-medium">${escapeHtml(issue.title || issue.type)}${count}:</span> <span class="text-red-100/80">${escapeHtml(String(issue.detail || ''))}</span></div>`;
            })
            .join('');
    }
}

async function _copyAiDiagnostics() {
    const status = aiStore.get('status');
    if (!status) return;
    const data = {
        generatedAt: new Date().toISOString(),
        sidecar: status.sidecar || null,
        mlSidecar: status.mlSidecar || null,
        models: status.models || {},
        scans: status.scans || {},
        counts: status.counts || {},
        trackers: status.trackers || {},
        issues: status.issues || null,
    };
    try {
        await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        showToast('AI diagnostics copied', 'success');
    } catch {
        showToast('Could not copy diagnostics', 'error');
    }
}

/**
 * Scanner card definitions — one per feature.
 * Each entry maps status API fields to card content.
 */
const _SCANNER_CARD_DEFS = [
    {
        feature: 'faces',
        label: 'Faces',
        icon: 'ri-user-smile-line',
        color: 'text-tg-blue',
        enabledKey: 'faceClustering',
        sidecarEndpoint: 'faces',
        modelKey: 'faces',
        countKey: 'withFaces',
        countLabel: 'with faces',
        scanBtnId: 'ai-scan-btn',
        cancelBtnId: 'ai-cancel-btn',
        estimateKey: null,
        settingsPaneId: 'ai-pane-faces',
        configSummary: (cfg, _models) => {
            const det = cfg.facesDetectorModel || 'buffalo_l';
            return `${det} · ε=${cfg.facesEpsilon || 0.5} · minPts=${cfg.facesMinPoints || 3}`;
        },
    },
    {
        feature: 'tags',
        label: 'CLIP Tags',
        icon: 'ri-price-tag-3-line',
        color: 'text-tg-orange',
        enabledKey: null, // uses models.tags.enabled
        sidecarEndpoint: 'tag',
        modelKey: 'tags',
        countKey: 'withTags',
        scanBtnId: 'ai-tags-scan-btn',
        cancelBtnId: 'ai-tags-cancel-btn',
        estimateKey: 'aiTags',
        settingsPaneId: 'ai-pane-tags',
        configSummary: (_cfg, models) => {
            const m = models.tags || {};
            const vs = m.vocabularySize || '';
            return `${m.id || 'clip-vit-base-patch32'}${vs ? ' · vocab=' + vs : ''}`;
        },
    },
    {
        feature: 'wd14',
        label: 'WD14 Tags',
        icon: 'ri-hashtag-line',
        color: 'text-purple-400',
        enabledKey: null, // cfg.wd14Tagging !== false
        sidecarEndpoint: 'wd14', // needs explicit wd14 endpoint — tgdl-ml doesn't expose it
        modelKey: 'wd14',
        countKey: 'withWd14Tags',
        scanBtnId: null,
        cancelBtnId: null,
        estimateKey: 'aiWd14',
        settingsPaneId: 'ai-pane-tags',
        configSummary: (_cfg, _models) => 'SmilingWolf wd-v1-4-vit-tagger-v2',
    },
    {
        feature: 'ocr',
        label: 'OCR',
        icon: 'ri-file-text-line',
        color: 'text-teal-400',
        enabledKey: 'imageOcr',
        sidecarEndpoint: 'ocr',
        modelKey: 'ocr',
        countKey: 'withText',
        scanBtnId: 'ai-ocr-scan-btn',
        cancelBtnId: 'ai-ocr-cancel-btn',
        estimateKey: 'aiOcr',
        settingsPaneId: 'ai-pane-ocr',
        configSummary: (cfg, _models) => {
            return cfg.imageOcr ? 'enabled' : 'disabled';
        },
    },
];

/**
 * Render per-scanner cards into #ai-scanner-cards.
 * Shows coverage, readiness, last-scan, and quick actions.
 */
function _renderScannerCards(status) {
    const container = $('#ai-scanner-cards');
    if (!container) return;
    const cfg = status.config || {};
    const counts = status.counts || {};
    const scans = status.scans || {};
    const models = status.models || {};
    const sidecar = status.sidecar || {};
    const mlSidecarCards = status.mlSidecar || {};
    const trackers = status.trackers || {};
    const totalEligible = Number(counts.totalEligible) || 0;
    const now = Date.now();

    container.innerHTML = _SCANNER_CARD_DEFS
        .map((def) => {
            const model = models[def.modelKey] || {};
            const scanState = scans[def.feature] || {};
            const tracker = trackers[def.estimateKey] || {};
            const running = !!scanState.running;

            // Enabled: check config key or model.enabled
            let enabled = true;
            if (def.enabledKey !== null) {
                enabled = cfg[def.enabledKey] === true;
            } else if (model.enabled !== undefined) {
                enabled = model.enabled === true;
            } else if (def.feature === 'wd14') {
                enabled = cfg.wd14Tagging !== false;
            }

            // Readiness — OCR can be served by either sidecar or tgdl-ml
            const modelReady =
                model.loaded === true || model.ready === true || model.ready === undefined;
            const sidecarOk = !!sidecar.url;
            const mlOcrOk =
                def.feature === 'ocr' && !!mlSidecarCards.ok && !!mlSidecarCards.endpoints?.ocr;
            const providerOk = sidecarOk || mlOcrOk;
            const hasEndpoint =
                def.sidecarEndpoint === null
                    ? providerOk
                    : mlOcrOk || !!sidecar.endpoints?.[def.sidecarEndpoint];
            const readiness = !providerOk
                ? 'offline'
                : !enabled
                  ? 'disabled'
                  : def.sidecarEndpoint !== null && !hasEndpoint
                    ? 'missing'
                    : modelReady
                      ? 'ready'
                      : 'unready';

            // Coverage
            const doneCount = Number(counts[def.countKey]) || 0;
            const pct = totalEligible
                ? Math.min(100, Math.round((doneCount / totalEligible) * 100))
                : 0;

            // Last scan / finished timestamp
            const finishedAt = scanState.finishedAt || tracker.finishedAt || 0;
            const lastScanStr = finishedAt ? _timeAgo(finishedAt, now) : 'never';

            // Failed / skipped / errors from tracker progress
            const progress = tracker.progress || {};
            const failedCount = Number(progress.failed || scanState.failed || 0);
            const skippedCount = Number(progress.skipped || scanState.skipped || 0);
            const hasErrors = !!scanState.error || !!tracker.error;

            // Build action buttons
            const actionsHtml = [];
            if (def.scanBtnId) {
                const scanDisabled =
                    running ||
                    readiness === 'offline' ||
                    readiness === 'missing' ||
                    readiness === 'disabled';
                actionsHtml.push(
                    `<button type="button" class="tg-btn text-[10px] px-2 py-1 inline-flex items-center gap-1 ai-scanner-action"` +
                        ` data-feature="${def.feature}" data-action="scan"` +
                        (scanDisabled ? ' disabled' : '') +
                        ` title="${scanDisabled ? 'Cannot scan — ' + readiness : 'Scan ' + def.label.toLowerCase()}">` +
                        `<i class="${running ? 'ri-loader-4-line animate-spin' : 'ri-play-fill'}"></i>` +
                        `<span>${running ? 'Running' : 'Scan'}</span></button>`,
                );
            }
            if (def.cancelBtnId && running) {
                actionsHtml.push(
                    `<button type="button" class="tg-btn-secondary text-[10px] px-2 py-1 inline-flex items-center gap-1 ai-scanner-action"` +
                        ` data-feature="${def.feature}" data-action="cancel" title="Cancel ${def.label} scan">` +
                        `<i class="ri-stop-circle-line"></i><span>Cancel</span></button>`,
                );
            }
            if (hasErrors && !running) {
                actionsHtml.push(
                    `<button type="button" class="tg-btn-secondary text-[10px] px-2 py-1 inline-flex items-center gap-1 text-yellow-200 ai-scanner-action"` +
                        ` data-feature="${def.feature}" data-action="retry" title="Retry failed items for ${def.label}">` +
                        `<i class="ri-refresh-line"></i><span>Retry</span></button>`,
                );
            }

            // Readiness pill
            const readinessPill = _readinessPill(readiness);

            return `<div class="ai-scanner-card bg-tg-panel rounded-xl p-3 border border-tg-border/30">
    <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex items-center gap-1.5">
            <i class="${def.icon} ${def.color}"></i>
            <span class="text-xs font-medium text-tg-text">${escapeHtml(def.label)}</span>
            <span class="shrink-0">${readinessPill}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
            ${actionsHtml.join('')}
        </div>
    </div>
    <div class="mt-2">
        <div class="flex justify-between text-[10px] text-tg-textSecondary">
            <span>${escapeHtml(doneCount.toLocaleString())} / ${escapeHtml(totalEligible.toLocaleString())} ${def.countLabel || 'indexed'}</span>
            <span class="tabular-nums">${pct}%</span>
        </div>
        <div class="h-1.5 bg-tg-bg/60 rounded overflow-hidden mt-0.5" role="progressbar" aria-valuenow="${doneCount}" aria-valuemin="0" aria-valuemax="${totalEligible || 1}">
            <div class="h-full ${pct >= 100 ? 'bg-green-500' : running ? 'bg-tg-blue' : pct > 0 ? 'bg-tg-blue/70' : 'bg-tg-bg'}" style="width:${Math.max(pct, running ? 2 : 0)}%"></div>
        </div>
    </div>
    <div class="flex items-center gap-2 mt-1.5 text-[10px] text-tg-textSecondary flex-wrap">
        ${failedCount > 0 ? `<span class="text-red-300" title="Failed rows"><i class="ri-close-circle-line"></i> ${failedCount.toLocaleString()} failed</span>` : ''}
        ${skippedCount > 0 ? `<span title="Skipped rows"><i class="ri-skip-forward-line"></i> ${skippedCount.toLocaleString()} skipped</span>` : ''}
        ${hasErrors && !failedCount && !skippedCount ? `<span class="text-red-300"><i class="ri-error-warning-line"></i> error</span>` : ''}
        <span class="ml-auto" title="Last scan"><i class="ri-time-line"></i> ${lastScanStr}</span>
    </div>
    <div class="flex items-center gap-2 mt-1.5 text-[9px]">
        <span class="text-tg-textSecondary truncate flex-1" title="${escapeHtml(def.configSummary(cfg, models))}">
            ${escapeHtml(def.configSummary(cfg, models))}
        </span>
        ${def.settingsPaneId ? `<button type="button" class="ai-scanner-action text-tg-blue hover:underline shrink-0" data-feature="${def.feature}" data-action="settings">Settings</button>` : ''}
        ${hasErrors && !running ? `<button type="button" class="ai-scanner-action text-red-300 hover:underline shrink-0" data-feature="${def.feature}" data-action="view-failures">Failures</button>` : ''}
    </div>
</div>`;
        })
        .join('');
}

/**
 * Delegated click handler for scanner card action buttons.
 * Bound once in _bindOnce so it survives repeated innerHTML swaps.
 */
function _onScannerCardClick(e) {
    const btn = e.target.closest('.ai-scanner-action');
    if (!btn) return;
    // Disabled buttons don't fire click events in the browser, but
    // double-check as a safety net.
    if (btn.disabled) return;
    const feature = btn.dataset.feature;
    const action = btn.dataset.action;
    if (action === 'scan') {
        _triggerScannerScan(feature);
    } else if (action === 'cancel') {
        _triggerScannerCancel(feature);
    } else if (action === 'retry') {
        _triggerScannerRetry(feature);
    } else if (action === 'settings') {
        _scrollToSettings(feature);
    } else if (action === 'view-failures') {
        _showScannerFailures(feature);
    }
}

/** Small pill for one of: ready, offline, disabled, missing, unready */
function _readinessPill(state) {
    const map = {
        ready: 'border-green-500/30 bg-green-500/10 text-green-200',
        offline: 'border-red-500/30 bg-red-500/10 text-red-200',
        disabled: 'border-tg-border/30 bg-tg-bg/30 text-tg-textSecondary',
        missing: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200',
        unready: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200',
    };
    const cls = map[state] || map.disabled;
    const label =
        {
            ready: 'Ready',
            offline: 'Offline',
            disabled: 'Off',
            missing: 'No endpoint',
            unready: 'Not ready',
        }[state] || state;
    return `<span class="inline-block rounded px-1.5 py-0.5 border text-[9px] font-medium leading-none ${cls}">${label}</span>`;
}

/** Human-friendly relative time */
function _timeAgo(ts, now) {
    const diff = (now || Date.now()) - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Trigger a scanner scan for the given feature.
 * Calls _startScan directly instead of going through the DOM button,
 * which avoids the disabled-button-doesn't-click problem.
 */
function _triggerScannerScan(feature) {
    _startScan(feature);
}

function _triggerScannerCancel(feature) {
    const def = _SCANNER_CARD_DEFS.find((d) => d.feature === feature);
    if (!def) return;
    if (def.feature === 'faces') {
        _cancelScan('faces');
    } else {
        const btn = def.cancelBtnId ? $(def.cancelBtnId) : null;
        if (btn && !btn.disabled) btn.click();
    }
}

function _triggerScannerRetry(feature) {
    // For now, clicking retry fires the scan — the scan-runner skips
    // already-processed rows and retries failed ones automatically.
    _triggerScannerScan(feature);
    showToast(`Retrying ${feature} scan…`, 'info');
}

/** Scroll to the settings pane for a given feature */
function _scrollToSettings(feature) {
    const def = _SCANNER_CARD_DEFS.find((d) => d.feature === feature);
    if (!def?.settingsPaneId) return;
    const el = $(def.settingsPaneId);
    if (el) {
        el.open = true; // open the <details> accordion
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/** Show the issues/failures card by scrolling to it */
function _showScannerFailures(feature) {
    const card = $('#ai-issues-card');
    if (card) {
        card.classList.remove('hidden');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function _renderStatus(status) {
    if (!status) return;
    const cfg = status.config || {};
    const counts = status.counts || {};
    const scans = status.scans || {};
    const models = status.models || {};

    // Sidecar status pill — always rendered now (the prior hide-on-
    // empty path silently dropped the chip during partial rollouts).
    _renderSidecarBadge(status);
    _renderQuickOps(status);
    _renderScannerCards(status);

    // Progress + scan buttons. Cancel is always rendered and just
    // toggles its disabled state; the thumbs page uses the same
    // contract so the controls feel consistent across the app.
    const facesScan = scans?.faces || {};
    const running = !!facesScan.running;
    const scanBtn = $('#ai-scan-btn');
    const cancelBtn = $('#ai-cancel-btn');
    if (scanBtn) scanBtn.disabled = running || !_doctorScanReady;
    if (cancelBtn) cancelBtn.disabled = !running;
    const reindexBtn = $('#ai-reindex-btn');
    if (reindexBtn) reindexBtn.disabled = running || !_doctorScanReady;
    const reclusterBtn = $('#ai-recluster-btn');
    if (reclusterBtn) reclusterBtn.disabled = running || !_doctorScanReady;
    const prog = $('#ai-progress');
    if (prog) prog.classList.toggle('hidden', !running);
    if (running) {
        const scanned = Number(facesScan.scanned) || 0;
        const total = Number(facesScan.total) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
        const bar = $('#ai-progress-bar');
        const pctEl = $('#ai-progress-pct');
        const statusEl = $('#ai-progress-status');
        if (bar) bar.style.width = `${pct}%`;
        if (pctEl)
            pctEl.textContent = total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`
                : `${scanned.toLocaleString()} processed`;
        if (statusEl) statusEl.textContent = i18nT('maintenance.ai.scanning', 'Scanning…');
    }

    // KPI tiles. peopleCount is the canonical "how many clusters"
    // metric; withFaces (distinct downloads that have at least one
    // face) gives a different shape and was confusing operators.
    const indexedEl = $('#ai-stat-indexed');
    if (indexedEl) {
        const indexed = Number(counts.indexed) || 0;
        const total = Number(counts.totalEligible) || 0;
        const pctIndexed = total > 0 ? Math.round((indexed / total) * 100) : 0;
        indexedEl.innerHTML = `<span>${pctIndexed}%</span><div class="text-[10px] text-tg-textSecondary font-normal mt-0.5 tabular-nums">${indexed.toLocaleString()} / ${total.toLocaleString()}</div>`;
    }
    const peopleEl = $('#ai-stat-people');
    if (peopleEl) peopleEl.textContent = String(counts.peopleCount ?? counts.withFaces ?? 0);
    const taggedEl = $('#ai-stat-tagged');
    if (taggedEl) {
        const tagged = Number(counts.withTags ?? 0);
        const indexed = Number(counts.indexed) || 0;
        const pctTagged = indexed > 0 ? Math.round((tagged / indexed) * 100) : 0;
        taggedEl.innerHTML = `<span>${pctTagged}%</span><div class="text-[10px] text-tg-textSecondary font-normal mt-0.5 tabular-nums">${tagged.toLocaleString()} tagged</div>`;
    }
    const ocrCount = $('#ai-ocr-count');
    if (ocrCount) {
        const n = Number(counts.withText) || 0;
        ocrCount.textContent = n ? `(${n.toLocaleString()})` : '';
    }
    _lastTagsChangedAt = Number(scans?.tags?.finishedAt) || _lastTagsChangedAt || 0;
    const lastEl = $('#ai-stat-last');
    if (lastEl) {
        // Prefer DB-persisted MAX(ai_indexed_at) — survives restarts.
        // Fall back to the most recent in-memory scan finishedAt.
        const dbLast = Number(counts?.lastScanAt) || 0;
        const memLast = Math.max(
            Number(scans?.faces?.finishedAt) || 0,
            Number(scans?.tags?.finishedAt) || 0,
            Number(scans?.ocr?.finishedAt) || 0,
        );
        const finishedAt = dbLast || memLast;
        lastEl.textContent =
            finishedAt > 0 ? new Date(finishedAt).toLocaleString() : i18nT('common.never', 'Never');
    }

    // Auto-cluster cadence hint — only shown when the feature is active.
    const autoClusterInfoEl = $('#ai-auto-cluster-info');
    const autoClusterTextEl = $('#ai-auto-cluster-info-text');
    if (autoClusterInfoEl && autoClusterTextEl) {
        const active = !!cfg.enabled && !!cfg.faceClustering && !!cfg.autoCluster;
        if (active) {
            const mins = Number(cfg.autoClusterIntervalMin) || 60;
            autoClusterTextEl.textContent = i18nTf(
                'maintenance.ai.auto_cluster_info',
                { mins },
                `Auto-clustering every ${mins} min`,
            );
            autoClusterInfoEl.classList.remove('hidden');
        } else {
            autoClusterInfoEl.classList.add('hidden');
        }
    }

    // Toggles. Click handlers in `_bindOnce` flip the underlying flag
    // optimistically; this is the "render from server truth" pass that
    // runs on init + after every save round-trip.
    const masterToggle = $('#ai-master-toggle');
    if (masterToggle) {
        const on = !!cfg.enabled;
        masterToggle.classList.toggle('active', on);
        masterToggle.setAttribute('aria-checked', String(on));
    }
    const autoToggle = $('#ai-auto-toggle');
    if (autoToggle) {
        const on = cfg.faceClustering !== false;
        autoToggle.classList.toggle('active', on);
        autoToggle.setAttribute('aria-checked', String(on));
    }

    // Model line — id + dim + provider, served by /api/ai/status.
    const facesModel = models.faces || {};
    const modelId =
        facesModel.id || (facesModel.bundled ? 'insightface buffalo_l (Python sidecar)' : '—');
    const dim = facesModel.dim || (facesModel.bundled ? 512 : null);
    const provider = _resolveProvider(facesModel);
    const modelLine = [modelId, dim ? `${dim}-dim` : null, provider || null]
        .filter(Boolean)
        .join(' · ');
    const modelLineEl = $('#ai-model-line');
    if (modelLineEl) {
        modelLineEl.textContent = modelLine;
        modelLineEl.title = modelId;
    }

    // Settings inputs — sync values from config so F5 doesn't appear
    // to revert local changes. The `value =` write fires before any
    // change listener, so this is safe even when the slider is in the
    // operator's focus.
    const modelSel = $('#ai-faces-model');
    if (modelSel) {
        const cur = String(cfg.facesDetectorModel || cfg.faces?.detectorModel || 'buffalo_l');
        if (modelSel.value !== cur) modelSel.value = cur;
    }
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    if (epsInp) {
        const cur = Number.isFinite(cfg.facesEpsilon) ? Number(cfg.facesEpsilon) : 0.5;
        if (Number(epsInp.value) !== cur) epsInp.value = String(cur);
        if (epsOut) epsOut.textContent = Number(cur).toFixed(2);
    }
    const minInp = $('#ai-faces-min-points');
    if (minInp) {
        const cur = Number.isFinite(cfg.facesMinPoints) ? Number(cfg.facesMinPoints) : 3;
        if (Number(minInp.value) !== cur) minInp.value = String(cur);
    }
    const provSel = $('#ai-faces-provider');
    if (provSel) {
        const cur = String(cfg.faces?.providers || 'auto').toLowerCase();
        if (provSel.value !== cur) provSel.value = cur;
    }
    const includeVideosEl = $('#ai-faces-include-videos');
    if (includeVideosEl) {
        const on = cfg.faces?.includeVideos === true;
        includeVideosEl.classList.toggle('active', on);
        includeVideosEl.setAttribute('aria-checked', String(on));
    }
    const videoIntervalEl = $('#ai-faces-video-interval');
    if (videoIntervalEl) {
        const cur = Number(cfg.faces?.videoFrameIntervalSec || 8);
        if (Number(videoIntervalEl.value) !== cur) videoIntervalEl.value = String(cur);
    }
    const videoMaxFramesEl = $('#ai-faces-video-max-frames');
    if (videoMaxFramesEl) {
        const cur = Number(cfg.faces?.videoMaxFrames || 24);
        if (Number(videoMaxFramesEl.value) !== cur) videoMaxFramesEl.value = String(cur);
    }
    const videoRuntimeEl = $('#ai-faces-video-runtime');
    if (videoRuntimeEl) {
        const on = cfg.faces?.includeVideos === true;
        const interval = Number(cfg.faces?.videoFrameIntervalSec || 8);
        const maxFrames = Number(cfg.faces?.videoMaxFrames || 24);
        videoRuntimeEl.textContent = on
            ? `video sampling: on · every ${interval}s · max ${maxFrames} frames/video`
            : 'video sampling: off';
    }

    // Image tagging card — toggle, model line, scan state, labels.
    const tagsToggle = $('#ai-tags-toggle');
    if (tagsToggle) {
        const on = cfg.imageTagging !== false;
        tagsToggle.classList.toggle('active', on);
        tagsToggle.setAttribute('aria-checked', String(on));
    }
    const tagsModel = models.tags || {};
    const tagsModelId = tagsModel.id || (tagsModel.loaded ? 'CLIP loaded' : '—');
    const tagsVocab = tagsModel.vocabularySize ? `${tagsModel.vocabularySize} tags` : '';
    const tagsModelLineEl = $('#ai-tags-model-line');
    if (tagsModelLineEl) {
        const parts = [tagsModelId, tagsVocab].filter(Boolean);
        tagsModelLineEl.textContent = parts.join(' · ') || '—';
        tagsModelLineEl.title = tagsModelId;
    }
    const tagsRunning = !!scans?.tags?.running;
    const tagsScanBtn = $('#ai-tags-scan-btn');
    const tagsCancelBtn = $('#ai-tags-cancel-btn');
    if (tagsScanBtn) {
        const tagsReady = tagsModel.loaded === true;
        tagsScanBtn.disabled = tagsRunning || !tagsReady;
        tagsScanBtn.title = tagsReady
            ? 'Run CLIP tag scan'
            : 'CLIP tagger is not ready on the sidecar';
        const tagScanIcon = tagsScanBtn.querySelector('i');
        if (tagScanIcon)
            tagScanIcon.className = tagsRunning
                ? 'ri-loader-4-line animate-spin'
                : 'ri-price-tag-3-line';
        const tagScanSpan = tagsScanBtn.querySelector('span[data-i18n]');
        if (tagScanSpan)
            tagScanSpan.textContent = tagsRunning
                ? i18nT('maintenance.ai.scanning_tags', 'Tagging…')
                : i18nT('maintenance.ai.tags.scan', 'Tag all');
    }
    if (tagsCancelBtn) tagsCancelBtn.disabled = !tagsRunning;
    // Hydrate tag labels textarea from config.
    const tagsLabelsEl = $('#ai-tags-labels');
    if (tagsLabelsEl) {
        const cur = Array.isArray(cfg.tagLabels) ? cfg.tagLabels.join(', ') : '';
        if (tagsLabelsEl.value !== cur) tagsLabelsEl.value = cur;
    }
    // Hydrate tag confidence threshold slider from config.
    const tagsConfSlider = $('#ai-tags-confidence');
    const tagsConfDisplay = $('#ai-tags-confidence-value');
    if (tagsConfSlider) {
        const stored = parseFloat(cfg.wd14MinScore);
        const val = Number.isFinite(stored) ? stored : 0.35;
        tagsConfSlider.value = String(val);
        if (tagsConfDisplay) tagsConfDisplay.textContent = val.toFixed(2);
    }

    // OCR card — toggle, scan state, sidecar readiness hint.
    const ocrToggle = $('#ai-ocr-toggle');
    if (ocrToggle) {
        const on = cfg.imageOcr === true;
        ocrToggle.classList.toggle('bg-tg-blue', on);
        ocrToggle.classList.toggle('bg-tg-bg/40', !on);
        ocrToggle.setAttribute('aria-checked', String(on));
    }
    const ocrRunning = !!scans?.ocr?.running;
    const ocrModel = models.ocr || {};
    const ocrScanBtn = $('#ai-ocr-scan-btn');
    const ocrCancelBtn = $('#ai-ocr-cancel-btn');
    if (ocrScanBtn) {
        ocrScanBtn.disabled = ocrRunning || !ocrModel.ready;
        ocrScanBtn.title = ocrModel.ready ? 'Run OCR scan' : 'OCR is not ready on the sidecar';
    }
    if (ocrCancelBtn) ocrCancelBtn.disabled = !ocrRunning;
    const ocrStatusEl = $('#ai-ocr-status-line');
    if (ocrStatusEl) {
        if (ocrModel.ready) {
            ocrStatusEl.textContent = 'Tesseract ready';
            ocrStatusEl.className = 'text-[10px] text-tg-green mt-1';
        } else if (ocrModel.error) {
            ocrStatusEl.textContent = `Tesseract: ${ocrModel.error}`;
            ocrStatusEl.className = 'text-[10px] text-red-400 mt-1';
        } else {
            ocrStatusEl.textContent = '';
        }
    }
}

function _renderSidecarBadge(status) {
    const badge = $('#ai-sidecar-badge');
    const text = $('#ai-sidecar-badge-text');
    if (!badge || !text) return;
    // The pill is always rendered now — operators want to see the
    // sidecar's state at a glance regardless of payload shape.
    badge.classList.remove('hidden');
    const faces = (status?.models && status.models.faces) || {};
    const state = String(faces.state || (faces.loaded ? 'healthy' : 'unknown')).toLowerCase();
    const provider = _resolveProvider(faces);
    let label;
    let cls;
    let healthy = false;
    if (state === 'healthy' || state === 'ready' || faces.loaded === true) {
        label = i18nTf(
            'maintenance.ai.sidecar.healthy',
            { provider: provider || 'CPU' },
            `Sidecar: healthy (${provider || 'CPU'})`,
        );
        cls = 'text-green-300';
        healthy = true;
    } else if (state === 'downloading' || state === 'pulling') {
        const pct = Number.isFinite(faces.downloadPct) ? Math.round(faces.downloadPct) : 0;
        label = i18nTf(
            'maintenance.ai.sidecar.downloading',
            { pct },
            `Sidecar: downloading… (${pct}%)`,
        );
        cls = 'text-yellow-300';
    } else if (state === 'starting' || state === 'loading') {
        label = i18nT('maintenance.ai.sidecar.starting', 'Sidecar: starting…');
        cls = 'text-yellow-300';
    } else if (state === 'disabled' || state === 'idle') {
        label = i18nT('maintenance.ai.sidecar.idle', 'Sidecar: idle');
        cls = 'text-tg-textSecondary';
    } else {
        label = i18nT('maintenance.ai.sidecar.down', 'Sidecar: unreachable');
        cls = 'text-red-300';
    }
    text.textContent = label;
    badge.classList.remove(
        'text-green-300',
        'text-yellow-300',
        'text-red-300',
        'text-tg-textSecondary',
    );
    badge.classList.add(cls);

    // Auto-surface the Install card when the sidecar isn't healthy and
    // we're not mid-installation already. Hide it once it's up so the
    // page reads as "everything's working" with no extra panels. The
    // operator can still trigger /api/ai/faces/install-deps from the
    // Re-cluster era (re-installing manually) by reopening the page
    // when offline — the card reappears on the next status flip.
    const installCard = $('#ai-install-card');
    if (installCard) {
        const installBusy = $('#ai-install-btn')?.dataset?.busy === '1';
        const showInstall = !healthy && !installBusy;
        installCard.classList.toggle('hidden', !showInstall);
    }
}

// Map onnxruntime's full provider name to the friendly tag we show in
// the UI. Without this, "DmlExecutionProvider" → "Dml" reads as a typo;
// "CUDAExecutionProvider" → "CUDA" is fine but it's worth normalising
// the whole table so the chip text stays consistent regardless of EP.
const _PROVIDER_LABEL = {
    DmlExecutionProvider: 'DirectML',
    CUDAExecutionProvider: 'CUDA',
    CoreMLExecutionProvider: 'CoreML',
    OpenVINOExecutionProvider: 'OpenVINO',
    TensorrtExecutionProvider: 'TensorRT',
    AzureExecutionProvider: 'Azure',
    CPUExecutionProvider: 'CPU',
};

function _resolveProvider(faces) {
    // The Python sidecar reports `providers: ["DmlExecutionProvider", ...]`.
    // Display the friendly tag (DirectML / CUDA / CoreML / CPU) — the
    // ExecutionProvider suffix is noise in a one-line badge.
    const list = Array.isArray(faces.providers)
        ? faces.providers
        : faces.provider
          ? [faces.provider]
          : [];
    if (!list.length) return '';
    const first = String(list[0] || '');
    return _PROVIDER_LABEL[first] || first.replace(/ExecutionProvider$/i, '').trim();
}

async function _onMasterToggle() {
    const el = $('#ai-master-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip — feels instant; rolled back below on save failure.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', { advanced: { ai: { enabled: next } } });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Capability cards -----------------------------------------------------

function _renderCapabilities(status) {
    const root = $('#ai-capabilities-grid');
    if (!root) return;
    const cfg = status?.config || {};
    const models = status?.models || {};

    const html = CAPABILITIES.map((cap) => {
        const m = models[cap.id] || {};
        return _renderCapabilityCard(cap, m, cfg);
    }).join('');
    root.innerHTML = html;

    // Wire controls. Per-card toggle, control inputs, scan buttons —
    // bound once per render because the markup is rebuilt on every
    // status refresh.
    for (const cap of CAPABILITIES) {
        const card = root.querySelector(`[data-cap="${cap.id}"]`);
        if (!card) continue;

        // Capability auto-toggle (e.g. faceClustering).
        const toggle = card.querySelector('[data-cap-toggle]');
        if (toggle && cap.autoToggleKey) {
            toggle.addEventListener('click', () => _toggleCapability(cap.autoToggleKey, toggle));
        }

        // Scan controls.
        card.querySelector('[data-cap-scan]')?.addEventListener('click', () =>
            _startScan(cap.scanFeature),
        );
        card.querySelector('[data-cap-cancel]')?.addEventListener('click', () =>
            _cancelScan(cap.scanFeature),
        );

        // Each control input — slider / number. Persist on `change`
        // so the operator can tweak the slider without spamming saves
        // while dragging.
        for (const ctrl of cap.controls || []) {
            const inp = card.querySelector(`[data-cap-ctrl="${ctrl.cfgKey}"]`);
            if (!inp) continue;
            inp.addEventListener('change', () => _saveControl(ctrl, inp));
            // Live slider readout — updates the adjacent <output> as
            // the operator drags, even before the change fires.
            if (ctrl.type === 'slider') {
                inp.addEventListener('input', () => {
                    const out = card.querySelector(`[data-cap-out="${ctrl.cfgKey}"]`);
                    if (out) out.textContent = Number(inp.value).toFixed(2);
                });
            }
        }

        // Face-clustering provider probe + dropdown. The card itself
        // is markup-only — wiring lives here so the renderer stays
        // declarative.
        if (cap.id === 'faces' && card.querySelector('[data-faces-provider-card]')) {
            _wireFacesProviderCard(card);
        }
    }
}

/**
 * Wire the provider sub-card embedded in the faces capability card:
 *   - "Run hardware probe" button → GET /api/ai/faces/provider-probe,
 *     renders verified/unverified chips. Mirrors `setting-adv-ffmpeg-
 *     hwaccel-probe` from maintenance-thumbs.js.
 *   - Provider <select> change → POST /api/config with the nested
 *     `advanced.ai.faces.providers` key, then asks the server to
 *     relaunch the sidecar so the new provider takes effect.
 */
function _wireFacesProviderCard(card) {
    const btn = card.querySelector('#ai-faces-provider-probe-btn');
    const sel = card.querySelector('#ai-faces-provider');
    if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', _runFacesProviderProbe);
    }
    if (sel && !sel.dataset.wired) {
        sel.dataset.wired = '1';
        sel.addEventListener('change', _onFacesProviderChange);
    }
}

// Dropdown short-key ↔ onnxruntime full provider name. Kept in sync with
// `faces-service/tgdl_faces/insight.py:_PROVIDER_ALIASES` so the UI and
// the sidecar agree on which probe entry maps to which dropdown option.
const _ONNX_PROVIDER_MAP = {
    cuda: 'CUDAExecutionProvider',
    coreml: 'CoreMLExecutionProvider',
    directml: 'DmlExecutionProvider',
    openvino: 'OpenVINOExecutionProvider',
    cpu: 'CPUExecutionProvider',
};

function _providerShortKey(fullName) {
    for (const [k, v] of Object.entries(_ONNX_PROVIDER_MAP)) {
        if (v === fullName) return k;
    }
    return null;
}

/**
 * Apply probe results to the provider dropdown:
 *   - disable + line-through every option whose underlying onnxruntime
 *     provider didn't verify (so the operator can't pick a broken one)
 *   - auto-select the recommended provider when the operator was on
 *     'auto', so the active choice matches the chip list at a glance
 *   - keep 'auto' always enabled (the sidecar resolves it at runtime)
 */
function _applyProbeToProviderSelect(probe) {
    const sel = $('#ai-faces-provider');
    if (!sel) return;
    const details = Array.isArray(probe?.details) ? probe.details : [];
    const detailsByShort = new Map();
    for (const d of details) {
        const shortKey = _providerShortKey(d.name);
        if (shortKey) detailsByShort.set(shortKey, d);
    }
    const recommendedShort = _providerShortKey(probe?.recommended);

    for (const opt of sel.options) {
        const v = String(opt.value || '').toLowerCase();
        if (v === 'auto') {
            opt.disabled = false;
            const recLabel = recommendedShort
                ? ` — ${i18nT('maintenance.ai.faces.providers.auto_picks', 'picks')} ${(_ONNX_PROVIDER_MAP[recommendedShort] || recommendedShort).replace('ExecutionProvider', '')}`
                : '';
            const base = i18nT('maintenance.ai.faces.providers.auto', 'Auto (best available)');
            opt.textContent = base + recLabel;
            continue;
        }
        const d = detailsByShort.get(v);
        const labelKey = `maintenance.ai.faces.providers.${v}`;
        const defaultLabel = opt.dataset._baseLabel || opt.textContent;
        if (!opt.dataset._baseLabel) opt.dataset._baseLabel = defaultLabel;
        const baseLabel = i18nT(labelKey, defaultLabel);
        if (!d) {
            opt.disabled = true;
            opt.textContent = `${baseLabel} — ${i18nT('maintenance.ai.faces.providers.unsupported', 'not available on this host')}`;
            continue;
        }
        if (d.verified) {
            opt.disabled = false;
            const star = v === recommendedShort ? '★ ' : '✓ ';
            opt.textContent = `${star}${baseLabel}`;
        } else {
            opt.disabled = true;
            opt.textContent = `✗ ${baseLabel} — ${i18nT('maintenance.ai.faces.providers.driver_missing', 'driver missing')}`;
        }
    }

    // If the operator was on 'auto', leave 'auto' selected — the sidecar
    // will pick `recommendedShort` itself. If they had a specific choice
    // that is now disabled, fall back to 'auto' so saves don't fail.
    const cur = String(sel.value || 'auto').toLowerCase();
    const curOpt = Array.from(sel.options).find((o) => String(o.value).toLowerCase() === cur);
    if (curOpt?.disabled) {
        sel.value = 'auto';
        // Persist the safe default so the next save round-trip matches.
        _onFacesProviderChange({ target: { value: 'auto' } });
    }
}

async function _runFacesProviderProbe() {
    const resultEl = $('#ai-faces-provider-probe-result');
    const btn = $('#ai-faces-provider-probe-btn');
    if (!resultEl) return;
    resultEl.textContent = i18nT('maintenance.ai.faces.providers.probing', 'Probing…');
    if (btn) btn.disabled = true;
    try {
        const r = await api.get('/api/ai/faces/provider-probe');
        const details = Array.isArray(r?.details) ? r.details : [];
        const available = Array.isArray(r?.available) ? r.available : [];
        if (!available.length) {
            resultEl.innerHTML = `<span class="text-yellow-300">${escapeHtml(
                i18nT(
                    'maintenance.ai.faces.providers.none',
                    'No working provider — falling back to CPU',
                ),
            )}</span>`;
            _applyProbeToProviderSelect(r);
            return;
        }
        // Render every candidate so the operator sees the full picture
        // (e.g. CUDA listed but unverified = driver missing; CPU
        // verified = always usable as a fallback). Verified chips get
        // the tg-blue accent; unverified ones are dimmed + struck.
        const chips = details
            .map((p) => {
                const okCls = p.verified
                    ? 'bg-tg-blue/20 text-tg-blue'
                    : 'bg-tg-bg/30 text-tg-textSecondary line-through';
                const icon = p.verified ? 'ri-check-line' : 'ri-close-line';
                return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${okCls} text-[10px] font-medium" title="${escapeHtml(
                    p.error || '',
                )}"><i class="${icon}"></i>${escapeHtml(p.name)}</span>`;
            })
            .join(' ');
        const rec = r?.recommended
            ? `<div class="mt-1.5 text-[11px]"><span class="opacity-70">${escapeHtml(
                  i18nT('maintenance.ai.faces.providers.recommended', 'Recommended:'),
              )}</span> <span class="text-tg-blue font-medium">${escapeHtml(r.recommended)}</span></div>`
            : '';
        resultEl.innerHTML = chips + rec;
        _applyProbeToProviderSelect(r);
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        resultEl.innerHTML = `<span class="text-red-300">${escapeHtml(
            i18nT('maintenance.ai.faces.providers.probe_failed', 'Probe failed:'),
        )} ${escapeHtml(msg)}</span>`;
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _onFacesProviderChange(e) {
    const v = String(e.target?.value || 'auto').toLowerCase();
    try {
        // The nested faces.providers key is the canonical home (Track I);
        // POST /api/config deep-merges so we don't overwrite siblings.
        const r = await api.post('/api/config', {
            advanced: { ai: { faces: { providers: v } } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        // Trigger a sidecar relaunch so the new provider takes effect on
        // the next scan. Best-effort — failures are surfaced as toasts
        // but the saved value still wins on the next process boot.
        try {
            await api.post('/api/ai/faces/restart', {});
        } catch (relaunchErr) {
            // Older builds may not expose the restart endpoint yet; the
            // saved value still applies on next process boot.
            console.warn('faces/restart:', relaunchErr);
        }
    } catch (err) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${err?.data?.error || err?.message || 'unknown'}`,
            'error',
        );
    }
}

function _renderCapabilityCard(cap, model, cfg) {
    const title = escapeHtml(i18nT(cap.i18n?.title, cap.defaults.title));
    const desc = escapeHtml(i18nT(cap.i18n?.desc, cap.defaults.desc));
    const enabled = cfg[cap.autoToggleKey] !== false;
    const _s = aiStore.get('status');
    const running = !!_s?.scans?.[cap.scanFeature]?.running;
    const scanned = Number(_s?.scans?.[cap.scanFeature]?.scanned) || 0;
    const total = Number(_s?.scans?.[cap.scanFeature]?.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
    const scanLabel = escapeHtml(i18nT(cap.i18n?.scanLabel, cap.defaults.scanLabel || 'Scan now'));
    const cancelLabel = escapeHtml(
        i18nT(cap.i18n?.cancelLabel, cap.defaults.cancelLabel || 'Cancel'),
    );

    // Model line — id + provider + dim. Falls back to a sidecar-aligned
    // label when the status payload hasn't been enriched yet (early boot
    // or fresh install without a scan).
    const modelId = model?.id || (model?.bundled ? 'insightface buffalo_l (Python sidecar)' : '—');
    const dim = model?.dim || (model?.bundled ? 512 : null);
    const provider = _resolveProvider(model);
    const modelLine = [escapeHtml(modelId), dim ? `${dim}-dim` : null, provider || null]
        .filter(Boolean)
        .join(' · ');

    const controlsHtml = (cap.controls || []).map((ctrl) => _renderControl(ctrl, cfg)).join('');

    // Hardware-acceleration sub-card — faces capability only. Mirrors
    // the UX of `#setting-adv-ffmpeg-hwaccel-probe` in the Build
    // thumbnails page: dropdown of provider hints + a "Run hardware
    // probe" button that actually attempts each backend on the host
    // and surfaces which ones initialise.
    const providerHtml = cap.id === 'faces' ? _renderFacesProviderCard(cfg) : '';

    return `
        <div class="ai-capability-card bg-tg-bg/30 rounded-lg p-3 border border-tg-border/30" data-cap="${escapeHtml(cap.id)}">
            <div class="flex items-start gap-3 flex-wrap">
                <i class="${escapeHtml(cap.icon || 'ri-sparkling-line')} text-tg-blue text-xl shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-tg-text text-sm font-semibold">${title}</span>
                        ${
                            !enabled
                                ? `<span class="ai-model-disabled" title="${escapeHtml(i18nT('maintenance.ai.disabled_pill_help', 'Capability is disabled.'))}">${escapeHtml(i18nT('maintenance.ai.disabled_pill', 'Disabled'))}</span>`
                                : ''
                        }
                    </div>
                    <p class="text-[11px] text-tg-textSecondary mt-0.5">${desc}</p>
                    <div class="text-[10px] text-tg-textSecondary mt-1 font-mono truncate" title="${escapeHtml(modelId)}">${modelLine}</div>
                </div>
                <div class="ai-cap-toggle tg-toggle ${enabled ? 'active' : ''}" data-cap-toggle role="switch" aria-checked="${enabled}" tabindex="0"
                    title="Enable or disable this capability"></div>
            </div>

            <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                ${controlsHtml}
            </div>

            ${providerHtml}

            <div class="mt-3 flex items-center gap-2 flex-wrap">
                <button type="button" class="tg-btn-input text-xs px-3 py-1.5" data-cap-scan ${running ? 'disabled' : ''}>
                    <i class="ri-play-fill"></i> ${scanLabel}
                </button>
                <button type="button" class="tg-btn-input-secondary text-xs px-3 py-1.5 ${running ? '' : 'hidden'}" data-cap-cancel>
                    <i class="ri-stop-fill"></i> ${cancelLabel}
                </button>
                <span class="text-[11px] text-tg-textSecondary" data-cap-progress-text>
                    ${running ? `${scanned.toLocaleString()} / ${total.toLocaleString()}` : ''}
                </span>
            </div>

            <div class="ai-cap-progress-track mt-2 h-1 rounded-full bg-tg-bg/50 overflow-hidden ${running ? '' : 'hidden'}" data-cap-progress-wrap>
                <div class="h-full bg-tg-blue transition-all" style="width: ${pct}%" data-cap-progress-bar></div>
            </div>
        </div>
    `;
}

/**
 * Render the "Hardware acceleration" sub-card embedded inside the faces
 * capability card. The dropdown's value is hydrated from
 * `config.advanced.ai.faces.providers` (defaulting to 'auto'); the
 * probe button + chip list are wired in `_wireFacesProviderCard()`.
 */
function _renderFacesProviderCard(cfg) {
    // The providers knob lives under the nested `faces` block (Track I);
    // fall back to the legacy `facesProviders` flat key for safety, then
    // 'auto' as the canonical default.
    const cur = String(cfg?.faces?.providers || cfg?.facesProviders || 'auto').toLowerCase();
    const opts = ['auto', 'cuda', 'coreml', 'directml', 'openvino', 'cpu'];
    const labelKeyMap = {
        auto: ['maintenance.ai.faces.providers.auto', 'Auto (best available)'],
        cuda: ['maintenance.ai.faces.providers.cuda', 'CUDA — NVIDIA GPU'],
        coreml: ['maintenance.ai.faces.providers.coreml', 'CoreML — Apple Silicon'],
        directml: ['maintenance.ai.faces.providers.directml', 'DirectML — Windows'],
        openvino: ['maintenance.ai.faces.providers.openvino', 'OpenVINO — Intel'],
        cpu: ['maintenance.ai.faces.providers.cpu', 'CPU only'],
    };
    const optionsHtml = opts
        .map((v) => {
            const [k, def] = labelKeyMap[v];
            const sel = v === cur ? ' selected' : '';
            return `<option value="${v}"${sel} data-i18n="${k}">${escapeHtml(i18nT(k, def))}</option>`;
        })
        .join('');
    return `
        <div class="bg-tg-bg/30 rounded-lg p-3 border border-tg-border/40 mt-3" data-faces-provider-card>
            <div class="flex items-center justify-between gap-2 flex-wrap mb-2">
                <div class="text-xs text-tg-text font-medium" data-i18n="maintenance.ai.faces.providers.probe_label">Test which inference provider this host can use</div>
                <button id="ai-faces-provider-probe-btn" type="button"
                    class="tg-btn-secondary text-xs px-3 py-1.5 inline-flex items-center justify-center gap-1.5 shrink-0">
                    <i class="ri-radar-line"></i>
                    <span data-i18n="maintenance.ai.faces.providers.probe_action">Run hardware probe</span>
                </button>
            </div>
            <div id="ai-faces-provider-probe-result"
                 class="text-[11px] text-tg-textSecondary leading-relaxed min-h-[24px] flex flex-wrap gap-1 items-center"
                 role="status" aria-live="polite"></div>
            <label for="ai-faces-provider" class="text-tg-text text-xs block mt-3 mb-1" data-i18n="maintenance.ai.faces.providers.label">Inference provider</label>
            <select id="ai-faces-provider" class="tg-input w-full text-sm">
                ${optionsHtml}
            </select>
            <p class="text-[10px] text-tg-textSecondary mt-1" data-i18n="maintenance.ai.faces.providers.help">Auto is the safe default; pick a specific backend only after a probe shows it works. Falls back to CPU if the chosen backend isn't available.</p>
        </div>
    `;
}

function _renderControl(ctrl, cfg) {
    const label = escapeHtml(i18nT(ctrl.labelKey, ctrl.labelDefault));
    // Pull current value generically — string for selects, number for
    // sliders/numbers. Fall back to ctrl.default when the config doesn't
    // yet hold the key (fresh install or just-added setting).
    const rawCur = cfg[ctrl.cfgKey];
    const numCur = Number.isFinite(rawCur) ? rawCur : ctrl.default;
    if (ctrl.type === 'slider') {
        return `
            <label class="block">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-[11px] text-tg-textSecondary">${label}</span>
                    <output class="text-[11px] text-tg-text font-mono tabular-nums" data-cap-out="${escapeHtml(ctrl.cfgKey)}">${Number(numCur).toFixed(2)}</output>
                </div>
                <input type="range" class="tg-range w-full mt-1" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}"
                    min="${ctrl.min}" max="${ctrl.max}" step="${ctrl.step}" value="${numCur}">
            </label>
        `;
    }
    if (ctrl.type === 'number') {
        return `
            <label class="block">
                <span class="text-[11px] text-tg-textSecondary">${label}</span>
                <input type="number" class="tg-input text-xs py-1 mt-1" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}"
                    min="${ctrl.min}" max="${ctrl.max}" step="${ctrl.step || 1}" value="${numCur}">
            </label>
        `;
    }
    if (ctrl.type === 'select') {
        const strCur = typeof rawCur === 'string' && rawCur ? rawCur : ctrl.default;
        const optionsHtml = (ctrl.options || [])
            .map((o) => {
                const optLabel = escapeHtml(i18nT(o.labelKey, o.labelDefault || o.value));
                const sel = o.value === strCur ? ' selected' : '';
                return `<option value="${escapeHtml(o.value)}"${sel} data-i18n="${escapeHtml(o.labelKey || '')}">${optLabel}</option>`;
            })
            .join('');
        const helpHtml = ctrl.helpKey
            ? `<p class="text-[10px] text-tg-textSecondary mt-1" data-i18n="${escapeHtml(ctrl.helpKey)}">${escapeHtml(i18nT(ctrl.helpKey, ctrl.helpDefault || ''))}</p>`
            : '';
        return `
            <label class="block sm:col-span-2">
                <span class="text-[11px] text-tg-textSecondary">${label}</span>
                <select class="tg-input text-xs py-1 mt-1 w-full" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}">
                    ${optionsHtml}
                </select>
                ${helpHtml}
            </label>
        `;
    }
    if (ctrl.type === 'custom') {
        const curVal = Array.isArray(rawCur)
            ? rawCur.join(', ')
            : String(rawCur || '').trim() || '';
        const placeholder = escapeHtml(ctrl.placeholder || '');
        return `
            <label class="block sm:col-span-2">
                <span class="text-[11px] text-tg-textSecondary">${label}</span>
                <textarea class="tg-input text-xs py-1 mt-1 w-full" rows="3" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}" placeholder="${placeholder}">${escapeHtml(curVal)}</textarea>
                <p class="text-[10px] text-tg-textSecondary mt-1">${escapeHtml(i18nT('maintenance.ai.tags.labels_help', "One tag per line or comma-separated. Leave empty to use the sidecar's built-in vocabulary."))}</p>
            </label>
        `;
    }
    return '';
}

async function _toggleCapability(toggleKey, el) {
    const cur = el.classList.contains('active');
    const next = !cur;
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', { advanced: { ai: { [toggleKey]: next } } });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(`${i18nT('common.save_failed', 'Save failed')}: ${e.message}`, 'error');
    }
}

// Map UI control cfgKey → canonical save path. The slider/number controls
// read from legacy flat keys (`cfg.facesEpsilon`, `cfg.facesMinPoints`),
// but the new nested `advanced.ai.faces.*` block is the canonical home —
// `_mergeAi` precedence is `faces.* > flat`, so a flat-key save gets
// silently overridden on the next load. Save into BOTH paths so the
// nested block actually changes.
const _CTRL_SAVE_PATHS = {
    facesEpsilon: ['facesEpsilon', 'faces', 'epsilon'],
    facesMinPoints: ['facesMinPoints', 'faces', 'minPoints'],
    facesDetectorModel: ['facesDetectorModel', 'faces', 'detectorModel'],
    includeVideos: ['includeVideos', 'faces', 'includeVideos'],
    videoFrameIntervalSec: ['videoFrameIntervalSec', 'faces', 'videoFrameIntervalSec'],
    videoMaxFrames: ['videoMaxFrames', 'faces', 'videoMaxFrames'],
};

async function _saveControl(ctrl, inp) {
    const raw = inp.value;
    let v;
    // Numeric controls (slider / number) save the parsed number; select
    // controls keep the value as a string — `_CTRL_SAVE_PATHS` carries
    // the alias mapping for both. Custom controls (textarea) save
    // comma-separated strings parsed into arrays.
    if (ctrl.type === 'custom') {
        const parts = String(raw || '')
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        v = parts.length ? parts : [];
    } else if (ctrl.type === 'select') {
        v = String(raw || '');
    } else {
        v = Number(raw);
        if (!Number.isFinite(v)) return;
    }
    try {
        // Build a payload that updates BOTH the legacy flat key AND
        // the nested faces.* path so the merger picks up the new value
        // regardless of which precedence rule fires.
        const body = { advanced: { ai: {} } };
        const map = _CTRL_SAVE_PATHS[ctrl.cfgKey];
        if (map) {
            body.advanced.ai[map[0]] = v;
            body.advanced.ai.faces = { [map[2]]: v };
        } else {
            body.advanced.ai[ctrl.cfgKey] = v;
        }
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        // For model change, also kick a sidecar relaunch so the new
        // insightface preset is loaded on the next /detect call.
        if (ctrl.cfgKey === 'facesDetectorModel') {
            try {
                await api.post('/api/ai/faces/restart', {});
            } catch (e) {
                console.warn('faces/restart on model change:', e);
            }
        }
        // Don't re-render the whole status — the slider's own output
        // already shows the live value, and a re-render would steal
        // focus from the operator's current input.
    } catch (e) {
        showToast(`${i18nT('common.save_failed', 'Save failed')}: ${e.message}`, 'error');
    }
}

async function _recluster() {
    // Phase B only — keeps the existing face embeddings, just re-runs
    // DBSCAN with the current ε / minPoints. The /api/ai/faces/recluster
    // endpoint pipelines into the same scan-runner Phase B as a full
    // scan, but skips Phase A so it lands in seconds instead of minutes.
    try {
        const r = await api.post('/api/ai/faces/recluster', {});
        if (!r.success) throw new Error(r.error || 'recluster failed');
        showToast(
            i18nT('maintenance.ai.recluster_kicked', 'Re-clustering existing faces…'),
            'success',
        );
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(
            `${i18nT('maintenance.ai.recluster_failed', 'Re-cluster failed')}: ${msg}`,
            'error',
        );
    }
}

async function _reindexFromScratch() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.reindex_confirm_title', 'Reindex from scratch?'),
        body: i18nT(
            'maintenance.ai.reindex_confirm_body',
            'This wipes EVERY face detection and EVERY person cluster, then re-scans every photo. Existing labels survive only if matching faces are detected again.',
        ),
        confirmLabel: i18nT('maintenance.ai.reindex_confirm_action', 'Reindex'),
        cancelLabel: i18nT('common.cancel', 'Cancel'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/ai/faces/reindex', {});
        if (!r.success) throw new Error(r.error || 'reindex failed');
        showToast(
            i18nT(
                'maintenance.ai.reindex_kicked',
                'Reindex started — every photo will be re-detected.',
            ),
            'success',
        );
        // Wipe local people cache + status to reflect the clean slate; the
        // scan progress events will refresh both as the run rebuilds them.
        _peopleCache = [];
        aiStore.set('selectedPerson', null);
        aiStore.set('selectedPersonName', '');
        _resetPeoplePhotosState();
        _renderPeopleGrid();
        await refreshStatus();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`${i18nT('maintenance.ai.reindex_failed', 'Reindex failed')}: ${msg}`, 'error');
    }
}

async function _backfillFaceQuality() {
    const ok = await confirmSheet({
        title: 'Backfill face quality?',
        body: 'This computes quality scores for existing face detections that are missing one. No detections are deleted and no full re-scan is run.',
        confirmLabel: 'Backfill',
        cancelLabel: i18nT('common.cancel', 'Cancel'),
        danger: false,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/ai/faces/backfill-quality', {});
        if (!r.success) throw new Error(r.error || 'backfill failed');
        showToast(`Backfill complete: ${r.updated || 0} updated`, 'success');
        await refreshStatus();
        if (aiStore.get('selectedPerson')) await _showPersonPhotos();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`Backfill failed: ${msg}`, 'error');
    } finally {
        const menu = document.getElementById('ai-more-menu');
        if (menu instanceof HTMLDetailsElement) menu.open = false;
    }
}

// ---- Scan controls --------------------------------------------------------

async function _startScan(feature) {
    // Auto-enable the AI subsystem if the operator hits Scan with the
    // master toggle off — there's no real cost (faces clustering is
    // already gated by its own per-capability toggle) and operators
    // shouldn't have to find two switches to start a scan. The master
    // toggle remains visible so it can be turned off explicitly to
    // pause auto-index on new downloads.
    if (!aiStore.get('status')?.config?.enabled) {
        try {
            await api.post('/api/config', {
                advanced: { ai: { enabled: true } },
            });
            await refreshStatus();
        } catch (e) {
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
                'error',
            );
            return;
        }
    }
    try {
        const payload = { feature };
        if (feature === 'tags') {
            const confSlider = $('#ai-tags-confidence');
            if (confSlider) {
                payload.minScore = parseFloat(confSlider.value) || 0.35;
            }
        }
        if (feature === 'ocr') {
            const langSelect = $('#ai-ocr-language');
            if (langSelect?.value) payload.language = langSelect.value;
        }
        const r = await api.post('/api/ai/scan/start', payload);
        if (r.error) {
            showToast(r.error, 'error');
            return;
        }
        showToast(i18nT('maintenance.ai.scan_started', 'Scan started'), 'success');
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

async function _cancelScan(feature) {
    try {
        await api.post('/api/ai/scan/cancel', { feature });
        showToast(i18nT('maintenance.ai.scan_cancelled', 'Scan cancelled'), 'info');
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

function _onScanProgress(feature, msg) {
    const running = !!msg.running;
    const scanned = Number(msg.scanned) || 0;
    const total = Number(msg.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;

    if (feature === 'faces') {
        const scanBtn = $('#ai-scan-btn');
        const cancelBtn = $('#ai-cancel-btn');
        if (scanBtn) scanBtn.disabled = running;
        if (cancelBtn) cancelBtn.disabled = !running;
    } else if (feature === 'tags') {
        const scanBtn = $('#ai-tags-scan-btn');
        const cancelBtn = $('#ai-tags-cancel-btn');
        if (scanBtn) {
            scanBtn.disabled = running;
            const icon = scanBtn.querySelector('i');
            if (icon)
                icon.className = running ? 'ri-loader-4-line animate-spin' : 'ri-price-tag-3-line';
            const span = scanBtn.querySelector('span[data-i18n]');
            if (span)
                span.textContent = running
                    ? i18nT('maintenance.ai.scanning_tags', 'Tagging…')
                    : i18nT('maintenance.ai.tags.scan', 'Tag all');
        }
        if (cancelBtn) cancelBtn.disabled = !running;
    } else if (feature === 'ocr') {
        const scanBtn = $('#ai-ocr-scan-btn');
        const cancelBtn = $('#ai-ocr-cancel-btn');
        if (scanBtn) scanBtn.disabled = running;
        if (cancelBtn) cancelBtn.disabled = !running;
    }

    // Shared progress bar — shows whichever scan is currently running.
    const progressWrap = $('#ai-progress');
    const progressBar = $('#ai-progress-bar');
    const progressPct = $('#ai-progress-pct');
    const progressStatus = $('#ai-progress-status');

    if (progressWrap) progressWrap.classList.toggle('hidden', !running);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPct) {
        progressPct.textContent = running
            ? total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`
                : `${scanned.toLocaleString()} processed`
            : '';
    }
    if (progressStatus && running) {
        let label;
        if (feature === 'faces') {
            label = i18nT('maintenance.ai.scanning', 'Scanning…');
        } else if (feature === 'tags') {
            label = i18nT('maintenance.ai.scanning_tags', 'Tagging photos…');
        } else if (feature === 'ocr') {
            label = i18nT('maintenance.ai.scanning_ocr', 'Extracting text…');
        }
        if (label) progressStatus.textContent = label;
    }
}

function _onScanDone(feature, msg) {
    _onScanProgress(feature, { ...msg, running: false });
    if (msg?.error) {
        showToast(`${feature}: ${msg.error}`, 'error');
    } else {
        showToast(i18nT('maintenance.ai.scan_done', 'Scan complete'), 'success');
    }
    refreshStatus();
    if (feature === 'faces') _loadPeople();
    if (feature === 'tags') _renderTagBrowser();
}

/**
 * Show merge suggestions — large unnamed clusters that likely
 * represent real people who should be named.
 */
function _renderPeopleSuggestions(people) {
    const section = $('#ai-people-suggestions');
    const list = $('#ai-people-suggestions-list');
    const count = $('#ai-people-suggestions-count');
    if (!section || !list) return;

    // Find unnamed clusters with >= 3 faces (likely real people)
    const suggestions = (Array.isArray(people) ? people : [])
        .filter((p) => !p.label && Number(p.face_count) >= 3)
        .sort((a, b) => (b.face_count || 0) - (a.face_count || 0))
        .slice(0, 8);

    if (!suggestions.length) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    if (count)
        count.textContent = `\u2014 ${suggestions.length} unnamed clusters with \u2265 3 faces`;

    list.innerHTML = suggestions
        .map(
            (p) =>
                `<button type="button" class="tg-btn-input text-[10px] px-2 py-1 inline-flex items-center gap-1 rounded-full ai-people-suggestion" data-person="${p.id}">
                    <i class="ri-user-question-line"></i>
                    <span>Person #${p.id}</span>
                    <span class="tabular-nums text-tg-textSecondary">${p.face_count} faces</span>
                </button>`,
        )
        .join('');

    list.querySelectorAll('.ai-people-suggestion').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pid = Number(btn.dataset.person);
            // Scope to the people grid so we never resolve back to this
            // suggestion chip (it also carries data-person).
            const tile = document.querySelector(`#ai-people-grid [data-person="${pid}"]`);
            if (tile) {
                tile.click();
                tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    });
}

// ---- People (face clusters) ----------------------------------------------

async function _loadPeople() {
    try {
        const r = await api.get('/api/ai/people?limit=500');
        if (!r.success) return;
        _peopleCache = Array.isArray(r.people) ? r.people : [];
        _renderPeopleGrid();
    } catch (e) {
        console.warn('ai/people:', e);
    }
}

function _renderPeopleGrid() {
    const grid = $('#ai-people-grid');
    const empty = $('#ai-people-empty');
    const count = $('#ai-people-count');
    if (!grid) return;

    // Apply filters client-side. The list is bounded at 500 by the
    // API request limit; a >500-cluster library is rare and would
    // be addressed by a server-side filter param later (paginate +
    // search).
    const q = _peopleFilter.query;
    const unlabeled = _peopleFilter.unlabeledOnly;
    const minFaces = Number(_peopleFilter.minFaces) || 1;
    const recentFirst = _peopleFilter.recentFirst === true;
    let filtered = _peopleCache.filter((p) => {
        if (unlabeled && p.label) return false;
        if (Number(p.face_count) < minFaces) return false;
        if (q) {
            const hay = `${p.label || ''} ${p.id}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
    if (recentFirst) {
        filtered = filtered.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    }

    if (count) {
        count.textContent = filtered.length
            ? `(${filtered.length}${
                  filtered.length !== _peopleCache.length ? `/${_peopleCache.length}` : ''
              })`
            : '';
    }

    if (!filtered.length) {
        grid.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');
    grid.innerHTML = filtered.map(_personTile).join('');

    // Merge suggestions — show large unnamed clusters that should be named
    _renderPeopleSuggestions(_peopleCache);
    grid.querySelectorAll('[data-person]').forEach((b) => {
        b.addEventListener('click', () => {
            aiStore.set('selectedPerson', Number(b.dataset.person));
            aiStore.set('selectedPersonName', b.dataset.name || '');
            _syncSelectedPersonTile();
            _showPersonPhotos({ scrollIntoSection: true });
        });
        b.addEventListener('dblclick', (e) => {
            if (e.target.closest('.ai-person-name')) {
                e.preventDefault();
                e.stopPropagation();
                aiStore.set('selectedPerson', Number(b.dataset.person));
                aiStore.set('selectedPersonName', b.dataset.name || '');
                _renameSelectedPerson();
            }
        });
    });
}

function _syncSelectedPersonTile() {
    document.querySelectorAll('#ai-people-grid [data-person]').forEach((tile) => {
        const selected = Number(tile.dataset.person) === Number(aiStore.get('selectedPerson'));
        tile.classList.toggle('bg-tg-blue/10', selected);
        tile.classList.toggle('ring-2', selected);
        tile.classList.toggle('ring-tg-blue/60', selected);
        tile.classList.toggle('hover:bg-tg-bg/50', !selected);
        tile.setAttribute('aria-pressed', String(selected));
    });
}

function _personTile(p) {
    const isUnclassified = p.id === -1 || p.noise === true;
    const name = isUnclassified
        ? i18nT('maintenance.ai.person_unclassified', 'Unclassified')
        : p.label || `${i18nT('maintenance.ai.person_default', 'Person')} #${p.id}`;
    const faceCover = !isUnclassified && p.id > 0 ? `/api/ai/person/${p.id}/face?w=160` : '';
    const fallbackCover = p.cover_download_id ? `/api/thumbs/${p.cover_download_id}?w=160` : '';
    const faceCount = Number(p.face_count) || 0;
    const safeName = escapeHtml(name);
    const dimCls = !p.label && !isUnclassified ? 'opacity-50' : '';
    const selectedCls =
        Number(p.id) === Number(aiStore.get('selectedPerson'))
            ? 'bg-tg-blue/10 ring-2 ring-tg-blue/60'
            : 'hover:bg-tg-bg/50';
    let imgHtml;
    if (faceCover) {
        const fb = fallbackCover
            ? `this.onerror=null;this.src='${fallbackCover}'`
            : `this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-xl text-tg-textSecondary/40\\'></i>'`;
        imgHtml = `<img src="${faceCover}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover" onerror="${fb}">`;
    } else if (fallbackCover) {
        imgHtml = `<img src="${fallbackCover}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover">`;
    } else {
        imgHtml = `<i class="ri-user-line text-xl text-tg-textSecondary/40"></i>`;
    }

    const updatedStr = p.updated_at ? _timeAgo(p.updated_at) : '';

    return `<button type="button" data-person="${p.id}" data-name="${safeName}"
        class="flex flex-col items-center gap-1.5 px-1 py-2 rounded-xl active:scale-95 transition-all group text-center select-none ${selectedCls} ${dimCls}"
        aria-pressed="${Number(p.id) === Number(aiStore.get('selectedPerson')) ? 'true' : 'false'}"
        title="${safeName} · ${faceCount} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}${updatedStr ? ' · ' + updatedStr : ''}">
        <div class="w-[60px] h-[60px] rounded-full overflow-hidden flex items-center justify-center bg-tg-bg/40 flex-shrink-0">
            ${imgHtml}
        </div>
        <div class="w-full min-w-0 space-y-0.5">
            <div class="ai-person-name text-[10.5px] font-medium text-tg-text leading-tight line-clamp-2 break-words px-0.5">${safeName}</div>
            <div class="text-[10px] text-tg-textSecondary tabular-nums">
                ${faceCount}${updatedStr ? ` · ${updatedStr}` : ''}
            </div>
        </div>
    </button>`;
}

async function _showPersonPhotos({ scrollIntoSection = false } = {}) {
    if (!aiStore.get('selectedPerson')) return;
    const section = $('#ai-people-photos');
    section?.classList.remove('hidden');
    if (scrollIntoSection && section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const nameEl = $('#ai-people-photos-name');
    if (nameEl) nameEl.textContent = aiStore.get('selectedPersonName');
    _peoplePhotosPage = 1;
    _peoplePhotosTotal = 0;
    _peoplePhotosTotalPages = 1;
    _peoplePhotoRows = [];
    _syncPeoplePhotosPager();
    await _loadPersonPhotosPage();
}

async function _loadPersonPhotosPage() {
    const grid = $('#ai-people-photos-grid');
    if (!grid || !aiStore.get('selectedPerson')) return;
    grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
    try {
        const offset = Math.max(0, (_peoplePhotosPage - 1) * _peoplePhotosLimit);
        const r = await api.get(
            `/api/ai/people/${aiStore.get('selectedPerson')}/photos?limit=${_peoplePhotosLimit}&offset=${offset}`,
        );
        if (!r.success) throw new Error(r.error || 'load failed');
        const files = r.files || [];
        _peoplePhotoRows = files;
        _peoplePhotosTotal = Number(r.total) || files.length;
        _peoplePhotosTotalPages = Math.max(1, Math.ceil(_peoplePhotosTotal / _peoplePhotosLimit));
        if (!files.length) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.no_photos', 'No photos in this cluster.'))}</div>`;
            _syncPeoplePhotosPager();
            return;
        }
        grid.innerHTML = files.map((row, i) => _photoTile(row, i)).join('');
        _wirePeoplePhotoClicks();
        _syncPeoplePhotosPager();
    } catch (e) {
        _peoplePhotoRows = [];
        _syncPeoplePhotosPager();
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-red-300 py-8">${escapeHtml(e.message)}</div>`;
    }
}

function _photoTile(row, index) {
    const id = row.download_id || row.id;
    const faceId = row.face_id || '';
    const name = escapeHtml(row.file_name || `#${id}`);
    const faceCrop = faceId ? `/api/ai/faces/${faceId}/crop?w=160` : '';
    const thumbFallback = `/api/thumbs/${id}?w=320`;
    const q = Number(row.face_quality);
    const qualityScore = Number.isFinite(q) ? Math.round(Math.max(0, Math.min(1, q)) * 100) : null;

    // Compute face bbox position within the crop image.
    // The crop endpoint adds 40% padding around the face (pad=0.4) then
    // resizes the padded region to a square with fit:'cover'. Given fw/fh
    // we can compute exactly where the face falls in the output image.
    let bboxHtml = '';
    const fw = Number(row.face_w) || 0;
    const fh = Number(row.face_h) || 0;
    if (fw > 0 && fh > 0) {
        const pad = 0.4;
        const cropW = fw * (1 + 2 * pad);
        const cropH = fh * (1 + 2 * pad);
        let leftPct, topPct, wPct, hPct;
        if (cropW >= cropH) {
            // Wide/square face: cover fills height, crops width symmetrically.
            const horzOffset = (cropW - cropH) / 2;
            leftPct = ((fw * pad - horzOffset) / cropH) * 100;
            topPct = ((fh * pad) / cropH) * 100;
            wPct = (fw / cropH) * 100;
            hPct = (fh / cropH) * 100;
        } else {
            // Tall face: cover fills width, crops height symmetrically.
            const vertOffset = (cropH - cropW) / 2;
            leftPct = ((fw * pad) / cropW) * 100;
            topPct = ((fh * pad - vertOffset) / cropW) * 100;
            wPct = (fw / cropW) * 100;
            hPct = (fh / cropW) * 100;
        }
        bboxHtml = `<span class="absolute pointer-events-none border border-tg-blue/70 rounded-[1px] opacity-0 group-hover:opacity-100 transition-opacity"
            style="left:${leftPct.toFixed(1)}%;top:${topPct.toFixed(1)}%;width:${wPct.toFixed(1)}%;height:${hPct.toFixed(1)}%"></span>`;
    }

    return `
        <button type="button" data-people-photo-index="${index}" data-face-id="${escapeHtml(String(faceId))}"
                class="nsfw-tile group relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 focus:outline-none focus:ring-2 focus:ring-tg-blue">
            <img src="${faceCrop || thumbFallback}" alt="${name}" loading="lazy" decoding="async"
                ${faceCrop ? `onerror="this.onerror=null;this.src='${thumbFallback}'"` : ''}
                class="absolute inset-0 w-full h-full object-cover">
            ${
                qualityScore == null
                    ? ''
                    : `<span class="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/65 text-white tabular-nums">Q${qualityScore}</span>`
            }
            ${bboxHtml}
            <span class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition flex items-end p-2 pointer-events-none">
                <span class="text-[11px] text-white truncate w-full text-left">${name}</span>
            </span>
        </button>
    `;
}

function _wirePeoplePhotoClicks() {
    const grid = $('#ai-people-photos-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-people-photo-index]').forEach((tile) => {
        if (tile.dataset.wired) return;
        tile.dataset.wired = '1';
        tile.addEventListener('click', () => {
            const idx = Number(tile.dataset.peoplePhotoIndex);
            if (Number.isFinite(idx)) _openPeoplePhotoLightbox(idx);
        });
    });
}

function _peoplePhotoRowToViewerFile(row) {
    const sizeMb = row.file_size ? (row.file_size / (1024 * 1024)).toFixed(1) : '0';
    return {
        fullPath: row.file_path || '',
        type: row.file_type === 'video' ? 'videos' : 'images',
        name: row.file_name || '',
        sizeFormatted: `${sizeMb} MB`,
        modified: row.created_at || Date.now(),
        _peoplePhotoRow: row,
    };
}

function _peoplePhotoMetaFor(file) {
    const row = file?._peoplePhotoRow;
    const q = Number(row?.face_quality);
    const qualityScore = Number.isFinite(q) ? Math.round(Math.max(0, Math.min(1, q)) * 100) : null;
    return `<span class="inline-flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-tg-blue"></span>
        <span>${escapeHtml(aiStore.get('selectedPersonName') || 'Person')}</span>
        ${qualityScore == null ? '' : `<span class="font-mono tabular-nums">Q${qualityScore}</span>`}
    </span>`;
}

function _openPeoplePhotoLightbox(startIndex) {
    if (!_peoplePhotoRows.length) return;
    openMediaViewerForReview(_peoplePhotoRows.map(_peoplePhotoRowToViewerFile), startIndex, {
        actions: [],
        metaRender: _peoplePhotoMetaFor,
    });
}

function _syncPeoplePhotosPager() {
    const pageInfo = $('#ai-people-photos-page-info');
    const prevBtn = $('#ai-people-photos-prev-btn');
    const nextBtn = $('#ai-people-photos-next-btn');
    const hasPerson = !!aiStore.get('selectedPerson');
    if (pageInfo) {
        pageInfo.textContent = hasPerson
            ? `Page ${_peoplePhotosPage} / ${_peoplePhotosTotalPages} · ${_peoplePhotosTotal.toLocaleString()} photos`
            : '';
    }
    if (prevBtn) prevBtn.disabled = !hasPerson || _peoplePhotosPage <= 1;
    if (nextBtn) nextBtn.disabled = !hasPerson || _peoplePhotosPage >= _peoplePhotosTotalPages;
}

function _resetPeoplePhotosState() {
    _peoplePhotosPage = 1;
    _peoplePhotosTotal = 0;
    _peoplePhotosTotalPages = 1;
    _peoplePhotoRows = [];
    _syncPeoplePhotosPager();
}

function _wirePeopleGridKeyboard() {
    const grid = document.getElementById('ai-people-grid');
    if (!grid || grid.dataset.kbWired) return;
    grid.dataset.kbWired = '1';

    grid.addEventListener('keydown', async (e) => {
        const tiles = Array.from(grid.querySelectorAll('[data-person]'));
        if (!tiles.length) return;

        const focused = document.activeElement;
        const idx = tiles.indexOf(focused);

        if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            if (idx === -1) return;
            e.preventDefault();
            // Compute column count from tile y-positions.
            const firstY = tiles[0].getBoundingClientRect().top;
            const cols = Math.max(
                1,
                tiles.filter((t) => t.getBoundingClientRect().top === firstY).length,
            );
            let next = idx;
            if (e.key === 'ArrowRight') next = Math.min(idx + 1, tiles.length - 1);
            else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0);
            else if (e.key === 'ArrowDown') next = Math.min(idx + cols, tiles.length - 1);
            else next = Math.max(idx - cols, 0);
            tiles[next]?.focus();
            return;
        }

        // Enter or N → rename focused person, then advance to next unlabeled.
        if ((e.key === 'Enter' || e.key === 'n' || e.key === 'N') && idx !== -1) {
            e.preventDefault();
            const pid = Number(focused.dataset.person);
            if (!pid || pid === -1) return;
            aiStore.set('selectedPerson', pid);
            aiStore.set('selectedPersonName', focused.dataset.name || '');
            _syncSelectedPersonTile();
            const saved = await _renameSelectedPerson();
            if (saved) _focusNextUnlabeled(pid);
        }
    });
}

function _focusNextUnlabeled(afterPersonId) {
    const grid = document.getElementById('ai-people-grid');
    if (!grid) return;
    const tiles = Array.from(grid.querySelectorAll('[data-person]'));
    const startIdx = tiles.findIndex((t) => Number(t.dataset.person) === afterPersonId);
    const search = (from, to) => {
        for (let i = from; i < to; i++) {
            const pid = Number(tiles[i].dataset.person);
            const person = _peopleCache.find((p) => p.id === pid);
            if (person && !person.label && pid > 0) {
                tiles[i].focus();
                return true;
            }
        }
        return false;
    };
    // Forward from the tile after the one just labeled, then wrap.
    if (!search(startIdx + 1, tiles.length)) search(0, startIdx);
}

async function _renameSelectedPerson() {
    if (!aiStore.get('selectedPerson')) return false;
    const label = await promptSheet({
        title: i18nT('maintenance.ai.person_rename', 'Rename'),
        message: i18nT('maintenance.ai.rename_prompt', 'Name this person:'),
        defaultValue: aiStore.get('selectedPersonName') || '',
        confirmLabel: i18nT('common.save', 'Save'),
    });
    if (label == null) return false;
    try {
        const r = await api.patch(`/api/ai/people/${aiStore.get('selectedPerson')}`, { label });
        if (!r.success) throw new Error(r.error || 'rename failed');
        aiStore.set('selectedPersonName', label);
        showToast(i18nT('common.saved', 'Saved'), 'success');
        const nameEl = $('#ai-people-photos-name');
        if (nameEl) nameEl.textContent = label;
        await _loadPeople();
        return true;
    } catch (e) {
        showToast(e.message, 'error');
        return false;
    }
}

// Renders a single person tile for the merge picker sheet.
// Separate from _personTile so it doesn't read selectedPerson from the store.
function _mergePickerTile(p, selectedId) {
    const isUnclassified = p.id === -1 || p.noise === true;
    const name = isUnclassified
        ? i18nT('maintenance.ai.person_unclassified', 'Unclassified')
        : p.label || `${i18nT('maintenance.ai.person_default', 'Person')} #${p.id}`;
    const faceCover = !isUnclassified && p.id > 0 ? `/api/ai/person/${p.id}/face?w=160` : '';
    const fallbackCover = p.cover_download_id ? `/api/thumbs/${p.cover_download_id}?w=160` : '';
    const faceCount = Number(p.face_count) || 0;
    const safeName = escapeHtml(name);
    const sel = Number(p.id) === Number(selectedId);
    const selCls = sel ? 'bg-tg-blue/10 ring-2 ring-tg-blue/60' : 'hover:bg-tg-bg/50';
    let imgHtml;
    if (faceCover) {
        const fb = fallbackCover
            ? `this.onerror=null;this.src='${fallbackCover}'`
            : `this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-xl text-tg-textSecondary/40\\'></i>'`;
        imgHtml = `<img src="${faceCover}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover" onerror="${fb}">`;
    } else if (fallbackCover) {
        imgHtml = `<img src="${fallbackCover}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover">`;
    } else {
        imgHtml = `<i class="ri-user-line text-xl text-tg-textSecondary/40"></i>`;
    }
    return `<button type="button" data-candidate="${p.id}" aria-pressed="${sel}"
        class="flex flex-col items-center gap-1 px-1 py-2 rounded-xl active:scale-95 transition-all text-center select-none ${selCls}"
        title="${safeName} · ${faceCount} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}">
        <div class="w-[52px] h-[52px] rounded-full overflow-hidden flex items-center justify-center bg-tg-bg/40 flex-shrink-0">
            ${imgHtml}
        </div>
        <div class="text-[10.5px] font-medium text-tg-text leading-tight line-clamp-2 break-words px-0.5 w-full">${safeName}</div>
        <div class="text-[10px] text-tg-textSecondary tabular-nums">${faceCount}</div>
    </button>`;
}

// Opens a grid-picker sheet for selecting a merge target.
// Resolves with the chosen person id, or null if cancelled.
function _openMergePickerSheet(candidates) {
    return new Promise((resolve) => {
        let pickedId = null;
        const sourceName =
            aiStore.get('selectedPersonName') ||
            `${i18nT('maintenance.ai.person_default', 'Person')} #${aiStore.get('selectedPerson')}`;

        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <p class="text-xs text-tg-textSecondary mb-3">${escapeHtml(
                i18nTf(
                    'maintenance.ai.merge_picker_desc',
                    { name: sourceName },
                    `All faces from "${sourceName}" will move to the selected cluster. This cluster is then deleted.`,
                ),
            )}</p>
            <input id="merge-picker-search" type="search"
                class="tg-input w-full text-xs mb-3"
                placeholder="${escapeHtml(i18nT('maintenance.ai.people.search_placeholder', 'Search names or IDs…'))}"
                autocomplete="off" spellcheck="false">
            <div id="merge-picker-grid"
                 class="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-[50vh] overflow-y-auto pr-0.5"></div>
            <div class="mt-4 flex items-center justify-end gap-2">
                <button id="merge-picker-cancel" type="button"
                    class="tg-btn-secondary text-sm px-4 py-2">
                    ${escapeHtml(i18nT('common.cancel', 'Cancel'))}
                </button>
                <button id="merge-picker-confirm" type="button" disabled
                    class="tg-btn text-sm px-4 py-2 inline-flex items-center gap-1.5">
                    <i class="ri-git-merge-line"></i>
                    <span>${escapeHtml(i18nT('maintenance.ai.person_merge', 'Merge'))}</span>
                </button>
            </div>`;

        function renderGrid(filter) {
            const grid = wrap.querySelector('#merge-picker-grid');
            if (!grid) return;
            const q = (filter || '').trim().toLowerCase();
            const visible = q
                ? candidates.filter((p) => `${p.label || ''} ${p.id}`.toLowerCase().includes(q))
                : candidates;
            grid.innerHTML = visible.length
                ? visible.map((p) => _mergePickerTile(p, pickedId)).join('')
                : `<p class="col-span-full text-xs text-tg-textSecondary text-center py-6">${escapeHtml(i18nT('common.no_results', 'No results'))}</p>`;
            grid.querySelectorAll('[data-candidate]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    pickedId = Number(btn.dataset.candidate);
                    // Re-render so selected ring moves to the new pick.
                    renderGrid(wrap.querySelector('#merge-picker-search')?.value);
                    const confirmBtn = wrap.querySelector('#merge-picker-confirm');
                    const picked = candidates.find((c) => c.id === pickedId);
                    const targetName =
                        picked?.label ||
                        `${i18nT('maintenance.ai.person_default', 'Person')} #${pickedId}`;
                    if (confirmBtn) {
                        confirmBtn.disabled = false;
                        const span = confirmBtn.querySelector('span');
                        if (span)
                            span.textContent = i18nTf(
                                'maintenance.ai.merge_into',
                                { name: targetName },
                                `Merge into ${targetName}`,
                            );
                    }
                });
            });
        }

        renderGrid('');

        const sheet = openSheet({
            title: i18nT('maintenance.ai.person_merge', 'Merge into…'),
            content: wrap,
            size: 'lg',
            onClose: () => resolve(null),
        });

        wrap.querySelector('#merge-picker-search')?.addEventListener('input', (e) =>
            renderGrid(e.target.value),
        );
        wrap.querySelector('#merge-picker-cancel')?.addEventListener('click', () => sheet.close());
        wrap.querySelector('#merge-picker-confirm')?.addEventListener('click', () => {
            if (pickedId == null) return;
            resolve(pickedId);
            sheet.close();
        });
    });
}

async function _mergeSelectedPerson() {
    if (!aiStore.get('selectedPerson')) return;
    // Exclude the current cluster and noise/unclassified from the picker.
    const candidates = _peopleCache.filter(
        (p) => p.id !== aiStore.get('selectedPerson') && p.id !== -1 && !p.noise,
    );
    if (!candidates.length) {
        showToast(
            i18nT('maintenance.ai.merge_no_other', 'No other clusters to merge with.'),
            'info',
        );
        return;
    }

    const targetId = await _openMergePickerSheet(candidates);
    if (targetId == null) return;

    const targetPerson = candidates.find((p) => p.id === targetId);
    const sourceName =
        aiStore.get('selectedPersonName') ||
        `${i18nT('maintenance.ai.person_default', 'Person')} #${aiStore.get('selectedPerson')}`;
    const targetName =
        targetPerson?.label || `${i18nT('maintenance.ai.person_default', 'Person')} #${targetId}`;
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_merge', 'Merge'),
        message: i18nTf(
            'maintenance.ai.merge_confirm_named',
            { source: sourceName, target: targetName },
            `Move all faces from "${sourceName}" into "${targetName}". This cluster is deleted. Cannot be undone.`,
        ),
        destructive: true,
        confirmText: i18nT('maintenance.ai.person_merge', 'Merge'),
    });
    if (!ok) return;

    try {
        const res = await api.post(`/api/ai/people/${targetId}/merge`, {
            otherId: aiStore.get('selectedPerson'),
        });
        if (!res.success) throw new Error(res.error || 'merge failed');
        showToast(
            `${i18nT('maintenance.ai.merge_done', 'Merged')} — ${res.moved || 0} ${i18nT('maintenance.ai.faces_short', 'faces')}`,
            'success',
        );
        aiStore.set('selectedPerson', null);
        aiStore.set('selectedPersonName', '');
        _resetPeoplePhotosState();
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// Renders a face tile for the split picker (always initially unselected).
// State changes are applied in-place via _updateSplitTileState() so images
// don't reload on every toggle.
function _splitPickerTile(row) {
    const faceId = String(row.face_id || '');
    const downloadId = row.download_id || row.id;
    const name = escapeHtml(row.file_name || `#${downloadId}`);
    const faceCrop = faceId ? `/api/ai/faces/${escapeHtml(faceId)}/crop?w=160` : '';
    const thumbFallback = `/api/thumbs/${downloadId}?w=320`;
    const q = Number(row.face_quality);
    const qualityScore = Number.isFinite(q) ? Math.round(Math.max(0, Math.min(1, q)) * 100) : null;
    return `<button type="button" data-split-face="${escapeHtml(faceId)}" aria-pressed="false"
        class="relative aspect-square rounded-lg overflow-hidden bg-tg-bg/40
               ring-1 ring-tg-border/30 hover:ring-tg-blue/50 transition-all"
        title="${name}">
        <img src="${faceCrop || thumbFallback}" alt="${name}" loading="lazy" decoding="async"
            ${faceCrop ? `onerror="this.onerror=null;this.src='${thumbFallback}'"` : ''}
            class="absolute inset-0 w-full h-full object-cover">
        ${qualityScore != null ? `<span class="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-black/70 text-white tabular-nums">Q${qualityScore}</span>` : ''}
    </button>`;
}

// Toggle the visual ring/overlay on a split tile without re-rendering it.
function _updateSplitTileState(btn, isSplit) {
    btn.classList.toggle('ring-2', isSplit);
    btn.classList.toggle('ring-tg-blue', isSplit);
    btn.classList.toggle('scale-[0.96]', isSplit);
    btn.classList.toggle('ring-1', !isSplit);
    btn.classList.toggle('ring-tg-border/30', !isSplit);
    btn.setAttribute('aria-pressed', String(isSplit));
    let overlay = btn.querySelector('.split-indicator');
    if (isSplit && !overlay) {
        overlay = document.createElement('span');
        overlay.className =
            'split-indicator absolute bottom-0 inset-x-0 py-0.5 bg-tg-blue/75 flex items-center justify-center pointer-events-none';
        overlay.innerHTML = '<i class="ri-arrow-right-up-line text-white text-xs"></i>';
        btn.appendChild(overlay);
    } else if (!isSplit && overlay) {
        overlay.remove();
    }
}

// Opens a click-to-mark sheet for visually selecting which faces to peel
// into a new cluster. Resolves with { faceIds, label } or null on cancel.
function _openSplitPickerSheet(allFaces, sourceName) {
    return new Promise((resolve) => {
        const splitSet = new Set(); // face_id strings marked for the new cluster

        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <p class="text-xs text-tg-textSecondary mb-3">${escapeHtml(
                i18nTf(
                    'maintenance.ai.split_picker_desc',
                    { name: sourceName },
                    `Click faces to mark them for the new cluster. Unmarked faces stay in "${sourceName}".`,
                ),
            )}</p>
            <div class="mb-3">
                <label class="text-xs text-tg-text block mb-1" for="split-label-input">
                    ${escapeHtml(i18nT('maintenance.ai.split_label_prompt', 'New cluster name'))}
                    <span class="text-tg-textSecondary text-[10.5px]">(${escapeHtml(i18nT('common.optional', 'optional'))})</span>
                </label>
                <input id="split-label-input" type="text" class="tg-input w-full text-sm"
                    placeholder="${escapeHtml(i18nT('maintenance.ai.person_default', 'Person'))}"
                    autocomplete="off">
            </div>
            <div class="flex items-center justify-between gap-2 mb-2">
                <div class="text-xs text-tg-textSecondary">
                    <span id="split-keep-count" class="font-medium text-tg-text">${allFaces.length}</span>
                    ${escapeHtml(i18nT('maintenance.ai.split_keeping', 'keeping'))}
                    &nbsp;·&nbsp;
                    <span id="split-off-count" class="font-medium text-tg-blue">0</span>
                    ${escapeHtml(i18nT('maintenance.ai.split_splitting_off', 'splitting off'))}
                </div>
                <button id="split-clear-btn" type="button"
                    class="hidden text-[11px] text-tg-textSecondary hover:text-tg-text">
                    ${escapeHtml(i18nT('common.clear_selection', 'Clear selection'))}
                </button>
            </div>
            <div id="split-picker-grid"
                 class="grid grid-cols-4 sm:grid-cols-6 gap-1.5 max-h-[50vh] overflow-y-auto pr-0.5 mb-1"></div>
            <div class="mt-4 flex items-center justify-end gap-2">
                <button id="split-picker-cancel" type="button"
                    class="tg-btn-secondary text-sm px-4 py-2">
                    ${escapeHtml(i18nT('common.cancel', 'Cancel'))}
                </button>
                <button id="split-picker-confirm" type="button" disabled
                    class="tg-btn text-sm px-4 py-2 inline-flex items-center gap-1.5">
                    <i class="ri-scissors-cut-line"></i>
                    <span>${escapeHtml(i18nT('maintenance.ai.person_split', 'Split'))}</span>
                </button>
            </div>`;

        // Render all tiles once; subsequent clicks update state in-place.
        const grid = wrap.querySelector('#split-picker-grid');
        if (grid) {
            grid.innerHTML = allFaces.map(_splitPickerTile).join('');
            grid.querySelectorAll('[data-split-face]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const fid = btn.dataset.splitFace;
                    if (!fid) return;
                    const nowSplit = !splitSet.has(fid);
                    if (nowSplit) splitSet.add(fid);
                    else splitSet.delete(fid);
                    _updateSplitTileState(btn, nowSplit);
                    updateCounts();
                });
            });
        }

        function updateCounts() {
            const n = splitSet.size;
            const keepEl = wrap.querySelector('#split-keep-count');
            const offEl = wrap.querySelector('#split-off-count');
            const clearBtn = wrap.querySelector('#split-clear-btn');
            const confirmBtn = wrap.querySelector('#split-picker-confirm');
            const confirmSpan = confirmBtn?.querySelector('span');
            if (keepEl) keepEl.textContent = String(allFaces.length - n);
            if (offEl) offEl.textContent = String(n);
            if (clearBtn) clearBtn.classList.toggle('hidden', n === 0);
            if (confirmBtn) {
                confirmBtn.disabled = n === 0;
                if (confirmSpan) {
                    confirmSpan.textContent =
                        n > 0
                            ? i18nTf(
                                  'maintenance.ai.split_confirm_label',
                                  { n },
                                  `Split off ${n} face${n === 1 ? '' : 's'}`,
                              )
                            : i18nT('maintenance.ai.person_split', 'Split');
                }
            }
        }

        const sheet = openSheet({
            title: i18nTf(
                'maintenance.ai.split_sheet_title',
                { name: sourceName },
                `Split: ${sourceName}`,
            ),
            content: wrap,
            size: 'lg',
            onClose: () => resolve(null),
        });

        wrap.querySelector('#split-clear-btn')?.addEventListener('click', () => {
            splitSet.clear();
            wrap.querySelectorAll('[data-split-face]').forEach((btn) =>
                _updateSplitTileState(btn, false),
            );
            updateCounts();
        });
        wrap.querySelector('#split-picker-cancel')?.addEventListener('click', () => sheet.close());
        wrap.querySelector('#split-picker-confirm')?.addEventListener('click', () => {
            if (!splitSet.size) return;
            const faceIds = [...splitSet].map(Number).filter((n) => n > 0);
            const label = wrap.querySelector('#split-label-input')?.value?.trim() || '';
            resolve({ faceIds, label: label || undefined });
            sheet.close();
        });
    });
}

async function _splitSelectedPerson() {
    if (!aiStore.get('selectedPerson')) return;
    const sourceName =
        aiStore.get('selectedPersonName') ||
        `${i18nT('maintenance.ai.person_default', 'Person')} #${aiStore.get('selectedPerson')}`;

    // Fetch all faces for this cluster in one shot so the full grid is visible.
    let allFaces;
    try {
        const r = await api.get(
            `/api/ai/people/${aiStore.get('selectedPerson')}/photos?limit=500&offset=0`,
        );
        if (!r.success) throw new Error(r.error || 'load failed');
        allFaces = Array.isArray(r.files) ? r.files : [];
    } catch (e) {
        showToast(e.message, 'error');
        return;
    }

    if (allFaces.length < 2) {
        showToast(i18nT('maintenance.ai.split_too_few', 'Need at least 2 faces to split.'), 'info');
        return;
    }

    const result = await _openSplitPickerSheet(allFaces, sourceName);
    if (!result) return;
    const { faceIds, label } = result;

    try {
        const res = await api.post(`/api/ai/people/${aiStore.get('selectedPerson')}/split`, {
            faceIds,
            newLabel: label || undefined,
        });
        if (!res.success) throw new Error(res.error || 'split failed');
        showToast(
            `${i18nT('maintenance.ai.split_done', 'Split complete')} — ${faceIds.length} ${i18nT('maintenance.ai.faces_short', 'faces')}`,
            'success',
        );
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _deleteSelectedPerson() {
    if (!aiStore.get('selectedPerson')) return;
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_delete', 'Delete'),
        message: i18nT(
            'maintenance.ai.delete_confirm',
            'Delete this cluster? Faces will become unassigned.',
        ),
        destructive: true,
        confirmText: i18nT('maintenance.ai.person_delete', 'Delete'),
    });
    if (!ok) return;
    try {
        const r = await api.delete(`/api/ai/people/${aiStore.get('selectedPerson')}`);
        if (!r.success) throw new Error(r.error || 'delete failed');
        showToast(i18nT('common.deleted', 'Deleted'), 'success');
        aiStore.set('selectedPerson', null);
        aiStore.set('selectedPersonName', '');
        _resetPeoplePhotosState();
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ---- Doctor (system-health card) -----------------------------------------

async function _refreshDoctor() {
    const el = $('#ai-doctor-list');
    const sumEl = $('#ai-doctor-summary');
    if (!el) return;
    el.innerHTML = `<div class="text-tg-textSecondary text-xs py-2">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
    if (sumEl) sumEl.textContent = `· ${i18nT('common.loading', 'Loading…')}`;
    try {
        const r = await api.get('/api/ai/doctor');
        if (!r.success) throw new Error(r.error || 'doctor failed');
        const checks = Array.isArray(r.checks) ? r.checks : [];
        _doctorScanReady = checks.every((c) => c.status !== 'fail');
        // Summary chip — colour reflects the worst-state check.
        const fails = checks.filter((c) => c.status === 'fail').length;
        const warns = checks.filter((c) => c.status === 'warn').length;
        // Auto-expand when checks are failing so the operator sees diagnostics immediately.
        if (fails > 0) document.getElementById('ai-doctor-card')?.setAttribute('open', '');
        if (sumEl) {
            let text;
            if (fails) {
                text = `· ${fails} ${i18nT('maintenance.ai.doctor_failing', 'failing')}`;
                sumEl.className = 'text-[10.5px] text-red-300';
            } else if (warns) {
                text = `· ${warns} ${i18nT('maintenance.ai.doctor_warning', 'warning')}`;
                sumEl.className = 'text-[10.5px] text-yellow-300';
            } else {
                text = `· ${i18nT('maintenance.ai.doctor_all_ok', 'all checks ok')}`;
                sumEl.className = 'text-[10.5px] text-green-300';
            }
            sumEl.textContent = text;
        }
        const iconFor = (s) => (s === 'ok' ? '✓' : s === 'warn' ? '⚠' : s === 'fail' ? '✗' : 'ℹ');
        el.innerHTML = checks
            .map(
                (c) => `
            <div class="ai-doctor-row" title="${escapeHtml(c.detail || '')}">
                <span class="ai-doctor-icon ai-doctor-${escapeHtml(c.status || 'info')}">${iconFor(c.status)}</span>
                <span class="ai-doctor-label">${escapeHtml(c.label || c.id || '')}</span>
                <span class="ai-doctor-detail">${escapeHtml(c.detail || '')}</span>
            </div>`,
            )
            .join('');
        // Re-apply control enable/disable state using the latest doctor gate.
        _renderStatus(aiStore.get('status') || {});
    } catch (e) {
        _doctorScanReady = false;
        el.innerHTML = `<div class="text-red-300 text-xs py-2">${escapeHtml(e.message)}</div>`;
        if (sumEl) {
            sumEl.className = 'text-[10.5px] text-red-300';
            sumEl.textContent = `· ${i18nT('common.error', 'Error')}`;
        }
        _renderStatus(aiStore.get('status') || {});
    }
}
