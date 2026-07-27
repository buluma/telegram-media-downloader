// @vitest-environment jsdom
//
// Covers src/web/public/js/wake-lock.js — the Screen Wake Lock helper.
// SUPPORTED is computed once at import time from `'wakeLock' in
// navigator`, so every test stubs (or deletes) navigator.wakeLock
// BEFORE importing and re-imports via vi.resetModules().
//
// attachVisibilityRefresh() attaches to `document` with no teardown,
// and jsdom keeps the same `document` across every test in a file —
// so, as with shortcuts.js, the handler is captured via a spy on
// addEventListener and invoked directly rather than dispatched through
// the (accumulating) real listener chain.

import { describe, it, expect, beforeEach, vi } from 'vitest';

function makeSentinel() {
    const listeners = new Map();
    return {
        addEventListener: vi.fn((type, fn) => {
            (listeners.get(type) || listeners.set(type, []).get(type)).push(fn);
        }),
        release: vi.fn().mockResolvedValue(undefined),
        _fireRelease: () => (listeners.get('release') || []).forEach((fn) => fn()),
    };
}

async function loadModule({ supported = true } = {}) {
    vi.resetModules();
    if (supported) {
        Object.defineProperty(navigator, 'wakeLock', {
            configurable: true,
            value: { request: vi.fn() },
        });
    } else {
        delete navigator.wakeLock;
    }
    return import('../src/web/public/js/wake-lock.js');
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => vi.restoreAllMocks());

describe('isSupported', () => {
    it('is true when navigator.wakeLock exists', async () => {
        const mod = await loadModule({ supported: true });
        expect(mod.isSupported).toBe(true);
    });

    it('is false when navigator.wakeLock is absent', async () => {
        const mod = await loadModule({ supported: false });
        expect(mod.isSupported).toBe(false);
    });
});

describe('acquireIfActive', () => {
    // Note: acquireIfActive's own `if (_sentinel) return` guard is
    // redundant with _acquire()'s internal `if (!SUPPORTED || _sentinel ||
    // _acquiring) return` — removing the outer one is unobservable through
    // any public-API test since _acquire() still no-ops. The
    // "does not double-acquire" test below pins the *observable* contract
    // (one request() call) regardless of which guard provides it.

    it('does nothing when unsupported', async () => {
        const mod = await loadModule({ supported: false });
        mod.acquireIfActive(3);
        await flush();
        expect(() => {}).not.toThrow(); // nothing to assert on — no navigator.wakeLock to call
    });

    it('requests the lock when activeJobs > 0', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
    });

    it('does not request when activeJobs is 0', async () => {
        const mod = await loadModule();
        mod.acquireIfActive(0);
        await flush();
        expect(navigator.wakeLock.request).not.toHaveBeenCalled();
    });

    it('does not request when activeJobs is negative', async () => {
        const mod = await loadModule();
        mod.acquireIfActive(-5);
        await flush();
        expect(navigator.wakeLock.request).not.toHaveBeenCalled();
    });

    it('does not double-acquire once a sentinel is already held', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        mod.acquireIfActive(1);
        await flush();
        expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
    });

    it('clears the sentinel when the browser fires its own release event', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        sentinel._fireRelease();
        // Sentinel is now null internally — a fresh acquireIfActive call
        // should request a new lock rather than treating one as held.
        mod.acquireIfActive(1);
        await flush();
        expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
    });

    it('swallows a request() rejection (e.g. tab not visible) without throwing', async () => {
        const mod = await loadModule();
        navigator.wakeLock.request.mockRejectedValue(new Error('not visible'));
        expect(() => mod.acquireIfActive(1)).not.toThrow();
        await flush();
    });

    it('does not race two concurrent acquire calls into two requests', async () => {
        const mod = await loadModule();
        let resolveRequest;
        navigator.wakeLock.request.mockReturnValue(new Promise((r) => (resolveRequest = r)));
        mod.acquireIfActive(1);
        mod.acquireIfActive(1);
        expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
        resolveRequest(makeSentinel());
        await flush();
    });
});

describe('releaseIfIdle', () => {
    it('does nothing when unsupported', async () => {
        const mod = await loadModule({ supported: false });
        expect(() => mod.releaseIfIdle(0)).not.toThrow();
    });

    it('does nothing when activeJobs is still > 0', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        mod.releaseIfIdle(1);
        await flush();
        expect(sentinel.release).not.toHaveBeenCalled();
    });

    it('does nothing when no sentinel is held', async () => {
        const mod = await loadModule();
        expect(() => mod.releaseIfIdle(0)).not.toThrow();
    });

    it('releases the held sentinel once the queue drains', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        mod.releaseIfIdle(0);
        await flush();
        expect(sentinel.release).toHaveBeenCalled();
    });

    it('swallows a release() rejection without throwing', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        sentinel.release.mockRejectedValue(new Error('already released'));
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        expect(() => mod.releaseIfIdle(0)).not.toThrow();
        await flush();
    });

    it('allows re-acquiring after a release', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        mod.acquireIfActive(1);
        await flush();
        mod.releaseIfIdle(0);
        await flush();
        mod.acquireIfActive(1);
        await flush();
        expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
    });
});

describe('attachVisibilityRefresh', () => {
    it('does nothing when unsupported', async () => {
        const mod = await loadModule({ supported: false });
        const spy = vi.spyOn(document, 'addEventListener');
        mod.attachVisibilityRefresh(() => 1);
        expect(spy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    it('re-acquires when the tab becomes visible with active jobs', async () => {
        const mod = await loadModule();
        const sentinel = makeSentinel();
        navigator.wakeLock.request.mockResolvedValue(sentinel);
        const spy = vi.spyOn(document, 'addEventListener');
        mod.attachVisibilityRefresh(() => 2);
        const handler = spy.mock.calls.find(([t]) => t === 'visibilitychange')[1];
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        handler();
        await flush();
        expect(navigator.wakeLock.request).toHaveBeenCalled();
    });

    it('does not re-acquire when the tab is hidden', async () => {
        const mod = await loadModule();
        const spy = vi.spyOn(document, 'addEventListener');
        mod.attachVisibilityRefresh(() => 2);
        const handler = spy.mock.calls.find(([t]) => t === 'visibilitychange')[1];
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        handler();
        await flush();
        expect(navigator.wakeLock.request).not.toHaveBeenCalled();
    });

    it('does not re-acquire when visible but there are no active jobs', async () => {
        const mod = await loadModule();
        const spy = vi.spyOn(document, 'addEventListener');
        mod.attachVisibilityRefresh(() => 0);
        const handler = spy.mock.calls.find(([t]) => t === 'visibilitychange')[1];
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        handler();
        await flush();
        expect(navigator.wakeLock.request).not.toHaveBeenCalled();
    });
});
