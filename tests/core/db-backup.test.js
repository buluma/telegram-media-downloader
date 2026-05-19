import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backup-test-'));

let db;
let backupDb, listBackups;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../../src/core/db.js');
    db = dbMod.getDb();
    ({ backupDb, listBackups } = await import('../../src/core/db/backup.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('backupDb', () => {
    it('creates a backup file in data/backups/', async () => {
        const result = await backupDb('test');
        expect(fs.existsSync(result.path)).toBe(true);
        expect(result.size).toBeGreaterThan(0);
        expect(path.basename(result.path)).toMatch(/^db-test-\d{4}-\d{2}-\d{2}/);
    });

    it('returns filename and size metadata', async () => {
        const result = await backupDb('test');
        expect(typeof result.filename).toBe('string');
        expect(typeof result.size).toBe('number');
        expect(result.size).toBeGreaterThan(0);
    });

    it('prunes old backups beyond MAX_BACKUPS (default 5)', async () => {
        // Create 7 backups; only 5 should remain after each call
        for (let i = 0; i < 7; i++) {
            await backupDb('prune');
        }
        const backupsDir = path.join(DATA_DIR, 'backups');
        const files = fs
            .readdirSync(backupsDir)
            .filter((f) => f.startsWith('db-prune-') && f.endsWith('.sqlite'));
        expect(files.length).toBeLessThanOrEqual(5);
    });

    it('different labels are pruned independently', async () => {
        for (let i = 0; i < 3; i++) await backupDb('label-a');
        for (let i = 0; i < 3; i++) await backupDb('label-b');
        const backupsDir = path.join(DATA_DIR, 'backups');
        const a = fs
            .readdirSync(backupsDir)
            .filter((f) => f.startsWith('db-label-a-') && f.endsWith('.sqlite'));
        const b = fs
            .readdirSync(backupsDir)
            .filter((f) => f.startsWith('db-label-b-') && f.endsWith('.sqlite'));
        expect(a.length).toBe(3);
        expect(b.length).toBe(3);
    });
});

describe('listBackups', () => {
    it('returns array of backup metadata sorted newest-first', async () => {
        await backupDb('list-test');
        await backupDb('list-test');
        const results = listBackups();
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThanOrEqual(2);
        // Newest first
        for (let i = 0; i < results.length - 1; i++) {
            expect(results[i].mtime).toBeGreaterThanOrEqual(results[i + 1].mtime);
        }
    });

    it('each entry has filename, size, mtime, label', () => {
        const results = listBackups();
        for (const r of results.slice(0, 3)) {
            expect(typeof r.filename).toBe('string');
            expect(typeof r.size).toBe('number');
            expect(typeof r.mtime).toBe('number');
            expect(typeof r.label).toBe('string');
        }
    });

    it('returns empty array when no backups exist', () => {
        // Use a sub-dir with no backups
        const empty = listBackups(path.join(DATA_DIR, 'no-such-dir'));
        expect(empty).toEqual([]);
    });
});
