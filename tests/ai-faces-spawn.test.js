// Covers src/core/ai/faces-spawn.js — the InsightFace sidecar lifecycle, and
// specifically the five ways startSidecar() can resolve WITHOUT spawning a
// child process:
//
//   backend=disabled → docker env URL → operator override → discovery of an
//   already-running sidecar on a well-known port → clustering-off no-op
//
// Those are the paths every containerised and every already-configured
// install actually takes, and none of them were exercised. The download +
// venv + spawn path (Mode 3) is not covered here: it shells out to a real
// binary download and a real Python process, which is a fixture problem of a
// different size.
//
// `http` is mocked with a routing table so the health/info probes are
// deterministic — binding the real well-known ports (8011, 41234, …) would
// make the discovery test depend on whatever else is listening on the
// machine. faces-client, faces-port and child_process are mocked; config and
// db run for real against an isolated TGDL_DATA_DIR.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-facespawn-'));

// ---- http double --------------------------------------------------------

// Map of absolute URL -> { status, body }. Anything unlisted behaves as a
// closed port (request emits an error), which is what "nothing listening"
// looks like to _probeHealth().
let httpRoutes = new Map();
const httpCalls = [];

function fakeGet(url, _opts, cb) {
    httpCalls.push(url);
    const req = new EventEmitter();
    req.destroy = () => {};
    const route = httpRoutes.get(url);
    queueMicrotask(() => {
        if (!route) {
            req.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            return;
        }
        const res = new EventEmitter();
        res.statusCode = route.status ?? 200;
        res.setEncoding = () => {};
        res.resume = () => {};
        cb(res);
        queueMicrotask(() => {
            if (route.body !== undefined) res.emit('data', JSON.stringify(route.body));
            res.emit('end');
        });
    });
    return req;
}

vi.mock('http', () => ({ default: { get: fakeGet }, get: fakeGet }));

// ---- collaborator doubles ----------------------------------------------

const clientApi = {
    setSidecarUrl: vi.fn(),
    getSidecarUrl: vi.fn(() => ''),
    applyFacesCfg: vi.fn(),
};
vi.mock('../src/core/ai/faces-client.js', () => clientApi);

const portApi = { pickAvailablePort: vi.fn(async () => 41500) };
vi.mock('../src/core/ai/faces-port.js', () => portApi);

const spawnCalls = [];
vi.mock('child_process', () => ({
    spawn: (...a) => {
        spawnCalls.push(a);
        const p = new EventEmitter();
        p.stdout = new EventEmitter();
        p.stderr = new EventEmitter();
        p.kill = () => {};
        p.pid = 4242;
        return p;
    },
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
}));

// ---- harness ------------------------------------------------------------

let spawnMod;
let manager;
let dbApi;

async function loadSpawn() {
    vi.resetModules();
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    manager = await import('../src/config/manager.js');
    spawnMod = await import('../src/core/ai/faces-spawn.js');
    return spawnMod;
}

/**
 * Replace advanced.ai wholesale for the run under test.
 *
 * Deliberately not a merge: config is persisted in the shared kv row, so a
 * merge leaks each test's knobs (`faces.backend`, `faces.sidecarUrl`) into
 * every later test in the file.
 */
function setAiConfig(ai) {
    const live = manager.loadConfig();
    live.advanced = { ...live.advanced, ai };
    manager.saveConfig(live);
}

function healthyAt(url, info = { dim: 512 }) {
    httpRoutes.set(`${url}/health`, { status: 200, body: { ok: true } });
    httpRoutes.set(`${url}/info`, { status: 200, body: info });
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
    clientApi.getSidecarUrl.mockReturnValue('');
    httpRoutes = new Map();
    httpCalls.length = 0;
    spawnCalls.length = 0;
    delete process.env.FACES_SERVICE_URL;
    delete process.env.TGDL_FACES_BACKEND;
    delete globalThis.__tgdlBroadcast;
    // Start every test from a bare ai config — see setAiConfig().
    const live = manager?.loadConfig?.();
    if (live) {
        live.advanced = { ...live.advanced, ai: {} };
        manager.saveConfig(live);
    }
});

afterEach(() => {
    try {
        spawnMod?._resetForTests();
    } catch {
        /* module may not have loaded */
    }
});

// ---- status + stop ------------------------------------------------------

describe('getSidecarStatus', () => {
    it('starts idle with no child and no error', async () => {
        const m = await loadSpawn();
        expect(m.getSidecarStatus()).toMatchObject({
            state: 'idle',
            error: null,
            pid: null,
        });
    });

    it('falls back to the client URL when no child of ours is running', async () => {
        const m = await loadSpawn();
        clientApi.getSidecarUrl.mockReturnValue('http://elsewhere:8011');
        expect(m.getSidecarStatus().url).toBe('http://elsewhere:8011');
    });

    it('returns a fresh snapshot each call', async () => {
        const m = await loadSpawn();
        expect(m.getSidecarStatus()).not.toBe(m.getSidecarStatus());
    });
});

describe('stopSidecar', () => {
    it('resets state and clears the client URL', async () => {
        const m = await loadSpawn();
        process.env.FACES_SERVICE_URL = 'http://sidecar:8011';
        healthyAt('http://sidecar:8011');
        await m.startSidecar();
        expect(m.getSidecarStatus().state).toBe('healthy');

        m.stopSidecar();

        expect(m.getSidecarStatus().state).toBe('idle');
        expect(clientApi.setSidecarUrl).toHaveBeenLastCalledWith('');
    });

    it('is safe to call repeatedly with nothing running', async () => {
        const m = await loadSpawn();
        expect(() => {
            m.stopSidecar();
            m.stopSidecar();
        }).not.toThrow();
    });

    it('lets a later startSidecar run again', async () => {
        const m = await loadSpawn();
        setAiConfig({ faceClustering: false });
        await m.startSidecar();
        m.stopSidecar();
        const again = await m.startSidecar();
        expect(again.state).toBe('idle');
    });
});

// ---- resolution modes ---------------------------------------------------

describe('startSidecar — backend=disabled', () => {
    it('never spawns and reports idle', async () => {
        const m = await loadSpawn();
        setAiConfig({ faceClustering: true, faces: { backend: 'disabled' } });

        const st = await m.startSidecar();

        expect(st.state).toBe('idle');
        expect(spawnCalls).toHaveLength(0);
        expect(httpCalls).toHaveLength(0);
    });

    it('broadcasts the disabled state for the maintenance card', async () => {
        const m = await loadSpawn();
        const events = [];
        globalThis.__tgdlBroadcast = (p) => events.push(p);
        setAiConfig({ faceClustering: true, faces: { backend: 'disabled' } });

        await m.startSidecar();

        expect(events.some((e) => e.type === 'ai_faces_status' && e.state === 'disabled')).toBe(
            true,
        );
    });
});

describe('startSidecar — docker URL', () => {
    it('adopts FACES_SERVICE_URL without probing or spawning', async () => {
        const m = await loadSpawn();
        process.env.FACES_SERVICE_URL = 'http://tgdl-faces:8011';
        healthyAt('http://tgdl-faces:8011');
        setAiConfig({ faceClustering: true });

        const st = await m.startSidecar();

        expect(st.state).toBe('healthy');
        expect(st.url).toBe('http://tgdl-faces:8011');
        expect(clientApi.setSidecarUrl).toHaveBeenCalledWith('http://tgdl-faces:8011');
        expect(spawnCalls).toHaveLength(0);
    });

    it('reports the docker mode on the broadcast', async () => {
        const m = await loadSpawn();
        const events = [];
        globalThis.__tgdlBroadcast = (p) => events.push(p);
        process.env.FACES_SERVICE_URL = 'http://tgdl-faces:8011';
        healthyAt('http://tgdl-faces:8011');

        await m.startSidecar();

        expect(events.some((e) => e.mode === 'docker' && e.ok === true)).toBe(true);
    });

    it('ignores a blank FACES_SERVICE_URL', async () => {
        const m = await loadSpawn();
        process.env.FACES_SERVICE_URL = '   ';
        setAiConfig({ faceClustering: false });

        const st = await m.startSidecar();
        expect(st.state).toBe('idle');
    });
});

describe('startSidecar — operator override', () => {
    it('uses advanced.ai.faces.sidecarUrl', async () => {
        const m = await loadSpawn();
        healthyAt('http://127.0.0.1:9100');
        setAiConfig({ faceClustering: true, faces: { sidecarUrl: 'http://127.0.0.1:9100' } });

        const st = await m.startSidecar();

        expect(st.state).toBe('healthy');
        expect(st.url).toBe('http://127.0.0.1:9100');
        expect(spawnCalls).toHaveLength(0);
    });

    it('falls back to the legacy advanced.ai.facesServiceUrl', async () => {
        const m = await loadSpawn();
        healthyAt('http://127.0.0.1:9200');
        setAiConfig({ faceClustering: true, facesServiceUrl: 'http://127.0.0.1:9200' });

        const st = await m.startSidecar();
        expect(st.url).toBe('http://127.0.0.1:9200');
    });

    it('lets the docker env URL win over a configured override', async () => {
        const m = await loadSpawn();
        process.env.FACES_SERVICE_URL = 'http://tgdl-faces:8011';
        healthyAt('http://tgdl-faces:8011');
        healthyAt('http://127.0.0.1:9100');
        setAiConfig({ faceClustering: true, faces: { sidecarUrl: 'http://127.0.0.1:9100' } });

        const st = await m.startSidecar();
        expect(st.url).toBe('http://tgdl-faces:8011');
    });
});

describe('startSidecar — discovery of a running sidecar', () => {
    it('adopts a sidecar already listening on a well-known port', async () => {
        const m = await loadSpawn();
        healthyAt('http://127.0.0.1:8013');
        setAiConfig({ faceClustering: true });

        const st = await m.startSidecar();

        expect(st.state).toBe('healthy');
        expect(st.url).toBe('http://127.0.0.1:8013');
        expect(spawnCalls).toHaveLength(0);
    });

    it('probes the well-known ports in order and stops at the first hit', async () => {
        const m = await loadSpawn();
        healthyAt('http://127.0.0.1:8012');
        setAiConfig({ faceClustering: true });

        await m.startSidecar();

        const probed = httpCalls.filter((u) => u.endsWith('/health'));
        expect(probed[0]).toBe('http://127.0.0.1:8011/health');
        expect(probed[probed.length - 1]).toBe('http://127.0.0.1:8012/health');
        expect(probed.some((u) => u.includes('8013'))).toBe(false);
    });

    it('treats a non-200 health response as nothing listening', async () => {
        const m = await loadSpawn();
        httpRoutes.set('http://127.0.0.1:8011/health', { status: 503, body: { ok: false } });
        setAiConfig({ faceClustering: false });

        const st = await m.startSidecar();
        expect(st.state).toBe('idle');
    });

    it('treats an ok:false body as nothing listening', async () => {
        const m = await loadSpawn();
        httpRoutes.set('http://127.0.0.1:8011/health', { status: 200, body: { ok: false } });
        setAiConfig({ faceClustering: false });

        const st = await m.startSidecar();
        expect(st.state).toBe('idle');
    });

    it('reports the discovered mode on the broadcast', async () => {
        const m = await loadSpawn();
        const events = [];
        globalThis.__tgdlBroadcast = (p) => events.push(p);
        healthyAt('http://127.0.0.1:41234');
        setAiConfig({ faceClustering: true });

        await m.startSidecar();
        expect(events.some((e) => e.mode === 'discovered')).toBe(true);
    });
});

describe('startSidecar — clustering disabled', () => {
    it('stops before the spawn path when faceClustering is off', async () => {
        const m = await loadSpawn();
        setAiConfig({ faceClustering: false });

        const st = await m.startSidecar();

        expect(st.state).toBe('idle');
        expect(spawnCalls).toHaveLength(0);
        expect(portApi.pickAvailablePort).not.toHaveBeenCalled();
    });

    it('still probes for an existing sidecar first', async () => {
        // Discovery runs ahead of the clustering gate on purpose: an
        // already-running sidecar is usable even when auto-spawn is not
        // wanted.
        const m = await loadSpawn();
        healthyAt('http://127.0.0.1:8011');
        setAiConfig({ faceClustering: false });

        const st = await m.startSidecar();
        expect(st.state).toBe('healthy');
    });
});

// ---- concurrency + reset ------------------------------------------------

describe('startSidecar concurrency', () => {
    it('collapses concurrent calls onto one in-flight start', async () => {
        const m = await loadSpawn();
        healthyAt('http://127.0.0.1:8011');
        setAiConfig({ faceClustering: true });

        const [a, b, c] = await Promise.all([m.startSidecar(), m.startSidecar(), m.startSidecar()]);

        expect(a).toEqual(b);
        expect(b).toEqual(c);
        // One resolution pass, not three.
        expect(httpCalls.filter((u) => u === 'http://127.0.0.1:8011/health')).toHaveLength(1);
    });

    it('never rejects — lifecycle failures surface through the status', async () => {
        const m = await loadSpawn();
        setAiConfig({ faceClustering: true, faces: { backend: 'disabled' } });
        await expect(m.startSidecar()).resolves.toBeTruthy();
    });
});

describe('_resetForTests / resetAutoInstallGuard', () => {
    it('returns the module to a clean idle state', async () => {
        const m = await loadSpawn();
        process.env.FACES_SERVICE_URL = 'http://tgdl-faces:8011';
        healthyAt('http://tgdl-faces:8011');
        await m.startSidecar();

        m._resetForTests();

        expect(m.getSidecarStatus()).toMatchObject({ state: 'idle', error: null, pid: null });
    });

    it('resetAutoInstallGuard is callable without a prior install', async () => {
        const m = await loadSpawn();
        expect(() => m.resetAutoInstallGuard()).not.toThrow();
    });
});
