// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-thumbs.js — the Thumbnails maintenance
// page: the stats strip and per-kind breakdown, the build sweep (start,
// progress, cancel, completion), the cache wipe and its confirm sheet, the
// cursor-paginated gallery, and the WebSocket wiring that drives all of it.
//
// Only `init()` is exported. Same harness as the cluster and backup pages,
// plus two additions this module needs:
//   - settings.js and viewer.js are mocked. Both are themselves P4 targets;
//     this page only calls loadAdvanced/setupAutoSave/openMediaViewerForReview.
//   - IntersectionObserver is stubbed. jsdom does not implement it, and the
//     gallery builds two (one for lazy image loading, one for the scroll
//     sentinel). The stub records instances so tests can drive intersections
//     directly instead of faking scroll.

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

const loadAdvanced = vi.fn();
const setupAutoSave = vi.fn();
vi.mock('../src/web/public/js/settings.js', () => ({ loadAdvanced, setupAutoSave }));

const openMediaViewerForReview = vi.fn();
vi.mock('../src/web/public/js/viewer.js', () => ({ openMediaViewerForReview }));

// jsdom has no IntersectionObserver; the gallery constructs two.
const observers = [];
class FakeIntersectionObserver {
    constructor(cb, opts) {
        this.cb = cb;
        this.opts = opts;
        this.observed = new Set();
        observers.push(this);
    }
    observe(el) {
        this.observed.add(el);
    }
    unobserve(el) {
        this.observed.delete(el);
    }
    disconnect() {
        this.observed.clear();
    }
    /** Fire the callback as if `el` scrolled into view. */
    trigger(el) {
        this.cb([{ isIntersecting: true, target: el }], this);
    }
}
globalThis.IntersectionObserver = FakeIntersectionObserver;

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="thumbs-stat-count"></div>
    <div id="thumbs-stat-bytes"></div>
    <div id="thumbs-stat-last"></div>
    <div id="thumbs-stat-summary" class="hidden"></div>
    <div id="thumbs-stat-widths"></div>
    <div id="thumbs-breakdown"></div>
    <div id="thumbs-no-ffmpeg" class="hidden"></div>
    <button id="thumbs-build-btn"><span data-i18n="x">Build all</span></button>
    <button id="thumbs-build-kind-btn"></button>
    <div id="thumbs-build-kind-menu"></div>
    <button id="thumbs-cancel-btn" class="hidden"></button>
    <button id="thumbs-wipe-btn"></button>
    <div id="thumbs-progress" class="hidden">
        <div id="thumbs-progress-bar"></div>
        <div id="thumbs-progress-pct"></div>
        <div id="thumbs-progress-status"></div>
    </div>
    <div id="thumbs-gallery-grid"></div>
    <div id="thumbs-gallery-empty" class="hidden"></div>
    <button id="thumbs-gallery-empty-cta"></button>
    <div id="thumbs-gallery-meta"></div>
    <div id="thumbs-gallery-end" class="hidden"></div>
    <div id="thumbs-gallery-sentinel"></div>
`;

function stubApi({
    stats = { count: 12, bytes: 2048, allowedWidths: [320], ffmpegAvailable: true },
    buildStats = { lastRun: null },
    buildStatus = { running: false },
    rebuildStatus = { running: false },
    rows = [],
    total = 0,
    hasMore = false,
} = {}) {
    api.get.mockImplementation(async (url) => {
        if (url === '/api/maintenance/thumbs/stats') return stats;
        if (url === '/api/maintenance/thumbs/build/stats') return buildStats;
        if (url === '/api/maintenance/thumbs/build/status') return buildStatus;
        if (url === '/api/maintenance/thumbs/rebuild/status') return rebuildStatus;
        if (url.startsWith('/api/maintenance/thumbs/list')) return { rows, total, hasMore };
        if (url === '/api/config') return { advanced: {} };
        return {};
    });
}

async function boot(opts) {
    vi.resetModules();
    wsHandlers.clear();
    observers.length = 0;
    document.body.innerHTML = DOM;
    stubApi(opts);
    const mod = await import('../src/web/public/js/maintenance-thumbs.js');
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

beforeEach(() => {
    vi.clearAllMocks();
    confirmAnswer = true;
    i18nDict = {};
});

afterEach(() => {
    document.body.innerHTML = '';
});

// ---- boot ---------------------------------------------------------------

describe('init', () => {
    it('loads stats, build history and recovers in-flight job state', async () => {
        await boot();
        const urls = api.get.mock.calls.map((c) => c[0]);
        expect(urls).toContain('/api/maintenance/thumbs/stats');
        expect(urls).toContain('/api/maintenance/thumbs/build/stats');
        expect(urls).toContain('/api/maintenance/thumbs/build/status');
        expect(urls).toContain('/api/maintenance/thumbs/rebuild/status');
    });

    it('hands the config to the shared settings panel', async () => {
        await boot();
        expect(loadAdvanced).toHaveBeenCalledWith({ advanced: {} });
        expect(setupAutoSave).toHaveBeenCalled();
    });

    it('subscribes to each live channel exactly once', async () => {
        const mod = await boot();
        mod.init();
        await flush();
        for (const type of [
            'thumbs_progress',
            'thumbs_done',
            'thumbs_rebuild_progress',
            'thumbs_rebuild_done',
        ]) {
            expect(wsHandlers.get(type), type).toHaveLength(1);
        }
    });

    it('survives missing page markup', async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        stubApi();
        const mod = await import('../src/web/public/js/maintenance-thumbs.js');
        expect(() => mod.init()).not.toThrow();
        await flush();
    });

    it('re-arms the build UI when a sweep is already running elsewhere', async () => {
        await boot({ buildStatus: { running: true } });
        expect($('thumbs-build-btn').disabled).toBe(true);
        expect($('thumbs-cancel-btn').classList.contains('hidden')).toBe(false);
    });

    it('re-arms the wipe UI when a rebuild is already running', async () => {
        await boot({ rebuildStatus: { running: true } });
        expect($('thumbs-wipe-btn').disabled).toBe(true);
    });
});

// ---- stats --------------------------------------------------------------

describe('stats', () => {
    it('renders the count, size and allowed widths', async () => {
        await boot({
            stats: { count: 1234, bytes: 5_242_880, allowedWidths: [320], ffmpegAvailable: true },
        });
        expect($('thumbs-stat-count').textContent).toBe('1234');
        expect($('thumbs-stat-bytes').textContent).toMatch(/MB/);
        expect($('thumbs-stat-widths').textContent).toContain('320');
    });

    it('shows the ffmpeg warning chip only when ffmpeg is missing', async () => {
        await boot({ stats: { count: 0, bytes: 0, ffmpegAvailable: true } });
        expect($('thumbs-no-ffmpeg').classList.contains('hidden')).toBe(true);

        await boot({ stats: { count: 0, bytes: 0, ffmpegAvailable: false } });
        expect($('thumbs-no-ffmpeg').classList.contains('hidden')).toBe(false);
    });

    it('renders a per-kind breakdown when the server sends one', async () => {
        await boot({
            stats: { count: 3, bytes: 0, byKind: { video: 2, image: 1 } },
        });
        const text = $('thumbs-breakdown').textContent;
        expect(text).toContain('image');
        expect(text).toContain('video');
    });

    it('clears the breakdown when the server sends none', async () => {
        await boot({ stats: { count: 0, bytes: 0 } });
        expect($('thumbs-breakdown').innerHTML).toBe('');
    });

    it('says never before the first build', async () => {
        await boot({ buildStats: { lastRun: null } });
        expect($('thumbs-stat-last').textContent).toBe('Never');
        expect($('thumbs-stat-summary').classList.contains('hidden')).toBe(true);
    });

    it('summarises the last build result', async () => {
        await boot({
            buildStats: {
                lastRun: {
                    finishedAt: Date.now() - 60_000,
                    built: 10,
                    skipped: 3,
                    errored: 1,
                    scanned: 14,
                },
            },
        });
        const summary = $('thumbs-stat-summary');
        expect(summary.classList.contains('hidden')).toBe(false);
        expect(summary.textContent).toContain('10');
        expect(summary.textContent).toContain('14');
        expect($('thumbs-stat-last').title).toBeTruthy();
    });

    it('leaves the previous numbers alone when the stats call fails', async () => {
        await boot({ stats: { count: 7, bytes: 0 } });
        expect($('thumbs-stat-count').textContent).toBe('7');

        api.get.mockRejectedValue(new Error('500'));
        fire('thumbs_done', { built: 1 });
        await flush();

        expect($('thumbs-stat-count').textContent).toBe('7');
    });
});

// ---- build --------------------------------------------------------------

describe('build sweep', () => {
    it('starts a build for every kind by default', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('thumbs-build-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/thumbs/build-all', {
            kind: 'all',
        });
        expect($('thumbs-build-btn').disabled).toBe(true);
        expect($('thumbs-progress').classList.contains('hidden')).toBe(false);
    });

    it('restores the UI when the server refuses to start', async () => {
        await boot();
        api.post.mockResolvedValue({ error: 'ffmpeg missing' });
        $('thumbs-build-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('ffmpeg missing', 'error');
        expect($('thumbs-build-btn').disabled).toBe(false);
        expect($('thumbs-progress').classList.contains('hidden')).toBe(true);
    });

    it('restores the UI when the request throws', async () => {
        await boot();
        api.post.mockRejectedValue(
            Object.assign(new Error('raw'), { data: { error: 'disk full' } }),
        );
        $('thumbs-build-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('disk full', 'error');
        expect($('thumbs-build-btn').disabled).toBe(false);
    });

    it('renders progress as it arrives', async () => {
        await boot();
        fire('thumbs_progress', { processed: 25, total: 100, built: 20 });

        expect($('thumbs-progress-bar').style.width).toBe('25%');
        expect($('thumbs-progress-pct').textContent).toContain('25%');
        expect($('thumbs-progress-status').textContent).toContain('20');
        expect($('thumbs-cancel-btn').classList.contains('hidden')).toBe(false);
    });

    it('clamps the bar at 100% and tolerates a zero total', async () => {
        await boot();
        fire('thumbs_progress', { processed: 500, total: 100 });
        expect($('thumbs-progress-bar').style.width).toBe('100%');

        fire('thumbs_progress', { processed: 0, total: 0 });
        expect($('thumbs-progress-pct').textContent).toBe('');
    });

    it('reports the tally when the build finishes', async () => {
        await boot();
        fire('thumbs_done', { built: 40, skipped: 2, scanned: 42 });
        await flush();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('40'), 'success');
        expect($('thumbs-build-btn').disabled).toBe(false);
        expect($('thumbs-progress').classList.contains('hidden')).toBe(true);
    });

    it('distinguishes a cancelled build from a failed one', async () => {
        await boot();
        fire('thumbs_done', { cancelled: true });
        await flush();
        expect(showToast).toHaveBeenCalledWith('Build cancelled', 'info');

        fire('thumbs_done', { error: 'ffmpeg crashed' });
        await flush();
        expect(showToast).toHaveBeenCalledWith('ffmpeg crashed', 'error');
    });

    it('cancels a running build', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('thumbs-cancel-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/thumbs/build/cancel', {});
        expect(showToast).toHaveBeenCalledWith('Cancelling…', 'info');
    });

    it('reports a failed cancel', async () => {
        await boot();
        api.post.mockRejectedValue(new Error('not running'));
        $('thumbs-cancel-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('not running', 'error');
    });
});

// ---- wipe ---------------------------------------------------------------

describe('cache wipe', () => {
    it('confirms with the real numbers before wiping', async () => {
        await boot({ stats: { count: 14200, bytes: 891_289_600 } });
        confirmAnswer = false;

        $('thumbs-wipe-btn').click();
        await flush();

        const msg = confirmSheet.mock.calls[0][0].message;
        expect(msg).toContain('14,200');
        expect(api.post).not.toHaveBeenCalled();
    });

    it('uses the generic prompt when the cache is empty', async () => {
        await boot({ stats: { count: 0, bytes: 0 } });
        confirmAnswer = false;
        $('thumbs-wipe-btn').click();
        await flush();

        expect(confirmSheet.mock.calls[0][0].message).toMatch(/every cached thumbnail/i);
    });

    it('wipes after confirmation', async () => {
        await boot();
        api.post.mockResolvedValue({ started: true });
        $('thumbs-wipe-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/thumbs/rebuild', {});
        expect($('thumbs-wipe-btn').disabled).toBe(true);
    });

    it('treats an already-running rebuild as informational, not an error', async () => {
        await boot();
        api.post.mockRejectedValue(
            Object.assign(new Error('x'), { data: { code: 'ALREADY_RUNNING' } }),
        );
        $('thumbs-wipe-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Already running'), 'info');
        // Left disabled on purpose — the other tab's run is still going.
        expect($('thumbs-wipe-btn').disabled).toBe(true);
    });

    it('re-enables the button on a genuine failure', async () => {
        await boot();
        api.post.mockRejectedValue(
            Object.assign(new Error('raw'), { data: { error: 'permission denied' } }),
        );
        $('thumbs-wipe-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('permission denied', 'error');
        expect($('thumbs-wipe-btn').disabled).toBe(false);
    });

    it('reports the wipe tally when it completes', async () => {
        await boot();
        fire('thumbs_rebuild_done', { removed: 900 });
        await flush();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('900'), 'success');
        expect($('thumbs-wipe-btn').disabled).toBe(false);
    });

    it('surfaces a wipe failure', async () => {
        await boot();
        fire('thumbs_rebuild_done', { error: 'EACCES' });
        await flush();
        expect(showToast).toHaveBeenCalledWith('EACCES', 'error');
    });

    it('disables the button while a rebuild reports progress', async () => {
        await boot();
        fire('thumbs_rebuild_progress', {});
        expect($('thumbs-wipe-btn').disabled).toBe(true);
    });
});

// ---- gallery ------------------------------------------------------------

describe('gallery', () => {
    const ROW = (id) => ({ id, file_name: `f${id}.jpg`, file_type: 'photo', cached: true });

    it('requests the first page cached-only', async () => {
        await boot({ rows: [ROW(1)], total: 1 });
        const listCall = api.get.mock.calls.find((c) =>
            String(c[0]).startsWith('/api/maintenance/thumbs/list'),
        );
        expect(listCall[0]).toContain('cachedOnly=1');
        expect(listCall[0]).toContain('kind=all');
    });

    it('renders a tile per row', async () => {
        await boot({ rows: [ROW(1), ROW(2), ROW(3)], total: 3 });
        expect($('thumbs-gallery-grid').children.length).toBeGreaterThanOrEqual(3);
    });

    it('shows the empty state when nothing is cached', async () => {
        await boot({ rows: [], total: 0 });
        expect($('thumbs-gallery-empty').classList.contains('hidden')).toBe(false);
    });

    it('escapes row filenames rather than emitting markup', async () => {
        await boot({
            rows: [{ id: 1, file_name: '<script>alert(1)</script>', file_type: 'photo' }],
            total: 1,
        });
        const grid = $('thumbs-gallery-grid');
        expect(grid.querySelector('script')).toBeNull();
    });

    it('builds both observers — lazy images and the scroll sentinel', async () => {
        await boot({ rows: [ROW(1)], total: 1 });
        expect(observers.length).toBeGreaterThanOrEqual(2);
    });

    const listCalls = () =>
        api.get.mock.calls.filter((c) => String(c[0]).startsWith('/api/maintenance/thumbs/list'))
            .length;

    it('loads the next page when the sentinel scrolls into view', async () => {
        // hasMore is what keeps the sentinel observed — the module reads the
        // server's flag, not the row count.
        await boot({ rows: [ROW(1)], total: 500, hasMore: true });
        const before = listCalls();

        const sentinelObs = observers.find((o) => o.observed.has($('thumbs-gallery-sentinel')));
        // Assert the observer exists rather than guarding on it — a guarded
        // test passes silently the day the sentinel stops being observed,
        // which is exactly the regression it is meant to catch.
        expect(sentinelObs).toBeTruthy();

        sentinelObs.trigger($('thumbs-gallery-sentinel'));
        await flush();

        expect(listCalls()).toBeGreaterThan(before);
    });

    // Once the server says there is nothing left, the sentinel is unobserved
    // so IntersectionObserver stops firing no-op callbacks on every scroll
    // past the end of the grid.
    it('stops watching the sentinel once the server reports no more rows', async () => {
        await boot({ rows: [ROW(1)], total: 1, hasMore: false });
        const watching = observers.some((o) => o.observed.has($('thumbs-gallery-sentinel')));
        expect(watching).toBe(false);
    });

    it('reveals the end-of-list marker only when rows exist and paging is done', async () => {
        await boot({ rows: [ROW(1)], total: 1, hasMore: false });
        expect($('thumbs-gallery-end').classList.contains('hidden')).toBe(false);

        await boot({ rows: [], total: 0, hasMore: false });
        expect($('thumbs-gallery-end').classList.contains('hidden')).toBe(true);
    });

    it('survives a failed page fetch', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        stubApi();
        api.get.mockImplementation(async (url) => {
            if (String(url).startsWith('/api/maintenance/thumbs/list')) throw new Error('500');
            if (url === '/api/maintenance/thumbs/stats') return { count: 0, bytes: 0 };
            return {};
        });
        const mod = await import('../src/web/public/js/maintenance-thumbs.js');
        expect(() => mod.init()).not.toThrow();
        await flush();
    });
});
