// Route-level tests for POST /api/ai/embeddings/reindex — the background
// embeddings re-index job. Contract under test:
//   - runs as a jobTrackers.aiIndex background job (endpoint returns
//     {started:true} immediately, 409 while already running)
//   - loops batches until EVERY eligible row is embedded (the legacy
//     handler stopped after one batch because `remaining` was computed
//     from the batch instead of the table)
//   - soft-deleted rows (deleted_at IS NOT NULL) are never embedded
//   - per-row embed failures land in media_scan_state (scanner='embed',
//     status='failed') and are excluded from subsequent runs
//   - 503 when no embedding provider is available

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-embed-reindex-'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---- mutable state shared with the vi.mock factory ------------------------
const embedCalls = [];
let embedShouldFail = () => false;
let embedDelayMs = 0;
let providerAvailable = true;

vi.mock('../../src/core/ai/faces-client.js', () => ({
    getSidecarUrl: () => null,
    getSidecarRoutingStatus: () => null,
    health: async () => ({ ok: false }),
    hasEmbeddingProvider: () => providerAvailable,
    embedImage: async (absPath) => {
        embedCalls.push(absPath);
        if (embedDelayMs) await new Promise((r) => setTimeout(r, embedDelayMs));
        if (embedShouldFail(absPath)) throw new Error('boom: embed failed');
        return { embedding: [0.1, 0.2, 0.3, 0.4], model: 'clip-test' };
    },
}));

let db;
let app;
let server;
let port;
let broadcasts;
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

let _seq = 0;
function insertPhoto({ deletedAt = null } = {}) {
    _seq += 1;
    const abs = path.join(MEDIA_DIR, `img${_seq}.jpg`);
    fs.writeFileSync(abs, 'not-a-real-jpeg');
    const id = db
        .prepare(
            `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status, deleted_at)
             VALUES (?, ?, 'photo', ?, ?, 'completed', ?)`,
        )
        .run('grp1', 100000 + _seq, abs, `img${_seq}.jpg`, deletedAt).lastInsertRowid;
    return { id: Number(id), abs };
}

// Wait until the aiIndex tracker finishes its current run.
async function waitForIdle(timeoutMs = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!jobTrackers.aiIndex.isRunning()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('aiIndex tracker still running after timeout');
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../../src/core/db.js');
    db = dbMod.getDb();

    const { createJobTracker } = await import('../../src/core/job-tracker.js');
    broadcasts = [];
    const broadcast = (m) => broadcasts.push(m);
    const log = () => {};
    jobTrackers = {
        aiIndex: createJobTracker({ kind: 'aiIndex', broadcast, log, eventPrefix: 'ai_index' }),
        aiTags: createJobTracker({ kind: 'aiTags', broadcast, log, eventPrefix: 'ai_tags' }),
        aiOcr: createJobTracker({ kind: 'aiOcr', broadcast, log, eventPrefix: 'ai_ocr' }),
        aiPeople: createJobTracker({ kind: 'aiPeople', broadcast, log, eventPrefix: 'ai_people' }),
        aiWd14: createJobTracker({ kind: 'aiWd14', broadcast, log, eventPrefix: 'ai_wd14' }),
    };

    const { createAiRouter } = await import('../../src/web/routes/ai.js');
    app = express();
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

describe('POST /api/ai/embeddings/reindex', () => {
    it('embeds EVERY missing row across multiple batches, not just the first', async () => {
        const rows = [];
        for (let i = 0; i < 12; i++) rows.push(insertPhoto());

        const r = await post('/api/ai/embeddings/reindex', { limit: 5 });
        expect(r.status).toBe(200);
        expect(r.body.started).toBe(true);

        await waitForIdle();

        const embedded = db.prepare('SELECT COUNT(*) AS n FROM image_embeddings').get().n;
        expect(embedded).toBe(12); // legacy handler stopped at `limit` rows

        // Tracker broadcast a done event.
        expect(broadcasts.some((m) => m?.type === 'ai_index_done')).toBe(true);

        // Durable job row completed.
        const { listJobs } = await import('../../src/core/ai/jobs.js');
        const jobs = listJobs({ feature: 'embed', status: 'completed', limit: 5 });
        expect(jobs.jobs.length).toBeGreaterThan(0);
    });

    it('never embeds soft-deleted rows', async () => {
        const dead = insertPhoto({ deletedAt: Date.now() });

        const r = await post('/api/ai/embeddings/reindex', { limit: 50 });
        expect(r.status).toBe(200);
        await waitForIdle();

        const row = db
            .prepare('SELECT COUNT(*) AS n FROM image_embeddings WHERE download_id = ?')
            .get(dead.id);
        expect(row.n).toBe(0);
        expect(embedCalls).not.toContain(dead.abs);
    });

    it('records per-row failures in media_scan_state and skips them next run', async () => {
        const bad = insertPhoto();
        embedShouldFail = (p) => p === bad.abs;

        await post('/api/ai/embeddings/reindex', { limit: 50 });
        await waitForIdle();

        const st = db
            .prepare(
                `SELECT status, last_error FROM media_scan_state
                  WHERE scanner = 'embed' AND download_id = ?`,
            )
            .get(bad.id);
        expect(st?.status).toBe('failed');
        expect(String(st.last_error)).toContain('boom');

        // Second run must not re-attempt the failed row.
        const callsBefore = embedCalls.filter((p) => p === bad.abs).length;
        await post('/api/ai/embeddings/reindex', { limit: 50 });
        await waitForIdle();
        const callsAfter = embedCalls.filter((p) => p === bad.abs).length;
        expect(callsAfter).toBe(callsBefore);

        embedShouldFail = () => false;
    });

    it('returns 409 while a re-index is already running', async () => {
        insertPhoto();
        embedDelayMs = 200;
        const first = await post('/api/ai/embeddings/reindex', { limit: 50 });
        expect(first.status).toBe(200);
        const second = await post('/api/ai/embeddings/reindex', { limit: 50 });
        expect(second.status).toBe(409);
        embedDelayMs = 0;
        await waitForIdle();
    });

    it('returns 503 when no embedding provider is available', async () => {
        providerAvailable = false;
        const r = await post('/api/ai/embeddings/reindex', {});
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('EMBEDDING_PROVIDER_OFFLINE');
        providerAvailable = true;
    });
});
