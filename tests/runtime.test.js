import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy deps before importing runtime
vi.mock('../src/core/downloader.js', () => ({
    DownloadManager: vi.fn(() => ({
        on: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        pendingCount: 3,
        active: new Map([['a', 1]]),
        workerCount: 2,
        init: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
    })),
    migrateFolders: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/monitor.js', () => ({
    RealtimeMonitor: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        stats: { groups: 0 },
    })),
}));

vi.mock('../src/core/security.js', () => ({
    RateLimiter: vi.fn(() => ({
        on: vi.fn(),
    })),
}));

vi.mock('../src/core/forwarder.js', () => ({
    AutoForwarder: vi.fn(() => ({
        process: vi.fn().mockResolvedValue(undefined),
        config: null,
    })),
}));

vi.mock('../src/core/metrics.js', () => ({
    metrics: {
        set: vi.fn(),
        inc: vi.fn(),
        observe: vi.fn(),
    },
}));

import { runtime } from '../src/core/runtime.js';

function makeAccountManager(count = 1) {
    return {
        count,
        getDefaultClient: vi.fn(() => ({ setLogLevel: vi.fn() })),
        getClient: vi.fn(),
    };
}

beforeEach(() => {
    // Reset singleton state between tests
    runtime.state = 'stopped';
    runtime.error = null;
    runtime.startedAt = null;
    runtime._monitor = null;
    runtime._downloader = null;
    runtime._forwarder = null;
    runtime._rateLimiter = null;
    runtime._accountManager = null;
    runtime.removeAllListeners();
});

describe('Runtime state machine', () => {
    it('starts in stopped state', () => {
        expect(runtime.state).toBe('stopped');
        expect(runtime.error).toBeNull();
        expect(runtime.startedAt).toBeNull();
    });

    it('setState emits state event with payload', () => {
        const events = [];
        runtime.on('state', (e) => events.push(e));
        runtime.setState('running');
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ state: 'running', error: null });
    });

    it('setState records error', () => {
        runtime.setState('error', 'something broke');
        expect(runtime.state).toBe('error');
        expect(runtime.error).toBe('something broke');
    });

    it('start() throws when already running', async () => {
        runtime.state = 'running';
        await expect(runtime.start({ config: {}, accountManager: makeAccountManager() }))
            .rejects.toThrow('Runtime already running');
    });

    it('start() throws when already starting', async () => {
        runtime.state = 'starting';
        await expect(runtime.start({ config: {}, accountManager: makeAccountManager() }))
            .rejects.toThrow('Runtime already starting');
    });

    it('start() throws when no accounts loaded', async () => {
        await expect(runtime.start({ config: {}, accountManager: makeAccountManager(0) }))
            .rejects.toThrow('No Telegram accounts loaded');
    });

    it('start() transitions stopped → running', async () => {
        const config = { download: {}, rateLimits: {} };
        await runtime.start({ config, accountManager: makeAccountManager() });
        expect(runtime.state).toBe('running');
        expect(runtime.startedAt).toBeTypeOf('number');
    });

    it('stop() when already stopped is a noop', async () => {
        const events = [];
        runtime.on('state', (e) => events.push(e));
        await runtime.stop();
        expect(events).toHaveLength(0);
        expect(runtime.state).toBe('stopped');
    });

    it('stop() transitions running → stopped', async () => {
        const config = { download: {}, rateLimits: {} };
        await runtime.start({ config, accountManager: makeAccountManager() });
        expect(runtime.state).toBe('running');

        await runtime.stop();
        expect(runtime.state).toBe('stopped');
        expect(runtime.startedAt).toBeNull();
        expect(runtime._monitor).toBeNull();
        expect(runtime._downloader).toBeNull();
    });
});

describe('Runtime.status()', () => {
    it('returns correct shape when stopped', () => {
        const s = runtime.status();
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

    it('returns non-zero uptime when running', async () => {
        const config = { download: {}, rateLimits: {} };
        await runtime.start({ config, accountManager: makeAccountManager() });
        const s = runtime.status();
        expect(s.state).toBe('running');
        expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
        expect(s.queue).toBe(3);
        expect(s.active).toBe(1);
        expect(s.workers).toBe(2);
        expect(s.accounts).toBe(1);
    });
});
