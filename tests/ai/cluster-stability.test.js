// persistFaceClusters — stable person identity across re-cluster passes.
//
// The legacy persist path wiped `people` and re-inserted every cluster,
// so person IDs changed on every pass. With auto-cluster firing after
// each drip-indexed batch, any UI snapshot went stale within minutes:
// clicking a person tile hit a deleted ID → "No photos in this cluster."
//
// Contract: a new cluster whose centroid lies within matchEps of an
// existing person's centroid REUSES that person row (same id, label
// kept, centroid/face_count refreshed). Unmatched clusters insert new
// rows; people no longer backed by any cluster are deleted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-stability-'));

let db;
let persistFaceClusters, renamePerson, listPeople;

function centroid(vals) {
    return Float32Array.from(vals);
}

let _seq = 0;
function insertFace() {
    _seq += 1;
    const dl = db
        .prepare(
            `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status)
             VALUES ('grp1', ?, 'photo', ?, ?, 'completed')`,
        )
        .run(500000 + _seq, `/data/downloads/images/c${_seq}.jpg`, `c${_seq}.jpg`).lastInsertRowid;
    const face = db
        .prepare(
            `INSERT INTO faces (download_id, x, y, w, h, embedding)
             VALUES (?, 10, 10, 50, 50, ?)`,
        )
        .run(Number(dl), Buffer.from(new Float32Array([0, 0]).buffer)).lastInsertRowid;
    return Number(face);
}

function peopleRows() {
    return db.prepare('SELECT id, label, face_count FROM people ORDER BY id').all();
}

function personOfFace(faceId) {
    return db.prepare('SELECT person_id FROM faces WHERE id = ?').get(faceId)?.person_id ?? null;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../../src/core/db.js');
    db = dbMod.getDb();
    ({ persistFaceClusters, renamePerson, listPeople } = await import(
        '../../src/core/db/faces.js'
    ));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('persistFaceClusters', () => {
    it('keeps person ids and labels stable when centroids match across passes', () => {
        const fA1 = insertFace();
        const fA2 = insertFace();
        const fB1 = insertFace();

        const pass1 = persistFaceClusters(
            [
                { centroid: centroid([1, 0]), faceCount: 2, memberFaceIds: [fA1, fA2] },
                { centroid: centroid([0, 1]), faceCount: 1, memberFaceIds: [fB1] },
            ],
            { matchEps: 0.5 },
        );
        expect(pass1.inserted).toBe(2);
        const [pA, pB] = peopleRows();
        expect(personOfFace(fA1)).toBe(pA.id);
        expect(personOfFace(fB1)).toBe(pB.id);

        renamePerson(pA.id, 'Alice');

        // Second pass: same clusters, slightly moved centroids (< matchEps).
        const pass2 = persistFaceClusters(
            [
                { centroid: centroid([0.9, 0.1]), faceCount: 2, memberFaceIds: [fA1, fA2] },
                { centroid: centroid([0.1, 0.9]), faceCount: 1, memberFaceIds: [fB1] },
            ],
            { matchEps: 0.5 },
        );
        expect(pass2.reused).toBe(2);
        expect(pass2.inserted).toBe(0);

        const after = peopleRows();
        expect(after.map((p) => p.id)).toEqual([pA.id, pB.id]); // ids survived
        expect(after.find((p) => p.id === pA.id).label).toBe('Alice'); // label survived
        expect(personOfFace(fA1)).toBe(pA.id);
    });

    it('deletes people no longer backed by a cluster and inserts new ones', () => {
        const before = peopleRows();
        const pB = before[1];
        const fNew = insertFace();

        // Cluster B disappears; a brand-new far-away cluster shows up.
        const r = persistFaceClusters(
            [
                { centroid: centroid([1, 0]), faceCount: 2, memberFaceIds: [] },
                { centroid: centroid([-5, -5]), faceCount: 1, memberFaceIds: [fNew] },
            ],
            { matchEps: 0.5 },
        );
        expect(r.reused).toBe(1);
        expect(r.inserted).toBe(1);
        expect(r.deleted).toBe(1);

        const ids = peopleRows().map((p) => p.id);
        expect(ids).not.toContain(pB.id);
        expect(listPeople().total).toBe(2);
    });

    it('never assigns two clusters to the same existing person', () => {
        db.prepare('UPDATE faces SET person_id = NULL').run();
        db.prepare('DELETE FROM people').run();
        const f1 = insertFace();
        const f2 = insertFace();

        persistFaceClusters([{ centroid: centroid([2, 2]), faceCount: 1, memberFaceIds: [f1] }], {
            matchEps: 1.0,
        });
        const [only] = peopleRows();

        // Two new clusters both near the single existing person — only one
        // may reuse its id, the other must insert.
        const r = persistFaceClusters(
            [
                { centroid: centroid([2.1, 2.1]), faceCount: 1, memberFaceIds: [f1] },
                { centroid: centroid([1.9, 1.9]), faceCount: 1, memberFaceIds: [f2] },
            ],
            { matchEps: 1.0 },
        );
        expect(r.reused).toBe(1);
        expect(r.inserted).toBe(1);
        const rows = peopleRows();
        expect(rows).toHaveLength(2);
        expect(rows.map((p) => p.id)).toContain(only.id);
    });
});
