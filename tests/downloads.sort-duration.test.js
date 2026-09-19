// Verifies the `duration_desc` sort ("Longest first") orders by the
// COALESCE(seekbar duration, downloads.duration_sec) value the tiles show,
// with rows lacking a duration (photos, unprobed videos) sinking to the end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-sort-duration-test-'));

let db;
let getAllDownloads, getDownloads, getAllDownloadsFederated;
let ids;

function insertRow({ message_id, file_type = 'video', duration = null }) {
    return Number(
        db
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status, duration_sec)
                 VALUES ('grp-dur', ?, ?, '/data/downloads/x', 'x', 'completed', ?)`,
            )
            .run(message_id, file_type, duration).lastInsertRowid,
    );
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    ({ getAllDownloads, getDownloads, getAllDownloadsFederated } = await import(
        '../src/core/db/downloads.js'
    ));
    const short = insertRow({ message_id: 1, duration: 30 });
    const long = insertRow({ message_id: 2, duration: 600 });
    const photo = insertRow({ message_id: 3, file_type: 'photo' });
    // Seekbar-probed duration wins over the column value.
    const sprite = insertRow({ message_id: 4, duration: 10 });
    db.prepare(
        `INSERT INTO seekbar_sprites (download_id, sprite_path, meta_path, duration_sec, generated_at)
         VALUES (?, 's', 'm', 3600, 0)`,
    ).run(sprite);
    ids = { short, long, photo, sprite };
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const order = (res) => res.files.map((f) => f.id);

describe('duration_desc sort', () => {
    it('getAllDownloads puts the longest video first and durationless rows last', () => {
        const res = getAllDownloads(50, 0, 'all', { sortBy: 'duration_desc' });
        expect(order(res)).toEqual([ids.sprite, ids.long, ids.short, ids.photo]);
    });

    it('getDownloads orders the same way within a group', () => {
        const res = getDownloads('grp-dur', 50, 0, 'all', { sortBy: 'duration_desc' });
        expect(order(res)).toEqual([ids.sprite, ids.long, ids.short, ids.photo]);
    });

    it('getAllDownloadsFederated orders the same way when peers are included', () => {
        const res = getAllDownloadsFederated(50, 0, 'all', {
            sortBy: 'duration_desc',
            include: 'peers',
        });
        expect(order(res)).toEqual([ids.sprite, ids.long, ids.short, ids.photo]);
    });
});
