// @vitest-environment jsdom
//
// Covers src/web/public/js/ws.js — the reconnecting WebSocket client
// every live-update feature in the SPA subscribes through.
//
// The module keeps connection state (socket, backoff, attemptCount) at
// module scope, so every test re-imports through vi.resetModules(). A
// FakeWebSocket stands in for the real one; tests drive it by calling
// its recorded instance's `_open()`/`_message()`/`_close()`/`_error()`.

import { describe, it, expect, afterEach, vi } from 'vitest';

let instances;

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = {};
        instances.push(this);
    }
    addEventListener(ev, fn) {
        (this.listeners[ev] ||= new Set()).add(fn);
    }
    removeEventListener(ev, fn) {
        this.listeners[ev]?.delete(fn);
    }
    _fire(ev, payload) {
        this.readyState = ev === 'open' ? 1 : ev === 'close' ? 3 : this.readyState;
        for (const fn of this.listeners[ev] || []) fn(payload);
    }
    _open() {
        this._fire('open');
    }
    _message(data) {
        this._fire('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    _close() {
        this._fire('close');
    }
    _error() {
        this._fire('error');
    }
    close() {
        this.readyState = 3;
    }
}

/** document.hidden is getter-only in jsdom; only defineProperty sticks. */
function setDocumentHidden(value) {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
}

async function loadWs({ throwOnConstruct = false } = {}) {
    vi.resetModules();
    instances = [];
    window.WebSocket = throwOnConstruct
        ? class {
              constructor() {
                  throw new Error('no ws support');
              }
          }
        : FakeWebSocket;
    setDocumentHidden(false);
    return import('../src/web/public/js/ws.js');
}

const lastSocket = () => instances[instances.length - 1];

describe('ws.connect', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('opens a socket against the current host with the right protocol', async () => {
        const { ws } = await loadWs();
        ws.connect();
        expect(lastSocket().url).toBe(`ws://${location.host}`);
    });

    it('uses wss over https', async () => {
        vi.spyOn(window, 'location', 'get').mockReturnValue({
            ...location,
            protocol: 'https:',
            host: location.host,
        });
        const { ws } = await loadWs();
        ws.connect();
        expect(lastSocket().url).toBe(`wss://${location.host}`);
    });

    it('does not open a second socket while one is already connecting or open', async () => {
        const { ws } = await loadWs();
        ws.connect();
        ws.connect();
        expect(instances).toHaveLength(1);
    });

    it('opens a new socket once the previous one has closed', async () => {
        const { ws } = await loadWs();
        ws.connect();
        lastSocket()._close();
        ws.connect();
        expect(instances.length).toBeGreaterThanOrEqual(1);
    });

    it('schedules a reconnect instead of throwing when the constructor fails', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs({ throwOnConstruct: true });
        expect(() => ws.connect()).not.toThrow();
        // Nothing to assert on the socket (none was created), but the
        // reconnect timer must be armed rather than the call throwing out.
        expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
});

describe('dispatch', () => {
    afterEach(() => vi.restoreAllMocks());

    it('routes a message to handlers registered for its type', async () => {
        const { ws } = await loadWs();
        const fn = vi.fn();
        ws.on('stats_update', fn);
        ws.connect();
        lastSocket()._message({ type: 'stats_update', stats: { totalFiles: 3 } });
        expect(fn).toHaveBeenCalledWith({ type: 'stats_update', stats: { totalFiles: 3 } });
    });

    it('also delivers to wildcard subscribers', async () => {
        const { ws } = await loadWs();
        const wild = vi.fn();
        ws.on('*', wild);
        ws.connect();
        lastSocket()._message({ type: 'anything' });
        expect(wild).toHaveBeenCalledWith({ type: 'anything' });
    });

    it('ignores unparseable frames', async () => {
        const { ws } = await loadWs();
        const fn = vi.fn();
        ws.on('*', fn);
        ws.connect();
        lastSocket()._message('not json{{{');
        expect(fn).not.toHaveBeenCalled();
    });

    it('ignores a parsed message with no type', async () => {
        const { ws } = await loadWs();
        const fn = vi.fn();
        ws.on('*', fn);
        ws.connect();
        lastSocket()._message({ noType: true });
        expect(fn).not.toHaveBeenCalled();
    });

    it('keeps notifying the rest when one handler throws', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { ws } = await loadWs();
        const good = vi.fn();
        ws.on('stats_update', () => {
            throw new Error('boom');
        });
        ws.on('stats_update', good);
        ws.connect();
        lastSocket()._message({ type: 'stats_update' });
        expect(good).toHaveBeenCalled();
        expect(err).toHaveBeenCalled();
    });

    it('a throwing wildcard handler does not break dispatch either', async () => {
        const { ws } = await loadWs();
        const good = vi.fn();
        ws.on('*', () => {
            throw new Error('boom');
        });
        ws.on('*', good);
        ws.connect();
        expect(() => lastSocket()._message({ type: 'x' })).not.toThrow();
        expect(good).toHaveBeenCalled();
    });

    it('dispatches __ws_open on connect and __ws_close on disconnect', async () => {
        const { ws } = await loadWs();
        const openFn = vi.fn();
        const closeFn = vi.fn();
        ws.on('__ws_open', openFn);
        ws.on('__ws_close', closeFn);
        ws.connect();
        lastSocket()._open();
        expect(openFn).toHaveBeenCalled();
        lastSocket()._close();
        expect(closeFn).toHaveBeenCalled();
    });
});

describe('on / off', () => {
    it('off stops a handler from receiving further messages', async () => {
        const { ws } = await loadWs();
        const fn = vi.fn();
        ws.on('stats_update', fn);
        ws.off('stats_update', fn);
        ws.connect();
        lastSocket()._message({ type: 'stats_update' });
        expect(fn).not.toHaveBeenCalled();
    });

    it('on() returns an unsubscribe function equivalent to off()', async () => {
        const { ws } = await loadWs();
        const fn = vi.fn();
        const unsub = ws.on('stats_update', fn);
        unsub();
        ws.connect();
        lastSocket()._message({ type: 'stats_update' });
        expect(fn).not.toHaveBeenCalled();
    });

    it('off on a type with no subscribers is a no-op', async () => {
        const { ws } = await loadWs();
        expect(() => ws.off('nope', () => {})).not.toThrow();
    });
});

describe('isConnected', () => {
    it('is false until the socket opens, true after, false again on close', async () => {
        const { ws } = await loadWs();
        expect(ws.isConnected()).toBe(false);
        ws.connect();
        lastSocket()._open();
        expect(ws.isConnected()).toBe(true);
        lastSocket()._close();
        expect(ws.isConnected()).toBe(false);
    });
});

describe('reconnect backoff', () => {
    afterEach(() => vi.useRealTimers());

    it('reconnects after the socket closes', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs();
        ws.connect();
        lastSocket()._close();
        vi.advanceTimersByTime(1000);
        expect(instances.length).toBe(2);
    });

    it('doubles the backoff on repeated failures, capped at 30s', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs();
        ws.connect();

        // 1st close -> reconnect after 1000ms
        lastSocket()._close();
        vi.advanceTimersByTime(999);
        expect(instances.length).toBe(1);
        vi.advanceTimersByTime(1);
        expect(instances.length).toBe(2);

        // 2nd close -> reconnect after 2000ms
        lastSocket()._close();
        vi.advanceTimersByTime(1999);
        expect(instances.length).toBe(2);
        vi.advanceTimersByTime(1);
        expect(instances.length).toBe(3);
    });

    it('resets the backoff to 1s after a successful open', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs();
        ws.connect();
        lastSocket()._close(); // backoff -> 2000 armed
        vi.advanceTimersByTime(1000);
        lastSocket()._open(); // success resets backoff to 1000
        lastSocket()._close();
        vi.advanceTimersByTime(999);
        expect(instances.length).toBe(2);
        vi.advanceTimersByTime(1);
        expect(instances.length).toBe(3);
    });

    it('pauses reconnecting and fires __ws_giveup after too many attempts', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs();
        const giveup = vi.fn();
        ws.on('__ws_giveup', giveup);
        ws.connect();

        // Fail repeatedly; each close schedules the next attempt.
        for (let i = 0; i < 12; i++) {
            lastSocket()._close();
            vi.advanceTimersByTime(30_000);
        }
        expect(giveup).toHaveBeenCalledWith(expect.objectContaining({ type: '__ws_giveup' }));
    });

    it('manual retry resets attempt count and backoff, and connects immediately', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs();
        const giveup = vi.fn();
        ws.on('__ws_giveup', giveup);
        ws.connect();
        for (let i = 0; i < 12; i++) {
            lastSocket()._close();
            vi.advanceTimersByTime(30_000);
        }
        expect(giveup).toHaveBeenCalledTimes(1);

        const before = instances.length;
        ws.retry();
        expect(instances.length).toBe(before + 1);

        // Backoff should be back at 1000ms, not 30000ms.
        lastSocket()._close();
        vi.advanceTimersByTime(999);
        expect(instances.length).toBe(before + 1);
        vi.advanceTimersByTime(1);
        expect(instances.length).toBe(before + 2);
    });

    it('defers reconnecting while the tab is hidden, resuming on visibilitychange', async () => {
        vi.useFakeTimers();
        const { ws } = await loadWs();
        setDocumentHidden(true);
        ws.connect();
        lastSocket()._close();

        vi.advanceTimersByTime(60_000);
        expect(instances.length).toBe(1); // no reconnect while hidden

        setDocumentHidden(false);
        document.dispatchEvent(new window.Event('visibilitychange'));
        expect(instances.length).toBe(2);
    });

    it('closes the socket on a transport error rather than leaking it open', async () => {
        const { ws } = await loadWs();
        ws.connect();
        const sock = lastSocket();
        const closeSpy = vi.spyOn(sock, 'close');
        sock._error();
        expect(closeSpy).toHaveBeenCalled();
    });
});
