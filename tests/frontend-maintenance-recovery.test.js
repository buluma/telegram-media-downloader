// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-recovery.js — the recovery cleanup
// page: list fetch + render, bulk-select checkboxes, resolve/disable/
// delete/reassign actions, and the WS-driven bulk progress bar.
//
// api.js, ws.js, sheet.js and showToast are mocked; escapeHtml is
// reimplemented inline to match utils.js.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn() };
const showToast = vi.fn();
const confirmSheet = vi.fn();

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function makeFakeWs() {
    const handlers = new Map();
    return {
        on: vi.fn((type, fn) => {
            (handlers.get(type) || handlers.set(type, new Set()).get(type)).add(fn);
        }),
        emit: async (type, msg = {}) => {
            for (const fn of handlers.get(type) || []) await fn({ type, ...msg });
        },
    };
}
let ws;

vi.mock('../src/web/public/js/api.js', () => ({ api }));
vi.mock('../src/web/public/js/ws.js', () => ({
    get ws() {
        return ws;
    },
}));
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet }));
vi.mock('../src/web/public/js/utils.js', () => ({ showToast, escapeHtml }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="recovery-stats"></div>
    <div id="recovery-toolbar">
        <input type="checkbox" id="recovery-select-all">
        <span id="recovery-selected-count"></span>
        <select id="recovery-reassign-select" class="hidden"></select>
        <button id="recovery-resolve-btn">Resolve</button>
        <button id="recovery-disable-btn">Disable</button>
        <button id="recovery-delete-btn">Delete</button>
    </div>
    <div id="recovery-empty" class="hidden">Nothing to recover</div>
    <div id="recovery-list"></div>
    <div id="recovery-progress" class="hidden">
        <div id="recovery-progress-bar"></div>
        <span id="recovery-progress-text"></span>
    </div>
`;

function item(over = {}) {
    return {
        id: 'unknown:1',
        name: 'Unknown group',
        enabled: true,
        isSynthetic: false,
        fileCount: 3,
        ...over,
    };
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

// Resets happen in a top-level beforeEach (below), NOT here — any test
// that does `api.post.mockRejectedValue(x); await loadModule()` needs
// that setup to survive. Configuring api.post/confirmSheet again here
// unconditionally would run after the test's own setup and clobber it,
// same bug as an earlier version of tests/frontend-statusbar.test.js.
// Test-specific overrides must be set AFTER awaiting loadModule().
async function loadModule({ items = [], accounts = [] } = {}) {
    vi.resetModules();
    ws = makeFakeWs();
    document.body.innerHTML = DOM;
    api.get.mockImplementation((url) => {
        if (url === '/api/maintenance/recovery/list') return Promise.resolve({ items });
        if (url === '/api/dialogs?accountsOnly=1') return Promise.resolve({ accounts });
        return Promise.resolve({});
    });
    return import('../src/web/public/js/maintenance-recovery.js');
}

beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({});
    confirmSheet.mockResolvedValue(true);
});

const rows = () => [...$('recovery-list').querySelectorAll('[data-rec-row]')];
const rowCheckbox = (id) => $('recovery-list').querySelector(`.rec-row-check[data-id="${id}"]`);

describe('init / list rendering', () => {
    it('fetches the list and accounts on init', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/recovery/list');
        expect(api.get).toHaveBeenCalledWith('/api/dialogs?accountsOnly=1');
    });

    it('shows the empty state and hides toolbar/stats with no items', async () => {
        const { init } = await loadModule({ items: [] });
        init();
        await flush();
        expect($('recovery-empty').classList.contains('hidden')).toBe(false);
        expect($('recovery-toolbar').classList.contains('hidden')).toBe(true);
    });

    it('renders one row per item and hides the empty state', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a' }), item({ id: 'b' })],
        });
        init();
        await flush();
        expect(rows()).toHaveLength(2);
        expect($('recovery-empty').classList.contains('hidden')).toBe(true);
        expect($('recovery-toolbar').classList.contains('hidden')).toBe(false);
    });

    it('escapes hostile item names', async () => {
        const { init } = await loadModule({
            items: [item({ name: '<img src=x onerror=alert(1)>' })],
        });
        init();
        await flush();
        expect($('recovery-list').querySelector('img')).toBeNull();
        expect($('recovery-list').textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('shows the synthetic badge only for synthetic ids', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a', isSynthetic: true }), item({ id: 'b', isSynthetic: false })],
        });
        init();
        await flush();
        const rowA = $('recovery-list').querySelector('[data-rec-row="a"]');
        const rowB = $('recovery-list').querySelector('[data-rec-row="b"]');
        expect(rowA.textContent).toContain('synthetic');
        expect(rowB.textContent).not.toContain('synthetic');
    });

    it('shows enabled vs disabled pills', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a', enabled: true }), item({ id: 'b', enabled: false })],
        });
        init();
        await flush();
        expect($('recovery-list').querySelector('[data-rec-row="a"]').textContent).toContain(
            'enabled',
        );
        expect($('recovery-list').querySelector('[data-rec-row="b"]').textContent).toContain(
            'disabled',
        );
    });

    it('surfaces a list-fetch failure as a toast', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/recovery/list'
                ? Promise.reject({ data: { error: 'db locked' } })
                : Promise.resolve({}),
        );
        init();
        await flush();
        expect(showToast).toHaveBeenCalledWith('db locked', 'error');
    });

    it('the _refreshing guard skips an overlapping fetch, not a sequential one', async () => {
        const { init } = await loadModule();
        // Both calls happen in the same synchronous tick: _refresh() sets
        // its guard flag before its first `await`, so the second call's
        // fetch is skipped outright — this is the guard actually firing.
        init();
        init();
        await flush();
        expect(
            api.get.mock.calls.filter(([u]) => u === '/api/maintenance/recovery/list'),
        ).toHaveLength(1);
    });

    it('a later, non-overlapping init() still fetches again', async () => {
        const { init } = await loadModule();
        init();
        await flush(); // let the first _refresh() finish — guard is released
        init();
        await flush();
        expect(
            api.get.mock.calls.filter(([u]) => u === '/api/maintenance/recovery/list'),
        ).toHaveLength(2);
    });

    it('wires the recovery-list change handler exactly once across repeated init calls', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        init();
        await flush();
        init();
        await flush();
        rowCheckbox('a').click();
        // If the change listener were bound twice (init() re-wiring on the
        // second call), this one click would toggle the Set add/delete
        // twice — net no-op — and the count would read 0, not 1.
        expect($('recovery-selected-count').textContent).toContain('1 selected');
    });
});

describe('reason text', () => {
    it('shows the banned explanation', async () => {
        const { init } = await loadModule({
            items: [item({ resolveFailedReason: 'banned:some detail' })],
        });
        init();
        await flush();
        expect($('recovery-list').textContent).toContain('banned / kicked');
    });

    it('shows the probe-failed detail', async () => {
        const { init } = await loadModule({
            items: [item({ resolveFailedReason: 'probe_failed:timeout' })],
        });
        init();
        await flush();
        expect($('recovery-list').textContent).toContain('Probe failed: timeout');
    });

    it('shows the index-miss explanation for synthetic ids with no reason', async () => {
        const { init } = await loadModule({
            items: [item({ isSynthetic: true, resolveFailedReason: null })],
        });
        init();
        await flush();
        expect($('recovery-list').textContent).toContain("not in any loaded account's dialogs");
    });

    it('falls back to the raw code for an unrecognised reason', async () => {
        const { init } = await loadModule({
            items: [item({ resolveFailedReason: 'weird_new_code' })],
        });
        init();
        await flush();
        expect($('recovery-list').textContent).toContain('weird_new_code');
    });
});

describe('bulk selection', () => {
    it('checking a row updates the selected count', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' }), item({ id: 'b' })] });
        init();
        await flush();
        rowCheckbox('a').click();
        expect($('recovery-selected-count').textContent).toContain('1 selected');
    });

    it('select-all checks every row and sets indeterminate correctly', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' }), item({ id: 'b' })] });
        init();
        await flush();
        rowCheckbox('a').click();
        expect($('recovery-select-all').indeterminate).toBe(true);

        $('recovery-select-all').checked = true;
        $('recovery-select-all').dispatchEvent(new window.Event('change'));
        expect(rows().every((r) => r.querySelector('.rec-row-check').checked)).toBe(true);
        expect($('recovery-select-all').indeterminate).toBe(false);
        expect($('recovery-select-all').checked).toBe(true);
    });

    it('unchecking select-all clears every selection', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' }), item({ id: 'b' })] });
        init();
        await flush();
        $('recovery-select-all').checked = true;
        $('recovery-select-all').dispatchEvent(new window.Event('change'));
        $('recovery-select-all').checked = false;
        $('recovery-select-all').dispatchEvent(new window.Event('change'));
        expect($('recovery-selected-count').textContent).toBe('');
    });

    it('shows the reassign select only with a selection AND multiple accounts', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a' })],
            accounts: [
                { id: '1', name: 'Acc 1' },
                { id: '2', name: 'Acc 2' },
            ],
        });
        init();
        await flush();
        expect($('recovery-reassign-select').classList.contains('hidden')).toBe(true);
        rowCheckbox('a').click();
        expect($('recovery-reassign-select').classList.contains('hidden')).toBe(false);
    });

    it('keeps the reassign select hidden with only one account loaded', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a' })],
            accounts: [{ id: '1', name: 'Only' }],
        });
        init();
        await flush();
        rowCheckbox('a').click();
        expect($('recovery-reassign-select').classList.contains('hidden')).toBe(true);
    });

    it('drops a selection that disappears from a refreshed list', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' }), item({ id: 'b' })] });
        init();
        await flush();
        rowCheckbox('a').click();
        rowCheckbox('b').click();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/recovery/list'
                ? Promise.resolve({ items: [item({ id: 'b' })] })
                : Promise.resolve({}),
        );
        await ws.emit('recovery_bulk_done', { resolved: 1, total: 2 });
        expect($('recovery-selected-count').textContent).toContain('1 selected');
    });
});

describe('resolve action', () => {
    it('warns instead of calling the API with nothing selected', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        init();
        await flush();
        $('recovery-resolve-btn').click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Nothing selected', 'info');
    });

    it('posts the selected ids', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        init();
        await flush();
        rowCheckbox('a').click();
        $('recovery-resolve-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/recovery/resolve', { ids: ['a'] });
    });

    it('shows a distinct message when another tab already has the job running', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        api.post.mockRejectedValue({ data: { code: 'ALREADY_RUNNING' } });
        init();
        await flush();
        rowCheckbox('a').click();
        $('recovery-resolve-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('Already running on another tab', 'info');
    });
});

describe('disable action', () => {
    it('does nothing with an empty selection', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        init();
        await flush();
        $('recovery-disable-btn').click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('posts, toasts the count, clears selection, and refreshes', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' }), item({ id: 'b' })] });
        api.post.mockResolvedValue({ disabled: 2 });
        init();
        await flush();
        rowCheckbox('a').click();
        rowCheckbox('b').click();
        api.get.mockClear();
        $('recovery-disable-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/recovery/disable', {
            ids: ['a', 'b'],
        });
        expect(showToast).toHaveBeenCalledWith('Disabled 2 group(s)', 'success');
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/recovery/list');
        expect($('recovery-selected-count').textContent).toBe('');
    });

    it('surfaces a failure as a toast', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        api.post.mockRejectedValue({ data: { error: 'nope' } });
        init();
        await flush();
        rowCheckbox('a').click();
        $('recovery-disable-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('nope', 'error');
    });
});

describe('delete action', () => {
    it('does nothing with an empty selection (no confirm shown)', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        init();
        await flush();
        $('recovery-delete-btn').click();
        await flush();
        expect(confirmSheet).not.toHaveBeenCalled();
    });

    it('asks for confirmation and does nothing when declined', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        confirmSheet.mockResolvedValue(false);
        init();
        await flush();
        rowCheckbox('a').click();
        $('recovery-delete-btn').click();
        await flush();
        expect(confirmSheet).toHaveBeenCalled();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('confirms with the destructive flag and posts purgeDownloads:false', async () => {
        const { init } = await loadModule({ items: [item({ id: 'a' })] });
        confirmSheet.mockResolvedValue(true);
        api.post.mockResolvedValue({ removed: 1 });
        init();
        await flush();
        rowCheckbox('a').click();
        $('recovery-delete-btn').click();
        await flush();
        expect(confirmSheet.mock.calls[0][0]).toMatchObject({ danger: true });
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/recovery/delete', {
            ids: ['a'],
            purgeDownloads: false,
        });
        expect(showToast).toHaveBeenCalledWith('Removed 1 group(s)', 'success');
    });
});

describe('reassign action', () => {
    it('is a no-op when the placeholder ("") is chosen', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a' })],
            accounts: [{ id: '1' }, { id: '2' }],
        });
        init();
        await flush();
        rowCheckbox('a').click();
        const sel = $('recovery-reassign-select');
        sel.value = '';
        sel.dispatchEvent(new window.Event('change'));
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('posts the selected ids and target account, then refreshes and clears the select', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a' }), item({ id: 'b' })],
            accounts: [{ id: '1' }, { id: '2' }],
        });
        api.post.mockResolvedValue({ reassigned: 2 });
        init();
        await flush();
        rowCheckbox('a').click();
        rowCheckbox('b').click();
        const sel = $('recovery-reassign-select');
        // The accounts loader appends real <option> elements — set the value
        // and let it match one of those.
        sel.value = sel.options[1]?.value ?? '1';
        sel.dispatchEvent(new window.Event('change'));
        await flush();
        expect(api.post).toHaveBeenCalledWith(
            '/api/maintenance/recovery/reassign',
            expect.objectContaining({ ids: ['a', 'b'] }),
        );
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Pinned'), 'success');
        expect(sel.value).toBe('');
    });

    it('resets the select back to empty even when the request fails', async () => {
        const { init } = await loadModule({
            items: [item({ id: 'a' })],
            accounts: [{ id: '1' }, { id: '2' }],
        });
        api.post.mockRejectedValue({ data: { error: 'boom' } });
        init();
        await flush();
        rowCheckbox('a').click();
        const sel = $('recovery-reassign-select');
        sel.value = sel.options[1]?.value ?? '1';
        sel.dispatchEvent(new window.Event('change'));
        await flush();
        expect(sel.value).toBe('');
    });
});

describe('WS bulk progress', () => {
    it('shows the progress bar and updates its width + text', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('recovery_bulk_progress', { processed: 3, total: 10 });
        expect($('recovery-progress').classList.contains('hidden')).toBe(false);
        expect($('recovery-progress-bar').style.width).toBe('30%');
        expect($('recovery-progress-text').textContent).toBe('3 / 10');
    });

    it('clamps the bar at 100% and never sets it when total is 0', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('recovery_bulk_progress', { processed: 12, total: 10 });
        expect($('recovery-progress-bar').style.width).toBe('100%');
    });

    it('hides the bar and toasts success on bulk_done', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('recovery_bulk_progress', { processed: 1, total: 2 });
        await ws.emit('recovery_bulk_done', { resolved: 2, total: 2 });
        expect($('recovery-progress').classList.contains('hidden')).toBe(true);
        expect(showToast).toHaveBeenCalledWith('Resolved 2/2 group(s)', 'success');
    });

    it('toasts an error message on a failed bulk job', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('recovery_bulk_done', { error: 'crashed' });
        expect(showToast).toHaveBeenCalledWith('Bulk failed: crashed', 'error');
    });

    it('refreshes the list after a bulk job completes', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.get.mockClear();
        await ws.emit('recovery_bulk_done', { resolved: 1, total: 1 });
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/recovery/list');
    });

    it('wires the WS handlers exactly once across repeated init calls', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        init();
        await flush();
        const subs = ws.on.mock.calls.filter(([type]) => type === 'recovery_bulk_progress');
        expect(subs).toHaveLength(1);
    });
});
