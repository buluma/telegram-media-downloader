// Route-level tests for the shared tracked-scan path. /ai/faces/recluster
// and /ai/faces/reindex used to fire the scan-runner directly, bypassing
// the JobTracker + durable maintenance_jobs row + destructive-job conflict
// guard that /ai/scan/start applies. All three now go through the same
// _startTrackedScan helper.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-tracked-scan-'));

vi.mock('../../src/core/ai/index.js', () => ({
    startFacesScan: (_cfg, _onProgress, onDone) => {
        setTimeout(() => onDone?.({ scanned: 0, withFaces: 0 }), 10);
        return Promise.resolve({ started: true });
    },
    cancelScan: () => true,
    isScanRunning: () => false,
    getScanState: () => ({ running: false }),
    _bgQueueDepths: () => ({ realtime: 0, backfill: 0 }),
    pregenerateAi: () => {},
}));

let db;
let server;
let port;
let jobTrackers;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function post(p, body = {}) {
    const res = await fetch(apiUrl(p), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

async function waitForIdle(tracker, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!tracker.isRunning()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('tracker still running after timeout');
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../../src/core/db.js');
    db = dbMod.getDb();

    const { createJobTracker } = await import('../../src/core/job-tracker.js');
    const broadcast = () => {};
    const log = () => {};
    jobTrackers = {
        aiIndex: createJobTracker({ kind: 'aiIndex', broadcast, log, eventPrefix: 'ai_index' }),
        aiTags: createJobTracker({ kind: 'aiTags', broadcast, log, eventPrefix: 'ai_tags' }),
        aiOcr: createJobTracker({ kind: 'aiOcr', broadcast, log, eventPrefix: 'ai_ocr' }),
        aiPeople: createJobTracker({ kind: 'aiPeople', broadcast, log, eventPrefix: 'ai_people' }),
        aiWd14: createJobTracker({ kind: 'aiWd14', broadcast, log, eventPrefix: 'ai_wd14' }),
        dedupDelete: createJobTracker({
            kind: 'dedupDelete',
            broadcast,
            log,
            eventPrefix: 'dedup_delete',
        }),
    };

    const { createAiRouter } = await import('../../src/web/routes/ai.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createAiRouter({ broadcast, log, jobTrackers }));
    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// Hold the dedupDelete tracker "running" for the duration of fn().
async function withDestructiveJobRunning(fn) {
    let release;
    const gate = new Promise((r) => {
        release = r;
    });
    jobTrackers.dedupDelete.tryStart(() => gate);
    try {
        await fn();
    } finally {
        release();
        await waitForIdle(jobTrackers.dedupDelete);
    }
}

describe('POST /api/ai/faces/recluster', () => {
    it('runs under the aiPeople tracker with a durable job row', async () => {
        const r = await post('/api/ai/faces/recluster');
        expect(r.status).toBe(200);
        expect(r.body.started).toBe(true);

        await waitForIdle(jobTrackers.aiPeople);

        const { listJobs } = await import('../../src/core/ai/jobs.js');
        const jobs = listJobs({ feature: 'faces', status: 'completed', limit: 5 });
        expect(jobs.jobs.length).toBeGreaterThan(0);
    });

    it('409s while a destructive job is running', async () => {
        await withDestructiveJobRunning(async () => {
            const r = await post('/api/ai/faces/recluster');
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('RESOURCE_BUSY');
            expect(r.body.conflictingJob).toBe('dedupDelete');
        });
    });
});

describe('POST /api/ai/faces/reindex', () => {
    it('refuses to wipe while a destructive job is running', async () => {
        const { markScanFailed, getScanStateCounts } = await import(
            '../../src/core/db/scan-state.js'
        );
        const id = db
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status)
                 VALUES ('grp1', 300001, 'photo', '/data/downloads/images/x.jpg', 'x.jpg', 'completed')`,
            )
            .run().lastInsertRowid;
        markScanFailed(Number(id), 'faces', 'sidecar 500');

        await withDestructiveJobRunning(async () => {
            const r = await post('/api/ai/faces/reindex');
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('RESOURCE_BUSY');
        });
        // Nothing wiped by the refused call.
        expect(getScanStateCounts('faces').failed).toBe(1);
    });

    it('wipes faces scan-state and starts a tracked scan', async () => {
        const { getScanStateCounts } = await import('../../src/core/db/scan-state.js');

        const r = await post('/api/ai/faces/reindex');
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
        expect(r.body.scanStarted).toBe(true);

        expect(getScanStateCounts('faces').failed).toBe(0);

        await waitForIdle(jobTrackers.aiPeople);
        const { listJobs } = await import('../../src/core/ai/jobs.js');
        const jobs = listJobs({ feature: 'faces', status: 'completed', limit: 10 });
        expect(jobs.jobs.length).toBeGreaterThanOrEqual(2); // recluster + reindex
    });
});
