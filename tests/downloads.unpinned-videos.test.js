// Verifies getUnpinnedVideoIds() selects exactly the rows the "delete
// unpinned videos" settings button is meant to remove: unconditional —
// every non-pinned, non-soft-deleted video, including ones already
// cache-evicted (cloud-only, no local file).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-unpinned-videos-test-'));

let db;
let getUnpinnedVideoIds, softDeleteDownloads, setDownloadPinned, setDownloadEvicted;

function insertRow(overrides = {}) {
    const id = db
        .prepare(
            `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status)
             VALUES (?, ?, ?, ?, ?, 'completed')`,
        )
        .run(
            overrides.group_id ?? 'grp1',
            overrides.message_id ?? Math.floor(Math.random() * 1e9),
            overrides.file_type ?? 'video',
            overrides.file_path ?? '/data/downloads/v.mp4',
            overrides.file_name ?? 'v.mp4',
        ).lastInsertRowid;
    return Number(id);
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    ({ getUnpinnedVideoIds, softDeleteDownloads, setDownloadPinned, setDownloadEvicted } =
        await import('../src/core/db/downloads.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('getUnpinnedVideoIds', () => {
    it('includes an unpinned video', () => {
        const id = insertRow({ message_id: 2001 });
        expect(getUnpinnedVideoIds()).toContain(id);
    });

    it('excludes a pinned video', () => {
        const id = insertRow({ message_id: 2002 });
        setDownloadPinned(id, true);
        expect(getUnpinnedVideoIds()).not.toContain(id);
    });

    it('excludes a soft-deleted unpinned video', () => {
        const id = insertRow({ message_id: 2003 });
        softDeleteDownloads([id]);
        expect(getUnpinnedVideoIds()).not.toContain(id);
    });

    it('excludes non-video file types', () => {
        const id = insertRow({ message_id: 2004, file_type: 'photo', file_name: 'p.jpg' });
        expect(getUnpinnedVideoIds()).not.toContain(id);
    });

    it('includes an already cache-evicted unpinned video (unconditional delete)', () => {
        const id = insertRow({ message_id: 2005 });
        setDownloadEvicted(id);
        expect(getUnpinnedVideoIds()).toContain(id);
    });
});
