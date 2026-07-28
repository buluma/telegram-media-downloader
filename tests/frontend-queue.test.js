// @vitest-environment jsdom
//
// Covers src/web/public/js/queue.js — the IDM-style Queue page: the in-memory
// store fed by the snapshot + WS events, filter/sort/search, the append-only
// renderer with its sliding DOM window, multi-select (click / shift-range /
// select-all / keyboard), per-row + global + batch actions, the aggregate
// strip and the throttle slider.
//
// Two exports (initQueue / showQueuePage); everything else is private and is
// driven through the DOM or through the WS handler registered by initQueue.
//
// Same harness as the other P4 pages, plus:
//   - store.js, because rows resolve their group label through getGroupName().
//   - an IntersectionObserver stub, because the load-more sentinel is what
//     paginates the rendered window.
//
// Fake timers are installed for every test: the render path is a
// setTimeout(RENDER_COALESCE_MS) followed by a requestAnimationFrame, so
// nothing lands in the DOM without advancing a clock. `settle()` advances
// past both.

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
vi.mock('../src/web/public/js/sheet.js', () => ({
    confirmSheet,
    openSheet: vi.fn(),
}));

// Mirrors the real resolver's last resort: with nothing in the store it hands
// back the caller's fallback, which is how a row labels its group.
const getGroupName = vi.fn((id, opts) => opts?.fallback ?? String(id ?? ''));
vi.mock('../src/web/public/js/store.js', () => ({
    state: { currentPage: 'queue', groups: [] },
    getGroupName: (...a) => getGroupName(...a),
}));

// ---- IntersectionObserver stub ------------------------------------------
// The load-more sentinel is the only thing that appends further pages, so
// tests need to be able to fire it by hand.
const observers = [];
class FakeIO {
    constructor(cb, opts) {
        this.cb = cb;
        this.opts = opts;
        this.targets = [];
        observers.push(this);
    }
    observe(el) {
        this.targets.push(el);
    }
    unobserve() {}
    disconnect() {}
    trigger(isIntersecting = true) {
        this.cb(this.targets.map((target) => ({ target, isIntersecting })));
    }
}
globalThis.IntersectionObserver = FakeIO;

const $ = (id) => document.getElementById(id);

const DOM = `
    <button id="fab"></button>
    <div id="queue-nav-badge" class="hidden"></div>
    <div id="page-queue">
        <div id="queue-chips"></div>
        <input id="queue-search" />
        <select id="queue-sort">
            <option value="addedAt">Added</option>
            <option value="size">Size</option>
            <option value="progress">Progress</option>
            <option value="group">Group</option>
            <option value="filename">Filename</option>
        </select>
        <button id="queue-pause-all"></button>
        <button id="queue-resume-all"></button>
        <button id="queue-retry-all"></button>
        <button id="queue-clear-finished"></button>
        <button id="queue-cancel-all"></button>
        <div id="queue-selection-bar" class="hidden">
            <span id="queue-selection-count"></span>
            <button data-batch-action="pause"><i></i></button>
            <button data-batch-action="resume"><i></i></button>
            <button data-batch-action="retry"><i></i></button>
            <button data-batch-action="dismiss"><i></i></button>
            <button data-batch-action="cancel"><i></i></button>
            <button id="queue-selection-clear"><i></i></button>
        </div>
        <input id="queue-select-all" type="checkbox" />
        <div id="queue-viewport">
            <div id="queue-rows"></div>
            <div id="queue-load-more" class="hidden"></div>
            <div id="queue-empty" class="hidden"></div>
        </div>
        <div id="queue-aggregate"></div>
        <input id="queue-throttle" type="range" min="0" max="52428800" step="262144" value="0" />
        <span id="queue-throttle-value"></span>
    </div>
`;

const NOW = 1_760_000_000_000;

const JOB = (over = {}) => ({
    key: '-100123_11',
    groupId: '-100123',
    groupName: 'My Group',
    mediaType: 'video',
    messageId: 11,
    fileName: 'clip.mp4',
    fileSize: 2_000_000,
    progress: 40,
    received: 800_000,
    total: 2_000_000,
    bps: 100_000,
    eta: 12,
    status: 'active',
    addedAt: NOW - 60_000,
    ...over,
});

function snapshot({ active = [], queued = [], recent = [], ...rest } = {}) {
    return {
        active,
        queued,
        recent,
        globalPaused: false,
        engineRunning: true,
        maxSpeed: null,
        ...rest,
    };
}

function stubSnapshot(snap) {
    api.get.mockImplementation(async (url) => {
        if (url === '/api/queue/snapshot') return snap;
        return {};
    });
}

// Advance past the coalescing setTimeout plus the requestAnimationFrame that
// follows it. Both are faked, so this is the only way anything renders.
async function settle() {
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(20);
}

async function boot(snap = snapshot()) {
    vi.resetModules();
    wsHandlers.clear();
    observers.length = 0;
    document.body.innerHTML = DOM;
    stubSnapshot(snap);
    const mod = await import('../src/web/public/js/queue.js');
    mod.initQueue();
    await mod.showQueuePage();
    await settle();
    return mod;
}

function fire(msg) {
    for (const fn of wsHandlers.get('*') || []) fn(msg);
}

const rows = () => Array.from($('queue-rows').querySelectorAll('[data-key]'));
const rowKeys = () => rows().map((r) => r.dataset.key);
const rowFor = (key) => $('queue-rows').querySelector(`[data-key="${key}"]`);

function click(el, init = {}) {
    el.dispatchEvent(
        new window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            ...init,
        }),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    confirmAnswer = true;
    i18nDict = {};
    api.post.mockResolvedValue({});
    getGroupName.mockImplementation((id, opts) => opts?.fallback ?? String(id ?? ''));
    delete window.Viewer;
});

afterEach(async () => {
    // Retire the module instance this test loaded. It keeps a document-level
    // keydown listener alive for the rest of the file, and it only stands
    // down when the `#page-queue` element its MutationObserver watches goes
    // hidden — so hide it while that element is still in the DOM. Wiping
    // innerHTML first would detach the node and leave the stale module
    // answering Ctrl+A out of its own store.
    document.getElementById('page-queue')?.classList.add('hidden');
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

// ---- boot ---------------------------------------------------------------

describe('initQueue / showQueuePage', () => {
    it('subscribes to the WS firehose once and boots from the snapshot', async () => {
        const mod = await boot(snapshot({ active: [JOB()] }));
        expect(ws.on).toHaveBeenCalledWith('*', expect.any(Function));
        expect(api.get).toHaveBeenCalledWith('/api/queue/snapshot');
        expect(rowKeys()).toEqual(['-100123_11']);

        // Second init is a no-op — the handler must not double-register, or
        // every WS event would be applied twice.
        mod.initQueue();
        expect(wsHandlers.get('*')).toHaveLength(1);
    });

    it('merges active, queued and recent into one store', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a', status: 'active' })],
                queued: [JOB({ key: 'q', status: 'queued' })],
                recent: [JOB({ key: 'r', status: 'done', progress: 100 })],
            }),
        );
        expect(rowKeys().sort()).toEqual(['a', 'q', 'r']);
        expect($('queue-chips').textContent).toContain('All');
    });

    it('re-uses the booted store instead of refetching on a second visit', async () => {
        const mod = await boot(snapshot({ active: [JOB()] }));
        api.get.mockClear();
        await mod.showQueuePage();
        await settle();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('applies a deep-linked status filter', async () => {
        const mod = await boot(
            snapshot({
                active: [JOB({ key: 'a' })],
                recent: [JOB({ key: 'r', status: 'failed' })],
            }),
        );
        await mod.showQueuePage({ status: 'failed' });
        await settle();
        expect(rowKeys()).toEqual(['r']);
    });

    it('ignores a deep-linked status that is not a known chip', async () => {
        const mod = await boot(snapshot({ active: [JOB({ key: 'a' })] }));
        await mod.showQueuePage({ status: 'bogus' });
        await settle();
        expect(rowKeys()).toEqual(['a']);
    });

    it('toasts when the snapshot fails', async () => {
        vi.resetModules();
        wsHandlers.clear();
        document.body.innerHTML = DOM;
        api.get.mockRejectedValue(new Error('boom'));
        const mod = await import('../src/web/public/js/queue.js');
        await mod.showQueuePage();
        await settle();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error');
    });

    it('stays silent on a 401 — the auth layer already handles that', async () => {
        vi.resetModules();
        wsHandlers.clear();
        document.body.innerHTML = DOM;
        api.get.mockRejectedValue(Object.assign(new Error('unauthorised'), { status: 401 }));
        const mod = await import('../src/web/public/js/queue.js');
        await mod.showQueuePage();
        await settle();
        expect(showToast).not.toHaveBeenCalled();
    });

    it('shows the empty state with no jobs', async () => {
        await boot();
        expect($('queue-empty').classList.contains('hidden')).toBe(false);
        expect(rows()).toHaveLength(0);
    });
});

// ---- row rendering ------------------------------------------------------

describe('row rendering', () => {
    it('renders name, group, size, speed and ETA for an active job', async () => {
        await boot(snapshot({ active: [JOB()] }));
        const row = rowFor('-100123_11');
        expect(row.textContent).toContain('clip.mp4');
        expect(row.textContent).toContain('My Group');
        expect(row.textContent).toContain('1.91 MB');
        expect(row.textContent).toContain('97.66 KB/s');
        expect(row.textContent).toContain('12s');
        expect(row.querySelector('[data-row-bar]').style.width).toBe('40%');
    });

    it('falls back to the message id, then to a placeholder, for an unnamed job', async () => {
        await boot(
            snapshot({
                queued: [
                    JOB({
                        key: 'a',
                        fileName: null,
                        messageId: 42,
                        status: 'queued',
                    }),
                    JOB({
                        key: 'b',
                        fileName: null,
                        messageId: null,
                        status: 'queued',
                    }),
                ],
            }),
        );
        expect(rowFor('a').textContent).toContain('#42');
        expect(rowFor('b').textContent).toContain('Unnamed file');
    });

    it('shows an ellipsis for a queued job of unknown size and a dash once it is not queued', async () => {
        await boot(
            snapshot({
                queued: [JOB({ key: 'q', fileSize: 0, status: 'queued' })],
                recent: [JOB({ key: 'f', fileSize: 0, status: 'failed' })],
            }),
        );
        expect(rowFor('q').textContent).toContain('…');
        expect(rowFor('f').textContent).toContain('—');
    });

    it('forces a finished row to 100% even when the stored progress lags', async () => {
        await boot(snapshot({ recent: [JOB({ status: 'done', progress: 3 })] }));
        expect(rowFor('-100123_11').querySelector('[data-row-bar]').style.width).toBe('100%');
        // The numeric label is suppressed under a finished bar — the pill
        // already says "done", so the percentage is noise.
        expect(rowFor('-100123_11').querySelector('[data-row-pct]').textContent).toBe('');
    });

    it('clamps an out-of-range progress value into 0..100', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'hi', progress: 320 }), JOB({ key: 'lo', progress: -5 })],
            }),
        );
        expect(rowFor('hi').querySelector('[data-row-bar]').style.width).toBe('100%');
        expect(rowFor('lo').querySelector('[data-row-bar]').style.width).toBe('0%');
    });

    it('suppresses speed and ETA for a job that is not actively transferring', async () => {
        await boot(snapshot({ queued: [JOB({ status: 'queued', bps: 999, eta: 5 })] }));
        const row = rowFor('-100123_11');
        expect(row.textContent).not.toContain('/s');
        expect(row.querySelector('[data-row-pct]').textContent).toBe('');
    });

    it('picks the media icon from mediaType, then from the extension', async () => {
        await boot(
            snapshot({
                active: [
                    JOB({ key: 'v', mediaType: 'video', fileName: 'a.bin' }),
                    JOB({ key: 'i', mediaType: null, fileName: 'a.png' }),
                    JOB({ key: 'au', mediaType: null, fileName: 'a.flac' }),
                    JOB({ key: 'd', mediaType: null, fileName: 'a.pdf' }),
                ],
            }),
        );
        expect(rowFor('v').querySelector('i').className).toBe('ri-video-line');
        expect(rowFor('i').querySelector('i').className).toBe('ri-image-line');
        expect(rowFor('au').querySelector('i').className).toBe('ri-music-line');
        expect(rowFor('d').querySelector('i').className).not.toMatch(/video|image|music/);
    });

    it('tags a deduped row and counts it on the dupe chip', async () => {
        await boot(snapshot({ recent: [JOB({ status: 'done', deduped: true })] }));
        expect(rowFor('-100123_11').textContent).toContain('Duplicate');
        const dupeChip = $('queue-chips').querySelector('[data-chip="dupe"]');
        expect(dupeChip.textContent).toContain('1');
    });

    it('renders an account chip only when the job carries an account name', async () => {
        await boot(
            snapshot({
                active: [
                    JOB({ key: 'with', accountName: 'main-session' }),
                    JOB({ key: 'without', accountName: null }),
                ],
            }),
        );
        expect(rowFor('with').textContent).toContain('main-session');
        expect(rowFor('without').querySelector('.ri-user-3-line')).toBeNull();
    });

    it('renders the error text on a failed row', async () => {
        await boot(
            snapshot({
                recent: [JOB({ status: 'failed', error: 'FILE_REFERENCE_EXPIRED' })],
            }),
        );
        expect(rowFor('-100123_11').textContent).toContain('FILE_REFERENCE_EXPIRED');
    });

    it('shows added, finished and duration stamps', async () => {
        await boot(
            snapshot({
                recent: [
                    JOB({
                        status: 'done',
                        addedAt: NOW - 125_000,
                        finishedAt: NOW - 5_000,
                    }),
                ],
            }),
        );
        // 120 s between the two stamps → "2m 0s".
        expect(rowFor('-100123_11').textContent).toContain('2m 0s');
    });

    it('omits the duration when the finish stamp is not after the add stamp', async () => {
        await boot(
            snapshot({
                recent: [
                    JOB({
                        status: 'done',
                        addedAt: NOW,
                        finishedAt: NOW - 1000,
                    }),
                ],
            }),
        );
        expect(rowFor('-100123_11').textContent).not.toMatch(/\d+m \d+s/);
    });

    it('escapes hostile filenames instead of injecting markup', async () => {
        const evil = '<img src=x onerror=alert(1)>.mp4';
        await boot(snapshot({ active: [JOB({ fileName: evil })] }));
        const row = rowFor('-100123_11');
        expect(row.querySelector('img')).toBeNull();
        expect(row.textContent).toContain(evil);
    });

    it('offers status-appropriate actions', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a', status: 'active' })],
                queued: [JOB({ key: 'p', status: 'paused' })],
                recent: [JOB({ key: 'f', status: 'failed' }), JOB({ key: 'd', status: 'done' })],
            }),
        );
        const actions = (key) =>
            Array.from(rowFor(key).querySelectorAll('[data-row-action]')).map(
                (b) => b.dataset.rowAction,
            );
        expect(actions('a')).toEqual(['pause', 'cancel']);
        expect(actions('p')).toEqual(['resume', 'cancel']);
        expect(actions('f')).toEqual(['retry', 'dismiss']);
        expect(actions('d')).toEqual(['dismiss']);
    });
});

// ---- filtering, sorting, search ----------------------------------------

describe('filter, sort and search', () => {
    const MIXED = () =>
        snapshot({
            active: [
                JOB({
                    key: 'a',
                    status: 'active',
                    fileName: 'bravo.mp4',
                    fileSize: 30,
                }),
            ],
            queued: [
                JOB({
                    key: 'q',
                    status: 'queued',
                    fileName: 'alpha.mp4',
                    fileSize: 10,
                }),
                JOB({
                    key: 'p',
                    status: 'paused',
                    fileName: 'delta.mp4',
                    fileSize: 20,
                }),
            ],
            recent: [
                JOB({
                    key: 'f',
                    status: 'failed',
                    fileName: 'charlie.mp4',
                    fileSize: 40,
                }),
                JOB({
                    key: 'd',
                    status: 'done',
                    fileName: 'echo.mp4',
                    fileSize: 50,
                    deduped: true,
                }),
            ],
        });

    it('filters by the clicked chip and rewrites the hash without a re-route', async () => {
        await boot(MIXED());
        $('queue-chips').querySelector('[data-chip="failed"]').click();
        await settle();
        expect(rowKeys()).toEqual(['f']);
        expect(location.hash).toBe('#/queue/failed');

        $('queue-chips').querySelector('[data-chip="all"]').click();
        await settle();
        expect(rowKeys()).toHaveLength(5);
        expect(location.hash).toBe('#/queue');
    });

    it('counts each chip independently', async () => {
        await boot(MIXED());
        const count = (id) =>
            $('queue-chips')
                .querySelector(`[data-chip="${id}"]`)
                .textContent.trim()
                .split(/\s+/)
                .pop();
        expect(count('all')).toBe('5');
        expect(count('active')).toBe('1');
        expect(count('queued')).toBe('1');
        expect(count('paused')).toBe('1');
        expect(count('failed')).toBe('1');
        expect(count('done')).toBe('1');
        expect(count('dupe')).toBe('1');
    });

    it('treats dupe as a cross-cutting filter, not a status', async () => {
        await boot(MIXED());
        $('queue-chips').querySelector('[data-chip="dupe"]').click();
        await settle();
        expect(rowKeys()).toEqual(['d']);
    });

    it('searches filename and group name, case-insensitively', async () => {
        await boot(MIXED());
        const search = $('queue-search');
        search.value = 'ALPHA';
        search.dispatchEvent(new window.Event('input'));
        await settle();
        expect(rowKeys()).toEqual(['q']);

        search.value = 'my group';
        search.dispatchEvent(new window.Event('input'));
        await settle();
        expect(rowKeys()).toHaveLength(5);

        search.value = 'nothing-matches';
        search.dispatchEvent(new window.Event('input'));
        await settle();
        expect(rows()).toHaveLength(0);
        expect($('queue-empty').classList.contains('hidden')).toBe(false);
    });

    it('debounces the search box', async () => {
        await boot(MIXED());
        const search = $('queue-search');
        search.value = 'a';
        search.dispatchEvent(new window.Event('input'));
        search.value = 'alpha';
        search.dispatchEvent(new window.Event('input'));
        // Only the final value is applied — an intermediate keystroke must
        // never leave the list filtered by a prefix the user already replaced.
        await settle();
        expect(rowKeys()).toEqual(['q']);
    });

    it('sorts by size, filename and group, honouring the descending default', async () => {
        await boot(MIXED());
        const sort = $('queue-sort');

        sort.value = 'size';
        sort.dispatchEvent(new window.Event('change'));
        await settle();
        expect(rowKeys()).toEqual(['d', 'f', 'a', 'p', 'q']);

        sort.value = 'filename';
        sort.dispatchEvent(new window.Event('change'));
        await settle();
        // Strings compare with localeCompare, then flip for the desc default.
        expect(rowKeys()).toEqual(['d', 'p', 'f', 'a', 'q']);
    });

    it('sorts newest-first by default', async () => {
        await boot(
            snapshot({
                active: [
                    JOB({ key: 'old', addedAt: NOW - 100_000 }),
                    JOB({ key: 'new', addedAt: NOW - 10 }),
                ],
            }),
        );
        expect(rowKeys()).toEqual(['new', 'old']);
    });

    it('scrolls back to the top when the row set changes underneath', async () => {
        await boot(MIXED());
        $('queue-viewport').scrollTop = 400;
        $('queue-chips').querySelector('[data-chip="failed"]').click();
        await settle();
        expect($('queue-viewport').scrollTop).toBe(0);
    });
});

// ---- pagination ---------------------------------------------------------

describe('append-only pagination', () => {
    const many = (n, over = () => ({})) =>
        Array.from({ length: n }, (_, i) =>
            JOB({
                key: `k${String(i).padStart(4, '0')}`,
                addedAt: NOW - i,
                ...over(i),
            }),
        );

    it('renders the first page and arms the sentinel', async () => {
        await boot(snapshot({ active: many(120) }));
        expect(rows()).toHaveLength(50);
        expect($('queue-load-more').classList.contains('hidden')).toBe(false);
        expect(observers).toHaveLength(1);
        expect(observers[0].opts.root).toBe($('queue-viewport'));
    });

    it('appends the next page when the sentinel intersects', async () => {
        await boot(snapshot({ active: many(120) }));
        observers[0].trigger();
        expect(rows()).toHaveLength(100);
        observers[0].trigger();
        expect(rows()).toHaveLength(120);
        // Everything is rendered — the sentinel retires.
        expect($('queue-load-more').classList.contains('hidden')).toBe(true);
    });

    it('ignores a non-intersecting observer callback', async () => {
        await boot(snapshot({ active: many(120) }));
        observers[0].trigger(false);
        expect(rows()).toHaveLength(50);
    });

    it('hides the sentinel when everything already fits', async () => {
        await boot(snapshot({ active: many(10) }));
        expect($('queue-load-more').classList.contains('hidden')).toBe(true);
    });

    it('caps the DOM at MAX_DOM_ROWS by dropping rows off the top', async () => {
        await boot(snapshot({ active: many(700) }));
        for (let i = 0; i < 13; i++) observers[0].trigger();
        // 50 + 13*50 = 700 rendered, but the DOM holds at most 500.
        expect(rows()).toHaveLength(500);
        expect(rowKeys()[0]).toBe('k0200');
        expect(rowKeys().at(-1)).toBe('k0699');
    });
});

// ---- WS handling --------------------------------------------------------

describe('WebSocket events', () => {
    it('adds a row on download_start', async () => {
        await boot();
        fire({
            type: 'download_start',
            payload: { key: 'new', groupId: '-1', fileName: 'x.mp4' },
        });
        await settle();
        expect(rowKeys()).toEqual(['new']);
        expect(rowFor('new').querySelector('[data-row-status]').dataset.status).toBe('active');
    });

    it('keeps known fields from the previous row when download_start omits them', async () => {
        await boot(snapshot({ queued: [JOB({ status: 'queued' })] }));
        fire({
            type: 'download_start',
            payload: { key: '-100123_11', groupId: '-100123' },
        });
        await settle();
        expect(rowFor('-100123_11').textContent).toContain('clip.mp4');
    });

    it('patches progress in place without re-rendering the row', async () => {
        await boot(snapshot({ active: [JOB({ progress: 10, received: 0, bps: 0 })] }));
        const before = rowFor('-100123_11');
        fire({
            type: 'download_progress',
            payload: {
                key: '-100123_11',
                progress: 75,
                received: 1_500_000,
                total: 2_000_000,
                bps: 500_000,
            },
        });
        await settle();
        const after = rowFor('-100123_11');
        expect(after).toBe(before); // same node — patched, not replaced
        expect(after.querySelector('[data-row-bar]').style.width).toBe('75%');
        expect(after.querySelector('[data-row-pct]').textContent).toBe('75%');
        expect(after.querySelector('[data-row-meta]').textContent).toContain('488.28 KB/s');
    });

    it('derives ETA from the remaining bytes and the current rate', async () => {
        await boot(snapshot({ active: [JOB()] }));
        fire({
            type: 'download_progress',
            payload: {
                key: '-100123_11',
                received: 1_000_000,
                total: 3_000_000,
                bps: 1_000_000,
            },
        });
        await settle();
        // 2 MB left at 1 MB/s → 2s.
        expect(rowFor('-100123_11').querySelector('[data-row-meta]').textContent).toContain('2s');
    });

    it('leaves the ETA blank when the transfer is stalled', async () => {
        await boot(snapshot({ active: [JOB()] }));
        fire({
            type: 'download_progress',
            payload: {
                key: '-100123_11',
                received: 100,
                total: 3_000_000,
                bps: 0,
            },
        });
        await settle();
        const meta = rowFor('-100123_11').querySelector('[data-row-meta]').textContent;
        expect(meta).not.toMatch(/\d+[smh]$/);
    });

    it('coalesces a burst of progress events into a single applied payload', async () => {
        await boot(snapshot({ active: [JOB()] }));
        for (const p of [20, 40, 60, 80]) {
            fire({
                type: 'download_progress',
                payload: {
                    key: '-100123_11',
                    progress: p,
                    received: 1,
                    total: 2,
                    bps: 1,
                },
            });
        }
        await settle();
        expect(rowFor('-100123_11').querySelector('[data-row-bar]').style.width).toBe('80%');
    });

    it('replaces the row when download_complete flips the status', async () => {
        await boot(snapshot({ active: [JOB()] }));
        const before = rowFor('-100123_11');
        fire({
            type: 'download_complete',
            payload: {
                key: '-100123_11',
                groupId: '-100123',
                filePath: '/data/media/clip.mp4',
                fileSize: 2_000_000,
                deduped: true,
            },
        });
        await settle();
        const after = rowFor('-100123_11');
        expect(after).not.toBe(before); // status change ⇒ the row is re-rendered
        expect(after.querySelector('[data-row-status]').dataset.status).toBe('done');
        expect(after.textContent).toContain('Duplicate');
        expect(after.dataset.rowOpen).toBe('/data/media/clip.mp4');
    });

    it('derives the display name from the file path when download_complete omits it', async () => {
        await boot();
        fire({
            type: 'download_complete',
            payload: {
                key: 'k',
                groupId: '-1',
                filePath: '/data/media/sub/movie.mkv',
            },
        });
        await settle();
        expect(rowFor('k').textContent).toContain('movie.mkv');
    });

    it('marks a row failed with its error text on download_error', async () => {
        await boot(snapshot({ active: [JOB()] }));
        fire({
            type: 'download_error',
            payload: {
                job: { key: '-100123_11', groupId: '-100123' },
                error: 'TIMEOUT',
            },
        });
        await settle();
        expect(rowFor('-100123_11').querySelector('[data-row-status]').dataset.status).toBe(
            'failed',
        );
        expect(rowFor('-100123_11').textContent).toContain('TIMEOUT');
        expect($('queue-retry-all').disabled).toBe(false);
    });

    it('falls back to a generic message when download_error carries none', async () => {
        await boot();
        fire({
            type: 'download_error',
            payload: { job: { key: 'k', groupId: '-1' } },
        });
        await settle();
        expect(rowFor('k').textContent).toContain('Download failed');
    });

    it('ignores payloads with no key', async () => {
        await boot(snapshot({ active: [JOB()] }));
        fire({ type: 'download_start', payload: {} });
        fire({ type: 'download_progress', payload: {} });
        fire({ type: 'download_complete', payload: {} });
        fire({ type: 'download_error', payload: { job: {} } });
        await settle();
        expect(rowKeys()).toEqual(['-100123_11']);
    });

    it('ignores unknown message types', async () => {
        await boot(snapshot({ active: [JOB()] }));
        fire({ type: 'queue_length', payload: { n: 9 } });
        fire({ type: 'something_else' });
        await settle();
        expect(rowKeys()).toEqual(['-100123_11']);
    });

    describe('queue_changed', () => {
        it('flips the global paused banner', async () => {
            await boot(snapshot({ active: [JOB()] }));
            fire({ type: 'queue_changed', payload: { op: 'pause-all' } });
            await settle();
            expect($('queue-aggregate').textContent).toContain('Globally paused');

            fire({ type: 'queue_changed', payload: { op: 'resume-all' } });
            await settle();
            expect($('queue-aggregate').textContent).not.toContain('Globally paused');
        });

        it('drops queued and paused rows on cancel-all but keeps active ones', async () => {
            await boot(
                snapshot({
                    active: [JOB({ key: 'a', status: 'active' })],
                    queued: [
                        JOB({ key: 'q', status: 'queued' }),
                        JOB({ key: 'p', status: 'paused' }),
                    ],
                }),
            );
            fire({ type: 'queue_changed', payload: { op: 'cancel-all' } });
            await settle();
            expect(rowKeys()).toEqual(['a']);
        });

        it('drops finished rows on clear-finished', async () => {
            await boot(
                snapshot({
                    active: [JOB({ key: 'a', status: 'active' })],
                    recent: [
                        JOB({ key: 'd', status: 'done' }),
                        JOB({ key: 'f', status: 'failed' }),
                    ],
                }),
            );
            fire({ type: 'queue_changed', payload: { op: 'clear-finished' } });
            await settle();
            expect(rowKeys()).toEqual(['a']);
        });

        it('pauses, resumes and retries a single row', async () => {
            await boot(snapshot({ active: [JOB()] }));
            const status = () =>
                rowFor('-100123_11').querySelector('[data-row-status]').dataset.status;

            fire({
                type: 'queue_changed',
                payload: { op: 'pause', key: '-100123_11' },
            });
            await settle();
            expect(status()).toBe('paused');

            fire({
                type: 'queue_changed',
                payload: { op: 'resume', key: '-100123_11' },
            });
            await settle();
            // Bytes already landed, so a resume goes straight back to active.
            expect(status()).toBe('active');
        });

        it('resumes a row with no bytes back into the queued state', async () => {
            await boot(snapshot({ queued: [JOB({ status: 'paused', received: 0 })] }));
            fire({
                type: 'queue_changed',
                payload: { op: 'resume', key: '-100123_11' },
            });
            await settle();
            expect(rowFor('-100123_11').querySelector('[data-row-status]').dataset.status).toBe(
                'queued',
            );
        });

        it('clears the error and the progress when a failed row is retried', async () => {
            await boot(
                snapshot({
                    recent: [
                        JOB({
                            status: 'failed',
                            error: 'TIMEOUT',
                            progress: 66,
                        }),
                    ],
                }),
            );
            fire({
                type: 'queue_changed',
                payload: { op: 'retry', key: '-100123_11' },
            });
            await settle();
            const row = rowFor('-100123_11');
            expect(row.querySelector('[data-row-status]').dataset.status).toBe('queued');
            expect(row.textContent).not.toContain('TIMEOUT');
            expect(row.querySelector('[data-row-bar]').style.width).toBe('0%');
            // The retry-all button follows the failed count back down.
            expect($('queue-retry-all').disabled).toBe(true);
        });

        it('removes a cancelled row', async () => {
            await boot(snapshot({ active: [JOB()] }));
            fire({
                type: 'queue_changed',
                payload: { op: 'cancel', key: '-100123_11' },
            });
            await settle();
            expect(rows()).toHaveLength(0);
        });

        it('re-renders on a keyless payload', async () => {
            await boot(snapshot({ active: [JOB()] }));
            fire({ type: 'queue_changed', payload: {} });
            await settle();
            expect(rowKeys()).toEqual(['-100123_11']);
        });

        it('ignores a row op for a key the store never saw', async () => {
            await boot(snapshot({ active: [JOB()] }));
            fire({
                type: 'queue_changed',
                payload: { op: 'pause', key: 'ghost' },
            });
            await settle();
            expect(rowKeys()).toEqual(['-100123_11']);
        });
    });

    describe('monitor_state', () => {
        it('drops in-flight rows but keeps history when the engine stops', async () => {
            await boot(
                snapshot({
                    active: [JOB({ key: 'a', status: 'active' })],
                    queued: [
                        JOB({ key: 'q', status: 'queued' }),
                        JOB({ key: 'p', status: 'paused' }),
                    ],
                    recent: [
                        JOB({ key: 'd', status: 'done' }),
                        JOB({ key: 'f', status: 'failed' }),
                    ],
                }),
            );
            fire({ type: 'monitor_state', state: 'stopped' });
            await settle();
            expect(rowKeys().sort()).toEqual(['d', 'f']);
            expect($('queue-aggregate').textContent).toContain('Engine stopped');
        });

        it('treats an errored engine the same as a stopped one', async () => {
            await boot(snapshot({ active: [JOB({ key: 'a' })] }));
            fire({ type: 'monitor_state', state: 'error' });
            await settle();
            expect(rows()).toHaveLength(0);
        });

        it('clears the stopped banner when the engine comes back', async () => {
            await boot(snapshot({ active: [JOB()] }));
            fire({ type: 'monitor_state', state: 'stopped' });
            await settle();
            fire({ type: 'monitor_state', state: 'running' });
            await settle();
            expect($('queue-aggregate').textContent).not.toContain('Engine stopped');
        });
    });
});

// ---- aggregate + nav badge ---------------------------------------------

describe('aggregate strip and nav badge', () => {
    it('sums active count, queued count and throughput', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a1', bps: 1_000_000 }), JOB({ key: 'a2', bps: 500_000 })],
                queued: [JOB({ key: 'q1', status: 'queued' })],
            }),
        );
        const text = $('queue-aggregate').textContent;
        expect(text).toContain('2 active');
        expect(text).toContain('1 queued');
        expect(text).toContain('1.43 MB/s');
    });

    it('draws a sparkline of recent throughput', async () => {
        await boot(snapshot({ active: [JOB({ bps: 1_000_000 })] }));
        const poly = $('queue-aggregate').querySelector('polyline');
        expect(poly).not.toBeNull();
        expect(poly.getAttribute('points').split(' ')).toHaveLength(60);
    });

    it('shows the nav badge for in-flight work and hides it when idle', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a' })],
                queued: [JOB({ key: 'q', status: 'queued' })],
            }),
        );
        expect($('queue-nav-badge').textContent).toBe('2');
        expect($('queue-nav-badge').classList.contains('hidden')).toBe(false);

        fire({ type: 'queue_changed', payload: { op: 'cancel', key: 'a' } });
        fire({ type: 'queue_changed', payload: { op: 'cancel', key: 'q' } });
        await settle();
        expect($('queue-nav-badge').classList.contains('hidden')).toBe(true);
    });

    it('caps the nav badge at 99+', async () => {
        await boot(
            snapshot({
                queued: Array.from({ length: 150 }, (_, i) =>
                    JOB({ key: `k${i}`, status: 'queued' }),
                ),
            }),
        );
        expect($('queue-nav-badge').textContent).toBe('99+');
    });
});

// ---- per-row actions ----------------------------------------------------

describe('per-row actions', () => {
    it('posts pause, resume and retry for the clicked row', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a', status: 'active' })],
                queued: [JOB({ key: 'p', status: 'paused' })],
                recent: [JOB({ key: 'f', status: 'failed' })],
            }),
        );
        rowFor('a').querySelector('[data-row-action="pause"]').click();
        rowFor('p').querySelector('[data-row-action="resume"]').click();
        rowFor('f').querySelector('[data-row-action="retry"]').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/a/pause');
        expect(api.post).toHaveBeenCalledWith('/api/queue/p/resume');
        expect(api.post).toHaveBeenCalledWith('/api/queue/f/retry');
    });

    it('url-encodes the key', async () => {
        await boot(snapshot({ active: [JOB({ key: 'a/b c' })] }));
        rowFor('a/b c').querySelector('[data-row-action="pause"]').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/a%2Fb%20c/pause');
    });

    it('confirms before cancelling, then drops the row', async () => {
        await boot(snapshot({ active: [JOB()] }));
        rowFor('-100123_11').querySelector('[data-row-action="cancel"]').click();
        await settle();
        expect(confirmSheet).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
        expect(api.post).toHaveBeenCalledWith('/api/queue/-100123_11/cancel');
        expect(rows()).toHaveLength(0);
    });

    it('leaves the row alone when the cancel confirm is declined', async () => {
        confirmAnswer = false;
        await boot(snapshot({ active: [JOB()] }));
        rowFor('-100123_11').querySelector('[data-row-action="cancel"]').click();
        await settle();
        expect(api.post).not.toHaveBeenCalled();
        expect(rows()).toHaveLength(1);
    });

    it('dismisses a finished row locally without touching the server', async () => {
        await boot(snapshot({ recent: [JOB({ status: 'done' })] }));
        rowFor('-100123_11').querySelector('[data-row-action="dismiss"]').click();
        await settle();
        expect(api.post).not.toHaveBeenCalled();
        expect(rows()).toHaveLength(0);
    });

    it('toasts when a row action fails', async () => {
        await boot(snapshot({ active: [JOB()] }));
        api.post.mockRejectedValueOnce(new Error('offline'));
        rowFor('-100123_11').querySelector('[data-row-action="pause"]').click();
        await settle();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('offline'), 'error');
    });
});

// ---- global actions -----------------------------------------------------

describe('toolbar actions', () => {
    it('posts pause-all and resume-all', async () => {
        await boot(snapshot({ active: [JOB()] }));
        $('queue-pause-all').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/pause-all');

        $('queue-resume-all').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/resume-all');
    });

    it('confirms cancel-all', async () => {
        await boot(snapshot({ queued: [JOB({ status: 'queued' })] }));
        $('queue-cancel-all').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/cancel-all');
    });

    it('skips cancel-all when the confirm is declined', async () => {
        confirmAnswer = false;
        await boot(snapshot({ queued: [JOB({ status: 'queued' })] }));
        $('queue-cancel-all').click();
        await settle();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('clears finished rows locally as well as on the server', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a' })],
                recent: [JOB({ key: 'd', status: 'done' }), JOB({ key: 'f', status: 'failed' })],
            }),
        );
        $('queue-clear-finished').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/clear-finished');
        expect(rowKeys()).toEqual(['a']);
    });

    it('toasts when a global action fails', async () => {
        await boot();
        api.post.mockRejectedValueOnce(new Error('503'));
        $('queue-pause-all').click();
        await settle();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('503'), 'error');
    });

    it('disables retry-all with no failed jobs and enables it once one lands', async () => {
        await boot(snapshot({ active: [JOB()] }));
        expect($('queue-retry-all').disabled).toBe(true);
        fire({
            type: 'download_error',
            payload: { job: { key: 'x', groupId: '-1' }, error: 'nope' },
        });
        await settle();
        expect($('queue-retry-all').disabled).toBe(false);
    });

    it('reports what retry-all retried and skipped', async () => {
        await boot(snapshot({ recent: [JOB({ status: 'failed' })] }));
        api.post.mockResolvedValueOnce({ retried: 3, skipped: 2 });
        $('queue-retry-all').click();
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/queue/retry-all');
        expect(showToast).toHaveBeenCalledWith('Retried 3, skipped 2', 'success');
    });

    it('says so when retry-all had nothing to do', async () => {
        await boot(snapshot({ recent: [JOB({ status: 'failed' })] }));
        api.post.mockResolvedValueOnce({ retried: 0, skipped: 0 });
        $('queue-retry-all').click();
        await settle();
        expect(showToast).toHaveBeenCalledWith('No failed jobs to retry', 'info');
    });

    it('toasts when retry-all fails', async () => {
        await boot(snapshot({ recent: [JOB({ status: 'failed' })] }));
        api.post.mockRejectedValueOnce(new Error('gone'));
        $('queue-retry-all').click();
        await settle();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('gone'), 'error');
    });
});

// ---- selection ----------------------------------------------------------

describe('selection', () => {
    const THREE = () =>
        snapshot({
            active: [
                JOB({ key: 'a', addedAt: NOW - 1 }),
                JOB({ key: 'b', addedAt: NOW - 2 }),
                JOB({ key: 'c', addedAt: NOW - 3 }),
            ],
        });

    const checkbox = (key) => rowFor(key).querySelector('input[data-row-select]');

    it('toggles a row via its checkbox and shows the floating bar', async () => {
        await boot(THREE());
        checkbox('a').click();
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(false);
        expect($('queue-selection-count').textContent).toBe('1 selected');
        // The FAB shares the bottom-right corner, so it steps aside.
        expect($('fab').style.visibility).toBe('hidden');

        checkbox('a').click();
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
        expect($('fab').style.visibility).toBe('');
    });

    it('pluralises the selection counter', async () => {
        await boot(THREE());
        checkbox('a').click();
        checkbox('b').click();
        await settle();
        expect($('queue-selection-count').textContent).toBe('2 selected');
    });

    it('toggles a row with a modifier-click anywhere on it', async () => {
        await boot(THREE());
        click(rowFor('b').querySelector('.min-w-0'), { metaKey: true });
        await settle();
        expect(checkbox('b').checked).toBe(true);
        expect(rowFor('b').classList.contains('bg-tg-blue/10')).toBe(true);
    });

    it('selects an inclusive range on shift-click, in the current sort order', async () => {
        await boot(THREE());
        checkbox('a').click();
        await settle();
        click(checkbox('c'), { shiftKey: true });
        await settle();
        expect($('queue-selection-count').textContent).toBe('3 selected');
        expect(checkbox('b').checked).toBe(true);
    });

    it('selects a backwards range just the same', async () => {
        await boot(THREE());
        checkbox('c').click();
        await settle();
        click(checkbox('a'), { shiftKey: true });
        await settle();
        expect($('queue-selection-count').textContent).toBe('3 selected');
    });

    it('falls back to a plain toggle when there is no pivot', async () => {
        await boot(THREE());
        click(checkbox('b'), { shiftKey: true });
        await settle();
        expect($('queue-selection-count').textContent).toBe('1 selected');
    });

    it('unions rather than subtracts on an overlapping range', async () => {
        await boot(THREE());
        checkbox('a').click();
        await settle();
        click(checkbox('b'), { shiftKey: true });
        await settle();
        click(checkbox('c'), { shiftKey: true });
        await settle();
        // The second range starts at b, but a stays selected.
        expect($('queue-selection-count').textContent).toBe('3 selected');
    });

    it('drives the header checkbox tri-state', async () => {
        await boot(THREE());
        const all = $('queue-select-all');
        expect(all.checked).toBe(false);
        expect(all.indeterminate).toBe(false);

        checkbox('a').click();
        await settle();
        expect(all.indeterminate).toBe(true);

        all.click();
        await settle();
        expect(all.checked).toBe(true);
        expect(all.indeterminate).toBe(false);
        expect($('queue-selection-count').textContent).toBe('3 selected');

        // Clicking again from "full" clears.
        all.click();
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
    });

    it('selects only the rows the current filter shows', async () => {
        await boot(
            snapshot({
                active: [JOB({ key: 'a' })],
                recent: [JOB({ key: 'f', status: 'failed' })],
            }),
        );
        $('queue-chips').querySelector('[data-chip="failed"]').click();
        await settle();
        $('queue-select-all').click();
        await settle();
        expect($('queue-selection-count').textContent).toBe('1 selected');
    });

    it('does nothing on select-all with an empty list', async () => {
        await boot();
        $('queue-select-all').click();
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
    });

    it('drops a row from the selection when it disappears', async () => {
        await boot(THREE());
        checkbox('a').click();
        checkbox('b').click();
        await settle();
        fire({ type: 'queue_changed', payload: { op: 'cancel', key: 'a' } });
        await settle();
        expect($('queue-selection-count').textContent).toBe('1 selected');
    });

    it('clears the selection from the bar', async () => {
        await boot(THREE());
        checkbox('a').click();
        await settle();
        $('queue-selection-clear').click();
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
    });

    it('hides the bar when the page is navigated away from', async () => {
        await boot(THREE());
        checkbox('a').click();
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(false);

        // The bar is position:fixed — leaving it up would float it over
        // whatever page the user went to.
        $('page-queue').classList.add('hidden');
        await settle();
        expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
    });

    it('survives a re-render of the row window', async () => {
        await boot(THREE());
        checkbox('a').click();
        await settle();
        $('queue-sort').value = 'filename';
        $('queue-sort').dispatchEvent(new window.Event('change'));
        await settle();
        expect(checkbox('a').checked).toBe(true);
        expect($('queue-selection-count').textContent).toBe('1 selected');
    });

    describe('keyboard', () => {
        const key = (init) =>
            document.dispatchEvent(
                new window.KeyboardEvent('keydown', {
                    bubbles: true,
                    cancelable: true,
                    ...init,
                }),
            );

        it('selects everything visible on ctrl/cmd+A', async () => {
            await boot(THREE());
            key({ key: 'a', ctrlKey: true });
            await settle();
            expect($('queue-selection-count').textContent).toBe('3 selected');
        });

        it('clears the selection on Escape', async () => {
            await boot(THREE());
            key({ key: 'a', metaKey: true });
            await settle();
            key({ key: 'Escape' });
            await settle();
            expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
        });

        it('stays out of the way while the user is typing', async () => {
            await boot(THREE());
            const input = $('queue-search');
            input.dispatchEvent(
                new window.KeyboardEvent('keydown', {
                    key: 'a',
                    ctrlKey: true,
                    bubbles: true,
                    cancelable: true,
                }),
            );
            await settle();
            expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
        });

        it('ignores shortcuts while another page is showing', async () => {
            await boot(THREE());
            $('page-queue').classList.add('hidden');
            await settle();
            key({ key: 'a', ctrlKey: true });
            await settle();
            // The bar is hidden either way while the page is away, so assert
            // on the selection itself: coming back must not reveal rows the
            // shortcut picked up behind another page's back.
            $('page-queue').classList.remove('hidden');
            await settle();
            expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
            expect($('queue-select-all').checked).toBe(false);
        });
    });

    describe('batch actions', () => {
        const batch = (action) =>
            $('queue-selection-bar').querySelector(`[data-batch-action="${action}"]`).click();

        it('posts the selected keys and clears the selection', async () => {
            await boot(THREE());
            checkbox('a').click();
            checkbox('b').click();
            await settle();
            api.post.mockResolvedValueOnce({ ok: 2 });
            batch('pause');
            await settle();
            expect(api.post).toHaveBeenCalledWith('/api/queue/batch', {
                keys: ['a', 'b'],
                action: 'pause',
            });
            expect(showToast).toHaveBeenCalledWith('2 updated (pause)', 'success');
            expect($('queue-selection-bar').classList.contains('hidden')).toBe(true);
        });

        it('confirms a batch cancel and names the count', async () => {
            await boot(THREE());
            checkbox('a').click();
            checkbox('b').click();
            await settle();
            batch('cancel');
            await settle();
            expect(confirmSheet).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('2 downloads'),
                }),
            );
            expect(api.post).toHaveBeenCalledWith(
                '/api/queue/batch',
                expect.objectContaining({ action: 'cancel' }),
            );
        });

        it('uses the singular phrasing for a one-row batch cancel', async () => {
            await boot(THREE());
            checkbox('a').click();
            await settle();
            batch('cancel');
            await settle();
            expect(confirmSheet).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('this download'),
                }),
            );
        });

        it('aborts the batch when the cancel confirm is declined', async () => {
            confirmAnswer = false;
            await boot(THREE());
            checkbox('a').click();
            await settle();
            batch('cancel');
            await settle();
            expect(api.post).not.toHaveBeenCalled();
        });

        it('drops the rows locally on a batch dismiss', async () => {
            await boot(THREE());
            checkbox('a').click();
            checkbox('b').click();
            await settle();
            batch('dismiss');
            await settle();
            expect(rowKeys()).toEqual(['c']);
        });

        it('falls back to the selection size when the server reports no count', async () => {
            await boot(THREE());
            checkbox('a').click();
            await settle();
            api.post.mockResolvedValueOnce({});
            batch('retry');
            await settle();
            expect(showToast).toHaveBeenCalledWith('1 updated (retry)', 'success');
        });

        it('toasts and keeps the selection when the batch fails', async () => {
            await boot(THREE());
            checkbox('a').click();
            await settle();
            api.post.mockRejectedValueOnce(new Error('nope'));
            batch('resume');
            await settle();
            expect(showToast).toHaveBeenCalledWith(expect.stringContaining('nope'), 'error');
            expect($('queue-selection-bar').classList.contains('hidden')).toBe(false);
        });

        it('does nothing with an empty selection', async () => {
            await boot(THREE());
            batch('pause');
            await settle();
            expect(api.post).not.toHaveBeenCalled();
        });

        it('acts on the selection as it was when the button was pressed', async () => {
            await boot(THREE());
            checkbox('a').click();
            await settle();
            let resolve;
            api.post.mockReturnValueOnce(new Promise((r) => (resolve = r)));
            batch('pause');
            await settle();
            // Selection churn mid-flight must not change what was sent.
            checkbox('b').click();
            await settle();
            resolve({ ok: 1 });
            await settle();
            expect(api.post).toHaveBeenCalledWith('/api/queue/batch', {
                keys: ['a'],
                action: 'pause',
            });
        });

        it('ignores a click on non-action chrome in the bar', async () => {
            await boot(THREE());
            checkbox('a').click();
            await settle();
            click($('queue-selection-count'));
            await settle();
            expect(api.post).not.toHaveBeenCalled();
            expect($('queue-selection-bar').classList.contains('hidden')).toBe(false);
        });
    });
});

// ---- opening a finished row --------------------------------------------

describe('opening a finished row', () => {
    const DONE = (over = {}) =>
        snapshot({
            recent: [
                JOB({
                    status: 'done',
                    progress: 100,
                    filePath: '/data/media/clip.mp4',
                    ...over,
                }),
            ],
        });

    it('hands the file to the in-app viewer', async () => {
        window.Viewer = { openMediaViewerSingle: vi.fn() };
        await boot(DONE());
        click(rowFor('-100123_11').querySelector('.min-w-0'));
        await settle();
        expect(window.Viewer.openMediaViewerSingle).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'clip.mp4',
                fullPath: '/data/media/clip.mp4',
                type: 'videos',
                extension: '.mp4',
            }),
        );
    });

    it('maps each media kind onto the gallery bucket the viewer expects', async () => {
        const seen = [];
        window.Viewer = {
            openMediaViewerSingle: vi.fn((f) => seen.push(f.type)),
        };
        await boot(
            snapshot({
                recent: [
                    JOB({
                        key: 'i',
                        status: 'done',
                        mediaType: 'image',
                        fileName: 'a.png',
                        filePath: '/m/a.png',
                    }),
                    JOB({
                        key: 'au',
                        status: 'done',
                        mediaType: 'audio',
                        fileName: 'a.mp3',
                        filePath: '/m/a.mp3',
                    }),
                    JOB({
                        key: 'doc',
                        status: 'done',
                        mediaType: 'document',
                        fileName: 'a.pdf',
                        filePath: '/m/a.pdf',
                    }),
                ],
            }),
        );
        for (const k of ['i', 'au', 'doc']) {
            click(rowFor(k).querySelector('.min-w-0'));
        }
        await settle();
        expect(seen).toEqual(['images', 'audio', 'documents']);
    });

    it('opens a new tab when the viewer is not on the page', async () => {
        const open = vi.fn();
        window.open = open;
        await boot(DONE());
        click(rowFor('-100123_11').querySelector('.min-w-0'));
        await settle();
        expect(open).toHaveBeenCalledWith('/files/%2Fdata%2Fmedia%2Fclip.mp4?inline=1', '_blank');
    });

    it('falls back to a new tab when the viewer throws', async () => {
        const open = vi.fn();
        window.open = open;
        window.Viewer = {
            openMediaViewerSingle: () => {
                throw new Error('viewer exploded');
            },
        };
        await boot(DONE());
        click(rowFor('-100123_11').querySelector('.min-w-0'));
        await settle();
        expect(open).toHaveBeenCalled();
    });

    it('is not clickable while the job is still running', async () => {
        window.Viewer = { openMediaViewerSingle: vi.fn() };
        await boot(snapshot({ active: [JOB()] }));
        expect(rowFor('-100123_11').dataset.rowOpen).toBeUndefined();
        click(rowFor('-100123_11').querySelector('.min-w-0'));
        await settle();
        expect(window.Viewer.openMediaViewerSingle).not.toHaveBeenCalled();
    });

    it('does not open while the user is selecting text', async () => {
        window.Viewer = { openMediaViewerSingle: vi.fn() };
        await boot(DONE());
        const sel = window.getSelection();
        vi.spyOn(window, 'getSelection').mockReturnValue({
            toString: () => 'clip',
        });
        click(rowFor('-100123_11').querySelector('.min-w-0'));
        await settle();
        expect(window.Viewer.openMediaViewerSingle).not.toHaveBeenCalled();
        vi.mocked(window.getSelection).mockReturnValue(sel);
    });

    it('does not open when the click carries a selection modifier', async () => {
        window.Viewer = { openMediaViewerSingle: vi.fn() };
        await boot(DONE());
        click(rowFor('-100123_11').querySelector('.min-w-0'), {
            ctrlKey: true,
        });
        await settle();
        expect(window.Viewer.openMediaViewerSingle).not.toHaveBeenCalled();
        expect($('queue-selection-count').textContent).toBe('1 selected');
    });
});

// ---- throttle slider ----------------------------------------------------

describe('throttle slider', () => {
    it('seeds itself from the server config', async () => {
        await boot(snapshot({ maxSpeed: 1_048_576 }));
        expect($('queue-throttle').value).toBe('1048576');
        expect($('queue-throttle-value').textContent).toBe('1 MB/s');
    });

    it('clamps a config value above the slider maximum', async () => {
        await boot(snapshot({ maxSpeed: 999_999_999 }));
        expect($('queue-throttle').value).toBe('52428800');
    });

    it('reads unlimited when no limit is configured', async () => {
        await boot(snapshot({ maxSpeed: null }));
        expect($('queue-throttle-value').textContent).toBe('Unlimited');
    });

    it('debounces the save and posts the new limit', async () => {
        await boot();
        const slider = $('queue-throttle');
        slider.value = '262144';
        slider.dispatchEvent(new window.Event('input'));
        expect($('queue-throttle-value').textContent).toBe('256 KB/s');
        expect(api.post).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(400);
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            download: { maxSpeed: 262144 },
        });
        expect(showToast).toHaveBeenCalledWith('Speed limit updated', 'success');
        expect(slider.disabled).toBe(false);
    });

    it('sends null rather than zero when the slider is dragged to unlimited', async () => {
        await boot(snapshot({ maxSpeed: 262_144 }));
        const slider = $('queue-throttle');
        slider.value = '0';
        slider.dispatchEvent(new window.Event('input'));
        await vi.advanceTimersByTimeAsync(400);
        await settle();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            download: { maxSpeed: null },
        });
    });

    it('re-enables the slider after a failed save', async () => {
        await boot();
        api.post.mockRejectedValueOnce(new Error('read-only config'));
        const slider = $('queue-throttle');
        slider.value = '524288';
        slider.dispatchEvent(new window.Event('input'));
        await vi.advanceTimersByTimeAsync(400);
        await settle();
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('read-only config'),
            'error',
        );
        expect(slider.disabled).toBe(false);
    });

    it('wires the slider only once across repeat visits', async () => {
        const mod = await boot();
        await mod.showQueuePage();
        await settle();
        const slider = $('queue-throttle');
        slider.value = '262144';
        slider.dispatchEvent(new window.Event('input'));
        await vi.advanceTimersByTimeAsync(400);
        await settle();
        // A second listener would fire a second POST for the same drag.
        expect(api.post).toHaveBeenCalledTimes(1);
    });
});

// ---- background rendering ----------------------------------------------

describe('rendering while the page is hidden', () => {
    it('keeps the store and the nav badge current without touching the rows', async () => {
        await boot(snapshot({ active: [JOB({ key: 'a' })] }));
        $('page-queue').classList.add('hidden');
        await settle();

        fire({
            type: 'download_start',
            payload: { key: 'b', groupId: '-1', fileName: 'y.mp4' },
        });
        await settle();
        // Rows are not repainted for an invisible page…
        expect(rowKeys()).toEqual(['a']);
        // …but the badge the user can still see is accurate.
        expect($('queue-nav-badge').textContent).toBe('2');

        $('page-queue').classList.remove('hidden');
        await settle();
        fire({ type: 'queue_changed', payload: {} });
        await settle();
        expect(rowKeys().sort()).toEqual(['a', 'b']);
    });
});
