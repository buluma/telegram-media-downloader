// Covers src/core/backup/manager.js — the destination orchestrator sitting
// above the providers: CRUD with credential encryption at rest, the scrubbing
// that keeps secrets out of API responses, per-destination pause/resume,
// the passphrase cache, and connection probing.
//
// Nothing is mocked. The providers, credentials, encryption and queue modules
// all have their own test files and are exercised for real here through the
// `local` provider writing to a temp directory; core/db.js runs against an
// isolated TGDL_DATA_DIR. That matters most for the scrubbing tests — the
// point is that a real encrypted blob never reaches the caller, which a stub
// could not demonstrate.
//
// Destinations are created disabled unless a test needs a live worker, since
// enabling one boots an interval-driven worker plus a snapshot timer.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A path that cannot be created, on every platform.
 *
 * Its parent is a regular file, so mkdir fails ENOTDIR immediately. Do NOT
 * reach for /proc here: it does not exist on macOS (so the call fails fast
 * and the test passes for the wrong reason) but does on Linux, where the
 * call stalls and the test times out instead.
 */
function unwritablePath() {
    const blocker = path.join(DATA_DIR, `not-a-dir-${process.pid}`);
    if (!fs.existsSync(blocker)) fs.writeFileSync(blocker, 'x');
    return path.join(blocker, 'nested');
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backupmgr-'));
const DEST_DIR = path.join(DATA_DIR, 'backup-target');

let mgr;
let dbApi;

const SHARE_SECRET = 'a'.repeat(64);

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    mgr = await import('../src/core/backup/manager.js');
    mgr.init({
        broadcast: (m) => broadcasts.push(m),
        log: (m) => logs.push(m),
        getShareSecret: () => SHARE_SECRET,
    });
});

afterAll(() => {
    try {
        dbApi.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const broadcasts = [];
const logs = [];

beforeEach(() => {
    broadcasts.length = 0;
    logs.length = 0;
    fs.mkdirSync(DEST_DIR, { recursive: true });
});

afterEach(() => {
    // Tear down every destination so no worker interval or snapshot timer
    // outlives the test that created it.
    for (const d of mgr.listDestinations()) {
        try {
            mgr.removeDestination(d.id);
        } catch {
            /* already gone */
        }
    }
    try {
        dbApi.getDb().prepare('DELETE FROM backup_jobs').run();
    } catch {
        /* table may not exist */
    }
});

function addLocal(over = {}) {
    return mgr.addDestination({
        name: 'My Target',
        provider: 'local',
        config: { rootPath: DEST_DIR },
        enabled: false,
        mode: 'manual',
        ...over,
    });
}

// ---- provider registry --------------------------------------------------

describe('listProviders', () => {
    it('advertises every wired provider with its schema', () => {
        const names = mgr.listProviders().map((p) => p.name);
        expect(names).toEqual(
            expect.arrayContaining(['local', 's3', 'sftp', 'ftp', 'gdrive', 'dropbox']),
        );
        for (const p of mgr.listProviders()) {
            expect(p.displayName, p.name).toBeTruthy();
            expect(p.configSchema, p.name).toBeTruthy();
        }
    });
});

// ---- validation ---------------------------------------------------------

describe('addDestination validation', () => {
    it('requires an object', () => {
        expect(() => mgr.addDestination(null)).toThrow(/input required/i);
        expect(() => mgr.addDestination('nope')).toThrow(/input required/i);
    });

    it('requires a name', () => {
        expect(() => addLocal({ name: '' })).toThrow(/name required/i);
        expect(() => addLocal({ name: '   ' })).toThrow(/name required/i);
    });

    it('rejects an unknown provider', () => {
        expect(() => addLocal({ provider: 'carrierpigeon' })).toThrow(/unknown provider/i);
    });

    it('requires a cron expression for snapshot mode', () => {
        expect(() => addLocal({ mode: 'snapshot' })).toThrow(/cron/i);
        expect(() => addLocal({ mode: 'snapshot', cron: '0 3 * * *' })).toBeTruthy();
    });

    it('defaults an unrecognised mode to mirror', () => {
        const id = addLocal({ mode: 'sideways' });
        expect(mgr.listDestinations().find((d) => d.id === id).mode).toBe('mirror');
    });

    it('truncates an overlong name', () => {
        const id = addLocal({ name: 'x'.repeat(400) });
        expect(mgr.listDestinations().find((d) => d.id === id).name).toHaveLength(200);
    });

    it('defaults retainCount to 7', () => {
        const id = addLocal();
        expect(mgr.listDestinations().find((d) => d.id === id).retainCount).toBe(7);
    });
});

// ---- secrets never leak -------------------------------------------------

describe('credential handling', () => {
    it('encrypts the config at rest', () => {
        const id = addLocal({ config: { rootPath: DEST_DIR, secretToken: 'hunter2' } });
        const raw = dbApi
            .getDb()
            .prepare('SELECT config_blob FROM backup_destinations WHERE id = ?')
            .get(id);

        expect(raw.config_blob).toBeTruthy();
        expect(String(raw.config_blob)).not.toContain('hunter2');
        expect(String(raw.config_blob)).not.toContain(DEST_DIR);
    });

    it('scrubs the blob out of every listed destination', () => {
        addLocal({ config: { rootPath: DEST_DIR, secretToken: 'hunter2' } });
        const flat = JSON.stringify(mgr.listDestinations());
        expect(flat).not.toContain('hunter2');
        expect(flat).not.toContain('config_blob');
    });

    it('hands back the raw rows only when explicitly asked', () => {
        addLocal();
        expect(mgr.listDestinations({ scrubbed: false })[0].config_blob).toBeTruthy();
        expect(mgr.listDestinations()[0].config_blob).toBeUndefined();
    });

    it('refuses to store credentials before the share secret exists', () => {
        // Boot order matters: the share secret is what encrypts the config,
        // so a destination added before it is initialised would otherwise
        // land in the DB with unusable credentials.
        mgr.init({ getShareSecret: () => null });
        try {
            expect(() => addLocal()).toThrow(/share secret not initialised/i);
            expect(mgr.listDestinations()).toHaveLength(0);
        } finally {
            mgr.init({ getShareSecret: () => SHARE_SECRET });
        }
    });

    it('refuses to re-encrypt a replaced config without the share secret', () => {
        const id = addLocal();
        mgr.init({ getShareSecret: () => null });
        try {
            expect(() => mgr.updateDestination(id, { config: { rootPath: DEST_DIR } })).toThrow(
                /share secret not initialised/i,
            );
        } finally {
            mgr.init({ getShareSecret: () => SHARE_SECRET });
        }
    });
});

// ---- update / remove ----------------------------------------------------

describe('updateDestination', () => {
    it('applies a partial patch and leaves the rest alone', () => {
        const id = addLocal({ name: 'Before', mode: 'manual' });
        const out = mgr.updateDestination(id, { name: 'After' });
        expect(out.name).toBe('After');
        expect(out.mode).toBe('manual');
    });

    it('rejects an invalid mode rather than silently defaulting', () => {
        const id = addLocal();
        expect(() => mgr.updateDestination(id, { mode: 'sideways' })).toThrow(/invalid mode/i);
    });

    it('clamps retainCount into range', () => {
        const id = addLocal();
        expect(mgr.updateDestination(id, { retainCount: 9999 }).retainCount).toBe(365);
        // 0 is falsy so it takes the 7 default; -5 is truthy and clamps to
        // the floor of 1. Different paths, deliberately pinned separately.
        expect(mgr.updateDestination(id, { retainCount: 0 }).retainCount).toBe(7);
        expect(mgr.updateDestination(id, { retainCount: -5 }).retainCount).toBe(1);
    });

    it('clears the cron when handed an empty value', () => {
        const id = addLocal({ mode: 'snapshot', cron: '0 3 * * *' });
        expect(mgr.updateDestination(id, { cron: '' }).cron).toBeNull();
    });

    it('re-encrypts a replaced config', () => {
        const id = addLocal({ config: { rootPath: DEST_DIR, token: 'old-token' } });
        mgr.updateDestination(id, { config: { rootPath: DEST_DIR, token: 'new-token' } });
        const raw = dbApi
            .getDb()
            .prepare('SELECT config_blob FROM backup_destinations WHERE id = ?')
            .get(id);
        expect(String(raw.config_blob)).not.toContain('new-token');
        expect(String(raw.config_blob)).not.toContain('old-token');
    });

    it('announces the update', () => {
        const id = addLocal();
        broadcasts.length = 0;
        mgr.updateDestination(id, { name: 'Renamed' });
        expect(broadcasts.some((b) => b.type === 'backup_destination_updated')).toBe(true);
    });

    it('throws for an unknown id', () => {
        expect(() => mgr.updateDestination(999999, { name: 'x' })).toThrow();
    });
});

describe('removeDestination', () => {
    it('deletes the row and reports it', () => {
        const id = addLocal();
        expect(mgr.removeDestination(id)).toBe(true);
        expect(mgr.listDestinations().find((d) => d.id === id)).toBeUndefined();
    });

    it('reports false for an id that was not there', () => {
        expect(mgr.removeDestination(999999)).toBe(false);
    });

    it('announces the removal', () => {
        const id = addLocal();
        broadcasts.length = 0;
        mgr.removeDestination(id);
        expect(broadcasts.some((b) => b.type === 'backup_destination_removed')).toBe(true);
    });
});

// ---- status -------------------------------------------------------------

describe('getDestinationStatus', () => {
    it('reports the destination shape plus queue counts', () => {
        const id = addLocal({ name: 'Statusy' });
        const st = mgr.getDestinationStatus(id);

        expect(st).toMatchObject({
            id,
            name: 'Statusy',
            provider: 'local',
            enabled: false,
            mode: 'manual',
            encryption: false,
            totalBytes: 0,
            totalFiles: 0,
        });
        // Queue counters come from backup/queue.js.
        expect(st).toHaveProperty('queued');
        expect(st).toHaveProperty('processing');
    });

    it('treats an unencrypted destination as always unlocked', () => {
        const id = addLocal();
        expect(mgr.getDestinationStatus(id).encryptionUnlocked).toBe(true);
    });

    it('throws for an unknown id', () => {
        expect(() => mgr.getDestinationStatus(999999)).toThrow();
    });
});

// ---- pause / resume -----------------------------------------------------

describe('pause / resume', () => {
    it('persists the paused flag', () => {
        const id = addLocal();
        mgr.pause(id);
        const row = dbApi
            .getDb()
            .prepare('SELECT paused FROM backup_destinations WHERE id = ?')
            .get(id);
        expect(row.paused).toBe(1);

        mgr.resume(id);
        expect(
            dbApi.getDb().prepare('SELECT paused FROM backup_destinations WHERE id = ?').get(id)
                .paused,
        ).toBe(0);
    });

    it('announces both transitions', () => {
        const id = addLocal();
        broadcasts.length = 0;
        mgr.pause(id);
        mgr.resume(id);
        expect(broadcasts.filter((b) => b.type === 'backup_destination_updated')).toHaveLength(2);
    });
});

// ---- encryption ---------------------------------------------------------

describe('setEncryption / unlockEncryption', () => {
    // deriveKey() rejects a missing passphrase too, so the message alone
    // does not prove which guard fired. What the manager's own check buys is
    // ORDER: it throws before the UPDATE, so a rejected enable leaves no
    // half-configured row behind (encryption flagged on, salt written, no
    // key cached — a destination that looks encrypted and cannot be used).
    it('requires a passphrase to enable, and writes nothing when it is missing', () => {
        const id = addLocal();
        expect(() => mgr.setEncryption(id, { enabled: true })).toThrow(/passphrase required/i);

        const row = dbApi
            .getDb()
            .prepare('SELECT encryption, encryption_salt FROM backup_destinations WHERE id = ?')
            .get(id);
        expect(row.encryption).toBe(0);
        expect(row.encryption_salt).toBeNull();
    });

    it('enables encryption, stores a salt and caches the key', () => {
        const id = addLocal();
        const out = mgr.setEncryption(id, { enabled: true, passphrase: 'correct horse' });

        expect(out.encryption).toBe(true);
        expect(out.encryptionUnlocked).toBe(true);
        const row = dbApi
            .getDb()
            .prepare('SELECT encryption, encryption_salt FROM backup_destinations WHERE id = ?')
            .get(id);
        expect(row.encryption).toBe(1);
        expect(row.encryption_salt).toBeTruthy();
    });

    it('never persists the passphrase itself', () => {
        const id = addLocal();
        mgr.setEncryption(id, { enabled: true, passphrase: 'correct horse' });
        const row = dbApi.getDb().prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id);
        expect(JSON.stringify(row)).not.toContain('correct horse');
    });

    it('disabling clears the salt and drops the cached key', () => {
        const id = addLocal();
        mgr.setEncryption(id, { enabled: true, passphrase: 'pw' });
        const out = mgr.setEncryption(id, { enabled: false });

        expect(out.encryption).toBe(false);
        const row = dbApi
            .getDb()
            .prepare('SELECT encryption, encryption_salt FROM backup_destinations WHERE id = ?')
            .get(id);
        expect(row.encryption).toBe(0);
        expect(row.encryption_salt).toBeNull();
    });

    it('keeps the existing salt when re-enabling, so old archives stay readable', () => {
        const id = addLocal();
        mgr.setEncryption(id, { enabled: true, passphrase: 'pw' });
        const saltA = dbApi
            .getDb()
            .prepare('SELECT encryption_salt FROM backup_destinations WHERE id = ?')
            .get(id).encryption_salt;

        mgr.setEncryption(id, { enabled: true, passphrase: 'pw' });
        const saltB = dbApi
            .getDb()
            .prepare('SELECT encryption_salt FROM backup_destinations WHERE id = ?')
            .get(id).encryption_salt;

        expect(String(saltB)).toBe(String(saltA));
    });

    it('unlockEncryption re-caches the key after a restart', () => {
        const id = addLocal();
        mgr.setEncryption(id, { enabled: true, passphrase: 'pw' });
        expect(mgr.unlockEncryption(id, 'pw')).toBe(true);
        expect(mgr.getDestinationStatus(id).encryptionUnlocked).toBe(true);
    });

    it('unlockEncryption refuses a destination without encryption', () => {
        const id = addLocal();
        expect(() => mgr.unlockEncryption(id, 'pw')).toThrow(/not enabled/i);
    });
});

// ---- retry --------------------------------------------------------------

describe('retryJob', () => {
    it('reports false for an unknown job', () => {
        expect(mgr.retryJob(999999)).toBe(false);
    });
});

// ---- connection probe ---------------------------------------------------

describe('testConnection', () => {
    it('succeeds against a writable local directory', async () => {
        const id = addLocal();
        const r = await mgr.testConnection(id);
        expect(r.ok).toBe(true);
    });

    it('fails cleanly when the target cannot be used', async () => {
        const id = addLocal({ config: { rootPath: unwritablePath() } });
        const r = await mgr.testConnection(id);
        expect(r.ok).toBe(false);
        expect(r.detail).toBeTruthy();
    });

    it('reports an unknown provider without throwing', async () => {
        const id = addLocal();
        dbApi
            .getDb()
            .prepare("UPDATE backup_destinations SET provider = 'carrierpigeon' WHERE id = ?")
            .run(id);
        const r = await mgr.testConnection(id);
        expect(r).toEqual({ ok: false, detail: 'unknown provider "carrierpigeon"' });
    });
});

// ---- runBackup ----------------------------------------------------------

describe('runBackup', () => {
    it('refuses a disabled destination', async () => {
        const id = addLocal({ enabled: false });
        await expect(mgr.runBackup(id)).rejects.toThrow(/disabled/i);
    });

    it('throws for an unknown id', async () => {
        await expect(mgr.runBackup(999999)).rejects.toThrow();
    });
});
