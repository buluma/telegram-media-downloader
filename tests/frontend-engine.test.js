// @vitest-environment jsdom
//
// Covers src/web/public/js/engine.js — the Settings-page Engine card:
// state pill/dot rendering per monitor state, start/stop/restart button
// wiring (optimistic state, rollback on failure), the initEngine
// idempotency guard, and handleEngineWsMessage's event routing.
//
// api.js, utils.js and monitor-status.js are mocked. i18n stays real.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { post: vi.fn() };
const showToast = vi.fn();
const subscribeMonitorStatus = vi.fn();
const refreshMonitorStatus = vi.fn();

vi.mock('../src/web/public/js/api.js', () => ({ api }));
vi.mock('../src/web/public/js/utils.js', () => ({ showToast }));
vi.mock('../src/web/public/js/monitor-status.js', () => ({
    subscribe: subscribeMonitorStatus,
    refreshNow: refreshMonitorStatus,
}));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="settings-card-engine">
        <span id="engine-pill"></span>
        <span id="engine-state-dot"></span>
        <button id="engine-start"></button>
        <button id="engine-stop" class="hidden"></button>
        <button id="engine-restart"></button>
        <div id="engine-error" class="hidden"></div>
        <span id="engine-queue"></span>
        <span id="engine-active"></span>
        <span id="engine-downloaded"></span>
        <span id="engine-uptime"></span>
    </div>
`;

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function loadModule() {
    vi.resetModules();
    document.body.innerHTML = DOM;
    return import('../src/web/public/js/engine.js');
}

beforeEach(() => {
    vi.resetAllMocks();
    api.post.mockResolvedValue({ status: { state: 'running' } });
});
afterEach(() => vi.useRealTimers());

describe('initEngine', () => {
    it('subscribes to the shared monitor-status poller', async () => {
        const { initEngine } = await loadModule();
        initEngine();
        expect(subscribeMonitorStatus).toHaveBeenCalledWith(expect.any(Function));
    });

    it('is idempotent — a second call does not double-bind handlers, but does refresh', async () => {
        const { initEngine } = await loadModule();
        initEngine();
        initEngine();
        expect(subscribeMonitorStatus).toHaveBeenCalledTimes(1);
        expect(refreshMonitorStatus).toHaveBeenCalledTimes(1); // only from the 2nd call
        $('engine-start').click();
        await flush();
        expect(api.post).toHaveBeenCalledTimes(1); // one listener, not two
    });
});

describe('applyStatus (via the subscribed callback)', () => {
    let apply;

    beforeEach(async () => {
        const { initEngine } = await loadModule();
        initEngine();
        apply = subscribeMonitorStatus.mock.calls[0][0];
    });

    it('does nothing when handed a falsy status', () => {
        apply({ state: 'running' });
        const before = $('engine-pill').innerHTML;
        apply(null);
        expect($('engine-pill').innerHTML).toBe(before);
    });

    it('renders every known state with its own pill class and icon', () => {
        const cases = {
            running: 'engine-state-running',
            starting: 'engine-state-starting',
            stopping: 'engine-state-stopping',
            stopped: 'engine-state-stopped',
            error: 'engine-state-error',
        };
        for (const [state, cls] of Object.entries(cases)) {
            apply({ state });
            expect($('engine-pill').className, state).toContain(cls);
            expect($('engine-state-dot').dataset.state).toBe(state);
            expect($('settings-card-engine').dataset.state).toBe(state);
        }
    });

    it('falls back to the stopped pill for an unrecognised state', () => {
        apply({ state: 'bogus' });
        expect($('engine-pill').className).toContain('engine-state-stopped');
    });

    it('shows the start button and hides stop when stopped', () => {
        apply({ state: 'stopped' });
        expect($('engine-start').classList.contains('hidden')).toBe(false);
        expect($('engine-stop').classList.contains('hidden')).toBe(true);
    });

    it('shows the stop button and hides start while running or starting', () => {
        apply({ state: 'running' });
        expect($('engine-start').classList.contains('hidden')).toBe(true);
        expect($('engine-stop').classList.contains('hidden')).toBe(false);
        apply({ state: 'starting' });
        expect($('engine-start').classList.contains('hidden')).toBe(true);
        expect($('engine-stop').classList.contains('hidden')).toBe(false);
    });

    it('shows the error banner only when an error is present', () => {
        apply({ state: 'error', error: 'crashed' });
        expect($('engine-error').classList.contains('hidden')).toBe(false);
        expect($('engine-error').textContent).toBe('crashed');
        apply({ state: 'running' });
        expect($('engine-error').classList.contains('hidden')).toBe(true);
    });

    it('renders queue/active/downloaded counters, defaulting missing values to 0', () => {
        apply({ state: 'running', queue: 3, active: 1, stats: { downloaded: 42 } });
        expect($('engine-queue').textContent).toBe('3');
        expect($('engine-active').textContent).toBe('1');
        expect($('engine-downloaded').textContent).toBe('42');
        apply({ state: 'running' });
        expect($('engine-queue').textContent).toBe('0');
        expect($('engine-downloaded').textContent).toBe('0');
    });

    it('formats uptime in seconds, minutes+seconds, and hours+minutes', () => {
        apply({ state: 'running', uptimeMs: 45_000 });
        expect($('engine-uptime').textContent).toBe('45s');
        apply({ state: 'running', uptimeMs: 125_000 });
        expect($('engine-uptime').textContent).toBe('2m 5s');
        apply({ state: 'running', uptimeMs: 3_725_000 });
        expect($('engine-uptime').textContent).toBe('1h 2m');
    });

    it('shows an em dash for zero/missing uptime', () => {
        apply({ state: 'stopped', uptimeMs: 0 });
        expect($('engine-uptime').textContent).toBe('—');
        apply({ state: 'stopped' });
        expect($('engine-uptime').textContent).toBe('—');
    });
});

describe('start / stop / restart buttons', () => {
    it('start: disables the button, shows starting optimistically, then applies the real status', async () => {
        api.post.mockResolvedValue({ status: { state: 'running', queue: 0, active: 0 } });
        const { initEngine } = await loadModule();
        initEngine();
        const btn = $('engine-start');
        btn.click();
        expect($('engine-pill').className).toContain('engine-state-starting');
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/monitor/start');
        expect($('engine-pill').className).toContain('engine-state-running');
        expect(btn.disabled).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Monitor started', 'success');
    });

    it('start: rolls back to stopped and toasts on failure', async () => {
        api.post.mockRejectedValue(new Error('boom'));
        const { initEngine } = await loadModule();
        initEngine();
        $('engine-start').click();
        await flush();
        expect($('engine-pill').className).toContain('engine-state-stopped');
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error');
        expect($('engine-start').disabled).toBe(false);
    });

    it('stop: disables the button, shows stopping optimistically, then applies the real status', async () => {
        api.post.mockResolvedValue({ status: { state: 'stopped', queue: 0, active: 0 } });
        const { initEngine } = await loadModule();
        initEngine();
        $('engine-stop').click();
        expect($('engine-pill').className).toContain('engine-state-stopping');
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/monitor/stop');
        expect($('engine-pill').className).toContain('engine-state-stopped');
        expect(showToast).toHaveBeenCalledWith('Monitor stopped', 'info');
    });

    it('stop: rolls back to running and toasts on failure', async () => {
        api.post.mockRejectedValue(new Error('offline'));
        const { initEngine } = await loadModule();
        initEngine();
        $('engine-stop').click();
        await flush();
        expect($('engine-pill').className).toContain('engine-state-running');
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('offline'), 'error');
    });

    it('restart: posts, applies the returned status, and toasts success', async () => {
        api.post.mockResolvedValue({ status: { state: 'running', queue: 0, active: 0 } });
        const { initEngine } = await loadModule();
        initEngine();
        $('engine-restart').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/monitor/restart');
        expect(showToast).toHaveBeenCalledWith('Monitor restarted', 'success');
        expect($('engine-restart').disabled).toBe(false);
    });

    it('restart: toasts an error and re-enables the button on failure', async () => {
        api.post.mockRejectedValue(new Error('down'));
        const { initEngine } = await loadModule();
        initEngine();
        $('engine-restart').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('down'), 'error');
        expect($('engine-restart').disabled).toBe(false);
    });
});

describe('handleEngineWsMessage', () => {
    let handleEngineWsMessage, apply;

    beforeEach(async () => {
        const mod = await loadModule();
        handleEngineWsMessage = mod.handleEngineWsMessage;
        mod.initEngine();
        apply = subscribeMonitorStatus.mock.calls[0][0];
        apply({ state: 'stopped' }); // baseline
    });

    it('applies monitor_state directly and schedules a delayed refresh', () => {
        vi.useFakeTimers();
        handleEngineWsMessage({ type: 'monitor_state', state: 'running' });
        expect($('engine-pill').className).toContain('engine-state-running');
        expect(refreshMonitorStatus).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(refreshMonitorStatus).toHaveBeenCalledTimes(1);
    });

    it('forwards an error on monitor_state', () => {
        handleEngineWsMessage({ type: 'monitor_state', state: 'error', error: 'oops' });
        expect($('engine-error').textContent).toBe('oops');
    });

    for (const type of [
        'history_progress',
        'history_done',
        'history_error',
        'history_cancelled',
        'download_complete',
        'download_start',
        'download_error',
        'queue_length',
    ]) {
        it(`triggers an immediate refresh on ${type}`, () => {
            handleEngineWsMessage({ type });
            expect(refreshMonitorStatus).toHaveBeenCalledTimes(1);
        });
    }

    it('ignores an unrelated message type', () => {
        handleEngineWsMessage({ type: 'something_else' });
        expect(refreshMonitorStatus).not.toHaveBeenCalled();
    });
});
