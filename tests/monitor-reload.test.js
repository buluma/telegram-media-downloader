// Regression: reloadConfig must tolerate configs with missing `groups`.
// The module-level _sharedMonitor is constructed with `config = {}`,
// so the first saveConfig() during boot (accounts.syncToConfig) would
// crash on `this.config.groups.map(...)`.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-monitor-reload-'));

let manager;
let dbApi;
let db;
let RealtimeMonitor;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    const monitorMod = await import('../src/core/monitor.js');
    RealtimeMonitor = monitorMod.RealtimeMonitor;
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    dbApi.kvDelete('config');
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
});

describe('monitor reloadConfig', () => {
    it('does not crash when constructed with empty config and saveConfig fires', () => {
        const monitor = new RealtimeMonitor(null, null, {});
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = 'trigger-bus';
        expect(() => manager.saveConfig(cfg)).not.toThrow();
    });

    it('does not crash when config has no groups and saveConfig fires', () => {
        const monitor = new RealtimeMonitor(null, null, { telegram: {} });
        const cfg = manager.loadConfig();
        cfg.accounts = [{ id: 'test' }];
        expect(() => manager.saveConfig(cfg)).not.toThrow();
    });

    it('detects added groups when old config had none', async () => {
        const monitor = new RealtimeMonitor(null, null, {});
        const cfg = manager.loadConfig();
        cfg.groups = [{ id: '-100111', name: 'New Group', enabled: true }];
        manager.saveConfig(cfg);
        expect(monitor.config.groups).toHaveLength(1);
        expect(String(monitor.config.groups[0].id)).toBe('-100111');
    });
});
