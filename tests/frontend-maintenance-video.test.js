// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-video.js — the faststart
// optimiser page: stats fetch, auto-optimise counters, the scan
// button + progress bar, WS-driven progress/done events, and boot-time
// in-flight recovery.
//
// api.js and ws.js are mocked; showToast is mocked. i18n stays real
// (synchronous fallback path).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn() };
const showToast = vi.fn();

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
vi.mock('../src/web/public/js/utils.js', () => ({ showToast }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <button id="video-scan-btn"><i class="ri-icon"></i><span data-i18n="maintenance.video.scan_all">Optimise all</span></button>
    <div id="video-progress" class="hidden">
        <div id="video-progress-bar"></div>
        <span id="video-progress-pct"></span>
        <span id="video-progress-status"></span>
    </div>
    <span id="video-stat-total"></span>
    <span id="video-stat-optimized"></span>
    <span id="video-stat-pending"></span>
    <span id="video-stat-skipped"></span>
    <span id="video-stat-last"></span>
    <div id="video-stat-summary" class="hidden"></div>
    <div id="video-no-ffmpeg" class="hidden"></div>
    <span id="video-auto-stat-total"></span>
    <span id="video-auto-stat-optimized"></span>
    <span id="video-auto-stat-already"></span>
    <span id="video-auto-stat-errored"></span>
    <span id="video-auto-stat-last"></span>
    <div id="video-auto-stat-last-error" class="hidden"></div>
`;

function statsResponse(over = {}) {
    return { total: 0, optimized: 0, pending: 0, missing: 0, unknown: 0, ext_skip: 0, ...over };
}
function autoStatsResponse(over = {}) {
    return { total: 0, optimized: 0, already: 0, errored: 0, lastAt: null, ...over };
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function loadModule({
    stats = statsResponse(),
    autoStats = autoStatsResponse(),
    status = { running: false },
} = {}) {
    vi.resetModules();
    ws = makeFakeWs();
    document.body.innerHTML = DOM;
    api.get.mockImplementation((url) => {
        if (url === '/api/maintenance/faststart/stats') return Promise.resolve(stats);
        if (url === '/api/maintenance/faststart/auto-stats') return Promise.resolve(autoStats);
        if (url === '/api/maintenance/faststart/status') return Promise.resolve(status);
        return Promise.resolve({});
    });
    return import('../src/web/public/js/maintenance-video.js');
}

beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({});
});

describe('init / stats fetch', () => {
    afterEach(() => vi.useRealTimers());

    it('fetches stats, auto-stats and boot status', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/faststart/stats');
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/faststart/auto-stats');
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/faststart/status');
    });

    it('renders total/optimized/pending counters', async () => {
        const { init } = await loadModule({
            stats: statsResponse({ total: 100, optimized: 40, pending: 10 }),
        });
        init();
        await flush();
        expect($('video-stat-total').textContent).toBe('100');
        expect($('video-stat-optimized').textContent).toBe('40');
        expect($('video-stat-pending').textContent).toBe('10');
    });

    it('lumps missing + unknown + ext_skip into the skipped counter', async () => {
        const { init } = await loadModule({
            stats: statsResponse({ missing: 2, unknown: 3, ext_skip: 5 }),
        });
        init();
        await flush();
        expect($('video-stat-skipped').textContent).toBe('10');
    });

    it('shows the no-ffmpeg chip only when ffmpeg is explicitly unavailable', async () => {
        const { init } = await loadModule({ stats: statsResponse({ ffmpegAvailable: false }) });
        init();
        await flush();
        expect($('video-no-ffmpeg').classList.contains('hidden')).toBe(false);
    });

    it('hides the no-ffmpeg chip when the field is absent (assume available)', async () => {
        const { init } = await loadModule({ stats: statsResponse() });
        init();
        await flush();
        expect($('video-no-ffmpeg').classList.contains('hidden')).toBe(true);
    });

    it('shows "Never" with no lastRun', async () => {
        const { init } = await loadModule({ stats: statsResponse() });
        init();
        await flush();
        expect($('video-stat-last').textContent).toBe('Never');
        expect($('video-stat-summary').classList.contains('hidden')).toBe(true);
    });

    it('shows the last-run summary with counts', async () => {
        const { init } = await loadModule({
            stats: statsResponse({
                lastRun: {
                    finishedAt: Date.now(),
                    optimized: 5,
                    already: 3,
                    skipped: 1,
                    scanned: 9,
                },
            }),
        });
        init();
        await flush();
        const summary = $('video-stat-summary');
        expect(summary.classList.contains('hidden')).toBe(false);
        expect(summary.textContent).toContain('5 optimised');
        expect(summary.textContent).toContain('3 already faststart');
        expect(summary.textContent).toContain('1 skipped');
        expect(summary.textContent).toContain('scanned 9');
    });

    it('leaves stats stale on a failed fetch rather than throwing', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/faststart/stats'
                ? Promise.reject(new Error('down'))
                : Promise.resolve({}),
        );
        expect(() => init()).not.toThrow();
        await flush();
        expect($('video-stat-total').textContent).toBe('');
    });
});

describe('auto-optimise stats', () => {
    it('renders every counter', async () => {
        const { init } = await loadModule({
            autoStats: autoStatsResponse({ total: 50, optimized: 30, already: 15, errored: 5 }),
        });
        init();
        await flush();
        expect($('video-auto-stat-total').textContent).toBe('50');
        expect($('video-auto-stat-optimized').textContent).toBe('30');
        expect($('video-auto-stat-already').textContent).toBe('15');
        expect($('video-auto-stat-errored').textContent).toBe('5');
    });

    it('shows "Never" with no lastAt', async () => {
        const { init } = await loadModule({ autoStats: autoStatsResponse({ lastAt: null }) });
        init();
        await flush();
        expect($('video-auto-stat-last').textContent).toBe('Never');
    });

    it('shows the last-error message only when errored > 0', async () => {
        const { init } = await loadModule({
            autoStats: autoStatsResponse({ errored: 1, lastError: 'ffmpeg crashed' }),
        });
        init();
        await flush();
        const el = $('video-auto-stat-last-error');
        expect(el.classList.contains('hidden')).toBe(false);
        expect(el.textContent).toBe('ffmpeg crashed');
    });

    it('hides the last-error message when errored is 0, even with a stale message', async () => {
        const { init } = await loadModule({
            autoStats: autoStatsResponse({ errored: 0, lastError: 'stale' }),
        });
        init();
        await flush();
        expect($('video-auto-stat-last-error').classList.contains('hidden')).toBe(true);
    });
});

describe('boot-time in-flight recovery', () => {
    it('shows the running UI when the server reports a scan in progress', async () => {
        const { init } = await loadModule({ status: { running: true } });
        init();
        await flush();
        expect($('video-scan-btn').disabled).toBe(true);
        expect($('video-progress').classList.contains('hidden')).toBe(false);
        expect($('video-scan-btn').querySelector('span').textContent).toBe('Optimising…');
    });

    it('leaves the UI idle when nothing is running', async () => {
        const { init } = await loadModule({ status: { running: false } });
        init();
        await flush();
        expect($('video-scan-btn').disabled).toBe(false);
    });

    it('does not throw when the status endpoint fails', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/faststart/status'
                ? Promise.reject(new Error('down'))
                : Promise.resolve({}),
        );
        expect(() => init()).not.toThrow();
        await flush();
    });
});

describe('scan button', () => {
    it('wires the click handler exactly once across repeated init calls', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        init();
        await flush();
        $('video-scan-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledTimes(1);
    });

    it('disables the button and shows the progress bar while scanning', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.post.mockImplementation(() => new Promise(() => {})); // never resolves
        $('video-scan-btn').click();
        expect($('video-scan-btn').disabled).toBe(true);
        expect($('video-progress').classList.contains('hidden')).toBe(false);
    });

    it('re-enables the button when the server responds with an error field', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.post.mockResolvedValue({ error: 'ffmpeg not found' });
        $('video-scan-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('ffmpeg not found', 'error');
        expect($('video-scan-btn').disabled).toBe(false);
    });

    it('shows a distinct message and leaves the UI running for ALREADY_RUNNING', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.post.mockRejectedValue({ data: { code: 'ALREADY_RUNNING' } });
        $('video-scan-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('another tab'), 'info');
        // Does NOT call _setUi(false) on this path — UI stays "running"
        // since the other tab's job really is in flight.
        expect($('video-scan-btn').disabled).toBe(true);
    });

    it('re-enables the button on a generic post failure', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.post.mockRejectedValue({ data: { error: 'boom' } });
        $('video-scan-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('boom', 'error');
        expect($('video-scan-btn').disabled).toBe(false);
    });

    it('resets the progress bar and percent text when the UI returns to idle', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_progress', { processed: 5, total: 10, optimized: 2 });
        expect($('video-progress-bar').style.width).toBe('50%');
        api.post.mockResolvedValue({ error: 'stop' });
        $('video-scan-btn').click();
        await flush();
        expect($('video-progress-bar').style.width).toBe('0%');
        expect($('video-progress-pct').textContent).toBe('');
    });
});

describe('WS progress/done events', () => {
    it('updates the bar width, status text and percent readout', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_progress', { processed: 3, total: 10, optimized: 1 });
        expect($('video-progress').classList.contains('hidden')).toBe(false);
        expect($('video-progress-bar').style.width).toBe('30%');
        expect($('video-progress-status').textContent).toBe('3 / 10 · 1 optimised');
        expect($('video-progress-pct').textContent).toBe('30% · 3 / 10');
    });

    it('clamps the bar at 100%', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_progress', { processed: 15, total: 10 });
        expect($('video-progress-bar').style.width).toBe('100%');
    });

    it('avoids a divide-by-zero when total is 0', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_progress', { processed: 0, total: 0 });
        expect($('video-progress-bar').style.width).not.toContain('NaN');
        expect($('video-progress-pct').textContent).toBe('');
    });

    it('re-enables the button and toasts success on done', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        $('video-scan-btn').disabled = true;
        await ws.emit('faststart_done', { optimized: 4, already: 2, scanned: 6 });
        expect($('video-scan-btn').disabled).toBe(false);
        expect(showToast).toHaveBeenCalledWith(
            'Optimised 4, 2 already faststart out of 6',
            'success',
        );
    });

    it('toasts an error message on a failed run', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_done', { error: 'disk full' });
        expect(showToast).toHaveBeenCalledWith('disk full', 'error');
    });

    it('refreshes both stats endpoints after done', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        api.get.mockClear();
        await ws.emit('faststart_done', { optimized: 1 });
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/faststart/stats');
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/faststart/auto-stats');
    });

    it('wires WS handlers exactly once across repeated init calls', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        init();
        await flush();
        const subs = ws.on.mock.calls.filter(([type]) => type === 'faststart_progress');
        expect(subs).toHaveLength(1);
    });
});

describe('per-file auto-optimise WS events', () => {
    it('increments the right counter for each result type', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_auto_done', { result: 'optimized' });
        await ws.emit('faststart_auto_done', { result: 'already' });
        await ws.emit('faststart_auto_done', { result: 'errored', error: 'boom' });
        expect($('video-auto-stat-total').textContent).toBe('3');
        expect($('video-auto-stat-optimized').textContent).toBe('1');
        expect($('video-auto-stat-already').textContent).toBe('1');
        expect($('video-auto-stat-errored').textContent).toBe('1');
        expect($('video-auto-stat-last-error').textContent).toBe('boom');
    });

    it('defaults an unrecognised result to skipped (no counter bump beyond total)', async () => {
        const { init } = await loadModule();
        init();
        await flush();
        await ws.emit('faststart_auto_done', {});
        expect($('video-auto-stat-total').textContent).toBe('1');
        expect($('video-auto-stat-optimized').textContent).toBe('0');
        expect($('video-auto-stat-already').textContent).toBe('0');
        expect($('video-auto-stat-errored').textContent).toBe('0');
    });

    it('accumulates on top of the fetched baseline, not from zero', async () => {
        const { init } = await loadModule({
            autoStats: autoStatsResponse({ total: 10, optimized: 5 }),
        });
        init();
        await flush();
        await ws.emit('faststart_auto_done', { result: 'optimized' });
        expect($('video-auto-stat-total').textContent).toBe('11');
        expect($('video-auto-stat-optimized').textContent).toBe('6');
    });
});

describe('duration backfill', () => {
    const DURATION_DOM = `
        <button id="duration-backfill-btn"><i class="ri-icon"></i><span data-i18n="maintenance.video.duration.run">Backfill durations</span></button>
        <div id="duration-progress" class="hidden">
            <div id="duration-progress-bar"></div>
            <span id="duration-progress-status"></span>
        </div>
        <span id="duration-stat-pending"></span>
        <span id="duration-stat-known"></span>
    `;

    async function loadDuration({
        stats = { pending: 3, known: 7 },
        status = { running: false },
    } = {}) {
        const mod = await loadModule();
        document.body.insertAdjacentHTML('beforeend', DURATION_DOM);
        api.get.mockImplementation((url) => {
            if (url === '/api/maintenance/duration/stats') return Promise.resolve(stats);
            if (url === '/api/maintenance/duration/status') return Promise.resolve(status);
            return Promise.resolve({});
        });
        mod.init();
        await flush();
        return mod;
    }

    it('renders pending / known counters', async () => {
        await loadDuration({ stats: { pending: 1234, known: 7 } });
        expect($('duration-stat-pending').textContent).toBe((1234).toLocaleString());
        expect($('duration-stat-known').textContent).toBe('7');
    });

    it('POSTs the backfill and disables the button while running', async () => {
        await loadDuration();
        $('duration-backfill-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/duration/backfill', {});
        expect($('duration-backfill-btn').disabled).toBe(true);
        expect($('duration-progress').classList.contains('hidden')).toBe(false);
    });

    it('re-enables the button and toasts when the server rejects the start', async () => {
        await loadDuration();
        api.post.mockResolvedValue({ error: 'nope' });
        $('duration-backfill-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('nope', 'error');
        expect($('duration-backfill-btn').disabled).toBe(false);
    });

    it('fills the bar from duration_backfill_progress', async () => {
        await loadDuration();
        await ws.emit('duration_backfill_progress', { processed: 5, total: 20, updated: 4 });
        expect($('duration-progress-bar').style.width).toBe('25%');
        expect($('duration-progress-status').textContent).toBe('5 / 20 · 4 updated');
    });

    it('resets the UI, toasts and refreshes counters on duration_backfill_done', async () => {
        await loadDuration();
        $('duration-backfill-btn').click();
        await flush();
        api.get.mockClear();
        await ws.emit('duration_backfill_done', { updated: 2, missing: 1, failed: 0 });
        await flush();
        expect($('duration-backfill-btn').disabled).toBe(false);
        expect($('duration-progress').classList.contains('hidden')).toBe(true);
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('Recorded 2 durations'),
            'success',
        );
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/duration/stats');
    });

    it('recovers an in-flight run on boot', async () => {
        await loadDuration({ status: { running: true } });
        expect($('duration-backfill-btn').disabled).toBe(true);
    });
});
