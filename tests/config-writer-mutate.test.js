// Tests for the mutateConfig helper in config-writer.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-mutate-'));

let manager;
let dbApi;
let db;
let mutateConfig;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    const writer = await import('../src/web/lib/config-writer.js');
    mutateConfig = writer.mutateConfig;
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

describe('mutateConfig', () => {
    it('reads, mutates in place, and persists', async () => {
        manager.loadConfig();
        await mutateConfig((cfg) => {
            cfg.telegram.apiId = 'mutated-123';
        });
        const reloaded = manager.loadConfig();
        expect(reloaded.telegram.apiId).toBe('mutated-123');
    });

    it('accepts a returned replacement object', async () => {
        manager.loadConfig();
        const saved = await mutateConfig((cfg) => {
            return { ...cfg, telegram: { ...cfg.telegram, apiHash: 'replaced-hash' } };
        });
        expect(saved.telegram.apiHash).toBe('replaced-hash');
        const reloaded = manager.loadConfig();
        expect(reloaded.telegram.apiHash).toBe('replaced-hash');
    });

    it('fires the config change bus', async () => {
        const fired = [];
        const unsub = manager.watchConfig((cfg) => fired.push(cfg.telegram.apiId));
        manager.loadConfig();
        await mutateConfig((cfg) => {
            cfg.telegram.apiId = 'bus-test';
        });
        unsub();
        expect(fired).toContain('bus-test');
    });
});
