// Verifies the extra gallery sorts (size_asc, duration_asc, name_desc,
// viewed_desc, crosspost_desc) order identically across the four list
// queries, and that rows with no value for the sort key sink to the end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-sort-orders-test-'));

let db;
let getAllDownloads, getDownloads, getAllDownloadsFederated, getDownloadsForGroupFederated;
let A, B, C, D, E;

function insertRow(groupId, messageId, r) {
    return Number(
        db
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, file_size,
                                        file_hash, status, duration_sec, last_viewed_at)
                 VALUES (?, ?, ?, 'x', ?, ?, ?, 'completed', ?, ?)`,
            )
            .run(
                groupId,
                messageId,
                r.type ?? 'video',
                r.name,
                r.size ?? null,
                r.hash ?? null,
                r.duration ?? null,
                r.viewed ?? null,
            ).lastInsertRowid,
    );
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = (await import('../src/core/db.js')).getDb();
    ({ getAllDownloads, getDownloads, getAllDownloadsFederated, getDownloadsForGroupFederated } =
        await import('../src/core/db/downloads.js'));
    // g1 holds A-D; E lives in g2 and shares A's hash, so both count as cross-posted.
    A = insertRow('g1', 1, { name: 'b.mp4', size: 300, duration: 60, hash: 'H', viewed: 1000 });
    B = insertRow('g1', 2, { name: 'a.mp4', size: 100, duration: 10 });
    C = insertRow('g1', 3, { name: 'c.jpg', type: 'photo', viewed: 3000 });
    D = insertRow('g1', 4, { name: 'd.mp4', size: 200, duration: 30, viewed: 500 });
    E = insertRow('g2', 5, { name: 'e.mp4', size: 50, duration: 45, hash: 'H' });
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// Expected order across the whole library. Ties and value-less rows fall
// back to id DESC.
const expectedAll = () => ({
    size_asc: [E, B, D, A, C],
    duration_asc: [B, D, E, A, C],
    duration_desc: [A, E, D, B, C],
    name_desc: [E, D, C, A, B],
    viewed_desc: [C, A, D, E, B],
    crosspost_desc: [E, A, D, C, B],
});

const ids = (res) => res.files.map((f) => f.id);

describe.each(Object.keys(expectedAll()))('sort %s', (sortBy) => {
    const g1Only = (list) => list.filter((id) => [A, B, C, D].includes(id));

    it('getAllDownloads', () => {
        expect(ids(getAllDownloads(50, 0, 'all', { sortBy }))).toEqual(expectedAll()[sortBy]);
    });

    it('getDownloads (single group)', () => {
        expect(ids(getDownloads('g1', 50, 0, 'all', { sortBy }))).toEqual(
            g1Only(expectedAll()[sortBy]),
        );
    });

    it('getAllDownloadsFederated', () => {
        expect(ids(getAllDownloadsFederated(50, 0, 'all', { sortBy, include: 'peers' }))).toEqual(
            expectedAll()[sortBy],
        );
    });

    it('getDownloadsForGroupFederated', () => {
        expect(
            ids(getDownloadsForGroupFederated('g1', 50, 0, 'all', { sortBy, include: 'peers' })),
        ).toEqual(g1Only(expectedAll()[sortBy]));
    });

    it('keeps pinned rows on top when pinnedFirst is set', () => {
        db.prepare('UPDATE downloads SET pinned = 1 WHERE id = ?').run(B);
        try {
            const got = ids(getAllDownloads(50, 0, 'all', { sortBy, pinnedFirst: true }));
            expect(got).toEqual([B, ...expectedAll()[sortBy].filter((id) => id !== B)]);
        } finally {
            db.prepare('UPDATE downloads SET pinned = 0 WHERE id = ?').run(B);
        }
    });
});
