// Covers src/core/seekbar/spawn.js — the seekbar sidecar lifecycle, scoped to
// the paths that resolve without downloading or forking a Go binary:
//
//   SEEKBAR_SIDECAR_URL env → configured sidecarUrl → status/broadcast
//   plumbing → stop/refresh teardown → platform slug resolution
//
// Same shape as tests/ai-faces-spawn.test.js and the same reasoning: the
// remote-URL modes are what every Docker and every remote-sidecar install
// actually takes. The auto-spawn path (Mode 2) fetches a release binary over
// the network and starts a real process — deliberately out of scope here.
//
// ./client.js is mocked so `health()` is deterministic; child_process is
// mocked so nothing can fork even if a test strays into the spawn path.
// config/manager.js and core/db.js run for real against an isolated
// TGDL_DATA_DIR.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbarspawn-'));

const clientApi = {
    health: vi.fn(async () => ({ ok: true })),
    setSidecarUrl: vi.fn(),
};
vi.mock('../src/core/seekbar/client.js', () => clientApi);

const spawnCalls = [];
vi.mock('child_process', () => ({
    spawn: (...a) => {
        spawnCalls.push(a);
        const p = new EventEmitter();
        p.stdout = new EventEmitter();
        p.stderr = new EventEmitter();
        p.kill = vi.fn();
        p.pid = 5150;
        return p;
    },
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
}));

let spawnMod;
let manager;
let dbApi;

async function loadSpawn() {
    vi.resetModules();
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    manager = await import('../src/config/manager.js');
    spawnMod = await import('../src/core/seekbar/spawn.js');
    return spawnMod;
}

function setSeekbarConfig(seekbar) {
    const live = manager.loadConfig();
    live.advanced = { ...live.advanced, seekbar };
    manager.saveConfig(live);
}

beforeAll(() => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
});

afterAll(() => {
    try {
        dbApi?.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    clientApi.health.mockResolvedValue({ ok: true });
    spawnCalls.length = 0;
    delete process.env.SEEKBAR_SIDECAR_URL;
    delete process.env.SEEKBAR_API_TOKEN;
    delete process.env.SEEKBAR_BIN;
    // Replace, never merge — a merged config subtree leaks each test's knobs
    // into the next (same trap as tests/ai-faces-spawn.test.js).
    const live = manager?.loadConfig?.();
    if (live) {
        live.advanced = { ...live.advanced, seekbar: {} };
        manager.saveConfig(live);
    }
});

afterEach(() => {
    try {
        spawnMod?.stopSidecar();
    } catch {
        /* not started */
    }
});

// ---- status + broadcast -------------------------------------------------

describe('getSidecarStatus / setBroadcast', () => {
    it('starts idle', async () => {
        const m = await loadSpawn();
        expect(m.getSidecarStatus()).toMatchObject({ ok: false, mode: 'idle', url: '' });
    });

    it('returns a copy, not the live state object', async () => {
        const m = await loadSpawn();
        const a = m.getSidecarStatus();
        a.ok = true;
        expect(m.getSidecarStatus().ok).toBe(false);
    });

    it('publishes a versioned sidecar constant', async () => {
        const m = await loadSpawn();
        expect(m.SIDECAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('broadcasts every state change once wired', async () => {
        const m = await loadSpawn();
        const events = [];
        m.setBroadcast((e) => events.push(e));
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';

        await m.startSidecar();

        expect(events.length).toBeGreaterThan(0);
        expect(events[0].type).toBe('seekbar_sidecar_status');
    });

    it('ignores a non-function broadcast handler', async () => {
        const m = await loadSpawn();
        expect(() => m.setBroadcast('nope')).not.toThrow();
        expect(() => m.setBroadcast(null)).not.toThrow();
    });

    it('survives a broadcast handler that throws', async () => {
        const m = await loadSpawn();
        m.setBroadcast(() => {
            throw new Error('listener exploded');
        });
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';
        await expect(m.startSidecar()).resolves.toBe(true);
    });
});

// ---- remote modes -------------------------------------------------------

describe('startSidecar — remote URL', () => {
    it('adopts SEEKBAR_SIDECAR_URL without spawning', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';
        process.env.SEEKBAR_API_TOKEN = 'tok123';

        const ok = await m.startSidecar();

        expect(ok).toBe(true);
        expect(clientApi.setSidecarUrl).toHaveBeenCalledWith('http://seekbar:8080', 'tok123');
        expect(m.getSidecarStatus()).toMatchObject({
            ok: true,
            mode: 'remote',
            url: 'http://seekbar:8080',
            error: null,
        });
        expect(spawnCalls).toHaveLength(0);
    });

    it('trims surrounding whitespace off the env URL', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = '  http://seekbar:8080  ';
        await m.startSidecar();
        expect(clientApi.setSidecarUrl).toHaveBeenCalledWith('http://seekbar:8080', '');
    });

    it('falls through to the configured sidecarUrl when no env var is set', async () => {
        const m = await loadSpawn();
        setSeekbarConfig({ sidecarUrl: 'http://configured:9090', apiToken: 'cfgtok' });

        const ok = await m.startSidecar();

        expect(ok).toBe(true);
        expect(clientApi.setSidecarUrl).toHaveBeenCalledWith('http://configured:9090', 'cfgtok');
        expect(m.getSidecarStatus().mode).toBe('remote');
    });

    it('lets the env URL win over the configured one', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = 'http://from-env:8080';
        setSeekbarConfig({ sidecarUrl: 'http://from-config:9090' });

        await m.startSidecar();
        expect(m.getSidecarStatus().url).toBe('http://from-env:8080');
    });

    it('reports unhealthy without throwing when the probe says not ok', async () => {
        const m = await loadSpawn();
        clientApi.health.mockResolvedValue({ ok: false });
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';

        const ok = await m.startSidecar();

        expect(ok).toBe(false);
        expect(m.getSidecarStatus()).toMatchObject({
            ok: false,
            mode: 'remote',
            error: 'unhealthy',
        });
    });

    it('records the reason when the probe throws', async () => {
        const m = await loadSpawn();
        clientApi.health.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:8080'));
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';

        const ok = await m.startSidecar();

        expect(ok).toBe(false);
        expect(m.getSidecarStatus().error).toMatch(/ECONNREFUSED/);
    });

    it('truncates a runaway error message', async () => {
        const m = await loadSpawn();
        clientApi.health.mockRejectedValue(new Error('x'.repeat(5000)));
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';

        await m.startSidecar();
        expect(m.getSidecarStatus().error.length).toBeLessThanOrEqual(200);
    });

    it('collapses concurrent starts onto one in-flight promise', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';

        const [a, b, c] = await Promise.all([m.startSidecar(), m.startSidecar(), m.startSidecar()]);

        expect([a, b, c]).toEqual([true, true, true]);
        expect(clientApi.health).toHaveBeenCalledTimes(1);
    });

    it('can be started again after the first attempt settles', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';
        await m.startSidecar();
        await m.startSidecar();
        expect(clientApi.health).toHaveBeenCalledTimes(2);
    });
});

// ---- stop / refresh -----------------------------------------------------

describe('stopSidecar', () => {
    it('clears the client target so no stale URL survives', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';
        await m.startSidecar();
        clientApi.setSidecarUrl.mockClear();

        m.stopSidecar();

        expect(clientApi.setSidecarUrl).toHaveBeenCalledWith('', '');
        expect(m.getSidecarStatus()).toMatchObject({
            ok: false,
            mode: 'stopped',
            url: '',
            pid: null,
        });
    });

    it('is safe with nothing running, and repeatable', async () => {
        const m = await loadSpawn();
        expect(() => {
            m.stopSidecar();
            m.stopSidecar();
        }).not.toThrow();
    });
});

describe('refreshSidecar', () => {
    it('re-probes and comes back healthy', async () => {
        const m = await loadSpawn();
        process.env.SEEKBAR_SIDECAR_URL = 'http://seekbar:8080';
        await m.startSidecar();

        clientApi.health.mockClear();
        const ok = await m.refreshSidecar();

        expect(ok).toBe(true);
        expect(clientApi.health).toHaveBeenCalledTimes(1);
    });

    it('picks up a changed configured URL', async () => {
        const m = await loadSpawn();
        setSeekbarConfig({ sidecarUrl: 'http://first:9090' });
        await m.startSidecar();
        expect(m.getSidecarStatus().url).toBe('http://first:9090');

        setSeekbarConfig({ sidecarUrl: 'http://second:9090' });
        await m.refreshSidecar();

        expect(m.getSidecarStatus().url).toBe('http://second:9090');
    });
});
