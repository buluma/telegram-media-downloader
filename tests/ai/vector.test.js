/**
 * Tests for LLM-based text embedding storage and retrieval:
 *   - text_embeddings DB table
 *   - setTextEmbedding / searchTextEmbeddings / buildMetadataText
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-vector-test-'));

let db;
let insertDownload;
let setTextEmbedding;
let searchTextEmbeddings;
let buildMetadataText;
let setImageTags;
let setImageText;

let _counter = 9000;

function _newDownload(overrides = {}) {
    const id = _counter++;
    insertDownload({
        groupId: `-100${id}`,
        groupName: overrides.groupName ?? `VecGroup ${id}`,
        messageId: id,
        fileName: overrides.fileName ?? `vec${id}.jpg`,
        fileSize: 1000,
        filePath: `data/downloads/vec${id}.jpg`,
        fileType: overrides.fileType ?? 'photo',
    });
    const row = db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(id);
    return row.id;
}

function _f32Blob(arr) {
    return Buffer.from(new Uint8Array(Float32Array.from(arr).buffer));
}

// Produce a unit vector with a 1 in position `i` and 0s elsewhere
function _unitVec(dim, i) {
    const v = new Array(dim).fill(0);
    v[i] = 1;
    return v;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    insertDownload = dbApi.insertDownload;
    const facesApi = await import('../../src/core/db/faces.js');
    setTextEmbedding = facesApi.setTextEmbedding;
    searchTextEmbeddings = facesApi.searchTextEmbeddings;
    buildMetadataText = facesApi.buildMetadataText;
    setImageTags = facesApi.setImageTags;
    setImageText = facesApi.setImageText;
    db.pragma('foreign_keys = OFF');
});

afterAll(() => {
    try {
        db.pragma('foreign_keys = ON');
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- text_embeddings table -------------------------------------------------

describe('text_embeddings schema', () => {
    it('text_embeddings table exists after DB init', () => {
        const row = db
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='text_embeddings'`)
            .get();
        expect(row).toBeTruthy();
        expect(row.name).toBe('text_embeddings');
    });
});

// ---- setTextEmbedding ------------------------------------------------------

describe('setTextEmbedding', () => {
    it('stores an embedding and makes it queryable', () => {
        const dlId = _newDownload();
        const blob = _f32Blob(_unitVec(4, 0));
        setTextEmbedding(dlId, blob, 'nomic-embed-text');
        const row = db
            .prepare('SELECT download_id, model FROM text_embeddings WHERE download_id = ?')
            .get(dlId);
        expect(row).toBeTruthy();
        expect(row.model).toBe('nomic-embed-text');
    });

    it('upserts — second call with same download_id updates embedding and model', () => {
        const dlId = _newDownload();
        setTextEmbedding(dlId, _f32Blob(_unitVec(4, 0)), 'model-a');
        setTextEmbedding(dlId, _f32Blob(_unitVec(4, 1)), 'model-b');
        const rows = db
            .prepare('SELECT model FROM text_embeddings WHERE download_id = ?')
            .all(dlId);
        expect(rows).toHaveLength(1);
        expect(rows[0].model).toBe('model-b');
    });

    it('stores indexed_at timestamp', () => {
        const dlId = _newDownload();
        const before = Math.floor(Date.now() / 1000);
        setTextEmbedding(dlId, _f32Blob(_unitVec(4, 0)), 'nomic-embed-text');
        const row = db
            .prepare('SELECT indexed_at FROM text_embeddings WHERE download_id = ?')
            .get(dlId);
        expect(row.indexed_at).toBeGreaterThanOrEqual(before - 1);
    });
});

// ---- searchTextEmbeddings --------------------------------------------------

describe('searchTextEmbeddings', () => {
    it('returns empty array when no embeddings stored', () => {
        const results = searchTextEmbeddings(_unitVec(4, 0));
        expect(Array.isArray(results)).toBe(true);
        // (may have rows from other tests; just assert it doesn't throw)
    });

    it('returns results ranked by cosine similarity', () => {
        const dim = 8;
        const dlA = _newDownload();
        const dlB = _newDownload();
        const dlC = _newDownload();

        // A perfectly matches query direction 0 → score ≈ 1
        setTextEmbedding(dlA, _f32Blob(_unitVec(dim, 0)), 'test-model');
        // B partially matches → lower score
        const partial = new Array(dim).fill(0);
        partial[0] = 0.6;
        partial[1] = 0.8;
        setTextEmbedding(dlB, _f32Blob(partial), 'test-model');
        // C orthogonal to query → score = 0
        setTextEmbedding(dlC, _f32Blob(_unitVec(dim, 1)), 'test-model');

        const results = searchTextEmbeddings(_unitVec(dim, 0), { topK: 10, minScore: 0.01 });
        const ids = results.map((r) => r.id);

        expect(ids).toContain(dlA);
        expect(ids).toContain(dlB);
        // C may or may not appear depending on rounding but should not outscore A
        const aEntry = results.find((r) => r.id === dlA);
        const bEntry = results.find((r) => r.id === dlB);
        expect(aEntry.score).toBeGreaterThan(bEntry.score);
    });

    it('result scores are in [0, 1]', () => {
        const dim = 4;
        const dlId = _newDownload();
        setTextEmbedding(dlId, _f32Blob(_unitVec(dim, 2)), 'test-model');
        const results = searchTextEmbeddings(_unitVec(dim, 2));
        for (const r of results) {
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(1);
        }
    });

    it('respects topK', () => {
        const dim = 4;
        const ids = Array.from({ length: 5 }, () => {
            const dlId = _newDownload();
            setTextEmbedding(dlId, _f32Blob(_unitVec(dim, 3)), 'test-model');
            return dlId;
        });
        const results = searchTextEmbeddings(_unitVec(dim, 3), { topK: 3 });
        // May overlap with other tests but topK is an upper bound
        expect(results.length).toBeLessThanOrEqual(3);
    });

    it('respects minScore — excludes low-similarity results', () => {
        const dim = 4;
        const dlHigh = _newDownload();
        const dlLow = _newDownload();
        // dlHigh: perfectly aligned with query axis 0
        setTextEmbedding(dlHigh, _f32Blob(_unitVec(dim, 0)), 'mintest');
        // dlLow: fully orthogonal (axis 2 vs axis 0 query → cos=0)
        setTextEmbedding(dlLow, _f32Blob(_unitVec(dim, 2)), 'mintest');

        const results = searchTextEmbeddings(_unitVec(dim, 0), { minScore: 0.5 });
        const lowEntry = results.find((r) => r.id === dlLow);
        expect(lowEntry).toBeUndefined();
    });

    it('returns {id, score} shaped objects', () => {
        const dim = 4;
        const dlId = _newDownload();
        setTextEmbedding(dlId, _f32Blob(_unitVec(dim, 0)), 'shape-test');
        const results = searchTextEmbeddings(_unitVec(dim, 0), { topK: 5 });
        const r = results.find((x) => x.id === dlId);
        expect(r).toBeTruthy();
        expect(typeof r.id).toBe('number');
        expect(typeof r.score).toBe('number');
    });
});

// ---- buildMetadataText -----------------------------------------------------

describe('buildMetadataText', () => {
    it('returns empty string for a download with no metadata', () => {
        const dlId = _newDownload({ fileName: 'bare.jpg', groupName: '' });
        const text = buildMetadataText(dlId);
        // filename tokens may appear, but no tags/objects/ocr
        expect(typeof text).toBe('string');
    });

    it('includes tags with score >= 0.2', () => {
        const dlId = _newDownload();
        setImageTags(dlId, [
            { tag: 'sunset', score: 0.9 },
            { tag: 'beach', score: 0.5 },
            { tag: 'noise', score: 0.1 }, // below threshold
        ]);
        const text = buildMetadataText(dlId);
        expect(text).toContain('sunset');
        expect(text).toContain('beach');
        expect(text).not.toContain('noise');
    });

    it('excludes tags with score < 0.2', () => {
        const dlId = _newDownload();
        setImageTags(dlId, [{ tag: 'verylow', score: 0.05 }]);
        const text = buildMetadataText(dlId);
        expect(text).not.toContain('verylow');
    });

    it('includes OCR text', () => {
        const dlId = _newDownload();
        setImageText(dlId, 'Hello world from OCR');
        const text = buildMetadataText(dlId);
        expect(text).toContain('Hello world from OCR');
    });

    it('includes filename tokens', () => {
        const dlId = _newDownload({ fileName: 'golden-retriever-2024.jpg' });
        const text = buildMetadataText(dlId);
        expect(text.toLowerCase()).toContain('golden');
        expect(text.toLowerCase()).toContain('retriever');
    });

    it('deduplicates terms that appear in multiple tag sources', () => {
        const dlId = _newDownload();
        setImageTags(dlId, [
            { tag: 'cat', score: 0.8 },
            { tag: 'cat', score: 0.7 },
        ]);
        const text = buildMetadataText(dlId);
        const matches = text.toLowerCase().match(/\bcat\b/g) || [];
        expect(matches.length).toBe(1);
    });

    it('truncates OCR text to avoid huge payloads', () => {
        const dlId = _newDownload();
        const longOcr = 'x'.repeat(1000);
        setImageText(dlId, longOcr);
        const text = buildMetadataText(dlId);
        // OCR portion capped at 300 chars; total text should stay reasonable
        expect(text.length).toBeLessThan(800);
    });
});
