// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-nsfw.js — the NSFW review page: the
// stats strip, the paginated tile list and its filters (tier, media kind,
// whitelisted), URL-hash state round-tripping, the scan toggle, the three
// bulk actions and their confirm paths, the lost-event watchdog, and the
// model/blocklist panels.
//
// Only `init()` is exported; everything else is reached through the DOM.
// Same harness as the other P4 pages, with settings.js and viewer.js mocked
// (both are P4 targets themselves).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../src/web/public/js/api.js', () => ({ api }));

const wsHandlers = new Map();
const ws = {
    on: vi.fn((type, fn) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, []);
        wsHandlers.get(type).push(fn);
    }),
};
vi.mock('../src/web/public/js/ws.js', () => ({ ws }));

let i18nDict = {};
const i18nT = vi.fn((key, fallback) => i18nDict[key] || fallback || key);
const i18nTf = vi.fn((key, vars, fallback) => {
    const tpl = i18nDict[key] || fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
});
vi.mock('../src/web/public/js/i18n.js', () => ({ t: i18nT, tf: i18nTf }));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

let confirmAnswer = true;
const confirmSheet = vi.fn(async () => confirmAnswer);
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet, openSheet: vi.fn() }));

vi.mock('../src/web/public/js/settings.js', () => ({
    loadAdvanced: vi.fn(),
    setupAutoSave: vi.fn(),
}));
const openMediaViewerForReview = vi.fn();
vi.mock('../src/web/public/js/viewer.js', () => ({ openMediaViewerForReview }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="page-maintenance-nsfw">
        <div id="nsfw-stat-scanned"></div>
        <div id="nsfw-stat-whitelisted"></div>
        <div id="nsfw-stat-borderline"></div>
        <div id="nsfw-stat-last"></div>
        <div id="nsfw-threshold-value"></div>
        <div id="nsfw-concurrency-value"></div>
        <button id="nsfw-scan-btn"></button>
        <div id="nsfw-scan-progress" class="hidden">
            <div id="nsfw-scan-progress-bar"></div>
        </div>
        <div id="nsfw-tiers"></div>
        <div id="nsfw-histogram"></div>
        <div id="nsfw-hist-legend"></div>
        <div id="nsfw-hist-tooltip" class="hidden"></div>
        <button class="nsfw-media-kind" data-kind="all"></button>
        <button class="nsfw-media-kind" data-kind="photo"></button>
        <button class="nsfw-media-kind" data-kind="video"></button>
        <button id="nsfw-ft-video"></button>
        <input id="nsfw-show-whitelisted" type="checkbox" />
        <div id="nsfw-list"></div>
        <div id="nsfw-empty" class="hidden"></div>
        <div id="nsfw-empty-db-banner" class="hidden"></div>
        <div id="nsfw-page-info"></div>
        <button id="nsfw-prev-btn"></button>
        <button id="nsfw-next-btn"></button>
        <div id="nsfw-bulk-bar" class="hidden"></div>
        <div id="nsfw-bulk-label"></div>
        <div id="nsfw-bulk-progress"></div>
        <button id="nsfw-bulk-delete-btn"></button>
        <button id="nsfw-bulk-whitelist-btn"></button>
        <button id="nsfw-bulk-reclassify-btn"></button>
        <div id="nsfw-model-status"></div>
        <div id="nsfw-model-progress"></div>
        <button id="nsfw-preload-btn"></button>
        <button id="nsfw-cache-clear-btn"></button>
        <div id="nsfw-blocklist-stats-row"></div>
        <div id="nsfw-blocklist-count"></div>
        <button id="nsfw-blocklist-clear-btn"></button>
        <input id="setting-adv-nsfw-blocklist" type="checkbox" />
    </div>
    <div id="media-modal" class="hidden"></div>
`;

// Rows come straight off the downloads table, so the tile renderer reads
// snake_case columns — camelCase fixtures render a blank tile that still
// passes a careless assertion.
const ROW = (over = {}) => ({
    id: 1,
    file_name: 'a.jpg',
    file_path: 'G/photos/a.jpg',
    file_type: 'photo',
    nsfw_score: 0.2,
    nsfw_whitelist: 0,
    group_name: 'G',
    ...over,
});

const TIERS = (over = {}) => ({
    scanned: 100,
    totalEligible: 120,
    whitelisted: 5,
    borderline: 7,
    threshold: 0.6,
    tiers: { def_not: 60, maybe_not: 3, uncertain: 2, maybe: 2, def: 33 },
    ...over,
});

function stubApi({
    tiers = TIERS(),
    rows = [],
    total = 0,
    totalPages = 1,
    hist = { bins: [] },
    tiersMeta = {
        tiers: [
            { id: 'safe', label: 'Safe' },
            { id: 'unsafe', label: 'Unsafe' },
        ],
    },
    blocklist = { count: 0 },
    modelStatus = { state: 'idle' },
    bulkStatus = { running: false },
} = {}) {
    api.get.mockImplementation(async (url) => {
        if (url.includes('/v2/tiers-meta')) return tiersMeta;
        if (url.includes('/v2/tiers')) return tiers;
        if (url.includes('/v2/list')) return { rows, total, totalPages };
        if (url.includes('/v2/histogram')) return hist;
        if (url.includes('/v2/bulk/status')) return bulkStatus;
        if (url.includes('blocklist/stats')) return blocklist;
        if (url.includes('model-status')) return modelStatus;
        return {};
    });
}

async function boot(opts) {
    vi.resetModules();
    wsHandlers.clear();
    document.body.innerHTML = DOM;
    window.location.hash = '';
    stubApi(opts);
    const mod = await import('../src/web/public/js/maintenance-nsfw.js');
    mod.init();
    await flush();
    return mod;
}

async function flush(times = 8) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < times; i++) await Promise.resolve();
}

function fire(type, msg) {
    for (const fn of wsHandlers.get(type) || []) fn(msg);
}

/** Select a tier the way the tier panel does, via the URL hash. */
async function selectTier(tier) {
    window.location.hash = `#/maintenance/nsfw?tier=${tier}`;
    window.dispatchEvent(new Event('hashchange'));
    await flush();
}

beforeEach(() => {
    vi.clearAllMocks();
    confirmAnswer = true;
    i18nDict = {};
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    window.location.hash = '';
});

// ---- boot ---------------------------------------------------------------

describe('init', () => {
    it('loads stats, the list and the histogram', async () => {
        await boot();
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/v2/tiers'))).toBe(true);
        expect(urls.some((u) => u.includes('/v2/list'))).toBe(true);
    });

    it('subscribes to each live channel exactly once', async () => {
        const mod = await boot();
        mod.init();
        await flush();
        for (const type of [
            'nsfw_progress',
            'nsfw_done',
            'nsfw_model_downloading',
            'nsfw_bulk_progress',
            'nsfw_bulk_done',
        ]) {
            expect(wsHandlers.get(type), type).toHaveLength(1);
        }
    });

    it('survives missing page markup', async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        stubApi();
        const mod = await import('../src/web/public/js/maintenance-nsfw.js');
        expect(() => mod.init()).not.toThrow();
        await flush();
    });
});

// ---- stats --------------------------------------------------------------

describe('stats', () => {
    it('reports scanned against eligible', async () => {
        await boot({ tiers: TIERS({ scanned: 80, totalEligible: 200 }) });
        expect($('nsfw-stat-scanned').textContent).toBe('80 / 200');
    });

    // "Borderline" is the sum of the three middle tiers — def_not and def are
    // the confident ends, the middle is what actually needs eyeballing.
    it('reports whitelisted, and sums the middle tiers as borderline', async () => {
        await boot({
            tiers: TIERS({
                whitelisted: 12,
                tiers: { def_not: 60, maybe_not: 3, uncertain: 2, maybe: 4, def: 33 },
            }),
        });
        expect($('nsfw-stat-whitelisted').textContent).toBe('12');
        expect($('nsfw-stat-borderline').textContent).toBe('9');
    });

    it('tolerates a stats payload with fields missing', async () => {
        await boot({ tiers: {} });
        expect($('nsfw-stat-scanned').textContent).toBe('0 / 0');
        expect($('nsfw-stat-whitelisted').textContent).toBe('0');
    });
});

// ---- list ---------------------------------------------------------------

describe('review list', () => {
    it('renders a tile per row', async () => {
        await boot({ rows: [ROW(), ROW({ id: 2, file_name: 'b.jpg' })], total: 2 });
        expect($('nsfw-list').innerHTML).toContain('a.jpg');
        expect($('nsfw-list').innerHTML).toContain('b.jpg');
    });

    it('shows the empty state when a page has no rows', async () => {
        await boot({ rows: [], total: 0 });
        expect($('nsfw-list').innerHTML).toBe('');
    });

    it('reveals the empty-database banner only when nothing was ever scanned', async () => {
        await boot({ tiers: TIERS({ scanned: 0, totalEligible: 0 }), rows: [] });
        expect($('nsfw-empty-db-banner').classList.contains('hidden')).toBe(false);

        await boot({ tiers: TIERS({ scanned: 10, totalEligible: 10 }), rows: [] });
        expect($('nsfw-empty-db-banner').classList.contains('hidden')).toBe(true);
    });

    it('never turns a filename into markup', async () => {
        await boot({ rows: [ROW({ file_name: '<script>alert(1)</script>' })], total: 1 });
        const list = $('nsfw-list');
        expect(list.querySelector('script')).toBeNull();
        expect(list.textContent).toContain('<script>alert(1)</script>');
    });

    it('renders a failure inline instead of throwing', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        stubApi();
        api.get.mockImplementation(async (url) => {
            if (String(url).includes('/v2/list')) {
                throw Object.assign(new Error('raw'), { data: { error: 'query failed' } });
            }
            return {};
        });
        const mod = await import('../src/web/public/js/maintenance-nsfw.js');
        mod.init();
        await flush();
        expect($('nsfw-list').textContent).toContain('query failed');
    });

    it('disables the pager at both ends', async () => {
        await boot({ rows: [ROW()], total: 1, totalPages: 1 });
        expect($('nsfw-prev-btn').disabled).toBe(true);
        expect($('nsfw-next-btn').disabled).toBe(true);
    });

    it('pages forward and back, and records the page in the URL', async () => {
        await boot({ rows: [ROW()], total: 60, totalPages: 3 });
        expect($('nsfw-next-btn').disabled).toBe(false);

        $('nsfw-next-btn').click();
        await flush();
        expect(window.location.hash).toContain('page=2');
        expect($('nsfw-prev-btn').disabled).toBe(false);

        $('nsfw-prev-btn').click();
        await flush();
        expect(window.location.hash).not.toContain('page=2');
    });

    it('refuses to page past either end', async () => {
        await boot({ rows: [ROW()], total: 1, totalPages: 1 });
        const before = api.get.mock.calls.length;
        $('nsfw-prev-btn').click();
        $('nsfw-next-btn').click();
        await flush();
        expect(api.get.mock.calls.length).toBe(before);
    });
});

// ---- filters ------------------------------------------------------------

describe('filters', () => {
    it('sends the media kind and resets to page one', async () => {
        await boot({ rows: [ROW()], total: 10, totalPages: 5 });
        $('nsfw-next-btn').click();
        await flush();

        document.querySelector('.nsfw-media-kind[data-kind="video"]').click();
        await flush();

        const last = api.get.mock.calls
            .map((c) => String(c[0]))
            .filter((u) => u.includes('/v2/list'))
            .pop();
        expect(last).toContain('kind=video');
        expect(last).toContain('page=1');
        expect(window.location.hash).toContain('kind=video');
    });

    it('drops the kind parameter for "all"', async () => {
        await boot({ rows: [ROW()] });
        document.querySelector('.nsfw-media-kind[data-kind="video"]').click();
        await flush();
        document.querySelector('.nsfw-media-kind[data-kind="all"]').click();
        await flush();

        const last = api.get.mock.calls
            .map((c) => String(c[0]))
            .filter((u) => u.includes('/v2/list'))
            .pop();
        expect(last).not.toContain('kind=');
    });

    it('marks the active media-kind button for assistive tech', async () => {
        await boot();
        document.querySelector('.nsfw-media-kind[data-kind="photo"]').click();
        await flush();
        expect(
            document
                .querySelector('.nsfw-media-kind[data-kind="photo"]')
                .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(
            document
                .querySelector('.nsfw-media-kind[data-kind="all"]')
                .getAttribute('aria-pressed'),
        ).toBe('false');
    });

    it('includes whitelisted rows on request', async () => {
        await boot({ rows: [ROW()] });
        const cb = $('nsfw-show-whitelisted');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
        await flush();

        const last = api.get.mock.calls
            .map((c) => String(c[0]))
            .filter((u) => u.includes('/v2/list'))
            .pop();
        expect(last).toContain('include_whitelisted=1');
        expect(window.location.hash).toContain('whitelisted=1');
    });

    it('restores the view from the URL hash', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');

        const last = api.get.mock.calls
            .map((c) => String(c[0]))
            .filter((u) => u.includes('/v2/list'))
            .pop();
        expect(last).toContain('tier=def_not');
    });
});

// ---- scan ---------------------------------------------------------------

describe('scan', () => {
    it('starts a scan', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('nsfw-scan-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/nsfw/scan', {});
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Scan started'), 'info');
        expect($('nsfw-scan-btn').disabled).toBe(false);
    });

    it('reports a scan already running elsewhere', async () => {
        await boot();
        api.post.mockResolvedValue({ alreadyRunning: true });
        $('nsfw-scan-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('A scan is already running', 'info');
    });

    it('cancels when the button is in cancel mode', async () => {
        await boot();
        $('nsfw-scan-btn').dataset.mode = 'cancel';
        api.post.mockResolvedValue({});

        $('nsfw-scan-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/nsfw/scan/cancel', {});
    });

    it('re-enables the button when starting fails', async () => {
        await boot();
        api.post.mockRejectedValue(
            Object.assign(new Error('raw'), { data: { error: 'model missing' } }),
        );
        $('nsfw-scan-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('model missing', 'error');
        expect($('nsfw-scan-btn').disabled).toBe(false);
    });

    it('refreshes stats when a scan completes', async () => {
        await boot();
        api.get.mockClear();
        fire('nsfw_done', { scanned: 10 });
        await flush();
        expect(api.get.mock.calls.some((c) => String(c[0]).includes('/v2/tiers'))).toBe(true);
    });
});

// ---- bulk actions -------------------------------------------------------

describe('bulk actions', () => {
    // A clean URL hydrates to DEFAULT_TIER ('uncertain') — the actual review
    // queue — so new arrivals do not wade through 95% def_not first. There is
    // therefore always a tier selected, and the bulk buttons are always live.
    it('defaults to the uncertain review queue on a clean URL', async () => {
        await boot({ rows: [ROW()] });
        const first = api.get.mock.calls
            .map((c) => String(c[0]))
            .find((u) => u.includes('/v2/list'));
        expect(first).toContain('tier=uncertain');
    });

    it('confirms before deleting a tier, and honours a refusal', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        confirmAnswer = false;

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect(confirmSheet).toHaveBeenCalled();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('deletes a tier once confirmed', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockResolvedValue({ started: true });

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith(
            '/api/maintenance/nsfw/v2/bulk-delete',
            expect.objectContaining({ tier: 'def_not' }),
        );
    });

    it('sends only photo file types by default', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockResolvedValue({ started: true });

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect(api.post.mock.calls[0][1].fileTypes).toEqual(['photo']);
    });

    // A fresh boot per variant: the first successful start disables the bulk
    // buttons, so a second click in the same test would be a no-op.
    it('includes video when the video file-type chip is active', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockResolvedValue({ started: true });
        $('nsfw-ft-video').classList.add('active');

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect(api.post.mock.calls[0][1].fileTypes).toEqual(['photo', 'video']);
    });

    it('whitelists a tier', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def');
        api.post.mockResolvedValue({});

        $('nsfw-bulk-whitelist-btn').click();
        await flush();

        expect(String(api.post.mock.calls[0][0])).toMatch(/whitelist/);
    });

    it('reclassifies a tier', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('uncertain');
        api.post.mockResolvedValue({});

        $('nsfw-bulk-reclassify-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith(
            '/api/maintenance/nsfw/v2/reclassify',
            expect.objectContaining({ tier: 'uncertain' }),
        );
    });

    it('locks the bulk buttons while one is running', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        // The endpoint has to acknowledge the start; a bare {} is treated as
        // a failure and releases the buttons again (covered below).
        api.post.mockResolvedValue({ started: true });

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect($('nsfw-bulk-delete-btn').disabled).toBe(true);
        expect($('nsfw-bulk-whitelist-btn').disabled).toBe(true);
    });

    it('releases the buttons when the server does not acknowledge the start', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockResolvedValue({});

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('Failed to start', 'error');
        expect($('nsfw-bulk-delete-btn').disabled).toBe(false);
    });

    it('keeps the buttons locked when another tab already owns the job', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockRejectedValue(
            Object.assign(new Error('x'), { data: { code: 'ALREADY_RUNNING' } }),
        );

        $('nsfw-bulk-delete-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Already running'), 'info');
        expect($('nsfw-bulk-delete-btn').disabled).toBe(true);
    });

    it('releases the buttons when the done event arrives', async () => {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockResolvedValue({ started: true });
        $('nsfw-bulk-delete-btn').click();
        await flush();

        fire('nsfw_bulk_done', { deleted: 5 });
        await flush();

        expect($('nsfw-bulk-delete-btn').disabled).toBe(false);
    });

    // A dropped nsfw_bulk_done would otherwise strand the buttons disabled
    // forever, so a 60s watchdog re-checks the canonical server status.
    // The watchdog is armed inside _setBulkUi(true), i.e. at click time, so
    // the fake clock has to be installed BEFORE the click — swapping it in
    // afterwards leaves the timer pending on the real one and it never fires.
    async function startBulkWithFakeClock(bulkStatus) {
        await boot({ rows: [ROW()] });
        await selectTier('def_not');
        api.post.mockResolvedValue({ started: true });

        vi.useFakeTimers();
        $('nsfw-bulk-delete-btn').click();
        await vi.advanceTimersByTimeAsync(1);
        expect($('nsfw-bulk-delete-btn').disabled).toBe(true);

        // The WS done event never arrives; the watchdog asks the server.
        stubApi({ bulkStatus });
        await vi.advanceTimersByTimeAsync(61_000);
        await vi.advanceTimersByTimeAsync(1);
    }

    it('recovers from a lost done event via the watchdog', async () => {
        await startBulkWithFakeClock({ running: false });
        expect($('nsfw-bulk-delete-btn').disabled).toBe(false);
    });

    it('leaves the buttons locked when the watchdog finds it still running', async () => {
        await startBulkWithFakeClock({ running: true });
        expect($('nsfw-bulk-delete-btn').disabled).toBe(true);
    });
});

// ---- blocklist ----------------------------------------------------------

describe('hash blocklist', () => {
    it('clears the blocklist', async () => {
        await boot({ blocklist: { count: 12 } });
        api.delete.mockResolvedValue({});

        $('nsfw-blocklist-clear-btn').click();
        await flush();

        expect(api.delete).toHaveBeenCalledWith('/api/maintenance/nsfw/blocklist', {
            confirm: true,
        });
        expect(showToast).toHaveBeenCalledWith('Blocklist cleared', 'success');
    });

    it('reports a failed clear', async () => {
        await boot({ blocklist: { count: 12 } });
        api.delete.mockRejectedValue(new Error('locked'));

        $('nsfw-blocklist-clear-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('locked', 'error');
    });
});

// ---- model --------------------------------------------------------------

describe('classifier model', () => {
    it('renders download progress as it arrives', async () => {
        await boot();
        fire('nsfw_model_downloading', {
            status: 'progress',
            progress: 42,
            file: 'model_quantized.onnx',
        });
        await flush();
        expect($('nsfw-model-status').textContent + $('nsfw-model-progress').textContent).toContain(
            '42',
        );
    });

    it('kicks off a preload', async () => {
        await boot();
        api.post.mockResolvedValue({ started: true });
        $('nsfw-preload-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith(
            expect.stringContaining('preload'),
            expect.anything(),
        );
    });

    it('clears the model cache after confirmation', async () => {
        await boot();
        api.post.mockResolvedValue({ ok: true });
        $('nsfw-cache-clear-btn').click();
        await flush();
        expect(confirmSheet).toHaveBeenCalled();
    });
});
