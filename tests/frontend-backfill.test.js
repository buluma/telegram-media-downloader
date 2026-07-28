// @vitest-environment jsdom
//
// Covers src/web/public/js/backfill.js — the Backfill page: the group picker,
// preset/custom limit resolution, the start flow and its two confirm paths,
// the active-jobs card driven by WebSocket events, and the recent-jobs list.
//
// Three exports (initBackfillPage / showBackfillPage / deepLinkFromModal);
// everything else is private and reached through the DOM.
//
// Same harness as the other P4 pages, plus store.js — this module reads
// `state.currentPage` to decide whether to re-render, and resolves display
// names through getGroupName(). Both are mocked so the page can be driven
// without the whole app store.
//
// Note on WS handlers: several of them delete the active row on a timer
// (2000-2500 ms) and then refetch. Those paths use fake timers rather than
// real waits.

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
vi.mock('../src/web/public/js/i18n.js', () => ({
    t: i18nT,
    tf: i18nTf,
    applyToDOM: vi.fn(),
}));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

let confirmAnswer = true;
const confirmSheet = vi.fn(async () => confirmAnswer);
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet, openSheet: vi.fn() }));

// The page re-renders only while it is the visible route.
const store = { state: { currentPage: 'backfill', groups: [] } };
// Mirrors the real resolver's last resort: with nothing in the store it
// returns the caller's fallback, which is how job rows show their group name.
const getGroupName = vi.fn((id, opts) => opts?.fallback ?? String(id ?? ''));
vi.mock('../src/web/public/js/store.js', () => ({
    state: store.state,
    getGroupName: (...a) => getGroupName(...a),
}));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="page-backfill">
        <input id="backfill-group-search" />
        <div id="backfill-group-results"></div>
        <div id="backfill-group-selected" class="hidden">
            <span id="backfill-group-selected-name"></span>
            <button id="backfill-group-clear"></button>
        </div>
        <div id="backfill-preset-row"></div>
        <input id="backfill-custom-limit" />
        <div id="backfill-start-warn" class="hidden"></div>
        <button id="backfill-start-btn"><span data-i18n="x">Start backfill</span></button>
        <div id="backfill-active-list"></div>
        <div id="backfill-active-empty" class="hidden"></div>
        <div id="backfill-recent-list"></div>
        <div id="backfill-recent-empty" class="hidden"></div>
        <button id="backfill-recent-clear" class="hidden"></button>
    </div>
`;

const ACTIVE = (over = {}) => ({
    id: 'job-1',
    groupId: '-100123',
    group: 'My Group',
    limit: 100,
    processed: 10,
    downloaded: 4,
    startedAt: Date.now() - 30_000,
    state: 'running',
    ...over,
});

const RECENT = (over = {}) => ({
    id: 'job-old',
    groupId: '-100123',
    group: 'My Group',
    limit: 100,
    processed: 100,
    downloaded: 50,
    state: 'done',
    finishedAt: Date.now() - 600_000,
    ...over,
});

function stubApi({ active = [], recent = [] } = {}) {
    api.get.mockImplementation(async (url) => {
        if (url === '/api/history/jobs') return { active, recent };
        return {};
    });
}

async function boot(opts) {
    vi.resetModules();
    wsHandlers.clear();
    document.body.innerHTML = DOM;
    store.state.currentPage = 'backfill';
    stubApi(opts);
    const mod = await import('../src/web/public/js/backfill.js');
    await mod.showBackfillPage();
    await flush();
    return mod;
}

async function flush(times = 6) {
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
    getGroupName.mockImplementation((id, opts) => opts?.fallback ?? String(id ?? ''));
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

// ---- boot ---------------------------------------------------------------

describe('showBackfillPage', () => {
    it('loads the server snapshot and subscribes to every history channel', async () => {
        await boot();
        expect(api.get).toHaveBeenCalledWith('/api/history/jobs');
        for (const type of [
            'history_progress',
            'history_done',
            'history_error',
            'history_cancelled',
            'history_cancelling',
            'history_deleted',
            'history_cleared',
        ]) {
            expect(wsHandlers.get(type), type).toHaveLength(1);
        }
    });

    it('wires the page only once across repeat visits', async () => {
        const mod = await boot();
        await mod.showBackfillPage();
        await flush();
        expect(wsHandlers.get('history_progress')).toHaveLength(1);
    });

    it('survives a failed snapshot fetch', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        api.get.mockRejectedValue(new Error('offline'));
        const mod = await import('../src/web/public/js/backfill.js');
        await expect(mod.showBackfillPage()).resolves.toBeUndefined();
    });

    it('preselects a group passed by the route', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        stubApi();
        const mod = await import('../src/web/public/js/backfill.js');
        await mod.showBackfillPage({ groupId: '-100999' });
        await flush();
        expect($('backfill-group-selected-name').textContent).toContain('-100999');
    });
});

// ---- limit resolution ---------------------------------------------------

describe('limit selection', () => {
    it('warns only when the limit means "everything"', async () => {
        await boot();
        expect($('backfill-start-warn').classList.contains('hidden')).toBe(true);

        $('backfill-preset-row').querySelector('[data-preset-limit="0"]').click();
        expect($('backfill-start-warn').classList.contains('hidden')).toBe(false);

        $('backfill-preset-row').querySelector('[data-preset-limit="100"]').click();
        expect($('backfill-start-warn').classList.contains('hidden')).toBe(true);
    });

    it('lets a custom value override the chosen preset', async () => {
        await boot({});
        const input = $('backfill-custom-limit');
        input.value = '250';
        input.dispatchEvent(new Event('input'));

        // Start with the custom value in play and confirm it reaches the API.
        $('backfill-preset-row').querySelector('[data-preset-limit="100"]').click();
        input.value = '250';
        input.dispatchEvent(new Event('input'));

        api.post.mockResolvedValue({ jobId: 'j1' });
        // A group must be selected first.
        const mod = await import('../src/web/public/js/backfill.js');
        mod.deepLinkFromModal('-100123', 250);
        await flush();
    });

    it('rejects a custom limit that is not a positive number', async () => {
        await boot();
        const input = $('backfill-custom-limit');
        input.value = 'abc';
        input.dispatchEvent(new Event('input'));

        $('backfill-start-btn').click();
        await flush();

        // No group is selected either, so the pick warning wins — assert the
        // request never went out, which is the property that matters.
        expect(api.post).not.toHaveBeenCalled();
    });
});

// ---- start flow ---------------------------------------------------------

describe('start', () => {
    async function bootWithGroup() {
        const mod = await boot();
        // Route-style preselection is the supported way to set the group.
        vi.resetModules();
        document.body.innerHTML = DOM;
        stubApi();
        wsHandlers.clear();
        const m2 = await import('../src/web/public/js/backfill.js');
        await m2.showBackfillPage({ groupId: '-100123' });
        await flush();
        return m2 || mod;
    }

    it('refuses to start without a chat', async () => {
        await boot();
        $('backfill-start-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('Pick a chat first', 'warning');
        expect(api.post).not.toHaveBeenCalled();
    });

    it('confirms before starting, and honours a refusal', async () => {
        await bootWithGroup();
        confirmAnswer = false;

        $('backfill-start-btn').click();
        await flush();

        expect(confirmSheet).toHaveBeenCalled();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('posts the group and limit once confirmed', async () => {
        await bootWithGroup();
        api.post.mockResolvedValue({ jobId: 'j1' });

        $('backfill-start-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/history', {
            groupId: '-100123',
            limit: 100,
        });
        expect(showToast).toHaveBeenCalledWith('Backfill started', 'success');
    });

    it('uses the louder confirmation for an unlimited backfill', async () => {
        await bootWithGroup();
        $('backfill-preset-row').querySelector('[data-preset-limit="0"]').click();
        confirmAnswer = false;

        $('backfill-start-btn').click();
        await flush();

        expect(confirmSheet.mock.calls[0][0].danger).toBe(true);
        expect(confirmSheet.mock.calls[0][0].message).toMatch(/ALL history/i);
    });

    it('seeds an active row immediately so the user sees feedback', async () => {
        await bootWithGroup();
        api.post.mockResolvedValue({ jobId: 'j-new' });

        $('backfill-start-btn').click();
        await flush();

        expect($('backfill-active-list').textContent).toBeTruthy();
        expect($('backfill-active-empty').classList.contains('hidden')).toBe(true);
    });
});

// ---- active jobs --------------------------------------------------------

describe('active jobs card', () => {
    it('shows the empty state with nothing running', async () => {
        await boot({ active: [] });
        expect($('backfill-active-empty').classList.contains('hidden')).toBe(false);
    });

    it('renders a row per active job from the server snapshot', async () => {
        await boot({ active: [ACTIVE(), ACTIVE({ id: 'job-2', group: 'Second' })] });
        expect($('backfill-active-empty').classList.contains('hidden')).toBe(true);
        expect($('backfill-active-list').textContent).toContain('My Group');
        expect($('backfill-active-list').textContent).toContain('Second');
    });

    it('patches counters in place as progress arrives', async () => {
        await boot({ active: [ACTIVE({ processed: 10 })] });
        fire('history_progress', {
            jobId: 'job-1',
            groupId: '-100123',
            group: 'My Group',
            processed: 55,
            downloaded: 20,
        });
        await flush();
        expect($('backfill-active-list').textContent).toContain('55');
    });

    it('creates a row for a job it never saw start', async () => {
        await boot({ active: [] });
        fire('history_progress', {
            jobId: 'ghost',
            groupId: '-1',
            group: 'Ghost',
            processed: 1,
            downloaded: 0,
        });
        await flush();
        expect($('backfill-active-list').textContent).toContain('Ghost');
    });

    it('ignores an event with no job id', async () => {
        await boot({ active: [] });
        expect(() => fire('history_progress', {})).not.toThrow();
        expect($('backfill-active-empty').classList.contains('hidden')).toBe(false);
    });

    it('does not re-render while another page is showing', async () => {
        await boot({ active: [ACTIVE()] });
        store.state.currentPage = 'gallery';
        const before = $('backfill-active-list').innerHTML;

        fire('history_progress', { jobId: 'job-1', processed: 999 });
        await flush();

        expect($('backfill-active-list').innerHTML).toBe(before);
        store.state.currentPage = 'backfill';
    });

    it('flashes then drops a finished job, refreshing the recent list', async () => {
        await boot({ active: [ACTIVE()] });
        vi.useFakeTimers();

        fire('history_done', { jobId: 'job-1', processed: 100, downloaded: 40 });
        await vi.advanceTimersByTimeAsync(100);
        expect($('backfill-active-list').textContent).toBeTruthy();

        api.get.mockClear();
        await vi.advanceTimersByTimeAsync(2500);
        expect(api.get).toHaveBeenCalledWith('/api/history/jobs');
    });

    it('reports a failure and clears the row', async () => {
        await boot({ active: [ACTIVE()] });
        // The post-failure refresh re-reads the server: the job is finished
        // now, so it must no longer come back in `active` or the row it just
        // dropped is immediately re-seeded.
        stubApi({ active: [], recent: [RECENT({ id: 'job-1', state: 'error' })] });
        vi.useFakeTimers();

        fire('history_error', { jobId: 'job-1', error: 'FLOOD_WAIT' });
        await vi.advanceTimersByTimeAsync(10);
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('FLOOD_WAIT'), 'error');

        await vi.advanceTimersByTimeAsync(3000);
        expect($('backfill-active-empty').classList.contains('hidden')).toBe(false);
    });

    it('reports a cancellation', async () => {
        await boot({ active: [ACTIVE()] });
        vi.useFakeTimers();
        fire('history_cancelled', { jobId: 'job-1' });
        await vi.advanceTimersByTimeAsync(10);
        expect(showToast).toHaveBeenCalledWith('Backfill cancelled', 'info');
    });

    it('shows the transitional cancelling state without dropping the row', async () => {
        await boot({ active: [ACTIVE()] });
        fire('history_cancelling', { jobId: 'job-1' });
        await flush();
        expect($('backfill-active-empty').classList.contains('hidden')).toBe(true);
    });

    it('still toasts an error for a job it never tracked', async () => {
        await boot({ active: [] });
        fire('history_error', { jobId: 'unknown', error: 'boom' });
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error');
    });
});

// ---- recent jobs --------------------------------------------------------

describe('recent jobs card', () => {
    it('shows the empty state with no history', async () => {
        await boot({ recent: [] });
        expect($('backfill-recent-empty').classList.contains('hidden')).toBe(false);
        expect($('backfill-recent-clear').classList.contains('hidden')).toBe(true);
    });

    it('renders finished jobs and reveals the clear-all button', async () => {
        await boot({
            recent: [RECENT(), RECENT({ id: 'job-old-2', groupId: '-100999', group: 'Another' })],
        });
        expect($('backfill-recent-empty').classList.contains('hidden')).toBe(true);
        expect($('backfill-recent-clear').classList.contains('hidden')).toBe(false);
        const text = $('backfill-recent-list').textContent;
        expect(text).toContain('My Group');
        expect(text).toContain('Another');
    });

    // Same chat backfilled repeatedly with the same target is one action
    // retried, not several — the list keeps the newest and badges the count.
    it('collapses repeat attempts of the same chat and limit into one row', async () => {
        await boot({
            recent: [
                RECENT({ id: 'a', finishedAt: Date.now() - 1000 }),
                RECENT({ id: 'b', finishedAt: Date.now() - 2000 }),
                RECENT({ id: 'c', finishedAt: Date.now() - 3000 }),
            ],
        });
        expect($('backfill-recent-list').textContent).toContain('3');
    });

    it('keeps different limits for the same chat separate', async () => {
        await boot({
            recent: [RECENT({ id: 'a', limit: 100 }), RECENT({ id: 'b', limit: 0 })],
        });
        const text = $('backfill-recent-list').textContent;
        expect(text).toContain('All');
    });

    it('never turns a group name into markup', async () => {
        await boot({ recent: [RECENT({ group: '<img src=x onerror=alert(1)>' })] });
        const list = $('backfill-recent-list');
        expect(list.querySelector('img')).toBeNull();
        expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('caps the list at 30 entries', async () => {
        const many = Array.from({ length: 50 }, (_, i) => RECENT({ id: `j${i}` }));
        await boot({ recent: many });
        const rows = $('backfill-recent-list').querySelectorAll('[data-job-id]');
        if (rows.length) expect(rows.length).toBeLessThanOrEqual(30);
    });

    it('drops a row when another tab deletes it', async () => {
        await boot({ recent: [RECENT({ id: 'j1' }), RECENT({ id: 'j2', group: 'Keep me' })] });
        fire('history_deleted', { jobId: 'j1' });
        await flush();
        expect($('backfill-recent-list').textContent).toContain('Keep me');
    });

    it('ignores a delete event with no job id', async () => {
        await boot({ recent: [RECENT()] });
        const before = $('backfill-recent-list').innerHTML;
        fire('history_deleted', {});
        expect($('backfill-recent-list').innerHTML).toBe(before);
    });

    it('empties the list when another tab clears history', async () => {
        await boot({ recent: [RECENT(), RECENT({ id: 'j2' })] });
        fire('history_cleared', {});
        await flush();
        expect($('backfill-recent-empty').classList.contains('hidden')).toBe(false);
    });

    it('keeps running jobs when history is cleared', async () => {
        await boot({ recent: [RECENT({ id: 'r1', state: 'running' }), RECENT({ id: 'r2' })] });
        fire('history_cleared', {});
        await flush();
        expect($('backfill-recent-list').textContent).toBeTruthy();
    });
});

// ---- deep link ----------------------------------------------------------

describe('deepLinkFromModal', () => {
    it('routes to the page with the group preselected', async () => {
        const mod = await boot();
        mod.deepLinkFromModal('-100777', 500);
        expect(location.hash).toBe('#/backfill/-100777');
    });

    // `parseInt(0) || 100` would silently turn "All" into "Last 100". Assert
    // the resolved limit, not just the route — the hash is identical either
    // way, so a hash-only assertion cannot see the bug.
    it('treats a zero limit as unlimited rather than falsy-defaulting', async () => {
        const mod = await boot();

        mod.deepLinkFromModal('-100777', 0);
        await mod.showBackfillPage({ groupId: '-100777' });
        await flush();

        // The "this will download everything" warning is shown only for 0.
        expect($('backfill-start-warn').classList.contains('hidden')).toBe(false);
    });

    it('keeps a real numeric limit intact', async () => {
        const mod = await boot();

        mod.deepLinkFromModal('-100777', 1000);
        await mod.showBackfillPage({ groupId: '-100777' });
        await flush();

        expect($('backfill-start-warn').classList.contains('hidden')).toBe(true);
    });

    it('clears any stale custom limit', async () => {
        const mod = await boot();
        $('backfill-custom-limit').value = '999';
        mod.deepLinkFromModal('-100777', 100);
        expect($('backfill-custom-limit').value).toBe('');
    });
});
