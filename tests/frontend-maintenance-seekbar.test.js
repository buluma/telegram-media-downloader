// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-seekbar.js — the seekbar preview
// page controller: KPI stats, master/auto toggles (optimistic flip +
// rollback), scan/cancel/wipe/restart/hwaccel-probe actions, WS progress/
// done handling, queue stats, sidecar status pill, and the health/doctor
// summary.
//
// api.js, ws.js, sheet.js, settings.js and utils.js are mocked. i18n
// stays real for its synchronous fallback path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn() };
const showToast = vi.fn();
const confirmSheet = vi.fn();
const loadAdvanced = vi.fn();
const setupAutoSave = vi.fn();

function formatBytes(n) {
    return `${n}B`;
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
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet }));
vi.mock('../src/web/public/js/settings.js', () => ({ loadAdvanced, setupAutoSave }));
vi.mock('../src/web/public/js/utils.js', () => ({ formatBytes, showToast }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="setting-adv-seekbar-enabled" class="tg-toggle" tabindex="0"></div>
    <div id="setting-adv-seekbar-autoOnDownload" class="tg-toggle" tabindex="0"></div>
    <button id="seekbar-scan-btn"></button>
    <button id="seekbar-cancel-btn"></button>
    <button id="seekbar-scan-cta" class="hidden"></button>
    <button id="seekbar-wipe-btn"></button>
    <button id="seekbar-restart-btn"></button>
    <button id="seekbar-hwaccel-probe"></button>
    <button id="seekbar-doctor-refresh-btn"></button>
    <span id="seekbar-hwaccel-result"></span>
    <span id="seekbar-kpi-indexed"></span>
    <span id="seekbar-kpi-disk"></span>
    <span id="seekbar-kpi-coverage"></span>
    <div id="seekbar-coverage-wrap" class="hidden">
        <div id="seekbar-coverage-bar"></div>
        <span id="seekbar-coverage-label"></span>
    </div>
    <div id="seekbar-ffmpeg-line" class="hidden"><span id="seekbar-kpi-ffmpeg"></span></div>
    <span id="seekbar-kpi-last"></span>
    <div id="seekbar-progress" class="hidden">
        <div id="seekbar-progress-bar"></div>
        <span id="seekbar-progress-pct"></span>
        <span id="seekbar-progress-detail"></span>
    </div>
    <span id="seekbar-queue-idle-badge" class="hidden"></span>
    <span id="seekbar-queue-live-badge" class="hidden"></span>
    <div id="seekbar-queue-active" class="hidden">
        <span id="seekbar-queue-queued"></span>
        <span id="seekbar-queue-processing"></span>
        <span id="seekbar-queue-completed"></span>
        <span id="seekbar-queue-failed"></span>
    </div>
    <div id="seekbar-queue-idle-line" class="hidden"></div>
    <div id="seekbar-sidecar-pill" class="bg-tg-bg/60 text-tg-textSecondary"></div>
    <span id="seekbar-sidecar-detail"></span>
    <span id="seekbar-health-sidecar"></span>
    <span id="seekbar-health-url"></span>
    <span id="seekbar-health-pid"></span>
    <span id="seekbar-health-binary"></span>
    <span id="seekbar-health-hwaccel"></span>
    <span id="seekbar-health-version"></span>
    <div id="seekbar-doctor-summary"></div>
    <div id="seekbar-health-error" class="hidden"></div>
`;

const ENDPOINTS = {
    stats: '/api/maintenance/seekbar/stats',
    buildStats: '/api/maintenance/seekbar/build/stats',
    buildStatus: '/api/maintenance/seekbar/build/status',
    queueStats: '/api/maintenance/seekbar/queue/stats',
    health: '/api/maintenance/seekbar/health',
    config: '/api/config',
};

function defaults(over = {}) {
    return {
        [ENDPOINTS.stats]: { count: 0, totalVideos: 0, bytes: 0, ffmpegAvailable: true },
        [ENDPOINTS.buildStats]: {},
        [ENDPOINTS.buildStatus]: { running: false },
        [ENDPOINTS.queueStats]: { running: false, completed: 0 },
        [ENDPOINTS.health]: { sidecar: {}, ffmpegAvailable: true },
        [ENDPOINTS.config]: {},
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
    return import('../src/web/public/js/maintenance-seekbar.js');
}

beforeEach(() => {
    // resetAllMocks (not clearAllMocks): a mockImplementation set by one
    // test — e.g. "survives setupAutoSave throwing" — otherwise survives
    // clearAllMocks (which only wipes call history) and leaks into every
    // later test, which is why that throw showed up as console noise in
    // unrelated tests further down the file.
    vi.resetAllMocks();
    api.post.mockResolvedValue({ success: true });
    confirmSheet.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('init', () => {
    it('fetches every stats endpoint and seeds the settings inputs', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.stats);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.buildStats);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.buildStatus);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.queueStats);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.health);
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.config);
        expect(loadAdvanced).toHaveBeenCalled();
    });

    it('calls setupAutoSave exactly once even across repeated init calls', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await init();
        await flush();
        expect(setupAutoSave).toHaveBeenCalledTimes(1);
    });

    it('survives setupAutoSave throwing', async () => {
        setupAutoSave.mockImplementation(() => {
            throw new Error('boom');
        });
        const { init } = await loadModule();
        await expect(init()).resolves.toBeUndefined();
    });

    it('wires WS handlers exactly once across repeated init calls', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await init();
        await flush();
        const subs = ws.on.mock.calls.filter(([type]) => type === 'seekbar_progress');
        expect(subs).toHaveLength(1);
    });

    it('wires the scan/cancel/wipe/restart buttons exactly once', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await init();
        await flush();
        $('seekbar-scan-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledTimes(1);
    });
});

describe('KPI stats', () => {
    it('renders indexed count, disk usage and coverage percent', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.stats]: {
                    count: 40,
                    totalVideos: 80,
                    bytes: 2048,
                    ffmpegAvailable: true,
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-kpi-indexed').textContent).toBe('40');
        expect($('seekbar-kpi-disk').textContent).toBe('2048B');
        expect($('seekbar-kpi-coverage').textContent).toBe('50%');
        expect($('seekbar-coverage-wrap').classList.contains('hidden')).toBe(false);
        expect($('seekbar-coverage-bar').style.width).toBe('50%');
        expect($('seekbar-coverage-label').textContent).toContain('40 / 80');
    });

    it('shows an em dash for coverage with zero total videos', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.stats]: { count: 0, totalVideos: 0, bytes: 0 } }),
        );
        await init();
        await flush();
        expect($('seekbar-kpi-coverage').textContent).toBe('—');
        expect($('seekbar-coverage-label').textContent).toBe('No videos yet');
    });

    it('hides the scan CTA once coverage reaches 100%', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.stats]: { count: 10, totalVideos: 10 } }),
        );
        await init();
        await flush();
        expect($('seekbar-scan-cta').classList.contains('hidden')).toBe(true);
    });

    it('shows the scan CTA with partial coverage', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.stats]: { count: 5, totalVideos: 10 } }),
        );
        await init();
        await flush();
        expect($('seekbar-scan-cta').classList.contains('hidden')).toBe(false);
    });

    it('colours the coverage bar by threshold', async () => {
        for (const [count, total] of [
            [100, 100],
            [60, 100],
            [10, 100],
        ]) {
            const { init } = await loadModule(
                defaults({ [ENDPOINTS.stats]: { count, totalVideos: total } }),
            );
            await init();
            await flush();
            const cls = $('seekbar-coverage-bar').className;
            if (count / total >= 1) expect(cls).toContain('bg-tg-green');
            else if (count / total >= 0.5) expect(cls).toContain('bg-tg-blue');
            else expect(cls).toContain('bg-yellow-400');
        }
    });

    it('shows the ffmpeg availability chip', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.stats]: { ffmpegAvailable: false } }),
        );
        await init();
        await flush();
        expect($('seekbar-kpi-ffmpeg').textContent).toBe('missing');
        expect($('seekbar-kpi-ffmpeg').className).toContain('text-red-400');
    });

    it('shows the last-build timestamp, or "never"', async () => {
        const { init: init1 } = await loadModule(defaults({ [ENDPOINTS.buildStats]: {} }));
        await init1();
        await flush();
        expect($('seekbar-kpi-last').textContent).toBe('never');
    });

    it('leaves KPIs untouched on a stats fetch failure', async () => {
        const responses = defaults();
        api.get.mockImplementation((url) =>
            url === ENDPOINTS.stats
                ? Promise.reject(new Error('down'))
                : Promise.resolve(responses[url] ?? {}),
        );
        vi.resetModules();
        ws = makeFakeWs();
        document.body.innerHTML = DOM;
        const { init } = await import('../src/web/public/js/maintenance-seekbar.js');
        await expect(init()).resolves.toBeUndefined();
        await flush();
        expect($('seekbar-kpi-indexed').textContent).toBe('');
    });
});

describe('master / auto toggles', () => {
    it('optimistically flips, posts, and shows Saved on success', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        const el = $('setting-adv-seekbar-enabled');
        el.click();
        expect(el.classList.contains('active')).toBe(true);
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            advanced: { seekbar: { enabled: true } },
        });
        expect(showToast).toHaveBeenCalledWith('Saved', 'success');
    });

    it('toggles off from an already-active state', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        const el = $('setting-adv-seekbar-enabled');
        el.classList.add('active');
        el.click();
        expect(el.classList.contains('active')).toBe(false);
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            advanced: { seekbar: { enabled: false } },
        });
    });

    it('rolls back the flip and toasts an error on a rejected save', async () => {
        api.post.mockResolvedValue({ success: false, error: 'nope' });
        const { init } = await loadModule();
        await init();
        await flush();
        const el = $('setting-adv-seekbar-enabled');
        el.click();
        await flush();
        expect(el.classList.contains('active')).toBe(false);
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('nope'), 'error');
    });

    it('rolls back on a network failure too', async () => {
        api.post.mockRejectedValue(new Error('offline'));
        const { init } = await loadModule();
        await init();
        await flush();
        const el = $('setting-adv-seekbar-autoOnDownload');
        el.click();
        await flush();
        expect(el.classList.contains('active')).toBe(false);
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('offline'), 'error');
    });

    it('responds to Space/Enter as well as click', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        const el = $('setting-adv-seekbar-enabled');
        el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        expect(el.classList.contains('active')).toBe(true);
    });

    it('refreshes stats only when the master toggle changes, not the auto toggle', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        api.get.mockClear();
        $('setting-adv-seekbar-autoOnDownload').click();
        await flush();
        expect(api.get).not.toHaveBeenCalledWith(ENDPOINTS.stats);
        $('setting-adv-seekbar-enabled').click();
        await flush();
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.stats);
    });
});

describe('scan / cancel', () => {
    it('starts a scan and shows the running UI', async () => {
        api.post.mockResolvedValue({ started: true });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-scan-btn').click();
        await flush();
        expect($('seekbar-scan-btn').disabled).toBe(true);
        expect($('seekbar-cancel-btn').disabled).toBe(false);
        expect($('seekbar-progress').classList.contains('hidden')).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Scan started');
    });

    it('the scan-cta button starts a scan too', async () => {
        api.post.mockResolvedValue({ started: true });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-scan-cta').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/seekbar/build-all', {});
    });

    it('shows "already running" and sets the running UI on a 409/ALREADY_RUNNING', async () => {
        api.post.mockRejectedValue({ status: 409 });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-scan-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('already running'), 'info');
        expect($('seekbar-scan-btn').disabled).toBe(true);
    });

    it('toasts a generic error on other scan failures', async () => {
        api.post.mockRejectedValue({ data: { error: 'disk full' } });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-scan-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('disk full', 'error');
    });

    it('cancel posts to the cancel endpoint and toasts', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-cancel-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/seekbar/build/cancel', {});
        expect(showToast).toHaveBeenCalledWith('Cancelling…');
    });

    it('cancel toasts an error on failure', async () => {
        api.post.mockRejectedValue({ data: { error: 'nope' } });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-cancel-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('nope', 'error');
    });

    it('recovers the running UI on mount when the server reports a scan in progress', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.buildStatus]: {
                    running: true,
                    lastProgress: { processed: 3, total: 10 },
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-scan-btn').disabled).toBe(true);
        expect($('seekbar-progress-pct').textContent).toBe('30%');
    });
});

describe('WS progress / done', () => {
    it('updates the progress bar, percent and detail line', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_progress', {
            processed: 4,
            total: 8,
            generated: 3,
            skipped: 1,
            errored: 0,
        });
        expect($('seekbar-progress-bar').style.width).toBe('50%');
        expect($('seekbar-progress-pct').textContent).toBe('50%');
        expect($('seekbar-progress-detail').textContent).toBe('4 / 8 · generated 3 · skipped 1');
    });

    it('flips running UI on even without an explicit start', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_progress', { processed: 1, total: 2 });
        expect($('seekbar-scan-btn').disabled).toBe(true);
    });

    it('clamps percent at 100 and avoids divide-by-zero on total=0', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_progress', { processed: 20, total: 10 });
        expect($('seekbar-progress-bar').style.width).toBe('100%');
        await ws.emit('seekbar_progress', { processed: 0, total: 0 });
        expect($('seekbar-progress-bar').style.width).toBe('0%');
    });

    it('on done: resets the running UI and toasts success with counts', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_progress', { processed: 1, total: 2 });
        await ws.emit('seekbar_done', { generated: 8, errored: 0 });
        expect($('seekbar-scan-btn').disabled).toBe(false);
        expect($('seekbar-progress').classList.contains('hidden')).toBe(true);
        expect(showToast).toHaveBeenCalledWith(
            'Scan finished — 8 generated, 0 errored.',
            'success',
        );
    });

    it('toasts a warning-level message when the run had errors', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_done', { generated: 5, errored: 2 });
        expect(showToast).toHaveBeenCalledWith(expect.any(String), 'warning');
    });

    it('shows a cancelled message distinct from the count summary', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_done', { cancelled: true });
        expect(showToast).toHaveBeenCalledWith('Scan cancelled');
    });

    it('the rebuild progress/done aliases drive the same UI', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        await ws.emit('seekbar_rebuild_progress', { processed: 2, total: 4 });
        expect($('seekbar-progress-bar').style.width).toBe('50%');
        await ws.emit('seekbar_rebuild_done', { generated: 4, errored: 0 });
        expect($('seekbar-scan-btn').disabled).toBe(false);
    });
});

describe('queue stats', () => {
    it('shows the idle line with a generated count when nothing is running', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.queueStats]: { running: false, completed: 12 } }),
        );
        await init();
        await flush();
        expect($('seekbar-queue-idle-line').textContent).toContain('12 sprites generated');
        expect($('seekbar-queue-idle-badge').classList.contains('hidden')).toBe(false);
        expect($('seekbar-queue-live-badge').classList.contains('hidden')).toBe(true);
    });

    it('shows the "no sprites yet" message when nothing has ever run', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.queueStats]: { running: false, completed: 0 } }),
        );
        await init();
        await flush();
        expect($('seekbar-queue-idle-line').textContent).toContain('No sprites yet');
    });

    it('shows live queue counters while running', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.queueStats]: {
                    running: true,
                    queued: 3,
                    processing: 1,
                    completed: 5,
                    failed: 0,
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-queue-live-badge').classList.contains('hidden')).toBe(false);
        expect($('seekbar-queue-active').classList.contains('hidden')).toBe(false);
        expect($('seekbar-queue-queued').textContent).toBe('3');
        expect($('seekbar-queue-processing').textContent).toBe('1');
    });
});

describe('wipe cache', () => {
    it('fetches stats, confirms with counts, then posts a wipe-only rebuild', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/seekbar/stats'
                ? Promise.resolve({ count: 12, bytes: 4096 })
                : Promise.resolve({}),
        );
        $('seekbar-wipe-btn').click();
        await flush();
        expect(confirmSheet.mock.calls[0][0]).toMatchObject({ danger: true });
        expect(confirmSheet.mock.calls[0][0].body).toContain('12 sprites');
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/seekbar/rebuild', {
            wipeOnly: true,
        });
        expect(showToast).toHaveBeenCalledWith('Wipe started');
    });

    it('does nothing when the confirmation is declined', async () => {
        confirmSheet.mockResolvedValue(false);
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-wipe-btn').click();
        await flush();
        expect(api.post).not.toHaveBeenCalledWith(
            '/api/maintenance/seekbar/rebuild',
            expect.anything(),
        );
    });

    it('toasts an error when the wipe request fails', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        api.post.mockImplementation((url) =>
            url === '/api/maintenance/seekbar/rebuild'
                ? Promise.reject({ data: { error: 'busy' } })
                : Promise.resolve({ success: true }),
        );
        $('seekbar-wipe-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('busy', 'error');
    });
});

describe('sidecar restart', () => {
    it('posts, re-renders the sidecar pill from the response, and toasts', async () => {
        api.post.mockResolvedValue({ sidecar: { ok: true, mode: 'running' } });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-restart-btn').click();
        await flush();
        expect($('seekbar-sidecar-pill').className).toContain('bg-tg-green/15');
        expect(showToast).toHaveBeenCalledWith('Sidecar restarted');
    });

    it('toasts an error on failure', async () => {
        api.post.mockRejectedValue({ data: { error: 'timeout' } });
        const { init } = await loadModule();
        await init();
        await flush();
        $('seekbar-restart-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('timeout', 'error');
    });
});

describe('sidecar status pill', () => {
    const cases = [
        [{ ok: true, mode: 'running' }, 'bg-tg-green/15'],
        [{ mode: 'binary_missing' }, 'bg-tg-orange/15'],
        [{ mode: 'starting' }, 'bg-tg-bg/60'],
        [{ mode: 'unhealthy', error: 'crashed' }, 'bg-red-500/15'],
        [{ mode: 'exited' }, 'bg-red-500/15'],
    ];
    for (const [sidecar, expectedClass] of cases) {
        it(`renders ${sidecar.mode || 'ok'} distinctly`, async () => {
            const { init } = await loadModule(defaults({ [ENDPOINTS.stats]: { sidecar } }));
            await init();
            await flush();
            expect($('seekbar-sidecar-pill').className).toContain(expectedClass);
        });
    }

    it('shows url/pid/error in the detail line', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.stats]: {
                    sidecar: { url: 'http://sidecar:9', pid: 123, error: 'flaky', ok: false },
                },
            }),
        );
        await init();
        await flush();
        const detail = $('seekbar-sidecar-detail').textContent;
        expect(detail).toContain('http://sidecar:9');
        expect(detail).toContain('pid=123');
        expect(detail).toContain('flaky');
    });
});

describe('hwaccel probe', () => {
    it('shows a probing placeholder then renders result chips', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/seekbar/hwaccel-probe'
                ? Promise.resolve({ available: ['vaapi'], compiled: ['vaapi', 'nvenc'] })
                : Promise.resolve(defaults()[url] ?? {}),
        );
        await init();
        await flush();
        $('seekbar-hwaccel-probe').click();
        await flush();
        const out = $('seekbar-hwaccel-result');
        expect(out.querySelectorAll('span').length).toBe(2);
        expect(out.innerHTML).toContain('ri-checkbox-circle-fill'); // vaapi available
        expect(out.innerHTML).toContain('ri-close-circle-line'); // nvenc not available
        expect(showToast).toHaveBeenCalledWith('Hardware probe complete');
    });

    it('shows an em dash when nothing is compiled', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/seekbar/hwaccel-probe'
                ? Promise.resolve({ available: [], compiled: [] })
                : Promise.resolve(defaults()[url] ?? {}),
        );
        await init();
        await flush();
        $('seekbar-hwaccel-probe').click();
        await flush();
        expect($('seekbar-hwaccel-result').textContent).toBe('—');
    });

    it('shows the error text when the probe reports one', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/seekbar/hwaccel-probe'
                ? Promise.resolve({ error: 'ffprobe missing' })
                : Promise.resolve(defaults()[url] ?? {}),
        );
        await init();
        await flush();
        $('seekbar-hwaccel-probe').click();
        await flush();
        expect($('seekbar-hwaccel-result').textContent).toBe('error: ffprobe missing');
    });

    it('shows an inline error when the probe request itself fails', async () => {
        const { init } = await loadModule();
        api.get.mockImplementation((url) =>
            url === '/api/maintenance/seekbar/hwaccel-probe'
                ? Promise.reject(new Error('timeout'))
                : Promise.resolve(defaults()[url] ?? {}),
        );
        await init();
        await flush();
        $('seekbar-hwaccel-probe').click();
        await flush();
        expect($('seekbar-hwaccel-result').textContent).toBe('error: timeout');
    });
});

describe('health mirrors into the hwaccel chip strip', () => {
    it('renders the settings-card chips from the health hwaccel result, not just the explicit probe', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: {},
                    ffmpegAvailable: true,
                    hwaccel: { available: ['vaapi'], compiled: ['vaapi', 'nvenc'] },
                },
            }),
        );
        await init();
        await flush();
        const out = $('seekbar-hwaccel-result');
        expect(out.querySelectorAll('span').length).toBe(2);
        expect(out.innerHTML).toContain('ri-checkbox-circle-fill');
    });

    it('does not mirror when the health hwaccel probe itself errored', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: {},
                    ffmpegAvailable: true,
                    hwaccel: { error: 'no gpu' },
                },
            }),
        );
        await init();
        await flush();
        // _renderHwaccelChips was never called with the errored payload —
        // the chip strip stays at its untouched initial state.
        expect($('seekbar-hwaccel-result').innerHTML).toBe('');
    });
});

describe('health / doctor summary', () => {
    it('shows the all-clear summary with hwaccel tail', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: { ok: true, mode: 'running', url: 'http://x', pid: 1 },
                    ffmpegAvailable: true,
                    hwaccel: { available: ['vaapi'] },
                    version: '1.2.3',
                    platform: 'linux',
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-doctor-summary').textContent).toContain('all systems go');
        expect($('seekbar-doctor-summary').textContent).toContain('vaapi');
        expect($('seekbar-doctor-summary').className).toContain('text-tg-green');
        expect($('seekbar-health-version').textContent).toBe('v1.2.3 · linux');
    });

    it('shows the warming-up summary while the sidecar is starting', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: { sidecar: { mode: 'starting' }, ffmpegAvailable: true },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-doctor-summary').textContent).toContain('warming up');
        expect($('seekbar-doctor-summary').className).toContain('text-tg-orange');
    });

    it('flags missing ffmpeg distinctly from a bad sidecar', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: { sidecar: { ok: true }, ffmpegAvailable: false },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-doctor-summary').textContent).toContain('ffmpeg missing');
        expect($('seekbar-doctor-summary').className).toContain('text-red-400');
    });

    it('falls back to the sidecar error/mode for an unhealthy state', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: { ok: false, mode: 'unhealthy', error: 'oom' },
                    ffmpegAvailable: true,
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-doctor-summary').textContent).toContain('oom');
    });

    it('shows the health error banner only when unhealthy', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: { ok: false, error: 'boom' },
                    ffmpegAvailable: true,
                },
            }),
        );
        await init();
        await flush();
        const el = $('seekbar-health-error');
        expect(el.classList.contains('hidden')).toBe(false);
        expect(el.textContent).toBe('boom');
    });

    it('hides the health error banner when ok', async () => {
        const { init } = await loadModule(
            defaults({ [ENDPOINTS.health]: { sidecar: { ok: true }, ffmpegAvailable: true } }),
        );
        await init();
        await flush();
        expect($('seekbar-health-error').classList.contains('hidden')).toBe(true);
    });

    it('the doctor refresh button re-fetches health', async () => {
        const { init } = await loadModule();
        await init();
        await flush();
        api.get.mockClear();
        $('seekbar-doctor-refresh-btn').click();
        await flush();
        expect(api.get).toHaveBeenCalledWith(ENDPOINTS.health);
    });

    it('reports the hwaccel probe error distinctly from an empty list', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: {},
                    ffmpegAvailable: true,
                    hwaccel: { error: 'no gpu' },
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-health-hwaccel').textContent).toBe('error: no gpu');
    });

    it('shows "none" when hwaccel probed but found nothing', async () => {
        const { init } = await loadModule(
            defaults({
                [ENDPOINTS.health]: {
                    sidecar: {},
                    ffmpegAvailable: true,
                    hwaccel: { available: [] },
                },
            }),
        );
        await init();
        await flush();
        expect($('seekbar-health-hwaccel').textContent).toBe('none');
    });
});
