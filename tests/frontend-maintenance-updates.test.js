// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-updates.js — the update history
// panel: stats tile (version / last-run / pending), the history table
// (status pill, version transition, error/backup cells, XSS escaping),
// the trigger button's up-to-date guard, and WS-driven auto-refresh.
//
// api.js, ws.js, statusbar.js (_openUpdateChooser) and showToast are
// mocked. i18n stays real for its synchronous fallback path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn() };
const showToast = vi.fn();
const openUpdateChooser = vi.fn();

function formatRelativeTime(iso) {
    return iso ? 'formatted-time' : '';
}

function makeFakeWs() {
    const handlers = new Map();
    return {
        on: vi.fn((type, fn) => {
            (handlers.get(type) || handlers.set(type, new Set()).get(type)).add(fn);
        }),
        emit: async (type, msg = {}) => {
            for (const fn of handlers.get(type) || []) await fn(msg);
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
vi.mock('../src/web/public/js/utils.js', () => ({ showToast, formatRelativeTime }));
vi.mock('../src/web/public/js/statusbar.js', () => ({
    _openUpdateChooser: openUpdateChooser,
}));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="page-maintenance-updates">
        <span id="updates-stat-version"></span>
        <span id="updates-stat-last"></span>
        <span id="updates-stat-pending" class="text-tg-text"></span>
        <div id="updates-status-card">
            <button id="updates-trigger-btn"></button>
        </div>
        <button id="updates-refresh-btn"></button>
        <div id="updates-history-list"></div>
    </div>
`;

const ENDPOINTS = {
    history: '/api/update/history?limit=25',
    status: '/api/update/status',
    version: '/api/version',
    check: '/api/version/check',
};

function defaults(over = {}) {
    return {
        [ENDPOINTS.history]: { history: [] },
        [ENDPOINTS.status]: { available: false },
        [ENDPOINTS.version]: { version: '2.5.0' },
        [ENDPOINTS.check]: { updateAvailable: false },
        ...over,
    };
}

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function loadModule(responses = defaults()) {
    vi.resetModules();
    ws = makeFakeWs();
    document.body.innerHTML = DOM;
    api.get.mockImplementation((url) => Promise.resolve(responses[url] ?? {}));
    return import('../src/web/public/js/maintenance-updates.js');
}

beforeEach(() => {
    vi.resetAllMocks();
});

describe('init', () => {
    it('does nothing when the page root is absent', async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        api.get.mockResolvedValue({});
        const { init } = await import('../src/web/public/js/maintenance-updates.js');
        await init();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('fetches status, version, history and check on boot', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.status]: { available: true } }));
        await init();
        await flush();
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.status);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.version);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.history);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.check);
    });

    it('does not probe /version/check when no update is available', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.status]: { available: false } }));
        await init();
        await flush();
        expect(api.get).not.toHaveBeenCalledWith(ENDPOINTS.check);
    });

    it('wires the refresh button and WS handlers exactly once across repeated init calls', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        api.get.mockClear();
        await init();
        await flush();
        const subs = ws.on.mock.calls.filter(([type]) => type === 'update_started');
        expect(subs).toHaveLength(1);
        api.get.mockClear();
        $('updates-refresh-btn').click();
        await flush();
        expect(api.get).toHaveBeenCalledTimes(1); // one _refresh(), not stacked handlers
    });
});

describe('stats tile', () => {
    it('shows the current version', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.version]: { version: '3.1.0' } }));
        await init();
        await flush();
        expect($('updates-stat-version').textContent).toBe('v3.1.0');
    });

    it('shows the em dash before the version call resolves, if it never resolves', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.version]: {} }));
        await init();
        await flush();
        expect($('updates-stat-version').textContent).toBe('—');
    });

    it('shows "Never" with no history', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.history]: { history: [] } }));
        await init();
        await flush();
        expect($('updates-stat-last').textContent).toBe('Never');
    });

    it('shows the formatted time of the most recent row', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.history]: { history: [{ created_at: '2026-01-01' }] } }),
        );
        await init();
        await flush();
        expect($('updates-stat-last').textContent).toBe('formatted-time');
    });

    it('shows "Up to date" and the neutral colour when nothing is pending', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.status]: { available: false } }));
        await init();
        await flush();
        const el = $('updates-stat-pending');
        expect(el.textContent).toBe('Up to date');
        expect(el.classList.contains('text-tg-text')).toBe(true);
        expect(el.classList.contains('text-tg-orange')).toBe(false);
    });

    it('shows the pending version in orange when one is available', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.status]: { available: true },
                [ENDPOINTS.check]: { updateAvailable: true, latest: '4.0.0' },
            }),
        );
        await init();
        await flush();
        const el = $('updates-stat-pending');
        expect(el.textContent).toBe('v4.0.0');
        expect(el.classList.contains('text-tg-orange')).toBe(true);
        expect(el.classList.contains('text-tg-text')).toBe(false);
    });
});

describe('history table rendering', () => {
    it('shows the empty state with no rows', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        expect($('updates-history-list').textContent).toContain('No updates have been triggered');
    });

    it('renders one row per history entry with a status pill', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.history]: {
                    history: [
                        { status: 'success', from_version: '2.0.0', to_version: '2.1.0' },
                        { status: 'failed', from_version: '2.0.0' },
                    ],
                },
            }),
        );
        await init();
        await flush();
        const rows = $('updates-history-list').querySelectorAll('tbody tr');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('v2.0.0 → v2.1.0');
        expect(rows[0].querySelector('span').className).toContain('bg-tg-green/15');
        expect(rows[1].querySelector('span').className).toContain('bg-tg-red/15');
    });

    it('shows the ellipsis target version for a non-success row', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.history]: {
                    history: [{ status: 'triggered', from_version: '1.0.0' }],
                },
            }),
        );
        await init();
        await flush();
        expect($('updates-history-list').textContent).toContain('v1.0.0');
        expect($('updates-history-list').textContent).not.toContain('→');
    });

    it('falls back to an unstyled pill for an unrecognised status', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.history]: { history: [{ status: 'weird_new_status' }] } }),
        );
        await init();
        await flush();
        const pill = $('updates-history-list').querySelector('span');
        expect(pill.className).toContain('bg-tg-bg/50');
        expect(pill.textContent).toBe('weird_new_status');
    });

    it('shows the translated error message and escapes both the code and message', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.history]: {
                    history: [
                        {
                            status: 'failed',
                            error_code: '<script>BAD_CODE</script>',
                            error_msg: '<img src=x onerror=alert(1)>',
                        },
                    ],
                },
            }),
        );
        await init();
        await flush();
        const html = $('updates-history-list').innerHTML;
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x onerror');
        expect(html).toContain('BAD_CODE'); // stripped of disallowed chars, code text kept
    });

    it('shows the backup filename and size, escaping a hostile path', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.history]: {
                    history: [
                        {
                            status: 'success',
                            backup_path: '/data/backups/<img src=x>evil.db',
                            backup_bytes: 2048,
                        },
                    ],
                },
            }),
        );
        await init();
        await flush();
        const list = $('updates-history-list');
        // The escaped entities in the source markup decode back to plain
        // characters once parsed into the DOM's title attribute — a quoted
        // attribute value doesn't need `<`/`>` escaping to stay safe, and
        // jsdom (matching real browsers) serialises it back unescaped on
        // .innerHTML read. That round-trip is not a vulnerability; what
        // matters is that no <img> element got created and the string
        // never broke out of the attribute (which an unescaped `"` would).
        expect(list.querySelectorAll('img')).toHaveLength(0);
        expect(list.querySelector('[title]').getAttribute('title')).toBe('<img src=x>evil.db');
        expect(list.textContent).toContain('evil.db');
        expect(list.textContent).toContain('2.0 KB');
    });

    it('omits the error/backup cells entirely when the fields are absent', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.history]: { history: [{ status: 'success' }] } }),
        );
        await init();
        await flush();
        const cells = $('updates-history-list').querySelectorAll('tbody tr td');
        expect(cells[3].innerHTML).toBe('');
        expect(cells[4].innerHTML).toBe('');
    });

    it('shows a load-failure message instead of throwing', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === ENDPOINTS.history
                ? Promise.reject(new Error('db locked'))
                : Promise.resolve({}),
        );
        await expect(init()).resolves.toBeUndefined();
        await flush();
        expect($('updates-history-list').textContent).toContain('db locked');
    });
});

describe('trigger button', () => {
    it('shows "Install vX" when an update is available', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.status]: { available: true },
                [ENDPOINTS.check]: { updateAvailable: true, latest: '5.0.0' },
            }),
        );
        await init();
        await flush();
        const btn = $('updates-trigger-btn');
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toContain('Install v5.0.0');
    });

    it('disables the button and shows "Up to date" when nothing is pending', async () => {
        const { init } = await loadModule(defaults({ [ENDPOINTS.status]: { available: false } }));
        await init();
        await flush();
        const btn = $('updates-trigger-btn');
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toContain('Install (unavailable)');
    });

    it('shows the up-to-date label when available but nothing newer exists', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.status]: { available: true },
                [ENDPOINTS.check]: { updateAvailable: false },
            }),
        );
        await init();
        await flush();
        const btn = $('updates-trigger-btn');
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toContain('Up to date');
    });

    it('opens the chooser sheet with the latest version when clicked', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.status]: { available: true },
                [ENDPOINTS.check]: { updateAvailable: true, latest: '5.0.0' },
            }),
        );
        await init();
        await flush();
        $('updates-trigger-btn').click();
        await flush();
        expect(openUpdateChooser).toHaveBeenCalledWith('5.0.0', null);
    });

    it('warns instead of opening the sheet when nothing is pending', async () => {
        // A `disabled` button never fires its click handler in a real
        // browser (jsdom matches that), so `available: false` — which
        // disables the button — can't reach the handler at all. The guard
        // this test targets is defensive code for a state the trigger
        // button itself normally prevents: `available: true` but
        // `_state.latest` never got set because /version/check failed,
        // which leaves the button enabled with default label/no data.
        const responses = defaults({ [ENDPOINTS.status]: { available: true } });
        const { init } = await loadModule(responses);
        // Calling defaults() fresh here (instead of reusing `responses`)
        // would silently reset status back to available:false and defeat
        // the scenario this test needs.
        api.get.mockImplementation((url) =>
            url === ENDPOINTS.check
                ? Promise.reject(new Error('down'))
                : Promise.resolve(responses[url] ?? {}),
        );
        await init();
        await flush();
        $('updates-trigger-btn').click();
        await flush();
        expect(openUpdateChooser).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Already running the latest release.', 'info', 4000);
    });

    it('toasts an error if the chooser sheet throws', async () => {
        openUpdateChooser.mockRejectedValue(new Error('sheet failed'));
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.status]: { available: true },
                [ENDPOINTS.check]: { updateAvailable: true, latest: '5.0.0' },
            }),
        );
        await init();
        await flush();
        $('updates-trigger-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('sheet failed', 'error');
    });
});

describe('WS-driven auto-refresh', () => {
    it('refreshes the history on update_started and update_done', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        api.get.mockClear();
        await ws.emit('update_started');
        await flush();
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.history);
        api.get.mockClear();
        await ws.emit('update_done');
        await flush();
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.history);
    });
});
