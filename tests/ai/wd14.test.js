/**
 * Tests for WD14 tagger infrastructure:
 *   - image_tags_wd14 DB table
 *   - setWd14Tags / clearWd14Tags / getUnscannedWd14Batch / countUnscannedWd14
 *   - resetAllAiData includes wd14 table
 *   - getAiCounts includes withWd14Tags
 *   - search._matchTags queries image_tags_wd14
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-wd14-test-'));

let db;
let insertDownload;
let setWd14Tags;
let clearWd14Tags;
let getUnscannedWd14Batch;
let countUnscannedWd14;
let resetAllAiData;
let getAiCounts;
let setImageTags; // CLIP tags
let crossModalSearch;

let _counter = 7000;

function _newDownload(overrides = {}) {
    const id = _counter++;
    insertDownload({
        groupId: `-100${id}`,
        groupName: overrides.groupName ?? `WD14Group ${id}`,
        messageId: id,
        fileName: overrides.fileName ?? `wd14_${id}.jpg`,
        fileSize: 1000,
        filePath: `data/downloads/wd14_${id}.jpg`,
        fileType: overrides.fileType ?? 'photo',
    });
    const row = db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(id);
    return row.id;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    insertDownload = dbApi.insertDownload;
    const facesApi = await import('../../src/core/db/faces.js');
    setWd14Tags = facesApi.setWd14Tags;
    clearWd14Tags = facesApi.clearWd14Tags;
    getUnscannedWd14Batch = facesApi.getUnscannedWd14Batch;
    countUnscannedWd14 = facesApi.countUnscannedWd14;
    resetAllAiData = facesApi.resetAllAiData;
    getAiCounts = facesApi.getAiCounts;
    setImageTags = facesApi.setImageTags;
    const searchApi = await import('../../src/core/ai/search.js');
    crossModalSearch = searchApi.crossModalSearch;
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

// ---- image_tags_wd14 schema ------------------------------------------------

describe('image_tags_wd14 schema', () => {
    it('table exists after DB init', () => {
        const row = db
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='image_tags_wd14'`)
            .get();
        expect(row?.name).toBe('image_tags_wd14');
    });
});

// ---- setWd14Tags -----------------------------------------------------------

describe('setWd14Tags', () => {
    it('stores tags and makes them queryable', () => {
        const dlId = _newDownload();
        setWd14Tags(dlId, [
            { tag: '1girl', score: 0.99 },
            { tag: 'nude', score: 0.95 },
        ]);
        const rows = db
            .prepare(
                'SELECT tag, score FROM image_tags_wd14 WHERE download_id = ? ORDER BY score DESC',
            )
            .all(dlId);
        expect(rows).toHaveLength(2);
        expect(rows[0].tag).toBe('1girl');
        expect(rows[1].tag).toBe('nude');
    });

    it('upserts — calling again replaces existing tags', () => {
        const dlId = _newDownload();
        setWd14Tags(dlId, [{ tag: 'old_tag', score: 0.8 }]);
        setWd14Tags(dlId, [{ tag: 'new_tag', score: 0.9 }]);
        const rows = db.prepare('SELECT tag FROM image_tags_wd14 WHERE download_id = ?').all(dlId);
        const tags = rows.map((r) => r.tag);
        expect(tags).not.toContain('old_tag');
        expect(tags).toContain('new_tag');
    });

    it('accepts empty array and writes sentinel', () => {
        const dlId = _newDownload();
        setWd14Tags(dlId, []);
        const rows = db.prepare('SELECT tag FROM image_tags_wd14 WHERE download_id = ?').all(dlId);
        expect(rows.length).toBeGreaterThan(0); // sentinel present
        expect(rows[0].tag).toBe('_wd14_scanned_');
    });

    it('scores are stored correctly', () => {
        const dlId = _newDownload();
        setWd14Tags(dlId, [{ tag: 'sunset', score: 0.73 }]);
        const row = db
            .prepare('SELECT score FROM image_tags_wd14 WHERE download_id = ? AND tag = ?')
            .get(dlId, 'sunset');
        expect(row?.score).toBeCloseTo(0.73, 2);
    });
});

// ---- clearWd14Tags ---------------------------------------------------------

describe('clearWd14Tags', () => {
    it('removes all tags for a download', () => {
        const dlId = _newDownload();
        setWd14Tags(dlId, [{ tag: 'beach', score: 0.9 }]);
        clearWd14Tags(dlId);
        const rows = db.prepare('SELECT tag FROM image_tags_wd14 WHERE download_id = ?').all(dlId);
        expect(rows).toHaveLength(0);
    });

    it('no-op for download with no tags', () => {
        const dlId = _newDownload();
        expect(() => clearWd14Tags(dlId)).not.toThrow();
    });
});

// ---- getUnscannedWd14Batch / countUnscannedWd14 ----------------------------

describe('getUnscannedWd14Batch', () => {
    it('returns downloads with no WD14 tags', () => {
        const dlId = _newDownload({ fileType: 'photo' });
        const batch = getUnscannedWd14Batch({ fileTypes: ['photo'], limit: 100 });
        const ids = batch.map((r) => r.id);
        expect(ids).toContain(dlId);
    });

    it('excludes downloads that already have WD14 tags', () => {
        const dlId = _newDownload({ fileType: 'photo' });
        setWd14Tags(dlId, [{ tag: 'dog', score: 0.9 }]);
        const batch = getUnscannedWd14Batch({ fileTypes: ['photo'], limit: 100 });
        const ids = batch.map((r) => r.id);
        expect(ids).not.toContain(dlId);
    });

    it('excludes downloads that have been scanned with empty result (sentinel)', () => {
        const dlId = _newDownload({ fileType: 'photo' });
        setWd14Tags(dlId, []); // writes sentinel
        const batch = getUnscannedWd14Batch({ fileTypes: ['photo'], limit: 100 });
        const ids = batch.map((r) => r.id);
        expect(ids).not.toContain(dlId);
    });

    it('filters by fileType', () => {
        const photoId = _newDownload({ fileType: 'photo' });
        const videoId = _newDownload({ fileType: 'video' });
        const batch = getUnscannedWd14Batch({ fileTypes: ['photo'], limit: 100 });
        const ids = batch.map((r) => r.id);
        expect(ids).toContain(photoId);
        expect(ids).not.toContain(videoId);
    });

    it('respects limit', () => {
        // create several unscanned
        for (let i = 0; i < 5; i++) _newDownload({ fileType: 'photo' });
        const batch = getUnscannedWd14Batch({ fileTypes: ['photo'], limit: 2 });
        expect(batch.length).toBeLessThanOrEqual(2);
    });
});

describe('countUnscannedWd14', () => {
    it('returns a non-negative number', () => {
        const count = countUnscannedWd14({ fileTypes: ['photo'] });
        expect(count).toBeGreaterThanOrEqual(0);
    });

    it('decreases after tagging', () => {
        const dlId = _newDownload({ fileType: 'photo' });
        const before = countUnscannedWd14({ fileTypes: ['photo'] });
        setWd14Tags(dlId, [{ tag: 'cat', score: 0.8 }]);
        const after = countUnscannedWd14({ fileTypes: ['photo'] });
        expect(after).toBeLessThan(before);
    });
});

// ---- resetAllAiData --------------------------------------------------------

describe('resetAllAiData', () => {
    it('clears image_tags_wd14', () => {
        const dlId = _newDownload();
        setWd14Tags(dlId, [{ tag: 'test_reset', score: 0.9 }]);
        const result = resetAllAiData();
        expect(result).toHaveProperty('wd14Tags');
        const rows = db.prepare('SELECT COUNT(*) AS n FROM image_tags_wd14').get();
        expect(rows.n).toBe(0);
    });
});

// ---- getAiCounts -----------------------------------------------------------

describe('getAiCounts', () => {
    it('includes withWd14Tags count', () => {
        const counts = getAiCounts({ fileTypes: ['photo'] });
        expect(counts).toHaveProperty('withWd14Tags');
        expect(typeof counts.withWd14Tags).toBe('number');
    });

    it('withWd14Tags increases after tagging', () => {
        const before = getAiCounts({ fileTypes: ['photo'] }).withWd14Tags;
        const dlId = _newDownload({ fileType: 'photo' });
        setWd14Tags(dlId, [{ tag: 'lion', score: 0.95 }]);
        const after = getAiCounts({ fileTypes: ['photo'] }).withWd14Tags;
        expect(after).toBeGreaterThan(before);
    });
});

// ---- search: _matchTags queries both tables --------------------------------

describe('crossModalSearch — WD14 tags in search', () => {
    const searchOpts = { skipSemantic: true };

    it('finds downloads tagged by WD14 (not in CLIP table)', async () => {
        const dlId = _newDownload();
        // Only in WD14 table, not CLIP
        setWd14Tags(dlId, [{ tag: 'explicit_content_test_tag_xyz', score: 0.95 }]);

        const r = await crossModalSearch('explicit_content_test_tag_xyz', searchOpts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(dlId);
    });

    it('finds downloads tagged by CLIP (not in WD14 table)', async () => {
        const dlId = _newDownload();
        setImageTags(dlId, [{ tag: 'clip_unique_tag_abc', score: 0.9 }]);

        const r = await crossModalSearch('clip_unique_tag_abc', searchOpts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(dlId);
    });

    it('download tagged by both tables returns at most one result', async () => {
        const dlId = _newDownload();
        setImageTags(dlId, [{ tag: 'shared_tag_dup', score: 0.8 }]);
        setWd14Tags(dlId, [{ tag: 'shared_tag_dup', score: 0.9 }]);

        const r = await crossModalSearch('shared_tag_dup', searchOpts);
        const matches = r.results.filter((x) => x.id === dlId);
        expect(matches).toHaveLength(1);
    });

    it('WD14 sentinel tag _wd14_scanned_ does not appear in search results', async () => {
        // Use neutral filename + groupName so neither matches the query tokens
        // ['wd14','scanned']: the default 'wd14_N.jpg' / 'WD14Group N' would hit
        // 'wd14' via the filename modality and produce a false positive.
        const dlId = _newDownload({ fileName: 'photo_test.jpg', groupName: 'PhotoGroup' });
        setWd14Tags(dlId, []); // writes sentinel only

        const r = await crossModalSearch('_wd14_scanned_', searchOpts);
        // sentinel should be invisible — either tag score too low or excluded
        const ids = r.results.map((x) => x.id);
        expect(ids).not.toContain(dlId);
    });
});
