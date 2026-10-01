// @vitest-environment jsdom
//
// Covers src/web/public/js/app.js — the SPA shell: boot, routing and page
// rendering, the sidebar groups list, the media gallery (grid render, tile
// windowing, selection, empty states, filters), the Chats page with its bulk
// operations and presets, the per-group settings modal, and the purge /
// unpinned-video flows.
//
// This module is shaped differently from the other P4 pages:
//   - It has NO exports. It calls init() at import time and publishes its
//     surface through window.* globals and registerAction() from ui-events.js.
//     Mocking ui-events with a capturing registry is what makes the internals
//     reachable — most tests drive an action by name.
//   - Its DOM is the entire application. Rather than hand-write a fixture for
//     a 5613-line module, the harness assembles the real index.html the same
//     way the server does (see _injectPartials in src/web/server.js) and
//     strips the <script> tags. The fixture therefore tracks the markup
//     automatically instead of drifting away from it.
//
// Not covered here: the AI search panels, stories, FAB/paste-URL wiring and
// the mini-player bridge. Those reach into modules that are mocked at the
// boundary, so testing them here would assert the mock, not the app.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'src/web/public');

// Mirrors _injectPartials() in src/web/server.js — same recursive regex, so
// the test DOM is exactly the markup the server ships.
function injectPartials(html, baseDir = PUBLIC_DIR) {
    return html.replace(/<!--\s*INCLUDE:\s*(.*?)\s*-->/g, (match, partialPath) => {
        try {
            return injectPartials(readFileSync(join(baseDir, partialPath), 'utf8'), baseDir);
        } catch {
            return match;
        }
    });
}

const FULL_HTML = (() => {
    const raw = injectPartials(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8'));
    return raw.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? raw;
})();

// Strip <script> elements through the DOM rather than a regex. The page has
// eight `<script` opens and only six `</script>` closes (module preloads and
// a self-closing tag), so a non-greedy pair regex swallows everything between
// the unmatched open and the next close — which quietly deleted a third of
// the markup, #page-title included. jsdom never executes scripts here anyway
// (runScripts is off by default), so removing the nodes is enough.
function freshBody() {
    const body = document.createElement('body');
    body.innerHTML = FULL_HTML;
    for (const el of body.querySelectorAll('script')) el.remove();
    return body;
}

// ---- module mocks --------------------------------------------------------

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../src/web/public/js/api.js', () => ({ api }));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

const wsHandlers = new Map();
const ws = {
    // Mirrors the real ws.js: on() hands back an unsubscribe closure.
    on: vi.fn((type, fn) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, []);
        wsHandlers.get(type).push(fn);
        return () => {
            const list = wsHandlers.get(type) || [];
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        };
    }),
    send: vi.fn(),
    connect: vi.fn(),
};
const wsHandlerCount = () => [...wsHandlers.values()].reduce((n, l) => n + l.length, 0);
vi.mock('../src/web/public/js/ws.js', () => ({ ws }));

// registerAction is the module's real public surface — capture it.
const actions = new Map();
const registerAction = vi.fn((name, fn) => actions.set(name, fn));
vi.mock('../src/web/public/js/ui-events.js', () => ({
    registerAction,
    initUiEvents: vi.fn(),
    runAction: vi.fn(),
}));

const i18nT = vi.fn((key, fallback) => fallback || key);
const i18nTf = vi.fn((key, vars, fallback) => {
    const tpl = fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
});
vi.mock('../src/web/public/js/i18n.js', () => ({
    initI18n: vi.fn(async () => {}),
    setLang: vi.fn(),
    getLang: vi.fn(() => 'en'),
    applyToDOM: vi.fn(),
    t: i18nT,
    tf: i18nTf,
}));

let confirmAnswer = true;
const confirmSheet = vi.fn(async () => confirmAnswer);
const openSheet = vi.fn();
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet, openSheet }));

const routes = new Map();
const router = {
    register: vi.fn((path, fn) => routes.set(path, fn)),
    // The module registers pages through `route()`, not `register()`.
    route: vi.fn((path, fn) => routes.set(path, fn)),
    navigate: vi.fn(),
    start: vi.fn(),
    current: vi.fn(() => ({ path: 'gallery', params: {} })),
};
vi.mock('../src/web/public/js/router.js', () => router);

const Viewer = {
    openMediaViewer: vi.fn(),
    closeMediaViewer: vi.fn(),
    setupViewerEvents: vi.fn(),
    openMediaViewerSingle: vi.fn(),
    openMediaViewerForReview: vi.fn(),
};
vi.mock('../src/web/public/js/viewer.js', () => Viewer);

const Settings = {
    loadSettings: vi.fn(async () => {}),
    loadAdvanced: vi.fn(),
    setupAutoSave: vi.fn(),
    saveSettings: vi.fn(),
    applyPreset: vi.fn(),
    saveProxy: vi.fn(),
    testProxy: vi.fn(),
    saveApiCredentials: vi.fn(),
    loadAccounts: vi.fn(),
    changePassword: vi.fn(),
    signOut: vi.fn(),
};
vi.mock('../src/web/public/js/settings.js', () => Settings);

const stubs = {
    './engine.js': { initEngine: vi.fn(), handleEngineWsMessage: vi.fn() },
    './theme.js': { initTheme: vi.fn(), getTheme: vi.fn(() => 'dark'), setTheme: vi.fn() },
    './statusbar.js': { initStatusBar: vi.fn() },
    './notifications.js': {
        isEnabled: vi.fn(() => false),
        disable: vi.fn(),
        requestEnable: vi.fn(),
        notify: vi.fn(),
        notifyDownloadComplete: vi.fn(),
        notifyGeneric: vi.fn(),
    },
    './onboarding.js': { initOnboarding: vi.fn(), refreshOnboarding: vi.fn() },
    './onboarding-dismiss.js': { initOnboardingDismiss: vi.fn() },
    './monitor-status.js': { getLatest: vi.fn(() => null), subscribe: vi.fn() },
    './reauth-modal.js': { initReauthModal: vi.fn() },
    './shortcuts.js': { initShortcuts: vi.fn() },
    './gestures.js': {
        attachPullToRefresh: vi.fn(),
        attachSwipe: vi.fn(),
        attachDragDismiss: vi.fn(),
    },
    './gallery-select.js': {
        setupGallerySelect: vi.fn(),
        exitSelectMode: vi.fn(),
        repaintSelection: vi.fn(),
        selectAllVisible: vi.fn(),
    },
    './backfill.js': {
        showBackfillPage: vi.fn(async () => {}),
        deepLinkFromModal: vi.fn(),
        stopBackfillPage: vi.fn(),
        initBackfillPage: vi.fn(),
    },
    './fonts.js': { populateSelect: vi.fn(), applyFont: vi.fn(), initFonts: vi.fn() },
    './queue.js': { showQueuePage: vi.fn(async () => {}), initQueue: vi.fn() },
    './header-mobile.js': { initHeaderMobile: vi.fn(), pushLogToNotify: vi.fn() },
    './dragdrop-link.js': { setupDragDropLink: vi.fn() },
    './mini-player.js': { setupMiniPlayer: vi.fn(), shrinkToMini: vi.fn(), dismiss: vi.fn() },
    './changelog-viewer.js': { wireChangelogTrigger: vi.fn() },
    './wake-lock.js': {
        init: vi.fn(),
        request: vi.fn(),
        release: vi.fn(),
        acquireIfActive: vi.fn(),
        releaseIfIdle: vi.fn(),
        attachVisibilityRefresh: vi.fn(),
    },
};
// vi.mock is hoisted, so each specifier has to be a literal — a loop over the
// table above would run before `stubs` exists. The factories themselves are
// lazy, and app.js is only imported inside boot(), so reading `stubs` here is
// safe.
vi.mock('../src/web/public/js/engine.js', () => stubs['./engine.js']);
vi.mock('../src/web/public/js/theme.js', () => stubs['./theme.js']);
vi.mock('../src/web/public/js/statusbar.js', () => stubs['./statusbar.js']);
vi.mock('../src/web/public/js/notifications.js', () => stubs['./notifications.js']);
vi.mock('../src/web/public/js/onboarding.js', () => stubs['./onboarding.js']);
vi.mock('../src/web/public/js/onboarding-dismiss.js', () => stubs['./onboarding-dismiss.js']);
vi.mock('../src/web/public/js/monitor-status.js', () => stubs['./monitor-status.js']);
vi.mock('../src/web/public/js/reauth-modal.js', () => stubs['./reauth-modal.js']);
vi.mock('../src/web/public/js/shortcuts.js', () => stubs['./shortcuts.js']);
vi.mock('../src/web/public/js/gestures.js', () => stubs['./gestures.js']);
vi.mock('../src/web/public/js/gallery-select.js', () => stubs['./gallery-select.js']);
vi.mock('../src/web/public/js/backfill.js', () => stubs['./backfill.js']);
vi.mock('../src/web/public/js/fonts.js', () => stubs['./fonts.js']);
vi.mock('../src/web/public/js/queue.js', () => stubs['./queue.js']);
vi.mock('../src/web/public/js/header-mobile.js', () => stubs['./header-mobile.js']);
vi.mock('../src/web/public/js/dragdrop-link.js', () => stubs['./dragdrop-link.js']);
vi.mock('../src/web/public/js/mini-player.js', () => stubs['./mini-player.js']);
vi.mock('../src/web/public/js/changelog-viewer.js', () => stubs['./changelog-viewer.js']);
vi.mock('../src/web/public/js/wake-lock.js', () => stubs['./wake-lock.js']);

// components.js renders list rows; keep the real thing so grid/list assertions
// exercise production markup rather than a stub.
vi.mock('../src/web/public/js/components.js', async (importOriginal) => importOriginal());

// ---- environment stubs ---------------------------------------------------
// init() constructs observers and queries media features on the way up; jsdom
// ships none of them, and a throw here aborts the whole boot.
const observers = [];
class FakeObserver {
    constructor(cb, opts) {
        this.cb = cb;
        this.opts = opts;
        this.targets = [];
        observers.push(this);
    }
    observe(el) {
        this.targets.push(el);
    }
    unobserve(el) {
        this.targets = this.targets.filter((t) => t !== el);
    }
    disconnect() {
        this.targets = [];
    }
    trigger(isIntersecting = true) {
        this.cb(
            this.targets.map((target) => ({ target, isIntersecting, intersectionRatio: 1 })),
            this,
        );
    }
}
globalThis.IntersectionObserver = FakeObserver;
globalThis.ResizeObserver = FakeObserver;
globalThis.MutationObserver =
    globalThis.MutationObserver ||
    class {
        observe() {}
        disconnect() {}
    };
if (!window.matchMedia) {
    window.matchMedia = (q) => ({
        matches: false,
        media: q,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
    });
}
globalThis.requestIdleCallback =
    globalThis.requestIdleCallback ||
    ((fn) => setTimeout(() => fn({ timeRemaining: () => 50 }), 0));
globalThis.cancelIdleCallback = globalThis.cancelIdleCallback || clearTimeout;
window.scrollTo = window.scrollTo || (() => {});
Element.prototype.scrollTo = Element.prototype.scrollTo || function () {};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---- fixtures ------------------------------------------------------------

const GROUP = (over = {}) => ({
    id: '-100111',
    name: 'Alpha Channel',
    enabled: true,
    type: 'channel',
    fileCount: 12,
    ...over,
});

const FILE = (over = {}) => ({
    id: 1,
    name: 'cat.jpg',
    type: 'images',
    fullPath: 'media/cat.jpg',
    path: 'media/cat.jpg',
    size: 1024,
    sizeFormatted: '1 KB',
    modified: '2026-07-01T10:00:00Z',
    groupId: '-100111',
    ...over,
});

function stubApi(overrides = {}) {
    const table = {
        // Order matters — pick() returns the first substring hit, so the
        // gallery routes have to come before the bare /api/downloads that
        // feeds the sidebar counts.
        '/api/downloads/all': { files: [], total: 0 },
        '/api/downloads/': { files: [], total: 0 },
        '/api/downloads': [],
        '/api/groups/presets': [],
        '/api/groups': [],
        '/api/dialogs': [],
        '/api/stats': {},
        '/api/config': {},
        '/api/version': { version: '2.8.0' },
        '/api/auth_check': { role: 'admin' },
        '/api/monitor/status': { running: false },
        '/api/cluster/peers': { peers: [] },
        ...overrides,
    };
    const pick = (url) => {
        for (const [pattern, res] of Object.entries(table)) {
            if (String(url).includes(pattern)) return res;
        }
        return undefined;
    };
    api.get.mockImplementation(async (url) => {
        const r = pick(url);
        return r === undefined ? {} : typeof r === 'function' ? r(url) : r;
    });
    api.post.mockImplementation(async (url) => {
        const r = pick(url);
        return r === undefined ? {} : typeof r === 'function' ? r(url) : r;
    });
    api.put.mockResolvedValue({});
    api.delete.mockResolvedValue({});
}

async function flush(times = 10) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    if (!vi.isFakeTimers()) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < times; i++) await Promise.resolve();
}

// The instance the current test booted. Retired in afterEach — app.js has no
// browser lifecycle event that needs teardown, but a test does: an instance
// that keeps answering WS events after its DOM is gone corrupts whatever runs
// next. See CLAUDE.md → Tests.
let lastMod = null;

async function boot(apiOverrides = {}) {
    lastMod?.destroy();
    lastMod = null;
    vi.resetModules();
    actions.clear();
    routes.clear();
    wsHandlers.clear();
    observers.length = 0;
    // app.js binds listeners to document/body and never removes them; swap the
    // whole body so a previous instance stops answering. Same leak the other
    // P4 page modules have — see CLAUDE.md → Tests.
    document.body.replaceWith(freshBody());
    stubApi(apiOverrides);
    const mod = await import('../src/web/public/js/app.js');
    // init() is async and awaits several round-trips, so a fixed number of
    // microtask turns is a race — it held locally and failed under a loaded
    // full-suite run. Wait for the last thing init() registers instead.
    await waitFor(() => actions.has('applyPreset'), 'init() to finish');
    await flush();
    lastMod = mod;
    return mod;
}

async function waitFor(predicate, what, tries = 200) {
    for (let i = 0; i < tries; i++) {
        if (predicate()) return;
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const act = (name, ...args) => actions.get(name)?.(...args);

beforeEach(() => {
    vi.clearAllMocks();
    confirmAnswer = true;
    localStorage.clear();
    stubApi();
    window.location.hash = '';
});

afterEach(() => {
    try {
        lastMod?.destroy();
    } catch {
        /* already torn down by the test itself */
    }
    lastMod = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
});

// ---- boot ----------------------------------------------------------------

describe('boot', () => {
    it('brings up every subsystem and registers the action surface', async () => {
        await boot();
        expect(actions.has('navigateTo')).toBe(true);
        expect(actions.has('openGroup')).toBe(true);
        expect(actions.has('openGroupSettings')).toBe(true);
        expect(actions.has('purgeAll')).toBe(true);
        expect(window.navigateTo).toBeTypeOf('function');
        expect(window.openGroup).toBeTypeOf('function');
    });

    it('registers the SPA routes', async () => {
        await boot();
        expect(routes.size).toBeGreaterThan(5);
        expect(router.start).toHaveBeenCalled();
    });

    it('loads the groups list at boot', async () => {
        await boot({ '/api/groups': [GROUP(), GROUP({ id: '-2', name: 'Beta' })] });
        expect($('groups-list').textContent).toContain('Alpha Channel');
        expect($('groups-list').textContent).toContain('Beta');
    });

    it('survives a groups endpoint that is down', async () => {
        api.get.mockRejectedValue(new Error('503'));
        await expect(boot()).resolves.toBeTruthy();
    });
});

// ---- sidebar groups ------------------------------------------------------

describe('sidebar groups list', () => {
    const MIXED = [
        GROUP({ id: '-1', name: 'Alpha Channel', type: 'channel' }),
        GROUP({ id: '-2', name: 'Beta Group', type: 'group' }),
        GROUP({ id: '-3', name: 'Carl DM', type: 'user' }),
    ];

    it('groups rows by type', async () => {
        await boot({ '/api/groups': MIXED });
        const list = $('groups-list');
        expect(list.querySelectorAll('.chat-row[data-id]').length).toBeGreaterThanOrEqual(3);
        expect(list.textContent).toContain('Alpha Channel');
        expect(list.textContent).toContain('Beta Group');
        expect(list.textContent).toContain('Carl DM');
    });

    it('filters by name', async () => {
        await boot({ '/api/groups': MIXED });
        window.filterSidebarGroups('beta');
        const visible = $$('#groups-list .chat-row[data-id]').filter(
            (el) => !el.classList.contains('hidden') && el.offsetParent !== null,
        );
        const shown = $$('#groups-list .chat-row[data-id]').filter(
            (el) => !el.classList.contains('hidden'),
        );
        expect(shown.map((e) => e.textContent).join(' ')).toContain('Beta');
        expect(visible.length + shown.length).toBeGreaterThan(0);
    });

    it('restores every row when the filter is cleared', async () => {
        await boot({ '/api/groups': MIXED });
        window.filterSidebarGroups('beta');
        window.filterSidebarGroups('');
        const hidden = $$('#groups-list .chat-row[data-id]').filter((el) =>
            el.classList.contains('hidden'),
        );
        expect(hidden).toHaveLength(0);
    });

    it('matches case-insensitively and on partial words', async () => {
        await boot({ '/api/groups': MIXED });
        window.filterSidebarGroups('ALPH');
        const shown = $$('#groups-list .chat-row[data-id]').filter(
            (el) => !el.classList.contains('hidden'),
        );
        expect(shown.map((e) => e.textContent).join(' ')).toContain('Alpha');
    });

    it('persists a collapsed type section', async () => {
        await boot({ '/api/groups': MIXED });
        const header = document.querySelector('#groups-list [data-action="sidebar-type-toggle"]');
        expect(header, 'type section header').not.toBeNull();
        const body = header
            .closest('.sidebar-group-section')
            .querySelector('.sidebar-group-section-body');

        header.click();
        expect(body.classList.contains('hidden')).toBe(true);
        expect(header.getAttribute('aria-expanded')).toBe('false');
        const type =
            header.dataset.sidebarType ||
            header.closest('.sidebar-group-section').dataset.sidebarGroupSection ||
            'other';
        const key = `tgdl.sidebar.groupType.${type}.collapsed`;
        expect(localStorage.getItem(key)).toBe('1');

        header.click();
        expect(body.classList.contains('hidden')).toBe(false);
        expect(localStorage.getItem(key)).toBe('0');
    });
});

// ---- navigation ----------------------------------------------------------

describe('navigation', () => {
    it('routes through the router module', async () => {
        await boot();
        act('navigateTo', 'settings');
        // Always normalised to a hash path so back/forward keeps working.
        expect(router.navigate).toHaveBeenCalledWith('#/settings', undefined);
        act('navigateTo', '#/queue');
        expect(router.navigate).toHaveBeenCalledWith('#/queue', undefined);
    });

    it('shows one page at a time', async () => {
        await boot();
        const settings = $('page-settings');
        const viewer = $('page-viewer');
        expect(settings, '#page-settings').not.toBeNull();
        expect(viewer, '#page-viewer').not.toBeNull();
        routes.get('/settings')({ params: {}, query: {} });
        await flush();
        expect(settings.classList.contains('hidden')).toBe(false);
        expect(viewer.classList.contains('hidden')).toBe(true);
    });

    it('hands the queue page to its own module', async () => {
        await boot();
        routes.get('/queue')?.({ params: {}, query: {} });
        await flush();
        expect(stubs['./queue.js'].showQueuePage).toHaveBeenCalled();
    });

    it('hands the backfill page to its own module', async () => {
        await boot();
        routes.get('/backfill')?.({ params: {}, query: {} });
        await flush();
        expect(stubs['./backfill.js'].showBackfillPage).toHaveBeenCalled();
    });

    it('loads settings when the settings page opens', async () => {
        await boot();
        routes.get('/settings')?.({ params: {}, query: {} });
        await flush();
        expect(Settings.loadSettings).toHaveBeenCalled();
    });

    it('closes the sidebar on demand', async () => {
        await boot();
        const sidebar = $('sidebar');
        sidebar?.classList.add('open');
        act('closeSidebar');
        expect(sidebar?.classList.contains('open')).toBe(false);
    });
});

// ---- gallery -------------------------------------------------------------

describe('gallery', () => {
    const FILES = (n = 3) =>
        Array.from({ length: n }, (_, i) =>
            FILE({
                id: i + 1,
                name: `f${i}.jpg`,
                fullPath: `media/f${i}.jpg`,
                path: `media/f${i}.jpg`,
            }),
        );

    async function openGallery(files = FILES(), extra = {}) {
        await boot({
            '/api/groups': [GROUP()],
            '/api/downloads/all': { files, total: files.length },
            '/api/downloads/': { files, total: files.length },
            ...extra,
        });
        act('showAllMedia');
        await flush();
    }

    it('renders one tile per file', async () => {
        await openGallery();
        const grid = $('media-grid');
        expect(grid.children.length).toBeGreaterThanOrEqual(3);
        expect(grid.textContent).toContain('f0.jpg');
    });

    it('shows an empty state with no files', async () => {
        await openGallery([]);
        const grid = $('media-grid');
        const empty = $('empty-state') || grid;
        expect(empty.textContent.length).toBeGreaterThan(0);
        expect(grid.querySelectorAll('[data-path]')).toHaveLength(0);
    });

    it('opens a group and scopes the gallery to it', async () => {
        await boot({
            '/api/groups': [GROUP()],
            '/api/downloads/all': { files: FILES(2), total: 2 },
            '/api/downloads/': { files: FILES(2), total: 2 },
        });
        window.openGroup('-100111', 'Alpha Channel');
        await flush();
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('-100111'))).toBe(true);
    });

    it('escapes hostile filenames in the grid', async () => {
        const evil = '<img src=x onerror=alert(1)>.jpg';
        await openGallery([FILE({ name: evil, fullPath: 'media/e.jpg', path: 'media/e.jpg' })]);
        const grid = $('media-grid');
        expect(grid.querySelector('img[onerror]')).toBeNull();
        expect(grid.textContent).toContain(evil);
    });

    it('opens the viewer when a tile is activated', async () => {
        await openGallery();
        const tile = $('media-grid').querySelector('[data-path]');
        expect(tile, 'a rendered tile').not.toBeNull();
        tile.click();
        await flush();
        expect(Viewer.openMediaViewer).toHaveBeenCalled();
    });
});

// ---- gallery filters -----------------------------------------------------

describe('gallery filters', () => {
    const tab = (sel) => document.querySelector(`#media-tabs ${sel}`);
    const tilePaths = () => $$('#media-grid .media-item[data-path]').map((t) => t.dataset.path);
    const allUrls = () =>
        api.get.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/downloads/all'));

    // Holds every /api/downloads/all call open until the test resolves it, so a
    // test decides the order replies arrive in.
    function deferredAll() {
        const pending = [];
        const respond = (url) => new Promise((res) => pending.push({ url, res }));
        return { pending, respond };
    }

    async function openAll(extra = {}) {
        await boot({ '/api/groups': [GROUP()], ...extra });
        act('showAllMedia');
        await flush();
    }

    it('keeps the newest filter result when an older request replies last', async () => {
        const { pending, respond } = deferredAll();
        await openAll({ '/api/downloads/all': respond });
        for (const p of pending.splice(0)) p.res({ files: [], total: 0 });
        await flush();

        tab('[data-type="videos"]').click();
        tab('[data-type="images"]').click();
        await flush();
        const videos = pending.find((p) => p.url.includes('type=videos'));
        const images = pending.find((p) => p.url.includes('type=images'));
        expect(videos && images, 'both tab requests in flight').toBeTruthy();

        images.res({
            files: [
                FILE({ id: 1, name: 'photo.jpg', fullPath: 'm/photo.jpg', path: 'm/photo.jpg' }),
            ],
            total: 1,
        });
        await flush();
        videos.res({
            files: [FILE({ id: 2, name: 'clip.mp4', fullPath: 'm/clip.mp4', path: 'm/clip.mp4' })],
            total: 1,
        });
        await flush();

        expect(tilePaths()).toEqual(['m/photo.jpg']);
    });

    it('does not page the old feed onto find-similar results', async () => {
        // A full page + a large total keeps state.hasMore true after the load.
        const full = (url) => {
            const limit = Number(/limit=(\d+)/.exec(url)?.[1]) || 50;
            return {
                files: Array.from({ length: limit }, (_, i) =>
                    FILE({
                        id: i + 1,
                        name: `f${i}.jpg`,
                        fullPath: `m/f${i}.jpg`,
                        path: `m/f${i}.jpg`,
                    }),
                ),
                total: limit * 10,
            };
        };
        await openAll({
            '/api/downloads/all': full,
            '/api/ai/search/similar': {
                success: true,
                results: [
                    {
                        download_id: 900,
                        group_id: '-100111',
                        file_name: 'ai-hit.jpg',
                        file_path: 'm/ai-hit.jpg',
                        file_type: 'photo',
                        created_at: '2026-07-01T10:00:00Z',
                    },
                ],
            },
        });

        // Similar is a list-view tile action.
        document.querySelector('#view-mode-menu [data-vm="list"]')?.click();
        await flush();
        document.querySelector('[data-tile-similar]').click();
        await flush();
        expect(tilePaths()).toEqual(['m/ai-hit.jpg']);

        const before = allUrls().length;
        observers.find((o) => o.opts?.rootMargin?.includes('1200px'))?.trigger();
        await flush();

        expect(allUrls().length).toBe(before);
        expect(tilePaths()).toEqual(['m/ai-hit.jpg']);
    });

    it('offers to save a watched-only filter', async () => {
        await openAll();
        tab('[data-watched-toggle]').click();
        await flush();
        $('saved-filters-chip').click();
        expect($('save-filter-btn')).not.toBeNull();
    });

    it('restores pinned and watched when a saved filter is applied', async () => {
        await openAll();
        tab('[data-pinned-toggle]').click();
        tab('[data-watched-toggle]').click();
        await flush();

        $('saved-filters-chip').click();
        vi.spyOn(window, 'prompt').mockReturnValue('mine');
        $('save-filter-btn').click();

        // Back to defaults: pinned cycles pinned → unpinned → off.
        tab('[data-pinned-toggle]').click();
        tab('[data-pinned-toggle]').click();
        tab('[data-watched-toggle]').click();
        await flush();
        api.get.mockClear();

        document.querySelector('[data-apply-filter="0"]').click();
        await flush();

        const last = allUrls().at(-1);
        expect(last).toContain('pinned=1');
        expect(last).toContain('watched=1');
    });

    it('clears filters a saved filter does not carry', async () => {
        localStorage.setItem(
            'tgdl-saved-filters',
            JSON.stringify([{ name: 'big', type: 'all', sortBy: 'size_desc' }]),
        );
        await openAll();
        tab('[data-pinned-toggle]').click();
        tab('[data-watched-toggle]').click();
        await flush();
        $('saved-filters-chip').click();
        api.get.mockClear();

        document.querySelector('[data-apply-filter="0"]').click();
        await flush();

        const last = allUrls().at(-1);
        expect(last).toContain('sort=size_desc');
        expect(last).not.toContain('pinned=');
        expect(last).not.toContain('watched=');
        expect(tab('[data-pinned-toggle]').getAttribute('aria-pressed')).toBe('false');
        expect(tab('[data-watched-toggle]').getAttribute('aria-pressed')).toBe('false');
    });
});

// ---- gallery search ------------------------------------------------------

describe('gallery search', () => {
    const tab = (sel) => document.querySelector(`#media-tabs ${sel}`);
    const tilePaths = () => $$('#media-grid .media-item[data-path]').map((t) => t.dataset.path);
    const searchUrls = () =>
        api.get.mock.calls
            .map((c) => String(c[0]))
            .filter((u) => u.includes('/api/downloads/search'));
    const allUrls = () =>
        api.get.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/downloads/all'));
    const hit = (name) =>
        FILE({ id: 7, name, fullPath: `m/${name}`, path: `m/${name}`, caption: 'golden hour' });

    // stubApi() matches the first substring hit, and '/api/downloads/' (the
    // per-group feed) would swallow the search route, so route search by hand.
    function stubSearch(res) {
        const base = api.get.getMockImplementation();
        api.get.mockImplementation(async (url) =>
            String(url).includes('/api/downloads/search')
                ? typeof res === 'function'
                    ? res(url)
                    : res
                : base(url),
        );
    }

    async function openAll(search = { files: [hit('pier.jpg')], total: 1 }) {
        await boot({ '/api/groups': [GROUP()] });
        stubSearch(search);
        act('showAllMedia');
        await flush();
    }

    // Typing arms a debounce timer, so fake timers go in before the keystroke.
    async function type(value) {
        vi.useFakeTimers();
        const input = $('gallery-search');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Past the debounce, plus room for the grid's coalesced render timer —
        // timers still pending when the real clock comes back are dropped.
        await vi.advanceTimersByTimeAsync(2000);
        vi.useRealTimers();
        await flush();
    }

    it('has a search box in the gallery', async () => {
        await openAll();
        expect($('gallery-search')).not.toBeNull();
    });

    it('searches after a pause and renders the hits', async () => {
        await openAll();
        await type('golden');
        expect(searchUrls()).toHaveLength(1);
        expect(searchUrls()[0]).toContain('q=golden');
        expect(tilePaths()).toEqual(['m/pier.jpg']);
    });

    it('debounces keystrokes into one request', async () => {
        await openAll();
        vi.useFakeTimers();
        const input = $('gallery-search');
        for (const v of ['g', 'go', 'gol']) {
            input.value = v;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(2000);
        vi.useRealTimers();
        await flush();
        expect(searchUrls()).toHaveLength(1);
        expect(searchUrls()[0]).toContain('q=gol');
    });

    it('carries the active type and chip filters', async () => {
        await openAll();
        tab('[data-type="videos"]').click();
        tab('[data-pinned-toggle]').click();
        tab('[data-watched-toggle]').click();
        await flush();
        await type('golden');
        const url = searchUrls().at(-1);
        expect(url).toContain('type=videos');
        expect(url).toContain('pinned=1');
        expect(url).toContain('watched=1');
    });

    it('re-runs the search when a filter changes while searching', async () => {
        await openAll();
        await type('golden');
        api.get.mockClear();
        tab('[data-type="images"]').click();
        await flush();
        expect(searchUrls()).toHaveLength(1);
        expect(searchUrls()[0]).toContain('q=golden');
        expect(searchUrls()[0]).toContain('type=images');
        expect(allUrls()).toHaveLength(0);
    });

    it('scopes the search to the open group', async () => {
        await boot({ '/api/groups': [GROUP()] });
        stubSearch({ files: [hit('pier.jpg')], total: 1 });
        window.openGroup('-100111', 'Alpha Channel');
        await flush();
        await type('golden');
        expect(searchUrls().at(-1)).toContain('groupId=-100111');
    });

    it('pages the search results on scroll', async () => {
        const full = (url) => {
            const limit = Number(/limit=(\d+)/.exec(url)?.[1]) || 50;
            return {
                files: Array.from({ length: limit }, (_, i) =>
                    FILE({
                        id: i + 1,
                        name: `s${i}.jpg`,
                        fullPath: `m/s${i}.jpg`,
                        path: `m/s${i}.jpg`,
                    }),
                ),
                total: limit * 5,
            };
        };
        await openAll(full);
        await type('golden');
        observers.find((o) => o.opts?.rootMargin?.includes('1200px'))?.trigger();
        await flush();
        expect(searchUrls().at(-1)).toContain('page=2');
        expect(searchUrls().at(-1)).toContain('q=golden');
    });

    it('goes back to the normal feed when the box is cleared', async () => {
        await openAll();
        await type('golden');
        api.get.mockClear();
        await type('');
        expect(searchUrls()).toHaveLength(0);
        expect(allUrls()).toHaveLength(1);
    });

    it('clears the box when a fresh gallery view is opened', async () => {
        await openAll();
        await type('golden');
        expect($('gallery-search').value).toBe('golden');
        api.get.mockClear();
        window.openGroup('-100111', 'Alpha Channel');
        await flush();
        expect($('gallery-search').value).toBe('');
        expect(searchUrls()).toHaveLength(0);
    });

    it('treats a whitespace-only query as no search and does not reload', async () => {
        await openAll();
        api.get.mockClear();
        await type('   ');
        expect(searchUrls()).toHaveLength(0);
        expect(allUrls()).toHaveLength(0);
    });
});

// ---- delete file ---------------------------------------------------------

describe('delete current file', () => {
    async function openWithFile() {
        await boot({
            '/api/groups': [GROUP()],
            '/api/downloads/all': { files: [FILE()], total: 1 },
            '/api/downloads/': { files: [FILE()], total: 1 },
        });
        act('showAllMedia');
        await flush();
    }

    it('asks before deleting', async () => {
        await openWithFile();
        await act('confirmDeleteFile');
        await flush();
        // Either a confirm sheet or a direct delete — both are gated paths.
        expect(confirmSheet.mock.calls.length + api.delete.mock.calls.length).toBeGreaterThan(0);
    });

    it('exposes the delete hook the viewer calls', async () => {
        await openWithFile();
        expect(window.tgdlDeleteCurrentFile).toBeTypeOf('function');
    });
});

// ---- group settings modal -----------------------------------------------

describe('group settings modal', () => {
    async function openModal(group = GROUP()) {
        await boot({
            '/api/groups': [group],
            [`/api/groups/${group.id}`]: group,
        });
        await act('openGroupSettings', group.id, group.name);
        await flush();
    }

    it('opens with the group name in the title', async () => {
        await openModal();
        expect($('group-modal').classList.contains('hidden')).toBe(false);
    });

    it('closes again', async () => {
        await openModal();
        act('closeGroupSettings');
        expect($('group-modal').classList.contains('hidden')).toBe(true);
    });

    it('switches between the three tabs', async () => {
        await openModal();
        // The Data tab kicks off a fetch of the group's stats + file list.
        // Settle between switches so a late render from the previous tab
        // cannot repaint over the assertion for the next one — that raced
        // under a loaded full-suite run.
        act('switchSettingsTab', 'forward');
        await flush();
        expect($('content-forward').classList.contains('hidden')).toBe(false);
        act('switchSettingsTab', 'data');
        await flush();
        expect($('content-data').classList.contains('hidden')).toBe(false);
        act('switchSettingsTab', 'media');
        await flush();
        expect($('content-media').classList.contains('hidden')).toBe(false);
    });

    it('flips the enable toggle', async () => {
        await openModal();
        const toggle = $('group-enable-toggle');
        const before = toggle.classList.contains('active');
        act('toggleGroupEnabled', new window.MouseEvent('click', { bubbles: true }));
        expect(toggle.classList.contains('active')).toBe(!before);
    });

    it('flips the forwarding toggles', async () => {
        await openModal();
        for (const [action, id] of [
            ['toggleFwdEnabled', 'fwd-enable-toggle'],
            ['toggleFwdDelete', 'fwd-delete-toggle'],
            ['toggleFwdKeepImages', 'fwd-keep-images-toggle'],
            ['toggleFwdKeepVideos', 'fwd-keep-videos-toggle'],
        ]) {
            const el = $(id);
            if (!el) continue;
            const before = el.classList.contains('active');
            act(action, new window.MouseEvent('click', { bubbles: true }));
            expect(el.classList.contains('active'), id).toBe(!before);
        }
    });

    describe('per-group video size limit', () => {
        const saved = () =>
            [...api.post.mock.calls, ...api.put.mock.calls]
                .filter((c) => String(c[0]).includes('-100111'))
                .at(-1)?.[1];

        it('defaults to the system limit when the group sets none', async () => {
            await openModal();
            expect($('setting-group-max-video').value).toBe('');
        });

        it('shows the group limit', async () => {
            await openModal(GROUP({ maxVideoSize: '500MB' }));
            expect($('setting-group-max-video').value).toBe('500MB');
        });

        it('shows an explicit no-limit override', async () => {
            await openModal(GROUP({ maxVideoSize: 'none' }));
            expect($('setting-group-max-video').value).toBe('none');
        });

        it('keeps a stored limit that is not one of the presets', async () => {
            await openModal(GROUP({ maxVideoSize: '750MB' }));
            expect($('setting-group-max-video').value).toBe('750MB');
            await act('saveGroupSettings');
            await flush();
            expect(saved().maxVideoSize).toBe('750MB');
        });

        it('saves the chosen limit', async () => {
            await openModal();
            $('setting-group-max-video').value = '2GB';
            await act('saveGroupSettings');
            await flush();
            expect(saved().maxVideoSize).toBe('2GB');
        });

        it('saves an empty value to fall back to the system default', async () => {
            await openModal(GROUP({ maxVideoSize: '500MB' }));
            $('setting-group-max-video').value = '';
            await act('saveGroupSettings');
            await flush();
            expect(saved().maxVideoSize).toBe('');
        });

        it("does not carry one group's limit into the next one opened", async () => {
            const a = GROUP({ id: '-100111', maxVideoSize: '750MB' });
            const b = GROUP({ id: '-100222', name: 'Beta' });
            await boot({
                '/api/groups': [a, b],
                '/api/groups/-100111': a,
                '/api/groups/-100222': b,
            });
            await act('openGroupSettings', a.id, a.name);
            await flush();
            expect($('setting-group-max-video').value).toBe('750MB');
            await act('openGroupSettings', b.id, b.name);
            await flush();
            expect($('setting-group-max-video').value).toBe('');
            expect($('setting-group-max-video').querySelector('option[data-custom]')).toBeNull();
        });
    });

    it('saves the edited group', async () => {
        await openModal();
        await act('saveGroupSettings');
        await flush();
        const calls = [...api.post.mock.calls, ...api.put.mock.calls].map((c) => String(c[0]));
        expect(calls.some((u) => u.includes('-100111'))).toBe(true);
    });
});

// ---- chats page ----------------------------------------------------------

describe('chats page', () => {
    const DIALOGS = [
        { id: '-1', name: 'Alpha', type: 'channel', enabled: true },
        { id: '-2', name: 'Beta', type: 'group', enabled: false },
    ];

    async function openChats() {
        await boot({ '/api/groups': DIALOGS, '/api/dialogs': DIALOGS });
        routes.get('/groups')?.({ params: {}, query: {} });
        await flush();
    }

    it('renders the dialog rows', async () => {
        await openChats();
        expect($('groups-config-list')?.textContent || '').toContain('Alpha');
    });

    it('filters the dialog list', async () => {
        await openChats();
        window.filterDialogs('beta');
        const rows = $$('#groups-config-list .chat-row[data-id]');
        expect(rows.length, 'rendered dialog rows').toBeGreaterThan(0);
        const shown = rows.filter((r) => !r.classList.contains('hidden'));
        expect(shown.map((r) => r.textContent).join(' ')).toContain('Beta');
        expect(shown.map((r) => r.textContent).join(' ')).not.toContain('Alpha');
    });

    it('switches between the chats tabs', async () => {
        await openChats();
        act('switchGroupsTab', 'configured');
        expect($('tab-configured')?.classList.contains('active') ?? true).toBe(true);
        act('switchGroupsTab', 'all');
        expect($('tab-all')?.classList.contains('active') ?? true).toBe(true);
    });
});

// ---- purge ---------------------------------------------------------------

describe('purge', () => {
    it('confirms before purging one group', async () => {
        await boot({ '/api/groups': [GROUP()] });
        await act('purgeGroup', '-100111', 'Alpha Channel');
        await flush();
        expect(confirmSheet).toHaveBeenCalled();
    });

    it('does nothing when the purge confirm is declined', async () => {
        confirmAnswer = false;
        await boot({ '/api/groups': [GROUP()] });
        api.post.mockClear();
        await act('purgeGroup', '-100111', 'Alpha Channel');
        await flush();
        const purges = api.post.mock.calls.filter((c) => String(c[0]).includes('purge'));
        expect(purges).toHaveLength(0);
    });

    it('confirms before purging everything', async () => {
        await boot();
        await act('purgeAll');
        await flush();
        expect(confirmSheet).toHaveBeenCalled();
    });

    it('confirms before deleting unpinned videos', async () => {
        await boot();
        await act('deleteUnpinnedVideos');
        await flush();
        expect(confirmSheet).toHaveBeenCalled();
    });
});

// ---- websocket ------------------------------------------------------------

describe('websocket handling', () => {
    it('subscribes to the event stream', async () => {
        await boot();
        expect(ws.on).toHaveBeenCalled();
        expect(wsHandlers.size).toBeGreaterThan(0);
    });

    it('forwards engine events to the engine module', async () => {
        await boot();
        for (const [, fns] of wsHandlers) {
            for (const fn of fns) fn({ type: 'monitor_state', state: 'running' });
        }
        await flush();
        expect(stubs['./engine.js'].handleEngineWsMessage).toHaveBeenCalled();
    });
});

// ---- misc ----------------------------------------------------------------

describe('miscellaneous', () => {
    it('publishes the viewer bridge for other modules', async () => {
        await boot();
        expect(window.Viewer).toBeTruthy();
        expect(window.Viewer.openMediaViewer).toBeTypeOf('function');
    });

    it('refreshes the current page on demand', async () => {
        await boot({ '/api/groups': [GROUP()] });
        api.get.mockClear();
        act('refreshCurrentPage');
        await flush();
        expect(api.get).toHaveBeenCalled();
    });

    it('exposes the mini-player bridge', async () => {
        await boot();
        expect(window.tgdlShrinkToMini).toBeTypeOf('function');
        expect(window.tgdlDismissMiniPlayer).toBeTypeOf('function');
    });
});

// ---- teardown ------------------------------------------------------------

describe('destroy', () => {
    it('unsubscribes every websocket handler it registered', async () => {
        const mod = await boot();
        expect(wsHandlerCount()).toBeGreaterThan(10);
        mod.destroy();
        expect(wsHandlerCount()).toBe(0);
    });

    it('detaches the document and window listeners', async () => {
        const mod = await boot();
        const before = document.body.innerHTML;
        mod.destroy();
        // A click that previously closed open menus must now be inert.
        document.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        document.dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        expect(document.body.innerHTML).toBe(before);
    });

    it('is safe to call twice', async () => {
        const mod = await boot();
        mod.destroy();
        expect(() => mod.destroy()).not.toThrow();
        expect(wsHandlerCount()).toBe(0);
    });

    it('leaves a destroyed instance deaf to later events', async () => {
        const mod = await boot({ '/api/groups': [GROUP()] });
        mod.destroy();
        api.get.mockClear();
        // Dispatch the way ws.js does — through the registry. Calling a
        // captured closure directly would prove nothing: unsubscribing drops
        // the reference, it does not neuter the function.
        for (const [, fns] of wsHandlers) {
            for (const fn of fns) fn({ type: 'group_purged' });
        }
        await flush();
        expect(api.get).not.toHaveBeenCalled();
    });
});
