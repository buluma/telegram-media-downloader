// Covers the in-process orchestrator surface area: lifecycle guards,
// state-machine emissions, and status() shape. The downloader / monitor /
// forwarder are heavyweight Telegram-coupled classes, so we exercise the
// runtime through public methods that don't require a wired engine.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

let Runtime;

beforeEach(async () => {
    // Re-import for a fresh class per suite so module-level singletons in
    // sibling files don't bleed between tests.
    const mod = await import('../src/core/runtime.js');
    // Rebuild a clean instance via the same constructor the singleton uses.
    Runtime = mod.runtime.constructor;
});

afterEach(() => vi.restoreAllMocks());

describe('Runtime initial state', () => {
    it('boots into the "stopped" state with no error or startedAt', () => {
        const rt = new Runtime();
        expect(rt.state).toBe('stopped');
        expect(rt.error).toBeNull();
        expect(rt.startedAt).toBeNull();
    });

    it('exposes EventEmitter semantics (state channel)', () => {
        const rt = new Runtime();
        const seen = [];
        rt.on('state', (e) => seen.push(e));
        rt.setState('starting');
        rt.setState('running');
        expect(seen).toEqual([
            { state: 'starting', error: null },
            { state: 'running', error: null },
        ]);
    });

    it('passes the error payload through setState', () => {
        const rt = new Runtime();
        const seen = [];
        rt.on('state', (e) => seen.push(e));
        rt.setState('error', 'boom');
        expect(seen[0]).toEqual({ state: 'error', error: 'boom' });
        expect(rt.error).toBe('boom');
    });
});

describe('Runtime.start guards', () => {
    it('rejects when already running', async () => {
        const rt = new Runtime();
        rt.state = 'running';
        await expect(rt.start({ config: {}, accountManager: { count: 1 } })).rejects.toThrow(
            /already running/i,
        );
    });

    it('rejects when already starting (no double-init)', async () => {
        const rt = new Runtime();
        rt.state = 'starting';
        await expect(rt.start({ config: {}, accountManager: { count: 1 } })).rejects.toThrow(
            /already starting/i,
        );
    });

    it('rejects when no accounts are loaded', async () => {
        const rt = new Runtime();
        await expect(rt.start({ config: {}, accountManager: { count: 0 } })).rejects.toThrow(
            /no telegram accounts/i,
        );
    });

    it('rejects when accountManager is missing entirely', async () => {
        const rt = new Runtime();
        await expect(rt.start({ config: {} })).rejects.toThrow(/no telegram accounts/i);
    });
});

describe('Runtime.stop', () => {
    it('is a noop when already stopped (no state event fires)', async () => {
        const rt = new Runtime();
        const seen = [];
        rt.on('state', (e) => seen.push(e));
        await rt.stop();
        expect(seen).toEqual([]);
        expect(rt.state).toBe('stopped');
    });

    it('walks stopping → stopped when we have an active engine', async () => {
        const rt = new Runtime();
        rt.state = 'running';
        rt._monitor = { stop: vi.fn().mockResolvedValue() };
        rt._downloader = { stop: vi.fn().mockResolvedValue() };

        const seen = [];
        rt.on('state', (e) => seen.push(e.state));
        await rt.stop();

        expect(seen).toEqual(['stopping', 'stopped']);
        expect(rt._monitor).toBeNull();
        expect(rt._downloader).toBeNull();
    });

    it('still reaches the "stopped" state even if a child stop() throws', async () => {
        const rt = new Runtime();
        rt.state = 'running';
        rt._monitor = { stop: vi.fn().mockRejectedValue(new Error('monitor down')) };
        rt._downloader = { stop: vi.fn().mockRejectedValue(new Error('dl down')) };
        await rt.stop();
        expect(rt.state).toBe('stopped');
    });
});

describe('Runtime.status', () => {
    it('returns the documented shape with sane defaults when stopped', () => {
        const rt = new Runtime();
        const s = rt.status();
        expect(s).toMatchObject({
            state: 'stopped',
            error: null,
            startedAt: null,
            uptimeMs: 0,
            stats: null,
            queue: 0,
            active: 0,
            workers: 0,
            accounts: 0,
        });
    });

    it('reports uptimeMs once startedAt is populated', () => {
        const rt = new Runtime();
        rt.startedAt = Date.now() - 1000;
        const s = rt.status();
        expect(s.uptimeMs).toBeGreaterThanOrEqual(900);
        expect(s.uptimeMs).toBeLessThan(5000);
    });

    it('surfaces queue / active / workers / accounts from wired children', () => {
        const rt = new Runtime();
        rt._downloader = { pendingCount: 7, active: new Set([1, 2]), workerCount: 4 };
        rt._monitor = { stats: { messages: 10 } };
        rt._accountManager = { count: 3 };
        const s = rt.status();
        expect(s).toMatchObject({
            queue: 7,
            active: 2,
            workers: 4,
            accounts: 3,
            stats: { messages: 10 },
        });
    });
});

describe('Runtime._wireEvents — config hot-reload on configReloaded', () => {
    // Found 2026-07-03: a Settings save only ever live-updated
    // forwarder.config. downloader.config and the rate limiter's tunables
    // were set once at construction and never refreshed, so changing
    // concurrency or requests/minute silently did nothing until a full
    // engine restart. _wireEvents() is exercised directly (not via start())
    // since downloader/monitor/forwarder are heavyweight Telegram-coupled
    // classes — real EventEmitters stand in for the ones _wireEvents()
    // calls .on() against.
    function wireFakeRuntime() {
        const rt = new Runtime();
        rt._monitor = new EventEmitter();
        rt._downloader = new EventEmitter();
        rt._downloader.config = { stale: true };
        rt._forwarder = { config: { stale: true } };
        rt._rateLimiter = new EventEmitter();
        rt._rateLimiter.updateConfig = vi.fn();
        rt._wireEvents();
        return rt;
    }

    it('swaps downloader.config to the fresh reference (no restart needed)', () => {
        const rt = wireFakeRuntime();
        const newConfig = { fresh: true, rateLimits: {} };
        rt._monitor.emit('configReloaded', newConfig);
        expect(rt._downloader.config).toBe(newConfig);
    });

    it('still updates forwarder.config (pre-existing behaviour, not regressed)', () => {
        const rt = wireFakeRuntime();
        const newConfig = { fresh: true, rateLimits: {} };
        rt._monitor.emit('configReloaded', newConfig);
        expect(rt._forwarder.config).toBe(newConfig);
    });

    it('pushes the new rateLimits block into the live RateLimiter', () => {
        const rt = wireFakeRuntime();
        const newConfig = { rateLimits: { requestsPerMinute: 5, delayMs: { min: 1, max: 2 } } };
        rt._monitor.emit('configReloaded', newConfig);
        expect(rt._rateLimiter.updateConfig).toHaveBeenCalledWith(newConfig.rateLimits);
    });

    it('tolerates a not-yet-wired forwarder (pre-existing guard, still respected)', () => {
        const rt = new Runtime();
        rt._monitor = new EventEmitter();
        rt._downloader = new EventEmitter();
        rt._forwarder = null;
        rt._rateLimiter = new EventEmitter();
        rt._rateLimiter.updateConfig = vi.fn();
        rt._wireEvents();
        expect(() => rt._monitor.emit('configReloaded', { rateLimits: {} })).not.toThrow();
    });

    it('signals backup before starting the forwarder', async () => {
        const rt = wireFakeRuntime();
        const order = [];
        rt.on('event', (event) => {
            if (event.type === 'download_ready_for_backup') order.push('backup');
        });
        rt._forwarder.process = vi.fn().mockImplementation(async () => {
            order.push('forward');
        });

        rt._downloader.emit('download_complete', {
            filePath: 'group/videos/example.mp4',
            deduped: false,
        });
        await Promise.resolve();

        expect(order).toEqual(['backup', 'forward']);
    });
});
