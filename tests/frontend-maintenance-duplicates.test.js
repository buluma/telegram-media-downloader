// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-duplicates.js — the Duplicates
// maintenance page: the stats strip, the scan lifecycle (start, cancel,
// recover, already-running elsewhere), duplicate-set rendering and the
// keep-oldest default, the bulk keep/clear controls, the delete flow, and the
// verify + reindex side jobs.
//
// Only `init()` is exported; everything else is reached through the DOM.
// Same harness as the other P4 pages.
//
// The keep-oldest/newest logic gets particular attention. Its comparator
// carries a comment describing a real prior bug: `createdAt` arrives as an
// ISO-like string from SQLite, so subtracting two of them yields NaN and the
// sort order became engine-defined. Those tests use string dates on purpose.

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

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="page-maintenance-duplicates">
        <div id="dup-stat-total"></div>
        <div id="dup-stat-hashed"></div>
        <div id="dup-stat-missing"></div>
        <div id="dup-stat-last"></div>
        <div id="dup-stat-summary" class="hidden"></div>
        <button id="dup-scan-btn"></button>
        <button id="dup-scan-cancel-btn" class="hidden"></button>
        <div id="dup-progress" class="hidden">
            <div id="dup-progress-bar"></div>
            <div id="dup-progress-pct"></div>
            <div id="dup-progress-stage"></div>
        </div>
        <div id="dup-list"></div>
        <div id="dup-list-pending" class="hidden"></div>
        <div id="dup-empty" class="hidden"></div>
        <div id="dup-summary"></div>
        <div id="dup-totals"></div>
        <div id="dup-bulk-bar" class="hidden"></div>
        <button id="dup-bulk-oldest"></button>
        <button id="dup-bulk-newest"></button>
        <button id="dup-bulk-clear"></button>
        <button id="dup-delete-btn"></button>
        <button id="dup-delete-all-oldest"></button>
        <button id="dup-delete-all-newest"></button>
        <button id="dup-verify-btn"></button>
        <div id="dup-verify-progress" class="hidden">
            <div id="dup-verify-progress-bar"></div>
            <div id="dup-verify-status"></div>
        </div>
        <button id="dup-reindex-btn"></button>
        <div id="dup-reindex-progress" class="hidden">
            <div id="dup-reindex-progress-bar"></div>
            <div id="dup-reindex-status"></div>
        </div>
    </div>
`;

/** A duplicate set of `n` copies, oldest first unless dates are given. */
function SET(over = {}) {
    return {
        hash: 'abc123',
        count: 2,
        fileSize: 1024,
        files: [
            { id: 1, fileName: 'a.jpg', groupName: 'G', fileSize: 1024, createdAt: 1000 },
            { id: 2, fileName: 'b.jpg', groupName: 'G', fileSize: 1024, createdAt: 2000 },
        ],
        ...over,
    };
}

function stubApi({
    stats = { totalFiles: 100, hashed: 90, missing: 10, lastScan: null },
    scanStatus = { running: false },
    deleteStatus = { running: false },
    reindexStatus = { running: false },
    verifyStatus = { running: false },
} = {}) {
    api.get.mockImplementation(async (url) => {
        if (url === '/api/maintenance/dedup/stats') return stats;
        if (url === '/api/maintenance/dedup/status') return scanStatus;
        if (url === '/api/maintenance/dedup/delete/status') return deleteStatus;
        if (url === '/api/maintenance/reindex/status') return reindexStatus;
        if (url.includes('verify')) return verifyStatus;
        return {};
    });
}

async function boot(opts) {
    vi.resetModules();
    wsHandlers.clear();
    document.body.innerHTML = DOM;
    stubApi(opts);
    const mod = await import('../src/web/public/js/maintenance-duplicates.js');
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

/** Render sets by completing a scan over the wire. */
async function renderSets(sets) {
    fire('dedup_done', { duplicateSets: sets });
    await flush();
}

const checkedIds = () =>
    [...document.querySelectorAll('.dup-del:checked')].map((el) => Number(el.dataset.id)).sort();

beforeEach(() => {
    vi.clearAllMocks();
    confirmAnswer = true;
    i18nDict = {};
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

// ---- boot ---------------------------------------------------------------

describe('init', () => {
    it('recovers scan, delete and reindex state on every entry', async () => {
        await boot();
        const urls = api.get.mock.calls.map((c) => c[0]);
        expect(urls).toContain('/api/maintenance/dedup/status');
        expect(urls).toContain('/api/maintenance/dedup/delete/status');
        expect(urls).toContain('/api/maintenance/reindex/status');
    });

    it('subscribes to each live channel exactly once', async () => {
        const mod = await boot();
        mod.init();
        await flush();
        for (const type of [
            'dedup_progress',
            'dedup_done',
            'dedup_delete_progress',
            'dedup_delete_done',
            'files_verify_progress',
            'files_verify_done',
            'reindex_progress',
            'reindex_done',
        ]) {
            expect(wsHandlers.get(type), type).toHaveLength(1);
        }
    });

    it('survives missing page markup', async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        stubApi();
        const mod = await import('../src/web/public/js/maintenance-duplicates.js');
        expect(() => mod.init()).not.toThrow();
        await flush();
    });

    it('re-arms the scanning UI when a scan is already running', async () => {
        await boot({ scanStatus: { running: true } });
        expect($('dup-scan-btn').disabled).toBe(true);
        expect($('dup-scan-cancel-btn').classList.contains('hidden')).toBe(false);
    });

    it('repaints the previous result when one is cached server-side', async () => {
        await boot({ scanStatus: { running: false, result: { duplicateSets: [SET()] } } });
        expect($('dup-list').querySelectorAll('[data-file-row]').length).toBe(2);
    });
});

// ---- stats --------------------------------------------------------------

describe('stats', () => {
    it('renders the counts with thousands separators', async () => {
        await boot({ stats: { totalFiles: 12345, hashed: 12000, missing: 345 } });
        fire('dedup_done', { duplicateSets: [] });
        await flush();
        expect($('dup-stat-total').textContent).toBe('12,345');
        expect($('dup-stat-hashed').textContent).toBe('12,000');
    });

    it('colours the missing count by whether work remains', async () => {
        await boot({ stats: { totalFiles: 10, hashed: 5, missing: 5 } });
        await renderSets([]);
        expect($('dup-stat-missing').classList.contains('text-tg-orange')).toBe(true);

        await boot({ stats: { totalFiles: 10, hashed: 10, missing: 0 } });
        await renderSets([]);
        expect($('dup-stat-missing').classList.contains('text-tg-green')).toBe(true);
    });

    it('says never before the first scan', async () => {
        await boot({ stats: { totalFiles: 0, hashed: 0, missing: 0, lastScan: null } });
        await renderSets([]);
        expect($('dup-stat-last').textContent).toBe('Never');
        expect($('dup-stat-summary').classList.contains('hidden')).toBe(true);
    });

    it('summarises the last scan result', async () => {
        await boot({
            stats: {
                totalFiles: 100,
                hashed: 100,
                missing: 0,
                lastScan: {
                    finishedAt: Date.now() - 30_000,
                    duplicateSets: 4,
                    extraCopies: 9,
                    reclaimableBytes: 1024 * 1024,
                    scanned: 100,
                },
            },
        });
        await renderSets([]);
        const summary = $('dup-stat-summary');
        expect(summary.classList.contains('hidden')).toBe(false);
        expect(summary.textContent).toContain('4');
        expect(summary.textContent).toContain('9');
    });
});

// ---- scan ---------------------------------------------------------------

describe('scan', () => {
    it('starts a scan and locks the UI', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('dup-scan-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/dedup/scan', {});
        expect($('dup-scan-btn').disabled).toBe(true);
    });

    it('releases the UI when the server refuses', async () => {
        await boot();
        api.post.mockResolvedValue({ error: 'no files hashed' });
        $('dup-scan-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('no files hashed', 'error');
        expect($('dup-scan-btn').disabled).toBe(false);
    });

    it('keeps the UI locked when a scan is already running elsewhere', async () => {
        await boot();
        api.post.mockRejectedValue(
            Object.assign(new Error('x'), { data: { code: 'ALREADY_RUNNING' } }),
        );
        $('dup-scan-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('already running'), 'info');
        expect($('dup-scan-btn').disabled).toBe(true);
    });

    it('releases the UI on a genuine failure', async () => {
        await boot();
        api.post.mockRejectedValue(
            Object.assign(new Error('raw'), { data: { error: 'disk error' } }),
        );
        $('dup-scan-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('disk error', 'error');
        expect($('dup-scan-btn').disabled).toBe(false);
    });

    it('renders progress as it arrives', async () => {
        // A scan must be live: _recoverScanState sets _scanKnownDone when the
        // server reports idle, and dedup_progress then drops the event.
        await boot({ scanStatus: { running: true } });
        fire('dedup_progress', { processed: 50, total: 200, stage: 'hashing' });
        await flush();
        expect($('dup-progress').classList.contains('hidden')).toBe(false);
        expect($('dup-progress-bar').style.width).toBe('25%');
        expect($('dup-progress-stage').textContent).toContain('Hashing');
    });

    // The guard exists because a dedup_progress buffered during a WS
    // reconnect would otherwise re-lock the UI after the scan had finished.
    it('ignores a stale progress event once the scan is known finished', async () => {
        await boot({ scanStatus: { running: false } });
        fire('dedup_progress', { processed: 50, total: 200, stage: 'hashing' });
        await flush();
        expect($('dup-progress').classList.contains('hidden')).toBe(true);
        expect($('dup-scan-btn').disabled).toBe(false);
    });

    it('labels each backend stage distinctly', async () => {
        await boot({ scanStatus: { running: true } });
        fire('dedup_progress', { processed: 1, total: 10, stage: 'grouping' });
        expect($('dup-progress-stage').textContent).toContain('Grouping');

        fire('dedup_progress', { processed: 0, total: 10, stage: 'starting' });
        expect($('dup-progress-stage').textContent).toContain('Starting');
    });

    it('cancels a running scan', async () => {
        await boot({ scanStatus: { running: true } });
        api.post.mockResolvedValue({});
        $('dup-scan-cancel-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/dedup/scan/cancel', {});
    });
});

// ---- results ------------------------------------------------------------

describe('duplicate sets', () => {
    it('shows the empty state when a scan finds nothing', async () => {
        await boot();
        await renderSets([]);
        expect($('dup-empty').classList.contains('hidden')).toBe(false);
    });

    it('renders a row per file across sets', async () => {
        await boot();
        await renderSets([
            SET(),
            SET({
                hash: 'def456',
                files: [
                    { id: 3, fileName: 'c.jpg', createdAt: 1000 },
                    { id: 4, fileName: 'd.jpg', createdAt: 2000 },
                ],
            }),
        ]);
        expect($('dup-list').querySelectorAll('[data-file-row]').length).toBe(4);
        expect($('dup-empty').classList.contains('hidden')).toBe(true);
    });

    it('never turns a filename into markup', async () => {
        await boot();
        await renderSets([
            SET({
                files: [
                    { id: 1, fileName: '<img src=x onerror=alert(1)>', createdAt: 1 },
                    { id: 2, fileName: 'b.jpg', createdAt: 2 },
                ],
            }),
        ]);
        const list = $('dup-list');
        // Every row has a legitimate thumbnail <img onerror="…"> of its own,
        // so match the injected one specifically rather than any <img>.
        expect(list.querySelector('img[src="x"]')).toBeNull();
        expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('defaults to keeping the oldest copy', async () => {
        await boot();
        await renderSets([SET()]);
        // id 1 is older (createdAt 1000) — it stays, id 2 is marked.
        expect(checkedIds()).toEqual([2]);
    });

    // The comparator's own comment records why: createdAt arrives as an
    // ISO-like string from SQLite, and subtracting two strings is NaN, which
    // leaves the sort order engine-defined.
    it('orders by date correctly when createdAt is an ISO string', async () => {
        await boot();
        await renderSets([
            SET({
                files: [
                    { id: 1, fileName: 'newer.jpg', createdAt: '2026-05-08 16:00:00' },
                    { id: 2, fileName: 'older.jpg', createdAt: '2026-05-07 15:30:05' },
                ],
            }),
        ]);
        // The older file (id 2) must be the one kept.
        expect(checkedIds()).toEqual([1]);
    });

    it('treats an unparseable date as oldest rather than crashing', async () => {
        await boot();
        await renderSets([
            SET({
                files: [
                    { id: 1, fileName: 'bad.jpg', createdAt: 'not a date' },
                    { id: 2, fileName: 'good.jpg', createdAt: 5000 },
                ],
            }),
        ]);
        expect(checkedIds()).toEqual([2]);
    });
});

// ---- bulk selection -----------------------------------------------------

describe('bulk keep', () => {
    it('keeps the newest across every set', async () => {
        await boot();
        await renderSets([SET()]);
        $('dup-bulk-newest').click();
        await flush();
        expect(checkedIds()).toEqual([1]);
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('newest'), 'success');
    });

    it('keeps the oldest across every set', async () => {
        await boot();
        await renderSets([SET()]);
        $('dup-bulk-newest').click();
        $('dup-bulk-oldest').click();
        await flush();
        expect(checkedIds()).toEqual([2]);
    });

    it('clears every selection', async () => {
        await boot();
        await renderSets([SET()]);
        $('dup-bulk-clear').click();
        await flush();
        expect(checkedIds()).toEqual([]);
    });

    it('does nothing with no sets loaded', async () => {
        await boot();
        await renderSets([]);
        expect(() => $('dup-bulk-newest').click()).not.toThrow();
    });
});

// ---- delete -------------------------------------------------------------

describe('delete selected', () => {
    it('refuses when nothing is selected', async () => {
        await boot();
        await renderSets([SET()]);
        $('dup-bulk-clear').click();

        $('dup-delete-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('Nothing selected', 'info');
        expect(api.post).not.toHaveBeenCalled();
    });

    it('confirms before deleting, and honours a refusal', async () => {
        await boot();
        await renderSets([SET()]);
        confirmAnswer = false;

        $('dup-delete-btn').click();
        await flush();

        expect(confirmSheet).toHaveBeenCalled();
        expect(confirmSheet.mock.calls[0][0].danger).toBe(true);
        expect(api.post).not.toHaveBeenCalled();
    });

    it('posts the checked ids once confirmed', async () => {
        await boot();
        await renderSets([SET()]);
        api.post.mockResolvedValue({ started: true });

        $('dup-delete-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/maintenance/dedup/delete', { ids: [2] });
        expect($('dup-delete-btn').disabled).toBe(true);
    });

    it('treats an already-running delete as informational', async () => {
        await boot();
        await renderSets([SET()]);
        api.post.mockRejectedValue(
            Object.assign(new Error('x'), { data: { code: 'ALREADY_RUNNING' } }),
        );

        $('dup-delete-btn').click();
        await flush();

        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Already running'), 'info');
    });

    it('reports the tally when a delete finishes', async () => {
        await boot();
        fire('dedup_delete_done', { deleted: 12, failed: 0 });
        await flush();
        expect($('dup-delete-btn').disabled).toBe(false);
    });
});

// ---- side jobs ----------------------------------------------------------

describe('verify and reindex', () => {
    it('starts a verify sweep', async () => {
        await boot();
        api.post.mockResolvedValue({ started: true });
        $('dup-verify-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith(expect.stringContaining('verify'), expect.anything());
    });

    it('renders verify progress and completion', async () => {
        await boot();
        fire('files_verify_progress', { processed: 5, total: 10 });
        await flush();
        expect($('dup-verify-progress').classList.contains('hidden')).toBe(false);

        fire('files_verify_done', { missing: 2, checked: 10 });
        await flush();
        expect($('dup-verify-btn').disabled).toBe(false);
    });

    it('starts a reindex', async () => {
        await boot();
        api.post.mockResolvedValue({ started: true });
        $('dup-reindex-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith(
            expect.stringContaining('reindex'),
            expect.anything(),
        );
    });

    // reindex_progress paints the bar and status but does NOT unhide the
    // panel — that happens in _runReindex, on the tab that started the job.
    // A reindex kicked off from another tab therefore updates a bar this tab
    // is not showing. Pinned as-is; the thumbs page reveals on progress, so
    // the two pages differ here.
    it('paints reindex progress without revealing the panel itself', async () => {
        await boot();
        fire('reindex_progress', { processed: 3, total: 6 });
        await flush();

        expect($('dup-reindex-progress-bar').style.width).toBe('50%');
        expect($('dup-reindex-status').textContent).toContain('3');
        expect($('dup-reindex-progress').classList.contains('hidden')).toBe(true);
    });

    it('re-enables the button and hides the panel when reindex finishes', async () => {
        await boot({ reindexStatus: { running: true } });
        expect($('dup-reindex-btn').disabled).toBe(true);

        fire('reindex_done', { added: 4 });
        await flush();

        expect($('dup-reindex-btn').disabled).toBe(false);
        expect($('dup-reindex-progress').classList.contains('hidden')).toBe(true);
    });

    it('re-arms the reindex button when one is already running', async () => {
        await boot({ reindexStatus: { running: true } });
        expect($('dup-reindex-btn').disabled).toBe(true);
    });
});
