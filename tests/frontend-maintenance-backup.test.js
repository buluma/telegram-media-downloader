// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-backup.js — the Backup destinations
// page: the per-destination cards and their state pill precedence, the
// aggregate stat strip, card actions (run / pause / resume / test / edit /
// remove / unlock), the recent-jobs strip and its retry button, and the
// WebSocket live-update wiring.
//
// Only `init()` is exported; everything else is module-private and reached
// through the DOM it renders. Same harness as
// tests/frontend-maintenance-cluster.test.js — api/ws/sheet mocked, showToast
// mocked, i18n backed by a test-controlled dictionary, and escapeHtml /
// formatBytes / formatRelativeTime left real.
//
// Module-scope state (wired flags, cached destinations and statuses) means
// every test re-imports through vi.resetModules().

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

// See the note in the cluster test: call sites here often pass a fallback,
// but not always, so the dictionary is what makes interpolation observable.
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

const openedSheets = [];
const openSheet = vi.fn((opts) => {
    const handle = { close: vi.fn(), opts };
    openedSheets.push(handle);
    return handle;
});
let confirmAnswer = true;
const confirmSheet = vi.fn(async () => confirmAnswer);
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet, confirmSheet }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <button id="backup-add-btn"></button>
    <div id="backup-cards"></div>
    <div id="backup-empty" class="hidden"></div>
    <div id="backup-stat-destinations"></div>
    <div id="backup-stat-synced"></div>
    <div id="backup-stat-queued"></div>
    <div id="backup-stat-last"></div>
    <div id="backup-recent"></div>
    <div id="backup-recent-empty" class="hidden"></div>
`;

const DEST = (over = {}) => ({
    id: 1,
    name: 'NAS',
    provider: 'local',
    enabled: true,
    mode: 'mirror',
    encryption: false,
    lastSuccessAt: Date.now() - 60_000,
    ...over,
});

const STATUS = (over = {}) => ({
    id: 1,
    enabled: true,
    paused: false,
    encryption: false,
    encryptionUnlocked: true,
    processing: 0,
    queued: 0,
    completed: 0,
    lastError: null,
    ...over,
});

function stubApi({ destinations = [], statuses = {}, recent = [] } = {}) {
    api.get.mockImplementation(async (url) => {
        if (url === '/api/backup/destinations') return { destinations };
        const m = url.match(/^\/api\/backup\/destinations\/(\d+)\/status$/);
        if (m) return statuses[m[1]] || STATUS({ id: Number(m[1]) });
        if (url.startsWith('/api/backup/jobs/recent')) return { jobs: recent };
        return {};
    });
}

async function boot(opts) {
    vi.resetModules();
    wsHandlers.clear();
    document.body.innerHTML = DOM;
    stubApi(opts);
    const mod = await import('../src/web/public/js/maintenance-backup.js');
    await mod.init();
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

/** Click a card action button through the delegated handler. */
function cardAction(destId, act) {
    const btn = document
        .querySelector(`[data-dest-id="${destId}"]`)
        ?.querySelector(`button[data-act="${act}"]`);
    if (!btn) throw new Error(`no ${act} button on destination ${destId}`);
    btn.click();
}

// Timers the module under test leaves pending (the wizard defers its wiring by
// 60ms). On a slow runner one can outlive the test file's jsdom and fire as an
// unhandled `document is not defined`, so clear whatever is still pending.
const pendingTimers = new Set();
let setTimeoutSpy;

beforeEach(() => {
    vi.clearAllMocks();
    openedSheets.length = 0;
    confirmAnswer = true;
    i18nDict = {};
    const realSetTimeout = globalThis.setTimeout;
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        const id = realSetTimeout(
            (...a) => {
                pendingTimers.delete(id);
                return fn(...a);
            },
            ms,
            ...args,
        );
        pendingTimers.add(id);
        return id;
    });
});

afterEach(() => {
    setTimeoutSpy.mockRestore();
    for (const id of pendingTimers) clearTimeout(id);
    pendingTimers.clear();
    document.body.innerHTML = '';
});

// ---- boot ---------------------------------------------------------------

describe('init', () => {
    it('loads destinations, their statuses and the recent strip', async () => {
        await boot({ destinations: [DEST()] });
        const urls = api.get.mock.calls.map((c) => c[0]);
        expect(urls).toContain('/api/backup/destinations');
        expect(urls).toContain('/api/backup/destinations/1/status');
        expect(urls.some((u) => u.startsWith('/api/backup/jobs/recent'))).toBe(true);
    });

    it('subscribes to every live channel exactly once', async () => {
        const mod = await boot();
        await mod.init();
        await flush();

        for (const type of [
            'backup_destination_added',
            'backup_destination_updated',
            'backup_destination_removed',
            'backup_progress',
            'backup_done',
            'backup_error',
            'backup_queue_drained',
        ]) {
            expect(wsHandlers.get(type), type).toHaveLength(1);
        }
    });

    it('survives missing page markup', async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        stubApi();
        const mod = await import('../src/web/public/js/maintenance-backup.js');
        await expect(mod.init()).resolves.toBeUndefined();
    });

    it('toasts when the destination list cannot be loaded', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        api.get.mockRejectedValue(Object.assign(new Error('boom'), { data: { error: 'nope' } }));
        const mod = await import('../src/web/public/js/maintenance-backup.js');
        await mod.init();
        await flush();
        expect(showToast).toHaveBeenCalledWith('nope', 'error');
    });
});

// ---- state pill ---------------------------------------------------------

describe('state pill precedence', () => {
    async function pillFor(status) {
        await boot({ destinations: [DEST()], statuses: { 1: STATUS(status) } });
        return document.querySelector('[data-dest-id="1"]').textContent;
    }

    it('reports disabled ahead of everything else', async () => {
        expect(
            await pillFor({ enabled: false, paused: true, queued: 5, lastError: 'x' }),
        ).toContain('Disabled');
    });

    it('reports paused ahead of locked and running', async () => {
        expect(
            await pillFor({ paused: true, encryption: true, encryptionUnlocked: false }),
        ).toContain('Paused');
    });

    it('reports locked ahead of running', async () => {
        expect(
            await pillFor({ encryption: true, encryptionUnlocked: false, processing: 2 }),
        ).toContain('Locked');
    });

    it('reports running ahead of an error', async () => {
        expect(await pillFor({ processing: 1, lastError: 'stale' })).toContain('Running');
    });

    it('reports an error ahead of a queue', async () => {
        expect(await pillFor({ lastError: 'permission denied', queued: 3 })).toContain('Error');
    });

    it('reports queued ahead of idle', async () => {
        expect(await pillFor({ queued: 3 })).toContain('Queued');
    });

    it('falls through to idle', async () => {
        expect(await pillFor({})).toContain('Idle');
    });
});

// ---- cards --------------------------------------------------------------

describe('destination cards', () => {
    it('shows the empty state with no destinations', async () => {
        await boot({ destinations: [] });
        expect($('backup-empty').classList.contains('hidden')).toBe(false);
        expect($('backup-cards').innerHTML).toBe('');
    });

    it('renders a card per destination', async () => {
        await boot({
            destinations: [DEST(), DEST({ id: 2, name: 'S3 bucket', provider: 's3' })],
        });
        expect(document.querySelectorAll('[data-dest-id]')).toHaveLength(2);
        expect($('backup-cards').textContent).toContain('NAS');
        expect($('backup-cards').textContent).toContain('S3 bucket');
    });

    it('badges each provider, falling back to the raw name', async () => {
        await boot({
            destinations: [
                DEST({ id: 1, provider: 's3' }),
                DEST({ id: 2, provider: 'dropbox' }),
                DEST({ id: 3, provider: 'carrierpigeon' }),
            ],
        });
        const text = $('backup-cards').textContent;
        expect(text).toContain('S3');
        expect(text).toContain('Dropbox');
        expect(text).toContain('carrierpigeon');
    });

    it('escapes destination names', async () => {
        await boot({ destinations: [DEST({ name: '<img src=x onerror=alert(1)>' })] });
        const html = $('backup-cards').innerHTML;
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });
});

// ---- stats --------------------------------------------------------------

describe('stat strip', () => {
    it('counts destinations, synced files and queued jobs', async () => {
        await boot({
            destinations: [DEST(), DEST({ id: 2 })],
            statuses: {
                1: STATUS({ completed: 10, queued: 2 }),
                2: STATUS({ id: 2, completed: 5, queued: 3 }),
            },
        });
        expect($('backup-stat-destinations').textContent).toBe('2');
        expect($('backup-stat-synced').textContent).toBe('15');
        expect($('backup-stat-queued').textContent).toBe('5');
    });

    it('highlights a non-empty queue', async () => {
        await boot({ destinations: [DEST()], statuses: { 1: STATUS({ queued: 4 }) } });
        expect($('backup-stat-queued').classList.contains('text-tg-orange')).toBe(true);
    });

    it('does not highlight an empty queue', async () => {
        await boot({ destinations: [DEST()], statuses: { 1: STATUS({ queued: 0 }) } });
        expect($('backup-stat-queued').classList.contains('text-tg-orange')).toBe(false);
    });

    it('says never before any successful run', async () => {
        await boot({ destinations: [DEST()], statuses: { 1: STATUS() } });
        expect($('backup-stat-last').textContent).toBe('Never');
    });

    it('reports the most recent success across destinations', async () => {
        const recent = Date.now() - 1000;
        await boot({
            destinations: [DEST(), DEST({ id: 2 })],
            statuses: {
                1: STATUS({ lastSuccessAt: Date.now() - 100_000 }),
                2: STATUS({ id: 2, lastSuccessAt: recent }),
            },
        });
        expect($('backup-stat-last').textContent).not.toBe('Never');
    });
});

// ---- card actions -------------------------------------------------------

describe('card actions', () => {
    async function bootOne(status) {
        await boot({ destinations: [DEST()], statuses: { 1: STATUS(status) } });
        api.post.mockResolvedValue({});
        api.get.mockClear();
    }

    it('runs a backup', async () => {
        await bootOne();
        cardAction(1, 'run');
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/backup/destinations/1/run', {});
        expect(showToast).toHaveBeenCalledWith('Backup run started', 'success');
    });

    it('pauses and resumes', async () => {
        await bootOne();
        cardAction(1, 'pause');
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/backup/destinations/1/pause', {});

        await boot({ destinations: [DEST()], statuses: { 1: STATUS({ paused: true }) } });
        api.post.mockResolvedValue({});
        cardAction(1, 'resume');
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/backup/destinations/1/resume', {});
    });

    it('reports a connection test result either way', async () => {
        await bootOne();
        api.post.mockResolvedValue({ ok: true, detail: 'Wrote probe' });
        cardAction(1, 'test');
        await flush();
        expect(showToast).toHaveBeenCalledWith('Wrote probe', 'success');

        api.post.mockResolvedValue({ ok: false, detail: 'EACCES' });
        cardAction(1, 'test');
        await flush();
        expect(showToast).toHaveBeenCalledWith('EACCES', 'error');
    });

    it('removes only after confirmation', async () => {
        await bootOne();
        confirmAnswer = false;
        cardAction(1, 'remove');
        await flush();
        expect(api.delete).not.toHaveBeenCalled();

        confirmAnswer = true;
        api.delete.mockResolvedValue({});
        cardAction(1, 'remove');
        await flush();
        expect(api.delete).toHaveBeenCalledWith('/api/backup/destinations/1');
        expect(showToast).toHaveBeenCalledWith('Destination removed', 'success');
    });

    it('refreshes the list after any action', async () => {
        await bootOne();
        cardAction(1, 'run');
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/backup/destinations');
    });

    it('surfaces a server error and still refreshes', async () => {
        await bootOne();
        api.post.mockRejectedValue(
            Object.assign(new Error('raw'), { data: { error: 'quota exceeded' } }),
        );
        cardAction(1, 'run');
        await flush();
        expect(showToast).toHaveBeenCalledWith('quota exceeded', 'error');
        expect(api.get).toHaveBeenCalledWith('/api/backup/destinations');
    });

    it('ignores an action for a destination it does not know', async () => {
        await bootOne();
        const cards = $('backup-cards');
        cards.innerHTML = '<div data-dest-id="99"><button data-act="run"></button></div>';
        cardAction(99, 'run');
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('opens the wizard to edit an existing destination', async () => {
        await bootOne();
        api.get.mockResolvedValue({ providers: [] });
        cardAction(1, 'edit');
        await flush();
        expect(openSheet).toHaveBeenCalled();
    });
});

// ---- unlock -------------------------------------------------------------

describe('unlock flow', () => {
    it('opens an unlock sheet for a locked destination', async () => {
        await boot({
            destinations: [DEST({ encryption: true })],
            statuses: { 1: STATUS({ encryption: true, encryptionUnlocked: false }) },
        });
        api.post.mockResolvedValue({});
        cardAction(1, 'unlock');
        await flush();
        expect(openSheet).toHaveBeenCalled();
    });
});

// ---- recent jobs --------------------------------------------------------

describe('recent jobs strip', () => {
    it('shows the empty state with no jobs', async () => {
        await boot({ recent: [] });
        expect($('backup-recent-empty').classList.contains('hidden')).toBe(false);
        expect($('backup-recent').innerHTML).toBe('');
    });

    // Jobs come straight off the backup_jobs table, so the row renderer reads
    // snake_case columns — finished_at/started_at, remote_path, destination_name.
    it('renders recent jobs with their status and target', async () => {
        await boot({
            destinations: [DEST()],
            recent: [
                {
                    id: 7,
                    status: 'done',
                    destination_name: 'NAS',
                    remote_path: 'a.jpg',
                    finished_at: Date.now(),
                },
                {
                    id: 8,
                    status: 'failed',
                    destination_name: 'NAS',
                    remote_path: 'b.mp4',
                    error: 'timeout',
                    finished_at: Date.now(),
                },
            ],
        });
        const text = $('backup-recent').textContent;
        expect(text).toContain('a.jpg');
        expect(text).toContain('b.mp4');
        expect(text).toContain('done');
        expect(text).toContain('failed');
        expect(text).toContain('timeout');
    });

    it('falls back to the download id when no remote path is recorded', async () => {
        await boot({
            recent: [{ id: 9, status: 'pending', download_id: 55, started_at: Date.now() }],
        });
        expect($('backup-recent').textContent).toContain('download #55');
    });

    it('labels an unrecognised status verbatim', async () => {
        await boot({
            recent: [{ id: 9, status: 'quarantined', remote_path: 'x', started_at: Date.now() }],
        });
        expect($('backup-recent').textContent).toContain('quarantined');
    });

    it('shows an em dash for a job with no timestamps', async () => {
        await boot({ recent: [{ id: 9, status: 'done', remote_path: 'x' }] });
        expect($('backup-recent').textContent).toContain('—');
    });

    // Asserting on innerHTML is the wrong test here: these values also land in
    // a title="" attribute, and serialising an attribute value does not escape
    // < or > (only &, " and nbsp), so a correctly-escaped page still shows
    // "<script>" in the innerHTML string. The property that actually matters is
    // that no element was created and the text survives verbatim.
    it('never turns job paths or error text into markup', async () => {
        await boot({
            recent: [
                {
                    id: 1,
                    status: 'failed',
                    remote_path: '<script>alert(1)</script>',
                    error: '<img src=x onerror=alert(2)>',
                    finished_at: Date.now(),
                },
            ],
        });
        const root = $('backup-recent');
        expect(root.querySelector('script')).toBeNull();
        expect(root.querySelector('img')).toBeNull();
        expect(root.textContent).toContain('<script>alert(1)</script>');
        expect(root.textContent).toContain('<img src=x onerror=alert(2)>');
    });

    it('retries a failed job from the strip', async () => {
        await boot({
            destinations: [DEST()],
            recent: [
                {
                    id: 42,
                    status: 'failed',
                    remote_path: 'b.mp4',
                    error: 'x',
                    finished_at: Date.now(),
                },
            ],
        });
        const retry = $('backup-recent').querySelector('button[data-act="retry-job"]');
        expect(retry).toBeTruthy();
        api.post.mockResolvedValue({});

        retry.click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/backup/jobs/42/retry', {});
        expect(showToast).toHaveBeenCalledWith('Retry queued', 'success');
    });

    it('offers retry only on failed jobs', async () => {
        await boot({
            recent: [
                { id: 1, status: 'done', remote_path: 'a', finished_at: Date.now() },
                { id: 2, status: 'uploading', remote_path: 'b', started_at: Date.now() },
            ],
        });
        expect($('backup-recent').querySelectorAll('button[data-act="retry-job"]')).toHaveLength(0);
    });

    it('treats a failed recent fetch as non-fatal', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        api.get.mockImplementation(async (url) => {
            if (url.startsWith('/api/backup/jobs/recent')) throw new Error('500');
            if (url === '/api/backup/destinations') return { destinations: [] };
            return {};
        });
        const mod = await import('../src/web/public/js/maintenance-backup.js');
        await expect(mod.init()).resolves.toBeUndefined();
    });
});

// ---- live updates -------------------------------------------------------

describe('websocket updates', () => {
    it('reloads destinations on add, update and remove', async () => {
        await boot({ destinations: [DEST()] });

        for (const type of [
            'backup_destination_added',
            'backup_destination_updated',
            'backup_destination_removed',
        ]) {
            api.get.mockClear();
            fire(type, {});
            await flush();
            expect(api.get, type).toHaveBeenCalledWith('/api/backup/destinations');
        }
    });

    it('flips a card to processing on the first progress event', async () => {
        await boot({ destinations: [DEST()], statuses: { 1: STATUS({ processing: 0 }) } });
        expect($('backup-cards').textContent).toContain('Idle');

        fire('backup_progress', { destinationId: 1 });
        await flush();

        expect($('backup-cards').textContent).toContain('Running');
    });

    it('ignores progress for a destination with no card', async () => {
        await boot({ destinations: [DEST()] });
        expect(() => fire('backup_progress', { destinationId: 999 })).not.toThrow();
    });

    it('refreshes statuses and the strip when a job finishes or fails', async () => {
        await boot({ destinations: [DEST()] });

        for (const type of ['backup_done', 'backup_error', 'backup_queue_drained']) {
            api.get.mockClear();
            fire(type, {});
            await flush();
            const urls = api.get.mock.calls.map((c) => c[0]);
            expect(urls, type).toContain('/api/backup/destinations/1/status');
            expect(
                urls.some((u) => u.startsWith('/api/backup/jobs/recent')),
                type,
            ).toBe(true);
        }
    });
});

// ---- wizard -------------------------------------------------------------

describe('add wizard', () => {
    it('opens from the add button', async () => {
        await boot();
        api.get.mockResolvedValue({ providers: [{ name: 'local', displayName: 'Local disk' }] });
        $('backup-add-btn').click();
        await flush();
        expect(openSheet).toHaveBeenCalled();
    });
});
