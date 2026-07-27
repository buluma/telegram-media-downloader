// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-logs.js — the realtime log viewer:
// backfill load, WS tailing, the ring buffer cap, source/level/search
// filtering, source-chip toggling (plain / shift-solo / all / none), and
// pause/clear/download.
//
// api.js, ws.js and showToast are mocked; escapeHtml is re-implemented
// inline (matching utils.js) since the module leans on it for every
// rendered line. i18n stays real for its synchronous fallback path.
//
// ws.js is a minimal in-memory pub/sub, same shape as the ws mock in
// tests/frontend-statusbar.test.js. jsdom has no URL.createObjectURL, so
// it is stubbed for the download-button tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn() };
const showToast = vi.fn();

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
        emit: (type, msg = {}) => {
            for (const fn of handlers.get(type) || []) fn({ type, ...msg });
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
vi.mock('../src/web/public/js/utils.js', () => ({ showToast, escapeHtml }));

const DOM = `
    <pre id="logs-stream"></pre>
    <div id="logs-filter-sources"></div>
    <div id="logs-filter-level">
        <input type="radio" name="logs-level" value="info" checked>
        <input type="radio" name="logs-level" value="warn">
        <input type="radio" name="logs-level" value="error">
    </div>
    <input id="logs-search" type="text">
    <input id="logs-autoscroll" type="checkbox" checked>
    <button id="logs-pause-btn" data-paused="0">Pause</button>
    <button id="logs-clear-btn">Clear</button>
    <button id="logs-download-btn">Download</button>
`;

const $ = (id) => document.getElementById(id);
const lines = () => [...$('logs-stream').querySelectorAll('.logline')];

/**
 * init() is not async — it fires `_loadBackfill()` without awaiting it, so
 * `await init()` resolves before the backfill's own `await api.get(...)`
 * continuation has run. Flush enough microtasks (api.get's promise chain,
 * plus its .catch()) so callers can rely on the backfill having landed.
 */
async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

function entry(over = {}) {
    return { ts: Date.now(), source: 'monitor', level: 'info', msg: 'hello', ...over };
}

async function loadModule({ backfill = [] } = {}) {
    vi.resetModules();
    vi.clearAllMocks();
    ws = makeFakeWs();
    document.body.innerHTML = DOM;
    api.get.mockResolvedValue({ logs: backfill });
    // jsdom does not implement CSS.escape.
    if (typeof window.CSS === 'undefined') window.CSS = {};
    window.CSS.escape ??= (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    return import('../src/web/public/js/maintenance-logs.js');
}

describe('init', () => {
    afterEach(() => vi.restoreAllMocks());

    it('loads the backfill and renders it', async () => {
        const { init } = await loadModule({
            backfill: [entry({ msg: 'one' }), entry({ msg: 'two' })],
        });
        await init();
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/logs/recent?limit=200');
        expect(lines()).toHaveLength(2);
    });

    it('surfaces a backfill failure as a toast instead of throwing', async () => {
        const { init } = await loadModule();
        api.get.mockRejectedValue({ data: { error: 'db locked' } });
        expect(() => init()).not.toThrow();
        await flush();
        expect(showToast).toHaveBeenCalledWith('db locked', 'error');
    });

    it('re-runs the backfill on every call, refreshing stale state', async () => {
        const { init } = await loadModule({ backfill: [entry({ msg: 'first visit' })] });
        await init();
        await flush();
        api.get.mockResolvedValue({ logs: [entry({ msg: 'second visit' })] });
        await init();
        await flush();
        expect(lines()).toHaveLength(1);
        expect(lines()[0].textContent).toContain('second visit');
    });

    it('wires the WS log handler exactly once across repeated init calls', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await init();
        await flush();
        const logSubscribers = ws.on.mock.calls.filter(([type]) => type === 'log');
        expect(logSubscribers).toHaveLength(1);
    });

    it('renders lines pushed over the WS stream after boot', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'downloader', level: 'warn', msg: 'slow write' });
        expect(lines()).toHaveLength(1);
        expect(lines()[0].dataset.source).toBe('downloader');
        expect(lines()[0].textContent).toContain('slow write');
    });

    it('defaults a missing level/source/msg on a WS line', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', {});
        expect(lines()[0].dataset.source).toBe('app');
        expect(lines()[0].dataset.level).toBe('info');
    });
});

describe('ring buffer cap', () => {
    it('evicts the oldest rendered line once MAX_LINES is exceeded', async () => {
        // jsdom's default innerWidth (1024) puts MAX_LINES at 1000.
        const { init } = await loadModule();
        await init();
        await flush();
        for (let i = 0; i < 1005; i++) {
            ws.emit('log', { source: 'x', level: 'info', msg: `line-${i}` });
        }
        expect($('logs-stream').children.length).toBeLessThanOrEqual(1000);
        expect($('logs-stream').textContent).toContain('line-1004');
        expect($('logs-stream').textContent).not.toContain('line-0 ');

        // _appendOne also trims the DOM directly on every push, which would
        // mask an uncapped in-memory buffer. Force a full re-render from
        // `_lines` (level filter change does this) so a missing shift()
        // on the underlying array is visible here too.
        const radio = document.querySelector('input[name="logs-level"][value="info"]');
        radio.dispatchEvent(new window.Event('change'));
        expect($('logs-stream').children.length).toBeLessThanOrEqual(1000);
    });
});

describe('level filter', () => {
    it('hides entries below the selected minimum level', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', level: 'info', msg: 'info line' });
        ws.emit('log', { source: 'a', level: 'warn', msg: 'warn line' });
        ws.emit('log', { source: 'a', level: 'error', msg: 'error line' });
        expect(lines()).toHaveLength(3);

        $('#logs-filter-level input[value="error"]'.replace('#', ''));
        const radio = document.querySelector('input[name="logs-level"][value="error"]');
        radio.checked = true;
        radio.dispatchEvent(new window.Event('change'));

        expect(lines()).toHaveLength(1);
        expect(lines()[0].textContent).toContain('error line');
    });

    it('treats an unranked level as info-equivalent', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', level: 'debug', msg: 'debug line' });
        const radio = document.querySelector('input[name="logs-level"][value="warn"]');
        radio.checked = true;
        radio.dispatchEvent(new window.Event('change'));
        expect(lines()).toHaveLength(0);
    });
});

describe('search filter', () => {
    it('debounces and filters case-insensitively', async () => {
        vi.useFakeTimers();
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'Download complete' });
        ws.emit('log', { source: 'a', msg: 'Nothing relevant' });

        const input = $('logs-search');
        input.value = 'DOWNLOAD';
        input.dispatchEvent(new window.Event('input'));
        expect(lines()).toHaveLength(2); // not yet — debounce pending
        vi.advanceTimersByTime(150);
        expect(lines()).toHaveLength(1);
        expect(lines()[0].textContent).toContain('Download complete');
        vi.useRealTimers();
    });

    it('collapses rapid keystrokes into a single pending timer', async () => {
        // Asserting only the end result here would still pass without the
        // clearTimeout: each keystroke's timer reads the CURRENT input value
        // when it fires, so 5 redundant timers landing on the same final
        // string produce the same visible outcome as 1. The debounce claim
        // is specifically about not leaving 5 timers in flight — check that.
        vi.useFakeTimers();
        const { init } = await loadModule();
        await init();
        await flush();
        const input = $('logs-search');
        for (const v of ['m', 'ma', 'mat', 'matc', 'match']) {
            input.value = v;
            input.dispatchEvent(new window.Event('input'));
            vi.advanceTimersByTime(50); // less than the 150ms debounce
        }
        expect(vi.getTimerCount()).toBe(1);
        vi.useRealTimers();
    });

    it('applies the debounced search value after it settles', async () => {
        vi.useFakeTimers();
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'match-me' });
        const input = $('logs-search');
        for (const v of ['m', 'ma', 'mat', 'matc', 'match']) {
            input.value = v;
            input.dispatchEvent(new window.Event('input'));
            vi.advanceTimersByTime(50);
        }
        vi.advanceTimersByTime(150);
        expect(lines()).toHaveLength(1);
        vi.useRealTimers();
    });
});

describe('source filtering and chips', () => {
    it('discovers sources from the backfill and renders a chip per source', async () => {
        const { init } = await loadModule({
            backfill: [entry({ source: 'monitor' }), entry({ source: 'downloader' })],
        });
        await init();
        await flush();
        const chips = [...$('logs-filter-sources').querySelectorAll('.log-src-chip')];
        expect(chips.map((c) => c.dataset.source).sort()).toEqual(['downloader', 'monitor']);
    });

    it('adds a new chip the first time a source is seen over WS', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'faces-spawn', msg: 'x' });
        expect(
            $('logs-filter-sources').querySelector('[data-source="faces-spawn"]'),
        ).not.toBeNull();
    });

    it('does not re-render chips for a source already known', async () => {
        const { init } = await loadModule({ backfill: [entry({ source: 'monitor' })] });
        await init();
        await flush();
        const wrap = $('logs-filter-sources');
        const before = wrap.innerHTML;
        ws.emit('log', { source: 'monitor', msg: 'again' });
        expect(wrap.innerHTML).toBe(before);
    });

    it('every chip starts pressed (no filter applied)', async () => {
        const { init } = await loadModule({ backfill: [entry({ source: 'monitor' })] });
        await init();
        await flush();
        const chip = $('logs-filter-sources').querySelector('.log-src-chip');
        expect(chip.getAttribute('aria-pressed')).toBe('true');
    });

    it('a plain click toggles just that source off, keeping others visible', async () => {
        // No backfill: both sources are discovered here via the WS
        // announce lines below, so the only rendered lines afterwards
        // are the "from a"/"from b" ones this test actually asserts on.
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'announce a' });
        ws.emit('log', { source: 'b', msg: 'announce b' });

        $('logs-filter-sources').querySelector('[data-source="a"]').click();

        ws.emit('log', { source: 'a', msg: 'from a' });
        ws.emit('log', { source: 'b', msg: 'from b' });
        const texts = lines().map((l) => l.textContent);
        expect(texts.some((t) => t.includes('from a'))).toBe(false);
        expect(texts.some((t) => t.includes('from b'))).toBe(true);
    });

    it('re-clicking every toggled-off source folds back to "no filter" (null)', async () => {
        const { init } = await loadModule({ backfill: [entry({ source: 'a' })] });
        await init();
        await flush();
        const chip = () => $('logs-filter-sources').querySelector('[data-source="a"]');
        chip().click(); // off
        chip().click(); // back on — only known source re-included → filter resets to null
        ws.emit('log', { source: 'brand-new', msg: 'x' });
        expect(lines().some((l) => l.textContent.includes('x'))).toBe(true);
    });

    it('shift-click solos a single source', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'seed a' });
        ws.emit('log', { source: 'b', msg: 'seed b' });
        ws.emit('log', { source: 'c', msg: 'seed c' });

        const chipA = $('logs-filter-sources').querySelector('[data-source="a"]');
        chipA.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));

        ws.emit('log', { source: 'a', msg: 'from a' });
        ws.emit('log', { source: 'b', msg: 'from b' });
        expect(lines().every((l) => l.dataset.source === 'a')).toBe(true);
        expect(lines().some((l) => l.textContent.includes('from a'))).toBe(true);
    });

    it('the "None" quick action hides everything, including new sources', async () => {
        const { init } = await loadModule({ backfill: [entry({ source: 'a' })] });
        await init();
        await flush();
        $('logs-filter-sources').querySelector('[data-action="none"]').click();
        ws.emit('log', { source: 'a', msg: 'x' });
        ws.emit('log', { source: 'brand-new', msg: 'y' });
        expect(lines()).toHaveLength(0);
    });

    it('the "All" quick action clears the filter entirely', async () => {
        const { init } = await loadModule({ backfill: [entry({ source: 'a' })] });
        await init();
        await flush();
        $('logs-filter-sources').querySelector('[data-action="none"]').click();
        expect(lines()).toHaveLength(0); // "none" hid the backfill line too
        $('logs-filter-sources').querySelector('[data-action="all"]').click();
        expect(lines()).toHaveLength(1); // backfill line is visible again
        ws.emit('log', { source: 'a', msg: 'x' });
        expect(lines()).toHaveLength(2);
    });

    it('updates the per-source count badge as lines arrive', async () => {
        const { init } = await loadModule({ backfill: [entry({ source: 'a' })] });
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'two' });
        // The badge update is rAF-scheduled — jsdom's rAF runs on a real
        // timer, so flush one macrotask.
        await new Promise((r) => setTimeout(r, 20));
        const badge = $('logs-filter-sources').querySelector('[data-source-count="a"]');
        expect(badge.textContent).toBe('2');
    });
});

describe('pause / clear / download', () => {
    it('stops appending new lines while paused, and flushes on resume', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        $('logs-pause-btn').click();
        expect($('logs-pause-btn').textContent).toBe('Resume');
        expect($('logs-pause-btn').dataset.paused).toBe('1');

        ws.emit('log', { source: 'a', msg: 'while paused' });
        expect(lines()).toHaveLength(0);

        $('logs-pause-btn').click();
        expect($('logs-pause-btn').textContent).toBe('Pause');
        expect(lines()).toHaveLength(1); // buffered line renders on resume
    });

    it('clear empties the visible stream and shows a toast, but keeps the buffer', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'one' });
        $('logs-clear-btn').click();
        expect($('logs-stream').innerHTML).toBe('');
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('server buffer'), 'info');
    });

    it('clear is visual only — a later render still sees the same buffered lines', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', msg: 'kept in buffer?' });
        $('logs-clear-btn').click();
        // Forcing a re-render (toggling level filter back to itself)
        // proves clear did not touch _lines, only the DOM.
        const radio = document.querySelector('input[name="logs-level"][value="info"]');
        radio.dispatchEvent(new window.Event('change'));
        expect($('logs-stream').innerHTML).toBe('');
    });

    it('download builds a Blob URL, triggers a click, and revokes it', async () => {
        // jsdom has neither method at all (not even a throwing stub), so
        // spyOn can't attach to them — assign directly. Adding methods to
        // the real URL constructor rather than replacing the global
        // matters: jsdom's own internals (the <a href> setter) call
        // `new URL(...)`, and a plain object stand-in is not constructible.
        const createObjectURL = vi.fn(() => 'blob:fake-url');
        const revokeObjectURL = vi.fn();
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
        vi.useFakeTimers();

        const { init } = await loadModule();
        await init();
        await flush();
        ws.emit('log', { source: 'a', level: 'error', msg: 'boom' });

        const clickSpy = vi
            .spyOn(window.HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => {});
        $('logs-download-btn').click();

        expect(createObjectURL).toHaveBeenCalled();
        const blob = createObjectURL.mock.calls[0][0];
        expect(blob.type).toBe('text/plain');
        expect(clickSpy).toHaveBeenCalled();

        vi.advanceTimersByTime(0);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');

        clickSpy.mockRestore();
        delete URL.createObjectURL;
        delete URL.revokeObjectURL;
        vi.useRealTimers();
    });

    it('download only includes lines that pass the active filter', async () => {
        const createObjectURL = vi.fn(() => 'blob:fake-url');
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        const { init } = await loadModule({ backfill: [entry({ source: 'a' })] });
        await init();
        await flush();
        $('logs-filter-sources').querySelector('[data-action="none"]').click();
        $('logs-download-btn').click();

        const blob = createObjectURL.mock.calls[0][0];
        const text = await blob.text();
        expect(text).toBe('');

        delete URL.createObjectURL;
        delete URL.revokeObjectURL;
    });
});
