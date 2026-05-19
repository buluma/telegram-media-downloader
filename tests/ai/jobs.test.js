import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-jobs-test-'));

let createJob, updateJobProgress, finishJob, listJobs, getJob;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    await import('../../src/core/db.js');
    ({ createJob, updateJobProgress, finishJob, listJobs, getJob } = await import(
        '../../src/core/ai/jobs.js'
    ));
});

afterAll(() => {
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('maintenance_jobs durable model', () => {
    it('createJob inserts a running row and returns an id', () => {
        const id = createJob({ type: 'scan', feature: 'faces', total: 100 });
        expect(typeof id).toBe('string');
        expect(id.startsWith('faces_')).toBe(true);

        const row = getJob(id);
        expect(row).toBeTruthy();
        expect(row.status).toBe('running');
        expect(row.feature).toBe('faces');
        expect(row.total).toBe(100);
        expect(row.processed).toBe(0);
        expect(row.finished_at).toBeNull();
    });

    it('updateJobProgress updates processed/skipped/failed counters', () => {
        const id = createJob({ type: 'scan', feature: 'ocr', total: 50 });
        updateJobProgress(id, { processed: 20, skipped: 3, failed: 1 });

        const row = getJob(id);
        expect(row.processed).toBe(20);
        expect(row.skipped).toBe(3);
        expect(row.failed).toBe(1);
        expect(row.status).toBe('running');
    });

    it('finishJob sets status to completed and stamps finished_at', () => {
        const id = createJob({ type: 'scan', feature: 'wd14', total: 10 });
        const before = Date.now();
        finishJob(id, 'completed');
        const after = Date.now();

        const row = getJob(id);
        expect(row.status).toBe('completed');
        expect(row.finished_at).toBeGreaterThanOrEqual(before);
        expect(row.finished_at).toBeLessThanOrEqual(after);
        expect(row.error).toBeNull();
    });

    it('finishJob sets status to failed and records error', () => {
        const id = createJob({ type: 'scan', feature: 'faces', total: 5 });
        finishJob(id, 'failed', 'sidecar unreachable');

        const row = getJob(id);
        expect(row.status).toBe('failed');
        expect(row.error).toBe('sidecar unreachable');
        expect(row.finished_at).toBeTruthy();
    });

    it('listJobs returns all matching jobs ordered by started_at DESC', () => {
        const id1 = createJob({ type: 'scan', feature: 'wd14', total: 1 });
        const id2 = createJob({ type: 'scan', feature: 'wd14', total: 2 });

        const { jobs, total } = listJobs({ feature: 'wd14' });
        const ids = jobs.map((j) => j.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
        expect(total).toBeGreaterThanOrEqual(2);
        // Verify DESC order: each row's started_at >= the next
        for (let i = 0; i < jobs.length - 1; i++) {
            expect(jobs[i].started_at).toBeGreaterThanOrEqual(jobs[i + 1].started_at);
        }
    });

    it('updateJobProgress is a no-op for unknown job id', () => {
        expect(() => updateJobProgress('nonexistent_id', { processed: 5 })).not.toThrow();
    });

    it('finishJob is a no-op for unknown job id', () => {
        expect(() => finishJob('nonexistent_id', 'completed')).not.toThrow();
    });
});
