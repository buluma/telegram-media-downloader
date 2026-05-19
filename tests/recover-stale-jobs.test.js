// Tests for recoverStaleJobs (src/core/ai/jobs.js).
// Uses an isolated temp DB so the real data/db.sqlite is never touched.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-stale-jobs-'));

let dbApi;
let db;
let jobs;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    jobs = await import('../src/core/ai/jobs.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    db.exec('DELETE FROM maintenance_jobs');
    db.exec('DELETE FROM media_scan_state');
});

describe('recoverStaleJobs', () => {
    it('resets stale maintenance_jobs rows to failed', () => {
        const staleTs = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
        db.prepare(
            "INSERT INTO maintenance_jobs (id, type, feature, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        ).run('stale-job-1', 'scan', 'faces', staleTs);

        const result = jobs.recoverStaleJobs(db);
        expect(result.jobs).toBe(1);

        const row = db.prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get('stale-job-1');
        expect(row.status).toBe('failed');
        expect(row.error).toContain('recovered');
        expect(row.finished_at).toBeGreaterThan(0);
    });

    it('resets stale media_scan_state locks to failed', () => {
        const staleTs = Date.now() - 2 * 60 * 60 * 1000;
        // Insert a download row first (FK constraint)
        db.prepare("INSERT INTO downloads (group_id, message_id) VALUES ('g1', 1)").run();
        const dlId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

        db.prepare(
            "INSERT INTO media_scan_state (download_id, scanner, status, locked_by, locked_at, updated_at) VALUES (?, 'faces', 'processing', 'old-lock', ?, ?)",
        ).run(dlId, staleTs, staleTs);

        const result = jobs.recoverStaleJobs(db);
        expect(result.locks).toBe(1);

        const row = db.prepare('SELECT * FROM media_scan_state WHERE download_id = ?').get(dlId);
        expect(row.status).toBe('failed');
        expect(row.last_error).toContain('recovered');
    });

    it('does not touch recent running jobs', () => {
        const recentTs = Date.now() - 60 * 1000; // 1 minute ago
        db.prepare(
            "INSERT INTO maintenance_jobs (id, type, feature, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        ).run('fresh-job', 'scan', 'wd14', recentTs);

        const result = jobs.recoverStaleJobs(db);
        expect(result.jobs).toBe(0);

        const row = db.prepare('SELECT status FROM maintenance_jobs WHERE id = ?').get('fresh-job');
        expect(row.status).toBe('running');
    });

    it('respects custom staleAfterMs threshold', () => {
        const ts = Date.now() - 10 * 60 * 1000; // 10 minutes ago
        db.prepare(
            "INSERT INTO maintenance_jobs (id, type, feature, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        ).run('medium-job', 'scan', 'ocr', ts);

        // With default 30-minute threshold: not stale
        const r1 = jobs.recoverStaleJobs(db, { staleAfterMs: 30 * 60 * 1000 });
        expect(r1.jobs).toBe(0);

        // With 5-minute threshold: stale
        const r2 = jobs.recoverStaleJobs(db, { staleAfterMs: 5 * 60 * 1000 });
        expect(r2.jobs).toBe(1);
    });

    it('returns zero counts when nothing is stale', () => {
        const result = jobs.recoverStaleJobs(db);
        expect(result.jobs).toBe(0);
        expect(result.locks).toBe(0);
    });
});
