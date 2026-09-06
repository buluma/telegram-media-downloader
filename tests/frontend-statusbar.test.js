// @vitest-environment jsdom
//
// Covers src/web/public/js/statusbar.js — the sticky status bar: engine
// state pill, queue/active counters, disk stats, version + update-check
// chips, the offline banner, and the WS connection dot.
//
// api.js, ws.js, sheet.js, monitor-status.js and the toast helper are
// mocked. i18n stays real (its fallback path is synchronous and
// dependency-free), so English fallback strings are what render.
//
// ws.js is replaced with a minimal in-memory pub/sub — statusbar.js only
// calls `ws.on(type, fn)`, so tests drive it via the exported `emit`
// helper rather than a real WebSocket.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn() };
const showToast = vi.fn();
const openSheet = vi.fn();
const confirmSheet = vi.fn();
const subscribeMonitorStatus = vi.fn();
const refreshMonitorStatus = vi.fn();

function makeFakeWs() {
    const handlers = new Map();
    return {
        on: vi.fn((type, fn) => {
            (handlers.get(type) || handlers.set(type, new Set()).get(type)).add(fn);
            return () => handlers.get(type)?.delete(fn);
        }),
        emit: (type, msg = {}) => {
            for (const fn of handlers.get(type) || []) fn({ type, ...msg });
        },
        retry: vi.fn(),
    };
}
let ws;

vi.mock('../src/web/public/js/api.js', () => ({ api }));
vi.mock('../src/web/public/js/ws.js', () => ({
    get ws() {
        return ws;
    },
}));
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet, confirmSheet }));
vi.mock('../src/web/public/js/monitor-status.js', () => ({
    subscribe: subscribeMonitorStatus,
    refreshNow: refreshMonitorStatus,
}));
vi.mock('../src/web/public/js/utils.js', () => ({
    formatBytes: (n) => `${n}B`,
    showToast,
}));

function sheetImpl(opts) {
    const root = document.createElement('div');
    if (typeof opts.content === 'string') root.innerHTML = opts.content;
    document.body.appendChild(root);
    return { body: root, close: vi.fn(), opts };
}

const DOM = `
    <span id="status-dot"></span>
    <span id="status-state"></span>
    <div id="engine-status-pill"><span class="engine-status-label"></span></div>
    <span id="status-queue"></span>
    <span id="status-active"></span>
    <span id="engine-nav-badge" class="hidden"></span>
    <span id="status-files"></span>
    <span id="status-disk"></span>
    <span id="status-groups"></span>
    <a id="status-version"></a>
    <a id="status-update-badge" class="hidden"></a>
    <button id="status-update-dismiss" class="hidden"></button>
    <div id="offline-banner" class="hidden"><span id="offline-banner-text"></span>
        <button id="offline-banner-retry"></button></div>
    <span id="status-ws"></span>
`;

// Resets + defaults live in a top-level beforeEach (below) rather than in
// this loader, specifically so a test can do
//   api.get.mockResolvedValue(...); const m = await loadStatusbar();
// and have its override survive. An earlier version cleared mocks INSIDE
// loadStatusbar, which silently wiped out exactly that pattern — every
// "configure then load" test was asserting against the default mock.
async function loadStatusbar() {
    vi.resetModules();
    document.body.innerHTML = DOM;
    const mod = await import('../src/web/public/js/statusbar.js');
    return mod;
}

beforeEach(() => {
    vi.clearAllMocks();
    ws = makeFakeWs();
    localStorage.clear();
    sessionStorage.clear();
    api.get.mockResolvedValue({});
    api.post.mockResolvedValue({});
    openSheet.mockImplementation(sheetImpl);
    confirmSheet.mockResolvedValue(true);
});

// Several tests below call vi.useFakeTimers() without a matching restore in
// the same test. Without this, fake timers leak into whichever test runs
// next — a later test that awaits a real setTimeout(0) then hangs until
// its own timeout, because there is no fake clock being advanced.
afterEach(() => {
    vi.useRealTimers();
});

const $ = (id) => document.getElementById(id);

describe('initStatusBar', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('is idempotent — a second call does not double-bind handlers', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        const onCallsAfterFirst = ws.on.mock.calls.length;
        initStatusBar();
        expect(ws.on.mock.calls.length).toBe(onCallsAfterFirst);
    });

    it('subscribes to the shared monitor-status poller', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        expect(subscribeMonitorStatus).toHaveBeenCalledWith(expect.any(Function));
    });

    it('fetches stats once at boot to fill the bar before the first push', async () => {
        api.get.mockImplementation((url) =>
            url === '/api/stats' ? Promise.resolve({ totalFiles: 42 }) : Promise.resolve({}),
        );
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect($('status-files').textContent).toBe('42'));
    });
});

describe('monitor state rendering', () => {
    let applyMonitor;

    beforeEach(async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        applyMonitor = subscribeMonitorStatus.mock.calls[0][0];
    });

    it('renders the running state with the green dot', () => {
        applyMonitor({ state: 'running', queue: 0, active: 0 });
        expect($('status-dot').className).toContain('bg-tg-green');
        expect($('status-state').textContent).toBe('Monitor running');
    });

    it('renders every known state distinctly', () => {
        const cases = {
            starting: 'bg-tg-blue',
            stopping: 'bg-tg-orange',
            stopped: 'bg-gray-500',
            error: 'bg-tg-red',
        };
        for (const [state, cls] of Object.entries(cases)) {
            applyMonitor({ state });
            expect($('status-dot').className, state).toContain(cls);
        }
    });

    it('falls back to the stopped/idle pill for an unknown state', () => {
        applyMonitor({ state: 'bogus' });
        expect($('status-dot').className).toContain('bg-gray-500');
        expect($('status-state').textContent).toBe('Idle');
    });

    it('mirrors the state onto the engine status pill and its aria-label', () => {
        applyMonitor({ state: 'running' });
        const pill = $('engine-status-pill');
        expect(pill.dataset.state).toBe('running');
        expect(pill.querySelector('.engine-status-label').textContent).toBe('Monitor running');
        expect(pill.getAttribute('aria-label')).toContain('Monitor running');
    });

    it('does nothing when handed a null snapshot', () => {
        applyMonitor({ state: 'running' });
        const before = $('status-state').textContent;
        applyMonitor(null);
        expect($('status-state').textContent).toBe(before);
    });

    it('updates the queue and active counters, defaulting missing values to 0', () => {
        applyMonitor({ state: 'running', queue: 5, active: 2 });
        expect($('status-queue').textContent).toBe('5');
        expect($('status-active').textContent).toBe('2');
        applyMonitor({ state: 'running' });
        expect($('status-queue').textContent).toBe('0');
        expect($('status-active').textContent).toBe('0');
    });

    it('shows the nav badge with the combined queue+active total', () => {
        applyMonitor({ state: 'running', queue: 3, active: 4 });
        const badge = $('engine-nav-badge');
        expect(badge.textContent).toBe('7');
        expect(badge.classList.contains('hidden')).toBe(false);
    });

    it('hides the nav badge when the total is zero', () => {
        applyMonitor({ state: 'running', queue: 0, active: 0 });
        expect($('engine-nav-badge').classList.contains('hidden')).toBe(true);
    });

    it('caps the nav badge display at 99+', () => {
        applyMonitor({ state: 'running', queue: 80, active: 30 });
        expect($('engine-nav-badge').textContent).toBe('99+');
    });
});

describe('stats bar', () => {
    it('paints file count, disk usage and group count from a stats_update push', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('stats_update', {
            stats: { totalFiles: 120, diskUsage: 2048, totalGroups: 4 },
        });
        expect($('status-files').textContent).toBe('120');
        expect($('status-disk').textContent).toBe('2048B');
        expect($('status-groups').textContent).toBe('4');
    });

    it('prefers a pre-formatted disk string when the server sends one', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('stats_update', { stats: { diskUsageFormatted: '2.0 GB' } });
        expect($('status-disk').textContent).toBe('2.0 GB');
    });

    it('accepts the legacy stats_push envelope shape', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('stats_push', { payload: { totalFiles: 7 } });
        expect($('status-files').textContent).toBe('7');
    });

    it('re-fetches stats on a WS reconnect', async () => {
        const { initStatusBar } = await loadStatusbar();
        api.get.mockClear();
        initStatusBar();
        api.get.mockClear();
        ws.emit('__ws_open');
        await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/stats'));
    });

    it('refreshes on relevant WS chatter but not on unrelated events', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('*', { type: 'download_complete' });
        expect(refreshMonitorStatus).toHaveBeenCalled();

        refreshMonitorStatus.mockClear();
        ws.emit('*', { type: 'some_chatty_event' });
        expect(refreshMonitorStatus).not.toHaveBeenCalled();
    });
});

describe('version chip', () => {
    it('renders the short commit and links to the GitHub commit', async () => {
        api.get.mockResolvedValue({ version: '2.5.0', commit: 'abc1234' });
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect($('status-version').textContent).toBe('v2.5.0 · abc1234'));
        expect($('status-version').href).toContain(
            'github.com/buluma/telegram-media-downloader/commit/abc1234',
        );
    });

    it('labels a dev build without linking to a commit', async () => {
        api.get.mockResolvedValue({ version: '2.5.0', commit: 'dev' });
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect($('status-version').textContent).toBe('v2.5.0 · dev'));
        expect($('status-version').getAttribute('href')).toBeNull();
    });

    it('repaints on config_updated', async () => {
        api.get.mockResolvedValue({ version: '1.0.0', commit: 'aaa' });
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect($('status-version').textContent).toContain('1.0.0'));
        api.get.mockResolvedValue({ version: '2.0.0', commit: 'bbb' });
        ws.emit('config_updated');
        await vi.waitFor(() => expect($('status-version').textContent).toContain('2.0.0'));
    });

    it('does not throw when the version endpoint fails', async () => {
        api.get.mockRejectedValue(new Error('down'));
        const { initStatusBar } = await loadStatusbar();
        expect(() => initStatusBar()).not.toThrow();
    });
});

describe('update-available chip', () => {
    it('shows the badge and toasts once when a newer version is available', async () => {
        api.get.mockImplementation((url) =>
            url === '/api/version/check'
                ? Promise.resolve({ updateAvailable: true, latest: '3.0.0' })
                : Promise.resolve({}),
        );
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() =>
            expect($('status-update-badge').classList.contains('hidden')).toBe(false),
        );
        expect($('status-update-badge').textContent).toContain('3.0.0');
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('3.0.0'),
            'info',
            expect.any(Number),
        );
    });

    it('hides the badge when no update is available', async () => {
        api.get.mockResolvedValue({ updateAvailable: false });
        const { initStatusBar } = await loadStatusbar();
        // Fixture markup already has the badge hidden, so hidden===true
        // would pass trivially without the guard ever running. Start it
        // visible so the assertion can only pass if hide() actually fires.
        $('status-update-badge').classList.remove('hidden');
        initStatusBar();
        await vi.waitFor(() =>
            expect($('status-update-badge').classList.contains('hidden')).toBe(true),
        );
    });

    it('respects a per-version dismissal in localStorage', async () => {
        localStorage.setItem('tgdl.update.dismissed', '3.0.0');
        api.get.mockImplementation((url) =>
            url === '/api/version/check'
                ? Promise.resolve({ updateAvailable: true, latest: '3.0.0' })
                : Promise.resolve({}),
        );
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/version/check'));
        // paintUpdateBadge's own await resumes on a later microtask than
        // the api.get call above, so give it one more tick before reading
        // the DOM. And assert on the badge TEXT, not just the hidden
        // class: the class starts as "hidden" in the fixture markup, so
        // asserting hidden===true is trivially satisfied by the initial
        // state and would pass even if the dismiss-check were deleted —
        // it needs a signal that can only be true once the code has run.
        await new Promise((r) => setTimeout(r, 0));
        expect($('status-update-badge').classList.contains('hidden')).toBe(true);
        expect($('status-update-badge').textContent).toBe('');
    });

    it('re-shows the badge for a version newer than the dismissed one', async () => {
        localStorage.setItem('tgdl.update.dismissed', '2.9.0');
        api.get.mockImplementation((url) =>
            url === '/api/version/check'
                ? Promise.resolve({ updateAvailable: true, latest: '3.0.0' })
                : Promise.resolve({}),
        );
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() =>
            expect($('status-update-badge').classList.contains('hidden')).toBe(false),
        );
    });

    it('only toasts once per version per session', async () => {
        sessionStorage.setItem('tgdl.update.toasted', '3.0.0');
        api.get.mockImplementation((url) =>
            url === '/api/version/check'
                ? Promise.resolve({ updateAvailable: true, latest: '3.0.0' })
                : Promise.resolve({}),
        );
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/version/check'));
        expect(showToast).not.toHaveBeenCalled();
    });

    it('dismissing persists the choice and hides the badge and its button', async () => {
        api.get.mockImplementation((url) =>
            url === '/api/version/check'
                ? Promise.resolve({ updateAvailable: true, latest: '3.0.0' })
                : Promise.resolve({}),
        );
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() =>
            expect($('status-update-dismiss').classList.contains('hidden')).toBe(false),
        );
        $('status-update-dismiss').click();
        expect($('status-update-badge').classList.contains('hidden')).toBe(true);
        expect($('status-update-dismiss').classList.contains('hidden')).toBe(true);
        expect(localStorage.getItem('tgdl.update.dismissed')).toBe('3.0.0');
    });
});

describe('WS connection indicator + offline banner', () => {
    it('turns the dot green and hides the banner on open', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        $('offline-banner').classList.remove('hidden');
        ws.emit('__ws_open');
        expect($('status-ws').className).toContain('bg-tg-green');
        expect($('offline-banner').classList.contains('hidden')).toBe(true);
    });

    it('turns the dot red on close and shows the banner after 5s', async () => {
        vi.useFakeTimers();
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('__ws_close');
        expect($('status-ws').className).toContain('bg-tg-red');
        expect($('offline-banner').classList.contains('hidden')).toBe(true);
        vi.advanceTimersByTime(5000);
        expect($('offline-banner').classList.contains('hidden')).toBe(false);
        expect($('offline-banner-text').textContent).toContain('reconnecting');
    });

    it('does not flash the banner on a close that reconnects within 5s', async () => {
        vi.useFakeTimers();
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('__ws_close');
        vi.advanceTimersByTime(2000);
        ws.emit('__ws_open');
        vi.advanceTimersByTime(5000);
        expect($('offline-banner').classList.contains('hidden')).toBe(true);
    });

    it('a second close before the debounce fires does not arm a stray extra timer', async () => {
        // The `if (!_offlineTimer)` guard exists so a rapid close/close
        // (flapping connection) only ever has ONE timer in flight. Without
        // it, the second close overwrites the tracked reference but leaves
        // the first timer running uncancelled — so a reconnect that clears
        // the (now second) timer cannot stop the leaked first one, and the
        // banner flashes on anyway after the original 5s elapses.
        vi.useFakeTimers();
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('__ws_close');
        vi.advanceTimersByTime(1000);
        ws.emit('__ws_close'); // should be a no-op while the first timer is pending
        vi.advanceTimersByTime(1000); // t=2000
        ws.emit('__ws_open'); // reconnect — must cancel every pending timer
        vi.advanceTimersByTime(5000); // past the original close's 5s mark
        expect($('offline-banner').classList.contains('hidden')).toBe(true);
    });

    it('escalates to the give-up state after too many reconnect attempts', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('__ws_giveup');
        expect($('offline-banner').classList.contains('hidden')).toBe(false);
        expect($('offline-banner-text').textContent).toContain('unreachable');
        expect($('status-ws').className).toContain('bg-tg-orange');
    });

    it('clicking the give-up dot retries the connection', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('__ws_giveup');
        $('status-ws').click();
        expect(ws.retry).toHaveBeenCalled();
        expect($('status-ws').className).toContain('bg-gray-500');
    });

    it('the offline banner retry button calls ws.retry and hides the banner', async () => {
        vi.useFakeTimers();
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('__ws_close');
        vi.advanceTimersByTime(5000);
        $('offline-banner-retry').click();
        expect($('offline-banner').classList.contains('hidden')).toBe(true);
        expect(ws.retry).toHaveBeenCalled();
    });

    it('applies the monitor_state push through the same state renderer', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('monitor_state', { state: 'error' });
        expect($('status-dot').className).toContain('bg-tg-red');
    });
});

describe('auto-update overlay + reconnect reload', () => {
    it('shows the full-screen overlay on update_started', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('update_started');
        expect(document.getElementById('tgdl-update-overlay')).not.toBeNull();
    });

    it('surfaces a structured error toast and tears down the overlay on update_done failure', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('update_started');
        ws.emit('update_done', { error: 'disk full', error_code: 'DISK_FULL' });
        expect(document.getElementById('tgdl-update-overlay')).toBeNull();
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('Update failed'),
            'error',
            expect.any(Number),
        );
    });

    it('does nothing on a successful update_done (no error)', async () => {
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        ws.emit('update_started');
        showToast.mockClear();
        ws.emit('update_done', {});
        expect(document.getElementById('tgdl-update-overlay')).not.toBeNull();
        expect(showToast).not.toHaveBeenCalled();
    });

    it('reloads the page when the version changes after a reconnect', async () => {
        vi.useFakeTimers();
        api.get.mockResolvedValue({ version: '1.0.0' });
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/version'));

        api.get.mockResolvedValue({ version: '2.0.0' });
        const reload = vi.fn();
        vi.stubGlobal('location', { ...location, reload });
        ws.emit('__ws_open');
        await vi.waitFor(() =>
            expect(showToast).toHaveBeenCalledWith(
                expect.stringContaining('2.0.0'),
                'success',
                expect.any(Number),
            ),
        );
        vi.advanceTimersByTime(1500);
        expect(reload).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('does not reload when the version is unchanged after a reconnect', async () => {
        api.get.mockResolvedValue({ version: '1.0.0' });
        const { initStatusBar } = await loadStatusbar();
        initStatusBar();
        await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/version'));
        showToast.mockClear();
        ws.emit('__ws_open');
        await new Promise((r) => setTimeout(r, 0));
        expect(showToast).not.toHaveBeenCalled();
    });
});

describe('_openUpdateChooser', () => {
    it('offers an install button when the watchtower sidecar is available', async () => {
        api.get.mockResolvedValue({ available: true, inDocker: true });
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', 'https://github.com/x/releases/tag/3.0.0');
        expect(openSheet).toHaveBeenCalled();
        const body = openSheet.mock.results[0].value.body;
        expect(body.querySelector('#upd-install-btn')).not.toBeNull();
    });

    it('disables install and explains why when watchtower is not configured', async () => {
        api.get.mockResolvedValue({ available: false, inDocker: true });
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', null);
        const body = openSheet.mock.results[0].value.body;
        expect(body.querySelector('#upd-install-btn')).toBeNull();
        expect(body.textContent).toContain('WATCHTOWER_HTTP_API_TOKEN');
    });

    it('explains the non-Docker case distinctly', async () => {
        api.get.mockResolvedValue({ available: false, inDocker: false });
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', null);
        const body = openSheet.mock.results[0].value.body;
        expect(body.textContent).toContain('outside Docker');
    });

    it('links to the release URL, falling back to the GitHub tag', async () => {
        api.get.mockResolvedValue({ available: false });
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', null);
        const body = openSheet.mock.results[0].value.body;
        const link = [...body.querySelectorAll('a')].find((a) => a.textContent.includes('release'));
        expect(link.getAttribute('href')).toContain('releases/tag/3.0.0');
    });

    it('confirms before installing, then posts and shows the overlay', async () => {
        api.get.mockResolvedValue({ available: true, inDocker: true });
        api.post.mockResolvedValue({});
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', null);
        const body = openSheet.mock.results[0].value.body;
        body.querySelector('#upd-install-btn').click();
        await vi.waitFor(() => expect(confirmSheet).toHaveBeenCalled());
        await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/update', {}));
        expect(document.getElementById('tgdl-update-overlay')).not.toBeNull();
    });

    it('does not install when the confirmation is declined', async () => {
        api.get.mockResolvedValue({ available: true, inDocker: true });
        confirmSheet.mockResolvedValue(false);
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', null);
        const body = openSheet.mock.results[0].value.body;
        body.querySelector('#upd-install-btn').click();
        await vi.waitFor(() => expect(confirmSheet).toHaveBeenCalled());
        expect(api.post).not.toHaveBeenCalled();
    });

    it('re-enables the install button and toasts on a failed install', async () => {
        api.get.mockResolvedValue({ available: true, inDocker: true });
        api.post.mockRejectedValue({ data: { error: 'busy' } });
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('3.0.0', null);
        const body = openSheet.mock.results[0].value.body;
        const btn = body.querySelector('#upd-install-btn');
        btn.click();
        await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('busy', 'error'));
        expect(btn.disabled).toBe(false);
    });

    // GitHub's release tag_name already carries a "v" prefix (e.g.
    // "v2.26.0") — production always calls this with that raw tag, unlike
    // every test above using a bare "3.0.0". The sheet title and install
    // button both hardcode their own literal "v", so passing the tag
    // through unstripped renders "vv2.26.0".
    it('does not double the "v" when the version already has one (real GitHub tag shape)', async () => {
        api.get.mockResolvedValue({ available: true, inDocker: true });
        const { _openUpdateChooser } = await loadStatusbar();
        await _openUpdateChooser('v2.26.0', 'https://github.com/x/releases/tag/v2.26.0');
        const { body, opts } = openSheet.mock.results[0].value;

        expect(opts.title).toBe('Update available — v2.26.0');
        expect(opts.title).not.toContain('vv');
        expect(body.querySelector('#upd-install-btn').textContent).toContain('Install v2.26.0');
        expect(body.querySelector('#upd-install-btn').textContent).not.toContain('vv');
    });
});
