import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-tag-merge-test-'));

let db;
let mergeTags;
let setImageTags;
let insertDownload;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    insertDownload = dbApi.insertDownload;
    const facesApi = await import('../../src/core/db/faces.js');
    mergeTags = facesApi.mergeTags;
    setImageTags = facesApi.setImageTags;
    db.pragma('foreign_keys = OFF');
});

let _downloadCounter = 5000;

function _createDownload() {
    const id = _downloadCounter++;
    insertDownload({
        groupId: `-100${id}`,
        groupName: `Test Group ${id}`,
        messageId: id,
        fileName: `test${id}.jpg`,
        fileSize: 1000,
        filePath: `data/downloads/test${id}.jpg`,
        fileType: 'photo',
        createdAt: Math.floor(Date.now() / 1000),
    });
    return id;
}

function _tagsFor(downloadId) {
    return db
        .prepare('SELECT tag FROM image_tags WHERE download_id = ? ORDER BY tag')
        .all(downloadId)
        .map((r) => r.tag);
}

afterAll(() => {
    try {
        db.pragma('foreign_keys = ON');
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('mergeTags', () => {
    it('renames the tag on downloads that only have the source tag', () => {
        const id = _createDownload();
        setImageTags(id, [{ tag: 'kitten', score: 0.9 }]);

        const changed = mergeTags('kitten', 'cat');

        expect(changed).toBe(1);
        expect(_tagsFor(id)).toEqual(['cat']);
    });

    it('drops the source tag row instead of colliding when both tags are present', () => {
        const id = _createDownload();
        setImageTags(id, [
            { tag: 'kitten', score: 0.9 },
            { tag: 'cat', score: 0.5 },
        ]);

        const changed = mergeTags('kitten', 'cat');

        // Merge itself renames 0 rows here (the only 'kitten' row was dropped
        // as a duplicate), but the download ends up with just 'cat'.
        expect(changed).toBe(0);
        expect(_tagsFor(id)).toEqual(['cat']);
    });

    it('only touches downloads carrying the source tag', () => {
        const id1 = _createDownload();
        const id2 = _createDownload();
        setImageTags(id1, [{ tag: 'kitten', score: 0.9 }]);
        setImageTags(id2, [{ tag: 'dog', score: 0.9 }]);

        mergeTags('kitten', 'cat');

        expect(_tagsFor(id1)).toEqual(['cat']);
        expect(_tagsFor(id2)).toEqual(['dog']);
    });

    it('throws when either tag is missing', () => {
        expect(() => mergeTags('', 'cat')).toThrow();
        expect(() => mergeTags('kitten', '')).toThrow();
    });

    it('throws when the two tags are the same', () => {
        expect(() => mergeTags('cat', 'cat')).toThrow();
    });
});
