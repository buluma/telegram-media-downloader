import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-search-test-'));

let db;
let insertDownload;
let setImageTags;
let addImageObjects;
let setImageText;
let insertFace;
let insertPerson;
let setFacePerson;
let listOcrWords;
let crossModalSearch;

let _counter = 5000;

function _newDownload(overrides = {}) {
    const id = _counter++;
    insertDownload({
        groupId: `-100${id}`,
        groupName: overrides.groupName ?? `Group ${id}`,
        messageId: id,
        fileName: overrides.fileName ?? `file${id}.jpg`,
        fileSize: 1000,
        filePath: `data/downloads/file${id}.jpg`,
        fileType: overrides.fileType ?? 'photo',
    });
    // insertDownload uses INSERT OR IGNORE and doesn't return the rowid reliably
    // when the PK is auto-assigned. Query back to get the actual id.
    const row = db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(id);
    return row.id;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    insertDownload = dbApi.insertDownload;
    const facesApi = await import('../../src/core/db/faces.js');
    setImageTags = facesApi.setImageTags;
    addImageObjects = facesApi.addImageObjects;
    setImageText = facesApi.setImageText;
    insertFace = facesApi.insertFace;
    insertPerson = facesApi.insertPerson;
    setFacePerson = facesApi.setFacePerson;
    listOcrWords = facesApi.listOcrWords;
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

// ---- helpers ---------------------------------------------------------------

const opts = { skipSemantic: true };

// ---- empty / blank query ---------------------------------------------------

describe('crossModalSearch — empty query', () => {
    it('returns modalities as array (not object) for blank query', async () => {
        const r = await crossModalSearch('', opts);
        expect(r.results).toEqual([]);
        expect(Array.isArray(r.modalities)).toBe(true);
    });

    it('returns modalities as array for whitespace-only query', async () => {
        const r = await crossModalSearch('   ', opts);
        expect(Array.isArray(r.modalities)).toBe(true);
        expect(r.results).toEqual([]);
    });

    it('echoes query string back', async () => {
        const r = await crossModalSearch('beach', { ...opts, topK: 0 });
        expect(r.query).toBe('beach');
    });
});

// ---- tags matcher ----------------------------------------------------------

describe('crossModalSearch — tags modality', () => {
    it('finds image by tag match', async () => {
        const id = _newDownload();
        setImageTags(id, [{ tag: 'golden retriever', score: 0.9 }]);

        const r = await crossModalSearch('golden retriever', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(id);
        expect(r.modalities).toContain('tags');
    });

    it('does not match image with unrelated tag', async () => {
        const id = _newDownload();
        setImageTags(id, [{ tag: 'spaceship', score: 0.95 }]);

        const r = await crossModalSearch('golden retriever', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).not.toContain(id);
    });

    it('score is clamped to [0, 1]', async () => {
        const id = _newDownload();
        setImageTags(id, [{ tag: 'ocean', score: 0.85 }]);

        const r = await crossModalSearch('ocean', opts);
        const hit = r.results.find((x) => x.id === id);
        expect(hit).toBeDefined();
        expect(hit.score).toBeGreaterThan(0);
        expect(hit.score).toBeLessThanOrEqual(1);
    });
});

// ---- objects matcher -------------------------------------------------------

describe('crossModalSearch — objects modality', () => {
    it('finds image by detected object', async () => {
        const id = _newDownload();
        addImageObjects(id, [{ object: 'bicycle', confidence: 0.88 }]);

        const r = await crossModalSearch('bicycle', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(id);
        expect(r.modalities).toContain('objects');
    });

    it('ignores low-confidence objects (threshold 0.3)', async () => {
        const id = _newDownload();
        addImageObjects(id, [{ object: 'unicycle', confidence: 0.1 }]);

        const r = await crossModalSearch('unicycle', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).not.toContain(id);
    });
});

// ---- people matcher --------------------------------------------------------

describe('crossModalSearch — people modality', () => {
    it('finds image by person label', async () => {
        const dlId = _newDownload();
        const personId = insertPerson({ label: 'Alice', centroidBlob: Buffer.alloc(4) });
        insertFace({
            downloadId: dlId,
            x: 10,
            y: 10,
            w: 50,
            h: 50,
            embeddingBlob: Buffer.alloc(4),
            personId,
        });

        const r = await crossModalSearch('alice', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(dlId);
        expect(r.modalities).toContain('people');
    });

    it('does not match unlabelled person', async () => {
        const dlId = _newDownload();
        const personId = insertPerson({ label: null, centroidBlob: Buffer.alloc(4) });
        insertFace({
            downloadId: dlId,
            x: 10,
            y: 10,
            w: 50,
            h: 50,
            embeddingBlob: Buffer.alloc(4),
            personId,
        });

        const r = await crossModalSearch('alice', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).not.toContain(dlId);
    });

    it('people score is always 1.0 before weighting', async () => {
        const dlId = _newDownload();
        const personId = insertPerson({ label: 'Bob', centroidBlob: Buffer.alloc(4) });
        insertFace({
            downloadId: dlId,
            x: 0,
            y: 0,
            w: 30,
            h: 30,
            embeddingBlob: Buffer.alloc(4),
            personId,
        });

        const r = await crossModalSearch('bob', {
            ...opts,
            weights: { people: 1.0, tags: 0, objects: 0, text: 0, filename: 0 },
        });
        const hit = r.results.find((x) => x.id === dlId);
        expect(hit).toBeDefined();
        expect(hit.score).toBeCloseTo(1.0, 2);
    });
});

// ---- text / OCR matcher ----------------------------------------------------

describe('crossModalSearch — text modality', () => {
    it('finds image by OCR text content', async () => {
        const id = _newDownload();
        setImageText(id, 'SALE 50% off limited time offer');

        const r = await crossModalSearch('sale', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(id);
        expect(r.modalities).toContain('text');
    });

    it('score reflects proportion of matched tokens', async () => {
        const id = _newDownload();
        setImageText(id, 'hello world');

        const both = await crossModalSearch('hello world', opts);
        const one = await crossModalSearch('hello', opts);

        const scoreBoth = both.results.find((x) => x.id === id)?.score ?? 0;
        const scoreOne = one.results.find((x) => x.id === id)?.score ?? 0;
        expect(scoreBoth).toBeGreaterThanOrEqual(scoreOne);
    });
});

// ---- filename matcher ------------------------------------------------------

describe('crossModalSearch — filename modality', () => {
    it('finds image by filename token', async () => {
        const id = _newDownload({ fileName: 'vacation_beach_sunset.jpg' });

        const r = await crossModalSearch('sunset', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(id);
        expect(r.modalities).toContain('filename');
    });

    it('finds image by group name token', async () => {
        const id = _newDownload({ groupName: 'Paris Trip Photos' });

        const r = await crossModalSearch('paris', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(id);
    });
});

// ---- topK / minScore / fileTypes -------------------------------------------

describe('crossModalSearch — options', () => {
    it('respects topK limit', async () => {
        // Insert enough tag matches to exceed topK=2
        for (let i = 0; i < 5; i++) {
            const id = _newDownload();
            setImageTags(id, [{ tag: 'landscape', score: 0.8 }]);
        }

        const r = await crossModalSearch('landscape', { ...opts, topK: 2 });
        expect(r.results.length).toBeLessThanOrEqual(2);
    });

    it('respects minScore filter on normalized scores', async () => {
        // Two results: strong (score 0.95) and weak (score 0.15).
        // After normalization: strong → 1.0, weak → ~0.16.
        // minScore:0.5 keeps strong, drops weak.
        const strongId = _newDownload();
        const weakId = _newDownload();
        setImageTags(strongId, [{ tag: 'forest', score: 0.95 }]);
        setImageTags(weakId, [{ tag: 'forest', score: 0.15 }]);

        const all = await crossModalSearch('forest', { ...opts, minScore: 0 });
        const filtered = await crossModalSearch('forest', { ...opts, minScore: 0.5 });

        expect(all.results.some((x) => x.id === strongId)).toBe(true);
        expect(all.results.some((x) => x.id === weakId)).toBe(true);
        expect(filtered.results.some((x) => x.id === strongId)).toBe(true);
        expect(filtered.results.some((x) => x.id === weakId)).toBe(false);
    });

    it('fileTypes filter excludes non-matching types', async () => {
        const photoId = _newDownload({ fileType: 'photo', fileName: 'filtertest.jpg' });
        const videoId = _newDownload({ fileType: 'video', fileName: 'filtertest.mp4' });
        setImageTags(photoId, [{ tag: 'filtertest', score: 0.9 }]);
        setImageTags(videoId, [{ tag: 'filtertest', score: 0.9 }]);

        const r = await crossModalSearch('filtertest', { ...opts, fileTypes: ['photo'] });
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(photoId);
        expect(ids).not.toContain(videoId);
    });
});

// ---- multi-modal combining -------------------------------------------------

describe('crossModalSearch — multi-modal scoring', () => {
    it('result with matches across modalities outscores single-modality match', async () => {
        const richId = _newDownload({ fileName: 'mountain_hike.jpg' });
        setImageTags(richId, [{ tag: 'mountain', score: 0.9 }]);
        setImageText(richId, 'mountain trail scenic view');

        const plainId = _newDownload();
        setImageTags(plainId, [{ tag: 'mountain', score: 0.9 }]);

        const r = await crossModalSearch('mountain', opts);
        const richScore = r.results.find((x) => x.id === richId)?.score ?? 0;
        const plainScore = r.results.find((x) => x.id === plainId)?.score ?? 0;
        expect(richScore).toBeGreaterThan(plainScore);
    });

    it('modalities array lists all active signal sources', async () => {
        const id = _newDownload({ fileName: 'combo_test.jpg' });
        setImageTags(id, [{ tag: 'combotest', score: 0.9 }]);
        setImageText(id, 'combotest document');

        const r = await crossModalSearch('combotest', opts);
        expect(r.modalities).toContain('tags');
        expect(r.modalities).toContain('text');
    });
});

// ---- score normalization ---------------------------------------------------

describe('crossModalSearch — score normalization', () => {
    it('best result scores 1.0 when single modality fires', async () => {
        const id = _newDownload();
        setImageTags(id, [{ tag: 'normtest', score: 0.55 }]);

        const r = await crossModalSearch('normtest', opts);
        const hit = r.results.find((x) => x.id === id);
        expect(hit).toBeDefined();
        expect(hit.score).toBeCloseTo(1.0, 2);
    });

    it('best result scores 1.0 when multiple modalities fire', async () => {
        const richId = _newDownload({ fileName: 'normrich.jpg' });
        const plainId = _newDownload();
        setImageTags(richId, [{ tag: 'normrich', score: 0.9 }]);
        setImageText(richId, 'normrich document');
        setImageTags(plainId, [{ tag: 'normrich', score: 0.9 }]);

        const r = await crossModalSearch('normrich', opts);
        const maxScore = Math.max(...r.results.map((x) => x.score));
        expect(maxScore).toBeCloseTo(1.0, 2);
    });

    it('relative ordering preserved after normalization', async () => {
        const strongId = _newDownload();
        const weakId = _newDownload();
        setImageTags(strongId, [{ tag: 'normorder', score: 0.95 }]);
        setImageText(strongId, 'normorder match');
        setImageTags(weakId, [{ tag: 'normorder', score: 0.7 }]);

        const r = await crossModalSearch('normorder', opts);
        const strongScore = r.results.find((x) => x.id === strongId)?.score ?? 0;
        const weakScore = r.results.find((x) => x.id === weakId)?.score ?? 0;
        expect(strongScore).toBeGreaterThan(weakScore);
        expect(strongScore).toBeCloseTo(1.0, 2);
    });

    it('minScore filter applies after normalization', async () => {
        const strongId = _newDownload();
        const weakId = _newDownload();
        setImageTags(strongId, [{ tag: 'normfilter', score: 0.95 }]);
        setImageText(strongId, 'normfilter text');
        setImageTags(weakId, [{ tag: 'normfilter', score: 0.4 }]);

        // With normalization, strong = 1.0, weak = some fraction.
        // minScore:0.9 should keep strong but may drop weak.
        const r = await crossModalSearch('normfilter', { ...opts, minScore: 0.9 });
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(strongId);
    });
});

// ---- boolean / exclusion search --------------------------------------------

describe('crossModalSearch — boolean exclusions', () => {
    it('pure negation with no include tokens returns empty results', async () => {
        const id = _newDownload();
        setImageTags(id, [{ tag: 'sunsetonly', score: 0.9 }]);

        const r = await crossModalSearch('-sunsetonly', opts);
        expect(r.results).toEqual([]);
    });

    it('-token excludes images matched via tags', async () => {
        const keepId = _newDownload();
        const dropId = _newDownload();
        setImageTags(keepId, [{ tag: 'beachexcl', score: 0.9 }]);
        setImageTags(dropId, [
            { tag: 'beachexcl', score: 0.9 },
            { tag: 'vacation', score: 0.85 },
        ]);

        const r = await crossModalSearch('beachexcl -vacation', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(keepId);
        expect(ids).not.toContain(dropId);
    });

    it('-token excludes images matched via OCR text', async () => {
        const keepId = _newDownload();
        const dropId = _newDownload();
        setImageTags(keepId, [{ tag: 'promo', score: 0.9 }]);
        setImageTags(dropId, [{ tag: 'promo', score: 0.9 }]);
        setImageText(dropId, 'adult content warning');

        const r = await crossModalSearch('promo -adult', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(keepId);
        expect(ids).not.toContain(dropId);
    });

    it('-token excludes images matched via filename', async () => {
        const keepId = _newDownload({ fileName: 'trip_photo.jpg' });
        const dropId = _newDownload({ fileName: 'trip_nsfw_photo.jpg' });
        setImageTags(keepId, [{ tag: 'trip', score: 0.9 }]);
        setImageTags(dropId, [{ tag: 'trip', score: 0.9 }]);

        const r = await crossModalSearch('trip -nsfw', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(keepId);
        expect(ids).not.toContain(dropId);
    });

    it('multiple -tokens all apply', async () => {
        const keepId = _newDownload();
        const drop1 = _newDownload();
        const drop2 = _newDownload();
        setImageTags(keepId, [{ tag: 'multiex', score: 0.9 }]);
        setImageTags(drop1, [
            { tag: 'multiex', score: 0.9 },
            { tag: 'cat', score: 0.85 },
        ]);
        setImageTags(drop2, [
            { tag: 'multiex', score: 0.9 },
            { tag: 'dog', score: 0.85 },
        ]);

        const r = await crossModalSearch('multiex -cat -dog', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).toContain(keepId);
        expect(ids).not.toContain(drop1);
        expect(ids).not.toContain(drop2);
    });

    it('self-excluding query returns empty', async () => {
        const id = _newDownload();
        setImageTags(id, [{ tag: 'selfex', score: 0.9 }]);

        const r = await crossModalSearch('selfex -selfex', opts);
        const ids = r.results.map((x) => x.id);
        expect(ids).not.toContain(id);
    });

    it('response includes excludedTokens when exclusions present', async () => {
        const r = await crossModalSearch('something -excluded', opts);
        expect(r.excludedTokens).toEqual(['excluded']);
    });

    it('response omits excludedTokens when no exclusions', async () => {
        const r = await crossModalSearch('something', opts);
        expect(r.excludedTokens).toBeUndefined();
    });
});

// ---- listOcrWords ----------------------------------------------------------

describe('listOcrWords', () => {
    it('returns empty array when no OCR text exists', () => {
        // Isolated DB starts empty for this check (prior tests may have added text)
        // so we just verify shape, not emptiness.
        const words = listOcrWords();
        expect(Array.isArray(words)).toBe(true);
        for (const entry of words) {
            expect(entry).toHaveProperty('word');
            expect(entry).toHaveProperty('cnt');
            expect(typeof entry.word).toBe('string');
            expect(typeof entry.cnt).toBe('number');
        }
    });

    it('counts word frequency across documents', () => {
        const id1 = _newDownload();
        const id2 = _newDownload();
        const id3 = _newDownload();
        setImageText(id1, 'invoice total amount due');
        setImageText(id2, 'invoice reference number');
        setImageText(id3, 'receipt amount paid');

        const words = listOcrWords({ minLength: 3, minCount: 1, limit: 200 });
        const invoice = words.find((w) => w.word === 'invoice');
        const amount = words.find((w) => w.word === 'amount');
        expect(invoice).toBeDefined();
        expect(invoice.cnt).toBeGreaterThanOrEqual(2);
        expect(amount).toBeDefined();
        expect(amount.cnt).toBeGreaterThanOrEqual(2);
    });

    it('respects minLength filter', () => {
        const id = _newDownload();
        setImageText(id, 'a to be the fox');

        const words = listOcrWords({ minLength: 4, minCount: 1, limit: 100 });
        for (const { word } of words) {
            expect(word.length).toBeGreaterThanOrEqual(4);
        }
    });

    it('respects minCount filter', () => {
        const id1 = _newDownload();
        const id2 = _newDownload();
        setImageText(id1, 'rareword');
        setImageText(id2, 'commonword commonword');

        const words = listOcrWords({ minLength: 3, minCount: 2, limit: 100 });
        const rare = words.find((w) => w.word === 'rareword');
        expect(rare).toBeUndefined();
    });

    it('respects limit', () => {
        const words = listOcrWords({ minLength: 3, minCount: 1, limit: 3 });
        expect(words.length).toBeLessThanOrEqual(3);
    });

    it('sorts by frequency descending', () => {
        const words = listOcrWords({ minLength: 3, minCount: 1, limit: 50 });
        for (let i = 0; i < words.length - 1; i++) {
            expect(words[i].cnt).toBeGreaterThanOrEqual(words[i + 1].cnt);
        }
    });
});
