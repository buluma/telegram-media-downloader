// @vitest-environment jsdom
//
// Covers src/web/public/js/job-buttons.js — the shared "fire-and-forget
// admin job" button wiring: status hydration on mount, click → POST,
// WS progress/done driving every button sharing an event prefix,
// ALREADY_RUNNING handling, and rehydrateAll on WS reconnect.

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
vi.mock('../src/web/public/js/utils.js', () => ({ showToast }));

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeBtn(text = 'Verify files') {
    const btn = document.createElement('button');
    btn.textContent = text;
    document.body.appendChild(btn);
    return btn;
}
function makeStatusEl() {
    const el = document.createElement('span');
    document.body.appendChild(el);
    return el;
}

async function loadModule() {
    vi.resetModules();
    document.body.innerHTML = '';
    // job-buttons.js calls ws.on('__ws_open', ...) at module load time, so
    // `ws` must exist before the import.
    ws = makeFakeWs();
    return import('../src/web/public/js/job-buttons.js');
}

beforeEach(() => {
    vi.resetAllMocks();
    api.get.mockResolvedValue({ running: false });
    api.post.mockResolvedValue({ started: true });
});

function baseOpts(over = {}) {
    return {
        btn: makeBtn(),
        statusEl: makeStatusEl(),
        statusUrl: '/api/maintenance/files/verify/status',
        eventPrefix: 'files_verify',
        runUrl: '/api/maintenance/files/verify',
        runningLabel: 'Verifying…',
        idleLabel: 'Verify files',
        ...over,
    };
}

describe('wireJobButton — guards', () => {
    it('does nothing (no throw) when required opts are missing', async () => {
        const { wireJobButton } = await loadModule();
        expect(() => wireJobButton({})).not.toThrow();
        expect(() => wireJobButton({ btn: makeBtn() })).not.toThrow();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('wiring the same button twice is a no-op the second time', async () => {
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        api.get.mockClear();
        wireJobButton(opts);
        await flush();
        expect(api.get).not.toHaveBeenCalled(); // no second hydrate
    });
});

describe('hydration on mount', () => {
    it('disables the button and shows the running label when a job is already in progress', async () => {
        api.get.mockResolvedValue({
            running: true,
            progress: { processed: 3, total: 10, stage: 'scanning' },
        });
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        expect(opts.btn.disabled).toBe(true);
        expect(opts.btn.textContent).toBe('Verifying…');
        expect(opts.statusEl.textContent).toBe('3/10 · scanning');
    });

    it('enables the button and shows the idle label when nothing is running', async () => {
        api.get.mockResolvedValue({ running: false });
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        expect(opts.btn.disabled).toBe(false);
        expect(opts.btn.textContent).toBe('Verify files');
    });

    it('shows a leftover error message when idle after a failed run', async () => {
        api.get.mockResolvedValue({ running: false, error: 'disk full' });
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        expect(opts.statusEl.textContent).toBe('disk full');
    });

    it('leaves the UI alone when the status endpoint fails', async () => {
        api.get.mockRejectedValue(new Error('down'));
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await expect(flush()).resolves.toBeUndefined();
        expect(opts.btn.disabled).toBe(false); // untouched default
    });
});

describe('click → run', () => {
    it('posts the run body and leaves the button disabled until WS confirms', async () => {
        const { wireJobButton } = await loadModule();
        const opts = baseOpts({ runBody: { force: true } });
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        expect(opts.btn.disabled).toBe(true);
        expect(opts.btn.textContent).toBe('Verifying…');
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/files/verify', { force: true });
    });

    it('defaults an absent runBody to {}', async () => {
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        delete opts.runBody;
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        await flush();
        expect(api.post).toHaveBeenCalledWith(opts.runUrl, {});
    });

    it('does nothing when clicked while already disabled', async () => {
        // Note: jsdom (matching real browsers) never dispatches a click
        // listener on a disabled form control at all, so the in-handler
        // `if (btn.disabled) return;` guard is unreachable through a real
        // .click() here — this test exercises the browser's own disabled
        // semantics, not that specific line. Left in as belt-and-braces
        // for any caller that might invoke the handler by other means.
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        opts.btn.disabled = true;
        opts.btn.click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('re-enables and toasts on an error response body (r.error)', async () => {
        api.post.mockResolvedValue({ error: 'not allowed' });
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        await flush();
        expect(opts.btn.disabled).toBe(false);
        expect(showToast).toHaveBeenCalledWith('not allowed', 'error');
    });

    it('re-enables and toasts on a network rejection', async () => {
        api.post.mockRejectedValue({ data: { error: 'timeout' } });
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        await flush();
        expect(opts.btn.disabled).toBe(false);
        expect(showToast).toHaveBeenCalledWith('timeout', 'error');
    });

    it('ALREADY_RUNNING re-hydrates instead of toasting a failure', async () => {
        api.post.mockRejectedValue({ data: { code: 'ALREADY_RUNNING' } });
        api.get.mockResolvedValueOnce({ running: false }); // initial hydrate
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        api.get.mockResolvedValue({ running: true, progress: { processed: 1, total: 5 } });
        opts.btn.click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('another tab'), 'info');
        expect(opts.btn.disabled).toBe(true); // hydrated as running
        expect(opts.btn.textContent).toBe('Verifying…');
    });

    it('preflightFail can suppress the default error toast', async () => {
        api.post.mockRejectedValue(new Error('custom handled'));
        const preflightFail = vi.fn(() => true);
        const { wireJobButton } = await loadModule();
        const opts = baseOpts({ preflightFail });
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        await flush();
        expect(preflightFail).toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();
    });

    it('preflightFail returning false still shows the default toast', async () => {
        api.post.mockRejectedValue(new Error('oops'));
        const preflightFail = vi.fn(() => false);
        const { wireJobButton } = await loadModule();
        const opts = baseOpts({ preflightFail });
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('oops', 'error');
    });

    it('attachClick:false hydrates and reflects WS state but does not wire a click POST', async () => {
        const { wireJobButton } = await loadModule();
        const opts = baseOpts({ attachClick: false });
        wireJobButton(opts);
        await flush();
        opts.btn.click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });
});

describe('WS progress / done — fan out to every button on the same prefix', () => {
    it('progress updates every button sharing the event prefix', async () => {
        const { wireJobButton } = await loadModule();
        const optsA = baseOpts({ btn: makeBtn('A'), statusEl: makeStatusEl() });
        const optsB = baseOpts({ btn: makeBtn('B'), statusEl: makeStatusEl() });
        wireJobButton(optsA);
        wireJobButton(optsB);
        await flush();
        await ws.emit('files_verify_progress', { processed: 2, total: 8, stage: 'hashing' });
        expect(optsA.btn.disabled).toBe(true);
        expect(optsB.btn.disabled).toBe(true);
        expect(optsA.statusEl.textContent).toBe('2/8 · hashing');
        expect(optsB.statusEl.textContent).toBe('2/8 · hashing');
    });

    it('does not touch a button wired under a different event prefix', async () => {
        const { wireJobButton } = await loadModule();
        const verify = baseOpts({ btn: makeBtn('verify') });
        const vacuum = baseOpts({
            btn: makeBtn('vacuum'),
            eventPrefix: 'db_vacuum',
            statusUrl: '/api/maintenance/db/vacuum/status',
            runUrl: '/api/maintenance/db/vacuum',
        });
        wireJobButton(verify);
        wireJobButton(vacuum);
        await flush();
        await ws.emit('files_verify_progress', { processed: 1, total: 2 });
        expect(verify.btn.disabled).toBe(true);
        expect(vacuum.btn.disabled).toBe(false);
    });

    it('done re-enables the button, restores the idle label, and calls onDone', async () => {
        const onDone = vi.fn();
        const { wireJobButton } = await loadModule();
        const opts = baseOpts({ onDone });
        wireJobButton(opts);
        await flush();
        await ws.emit('files_verify_progress', { processed: 1, total: 2 });
        await ws.emit('files_verify_done', { removed: 3 });
        expect(opts.btn.disabled).toBe(false);
        expect(opts.btn.textContent).toBe('Verify files');
        expect(onDone).toHaveBeenCalledWith({ removed: 3 });
    });

    it('shows the error message on the status line when done reports one', async () => {
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        await ws.emit('files_verify_done', { error: 'crashed' });
        expect(opts.statusEl.textContent).toBe('crashed');
    });

    it('a throwing onDone does not break the other buttons on the same prefix', async () => {
        const { wireJobButton } = await loadModule();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bad = baseOpts({
            btn: makeBtn('bad'),
            onDone: () => {
                throw new Error('boom');
            },
        });
        const good = baseOpts({ btn: makeBtn('good') });
        wireJobButton(bad);
        wireJobButton(good);
        await flush();
        await expect(ws.emit('files_verify_done', {})).resolves.toBeUndefined();
        expect(good.btn.disabled).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('subscribes to the WS prefix exactly once no matter how many buttons share it', async () => {
        const { wireJobButton } = await loadModule();
        wireJobButton(baseOpts({ btn: makeBtn('1') }));
        wireJobButton(baseOpts({ btn: makeBtn('2') }));
        wireJobButton(baseOpts({ btn: makeBtn('3') }));
        await flush();
        const subs = ws.on.mock.calls.filter(([type]) => type === 'files_verify_progress');
        expect(subs).toHaveLength(1);
    });
});

describe('rehydrateAll / __ws_open', () => {
    it('rehydrateAll re-fetches status for every wired button', async () => {
        const { wireJobButton, rehydrateAll } = await loadModule();
        const a = baseOpts({ btn: makeBtn('a') });
        const b = baseOpts({
            btn: makeBtn('b'),
            eventPrefix: 'db_vacuum',
            statusUrl: '/api/db/vacuum/status',
            runUrl: '/api/db/vacuum',
        });
        wireJobButton(a);
        wireJobButton(b);
        await flush();
        api.get.mockClear();
        rehydrateAll();
        await flush();
        expect(api.get).toHaveBeenCalledWith(a.statusUrl);
        expect(api.get).toHaveBeenCalledWith(b.statusUrl);
    });

    it('a WS reconnect (__ws_open) triggers a rehydrate of every button', async () => {
        const { wireJobButton } = await loadModule();
        const opts = baseOpts();
        wireJobButton(opts);
        await flush();
        api.get.mockClear();
        await ws.emit('__ws_open');
        await flush();
        expect(api.get).toHaveBeenCalledWith(opts.statusUrl);
    });
});
