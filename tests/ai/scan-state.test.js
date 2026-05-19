import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-scanstate-test-'));

let db;
let markScanDone,
    markScanFailed,
    markScanSkipped,
    resetScanState,
    recoverStaleLocks,
    getScanStateCounts,
    listScanFailures;

function insertRow(overrides = {}) {
    const id = db
        .prepare(
            `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status)
             VALUES (?, ?, ?, ?, ?, 'completed')`,
        )
        .run(
            overrides.group_id ?? 'grp1',
            overrides.message_id ?? Math.floor(Math.random() * 1e9),
            overrides.file_type ?? 'photo',
            overrides.file_path ?? '/data/downloads/img.jpg',
            overrides.file_name ?? 'img.jpg',
        ).lastInsertRowid;
    return Number(id);
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../../src/core/db.js');
    db = dbMod.getDb();
    ({
        markScanDone,
        markScanFailed,
        markScanSkipped,
        resetScanState,
        recoverStaleLocks,
        getScanStateCounts,
        listScanFailures,
    } = await import('../../src/core/db/scan-state.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('media_scan_state helpers', () => {
    it('markScanDone inserts status=done with completed_at', () => {
        const id = insertRow({ message_id: 2001 });
        markScanDone(id, 'wd14');
        const row = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .get(id);
        expect(row.status).toBe('done');
        expect(row.completed_at).toBeTruthy();
        expect(row.locked_by).toBeNull();
    });

    it('markScanDone is idempotent', () => {
        const id = insertRow({ message_id: 2002 });
        markScanDone(id, 'wd14');
        markScanDone(id, 'wd14');
        const rows = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .all(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('done');
    });

    it('markScanFailed records error and increments attempts', () => {
        const id = insertRow({ message_id: 2003 });
        markScanFailed(id, 'wd14', 'sidecar error', 'SIDECAR_UNREACHABLE');
        markScanFailed(id, 'wd14', 'sidecar error again', 'SIDECAR_UNREACHABLE');
        const row = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .get(id);
        expect(row.status).toBe('failed');
        expect(row.attempts).toBe(2);
        expect(row.last_error).toBe('sidecar error again');
        expect(row.last_error_code).toBe('SIDECAR_UNREACHABLE');
        expect(row.locked_by).toBeNull();
    });

    it('markScanSkipped records reason and status', () => {
        const id = insertRow({ message_id: 2004 });
        markScanSkipped(id, 'wd14', 'file_missing');
        const row = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .get(id);
        expect(row.status).toBe('skipped');
        expect(row.last_error).toBe('file_missing');
        expect(row.completed_at).toBeTruthy();
    });

    it('resetScanState removes the row so the download can be retried', () => {
        const id = insertRow({ message_id: 2005 });
        markScanFailed(id, 'wd14', 'err');
        resetScanState([id], 'wd14');
        const row = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .get(id);
        expect(row).toBeUndefined();
    });

    it('resetScanState is no-op for empty array', () => {
        expect(() => resetScanState([], 'wd14')).not.toThrow();
    });

    it('recoverStaleLocks resets processing rows older than maxAgeMs', () => {
        const id = insertRow({ message_id: 2006 });
        db.prepare(`
            INSERT INTO media_scan_state (download_id, scanner, status, locked_by, locked_at, updated_at)
            VALUES (?, 'wd14', 'processing', 'job-stale', ?, ?)
        `).run(id, Date.now() - 60 * 60 * 1000, Date.now());

        const recovered = recoverStaleLocks('wd14', 30 * 60 * 1000);
        expect(recovered).toBeGreaterThan(0);

        const row = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .get(id);
        expect(row.status).toBe('failed');
        expect(row.locked_by).toBeNull();
    });

    it('recoverStaleLocks leaves recent locks untouched', () => {
        const id = insertRow({ message_id: 2007 });
        db.prepare(`
            INSERT INTO media_scan_state (download_id, scanner, status, locked_by, locked_at, updated_at)
            VALUES (?, 'wd14', 'processing', 'job-fresh', ?, ?)
        `).run(id, Date.now() - 60 * 1000, Date.now()); // 1 min old, threshold 30 min

        recoverStaleLocks('wd14', 30 * 60 * 1000);

        const row = db
            .prepare(`SELECT * FROM media_scan_state WHERE download_id=? AND scanner='wd14'`)
            .get(id);
        expect(row.status).toBe('processing');
    });

    it('getScanStateCounts returns counts per status', () => {
        const id1 = insertRow({ message_id: 2008 });
        const id2 = insertRow({ message_id: 2009 });
        markScanDone(id1, 'ocr');
        markScanFailed(id2, 'ocr', 'timeout');

        const counts = getScanStateCounts('ocr');
        expect(counts.done).toBeGreaterThanOrEqual(1);
        expect(counts.failed).toBeGreaterThanOrEqual(1);
        expect(typeof counts.skipped).toBe('number');
    });

    it('listScanFailures returns failed rows joined with download info', () => {
        const id = insertRow({ message_id: 2010, file_name: 'fail.jpg' });
        markScanFailed(id, 'ocr', 'sidecar timeout', 'TIMEOUT');

        const failures = listScanFailures('ocr');
        const found = failures.find((r) => r.download_id === id);
        expect(found).toBeTruthy();
        expect(found.last_error_code).toBe('TIMEOUT');
        expect(found.file_name).toBe('fail.jpg');
    });

    it('listScanFailures returns empty array when no failures', () => {
        const result = listScanFailures('seekbar');
        expect(Array.isArray(result)).toBe(true);
    });
});
