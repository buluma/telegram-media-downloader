// @vitest-environment jsdom
//
// Covers src/web/public/js/monitor-status.js — the shared WS-push
// subscription for /api/monitor/status: subscribe()'s synchronous
// replay-or-fetch behavior, the monitor_status_push / __ws_open WS
// handlers, refreshNow()'s in-flight de-dupe, and subscriber-callback
// error isolation.
//
// api.js and ws.js are mocked. ws.js is a fresh fake per test (module
// state lives in this module, not on a shared jsdom global), so no
// listener-accumulation concern across resetModules() the way
// document/window-level wiring needs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const api = { get: vi.fn() };

function makeFakeWs() {
    const handlers = new Map();
    return {
        on: vi.fn((type, fn) => {
            (handlers.get(type) || handlers.set(type, new Set()).get(type)).add(fn);
        }),
        emit: async (type, msg) => {
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

async function loadModule() {
    vi.resetModules();
    vi.clearAllMocks();
    ws = makeFakeWs();
    api.get.mockResolvedValue({ running: true });
    return import('../src/web/public/js/monitor-status.js');
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => vi.clearAllMocks());

describe('subscribe', () => {
    it('fetches once for the first subscriber when there is no cached snapshot', async () => {
        const mod = await loadModule();
        mod.subscribe(vi.fn());
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/monitor/status');
        expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('calls the new subscriber synchronously with the cached snapshot instead of re-fetching', async () => {
        const mod = await loadModule();
        await mod.subscribe(vi.fn());
        await flush();
        api.get.mockClear();
        const fn = vi.fn();
        mod.subscribe(fn);
        expect(fn).toHaveBeenCalledWith({ running: true });
        expect(api.get).not.toHaveBeenCalled();
    });

    it('does not double-fetch for a second subscriber before the first fetch resolves', async () => {
        const mod = await loadModule();
        let resolveFetch;
        api.get.mockReturnValue(new Promise((r) => (resolveFetch = r)));
        mod.subscribe(vi.fn());
        mod.subscribe(vi.fn());
        expect(api.get).toHaveBeenCalledTimes(1);
        resolveFetch({ running: false });
        await flush();
    });

    it('unsubscribe stops further notifications to that callback', async () => {
        const mod = await loadModule();
        const fn = vi.fn();
        const unsub = mod.subscribe(fn);
        await flush();
        fn.mockClear();
        unsub();
        await ws.emit('monitor_status_push', { payload: { running: false } });
        expect(fn).not.toHaveBeenCalled();
    });

    it('does not throw when the synchronous cached-snapshot replay callback itself throws', async () => {
        const mod = await loadModule();
        await mod.subscribe(vi.fn());
        await flush();
        expect(() =>
            mod.subscribe(() => {
                throw new Error('boom');
            }),
        ).not.toThrow();
    });

    it('isolates one subscriber throwing from the others still being notified', async () => {
        const mod = await loadModule();
        const bad = vi.fn(() => {
            throw new Error('boom');
        });
        const good = vi.fn();
        mod.subscribe(bad);
        mod.subscribe(good);
        await flush();
        good.mockClear();
        await ws.emit('monitor_status_push', { payload: { running: false } });
        expect(good).toHaveBeenCalledWith({ running: false });
    });
});

describe('monitor_status_push', () => {
    it('applies the payload directly and notifies subscribers', async () => {
        const mod = await loadModule();
        const fn = vi.fn();
        mod.subscribe(fn);
        await flush();
        fn.mockClear();
        await ws.emit('monitor_status_push', { payload: { running: false, hint: 'x' } });
        expect(fn).toHaveBeenCalledWith({ running: false, hint: 'x' });
        expect(mod.getLatest()).toEqual({ running: false, hint: 'x' });
    });

    it('ignores a push with no payload', async () => {
        const mod = await loadModule();
        const fn = vi.fn();
        mod.subscribe(fn);
        await flush();
        fn.mockClear();
        await ws.emit('monitor_status_push', {});
        expect(fn).not.toHaveBeenCalled();
    });

    it('ignores a push with no message at all', async () => {
        const mod = await loadModule();
        const fn = vi.fn();
        mod.subscribe(fn);
        await flush();
        fn.mockClear();
        await ws.emit('monitor_status_push', undefined);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('__ws_open (reconnect)', () => {
    it('re-fetches when there is at least one active subscriber', async () => {
        const mod = await loadModule();
        mod.subscribe(vi.fn());
        await flush();
        api.get.mockClear();
        await ws.emit('__ws_open', {});
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/monitor/status');
    });

    it('does nothing when there are no subscribers', async () => {
        const mod = await loadModule();
        api.get.mockClear();
        await ws.emit('__ws_open', {});
        await flush();
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe('refreshNow', () => {
    it('triggers a fetch and notifies subscribers on success', async () => {
        const mod = await loadModule();
        const fn = vi.fn();
        mod.subscribe(fn);
        await flush();
        api.get.mockResolvedValue({ running: false });
        fn.mockClear();
        mod.refreshNow();
        await flush();
        expect(fn).toHaveBeenCalledWith({ running: false });
    });

    it('keeps the last snapshot and does not throw when the fetch fails', async () => {
        const mod = await loadModule();
        const fn = vi.fn();
        mod.subscribe(fn);
        await flush();
        const before = mod.getLatest();
        api.get.mockRejectedValue(new Error('offline'));
        fn.mockClear();
        expect(() => mod.refreshNow()).not.toThrow();
        await flush();
        expect(fn).not.toHaveBeenCalled();
        expect(mod.getLatest()).toEqual(before);
    });

    it('does not run a second overlapping refresh while one is in flight', async () => {
        const mod = await loadModule();
        let resolveFetch;
        api.get.mockReturnValue(new Promise((r) => (resolveFetch = r)));
        mod.subscribe(vi.fn());
        mod.refreshNow();
        expect(api.get).toHaveBeenCalledTimes(1);
        resolveFetch({ running: true });
        await flush();
    });
});

describe('getLatest', () => {
    it('returns null before any snapshot has resolved', async () => {
        const mod = await loadModule();
        expect(mod.getLatest()).toBeNull();
    });
});
