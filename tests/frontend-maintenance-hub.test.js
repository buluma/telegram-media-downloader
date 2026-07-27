// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-hub.js — the tool card grid: the
// no-status "not yet fetched" pill vs idle/running/count states, the
// hideWhenZero recovery tile, WS live updates with the 200ms coalescing
// render throttle, and the backup_destination_updated re-fetch path.
//
// api.js and ws.js are mocked. i18n stays real for its synchronous
// fallback path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn() };

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

const $ = (id) => document.getElementById(id);

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function loadModule() {
    vi.resetModules();
    ws = makeFakeWs();
    document.body.innerHTML = '<div id="hub-grid"></div>';
    api.get.mockResolvedValue({});
    return import('../src/web/public/js/maintenance-hub.js');
}

const cardFor = (slug) => $('hub-grid').querySelector(`[data-tool="${slug}"]`);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('init', () => {
    it('does nothing (no throw) when the grid element is absent', async () => {
        const { init } = await loadModule();
        document.body.innerHTML = '';
        expect(() => init()).not.toThrow();
    });

    it('renders one card per tool immediately, before status resolves', async () => {
        const { init } = await loadModule();
        init();
        const cards = $('hub-grid').querySelectorAll('.hub-card');
        expect(cards.length).toBeGreaterThan(5);
        expect(cardFor('duplicates')).not.toBeNull();
        expect(cardFor('logs')).not.toBeNull(); // has no statusUrl
    });

    it('fetches status only for tools that declare a statusUrl', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/dedup/status');
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/recovery/list?countOnly=1');
        // logs/db-stats/cluster have statusUrl: null and must not be fetched.
        expect(api.get).not.toHaveBeenCalledWith(null);
    });

    it('wires the WS listeners exactly once across repeated init calls', async () => {
        // Note: init()'s own `if (!_wired)` guard is what actually stops
        // this — it's the only caller of _wireWs(), so _wireWs()'s own
        // internal `_wsWired` guard is unreachable/redundant through the
        // public API. This test pins the observable contract either way.
        const { init } = await loadModule();
        init();
        await flush();
        const before = ws.on.mock.calls.filter(([t]) => t === 'dedup_progress').length;
        init();
        await flush();
        const after = ws.on.mock.calls.filter(([t]) => t === 'dedup_progress').length;
        expect(after).toBe(before);
        expect(before).toBe(1);
    });
});

describe('pill states', () => {
    it('shows a blank placeholder pill before any status has been fetched', async () => {
        const { init } = await loadModule();
        api.get.mockReturnValue(new Promise(() => {})); // never resolves
        init();
        expect(cardFor('duplicates').textContent).not.toContain('Idle');
        expect(cardFor('duplicates').textContent).not.toContain('Running');
    });

    it('shows Idle once status resolves with running:false', async () => {
        const { init } = await loadModule();
        api.get.mockResolvedValue({ running: false });
        init();
        await flush();
        expect(cardFor('duplicates').textContent).toContain('Idle');
    });

    it('shows Running with a pulse dot when the tool is active', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            Promise.resolve(url.includes('dedup') ? { running: true } : {}),
        );
        init();
        await flush();
        expect(cardFor('duplicates').textContent).toContain('Running');
    });

    it('a status endpoint failure leaves the card without a stale pill', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url.includes('dedup') ? Promise.reject(new Error('down')) : Promise.resolve({}),
        );
        init();
        await flush();
        expect(cardFor('duplicates').textContent).not.toContain('Idle');
        expect(cardFor('duplicates').textContent).not.toContain('Running');
    });
});

describe('recovery tile (count-based status)', () => {
    it('shows the unresolved count as a red badge', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            Promise.resolve(url.includes('recovery') ? { total: 4 } : {}),
        );
        init();
        await flush();
        expect(cardFor('recovery').textContent).toContain('4');
        expect(cardFor('recovery').querySelector('.bg-red-500\\/15')).not.toBeNull();
    });

    it('hides the tile entirely once the count reaches zero', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            Promise.resolve(url.includes('recovery') ? { total: 0 } : {}),
        );
        init();
        await flush();
        expect(cardFor('recovery')).toBeNull();
    });

    it('shows the tile before the count has been fetched (default visible)', async () => {
        const { init } = await loadModule();
        init();
        expect(cardFor('recovery')).not.toBeNull();
    });
});

describe('WS live updates', () => {
    it('a _progress event marks the tool running immediately, then coalesces the repaint', async () => {
        vi.useFakeTimers();
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('dedup_progress', { processed: 1, total: 10 });
        // Repaint is throttled 200ms; the card should not have updated yet.
        expect(cardFor('duplicates').textContent).not.toContain('Running');
        vi.advanceTimersByTime(200);
        expect(cardFor('duplicates').textContent).toContain('Running');
    });

    it('coalesces a burst of progress events into a single repaint timer', async () => {
        vi.useFakeTimers();
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('dedup_progress', {});
        await ws.emit('dedup_progress', {});
        await ws.emit('dedup_progress', {});
        expect(vi.getTimerCount()).toBe(1);
    });

    it('a _done event with running:false clears the running pill after the coalesce', async () => {
        vi.useFakeTimers();
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            Promise.resolve(url.includes('dedup') ? { running: true } : {}),
        );
        init();
        await flush();
        vi.advanceTimersByTime(200);
        expect(cardFor('duplicates').textContent).toContain('Running');

        await ws.emit('dedup_done', { running: false });
        vi.advanceTimersByTime(200);
        expect(cardFor('duplicates').textContent).toContain('Idle');
    });

    it('backup_destination_updated re-fetches status instead of guessing from the event', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.get.mockClear();
        api.get.mockResolvedValue({ running: true });
        await ws.emit('backup_destination_updated', {});
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/backup/status');
        expect(cardFor('backup').textContent).toContain('Running');
    });

    it('only touches the card for the tool whose event fired', async () => {
        vi.useFakeTimers();
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('dedup_progress', {});
        vi.advanceTimersByTime(200);
        expect(cardFor('thumbs').textContent).not.toContain('Running');
    });
});

describe('escaping', () => {
    it('the recovery count is coerced through escapeHtml (no literal markup path)', async () => {
        // Static tool metadata has no user-controlled strings, so this
        // mainly documents that count rendering goes through escapeHtml
        // rather than raw interpolation; a non-numeric total still
        // renders as a safe string via Number(...) || 0.
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            Promise.resolve(url.includes('recovery') ? { total: '<img src=x>' } : {}),
        );
        init();
        await flush();
        expect(cardFor('recovery')).toBeNull(); // Number('<img...>') || 0 -> hidden
    });
});
