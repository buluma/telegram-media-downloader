// Gallery search over captions + filters. TGDL_DATA_DIR points at a tmpdir
// before the dynamic import so the real data/db.sqlite is never touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

let dir;
let api;

async function open() {
    vi.resetModules();
    process.env.TGDL_DATA_DIR = dir;
    api = await import('../src/core/db.js');
    return api.getDb();
}

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-caption-search-'));
    await open();
});

afterEach(() => {
    try {
        api.closeDb();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
});

let nextMsg = 1;
function add(over = {}) {
    const r = api.insertDownload({
        groupId: '-100777',
        groupName: 'Grp',
        messageId: nextMsg++,
        fileName: `f${nextMsg}.jpg`,
        fileType: 'photo',
        fileSize: 10,
        ...over,
    });
    return Number(r.lastInsertRowid);
}

describe('searchDownloads — captions', () => {
    it('finds a row by a word that only appears in its caption', () => {
        add({ fileName: '2026-09-28T14-34-01_97626.jpg', caption: 'Sunset over the lake' });
        const r = api.searchDownloads('sunset');
        expect(r.total).toBe(1);
        expect(r.files[0].caption).toBe('Sunset over the lake');
    });

    it('prefix-matches caption words and ANDs multiple terms', () => {
        add({ caption: 'Sunset over the lake' });
        add({ caption: 'Sunrise over the hills' });
        expect(api.searchDownloads('sun lake').total).toBe(1);
        expect(api.searchDownloads('over').total).toBe(2);
    });

    it('re-indexes when a caption changes', () => {
        const id = add({ caption: 'old words' });
        api.getDb().prepare('UPDATE downloads SET caption = ? WHERE id = ?').run('new words', id);
        expect(api.searchDownloads('old').total).toBe(0);
        expect(api.searchDownloads('new').total).toBe(1);
    });

    it('drops the index entry when the row is deleted', () => {
        const id = add({ caption: 'gone soon' });
        api.getDb().prepare('DELETE FROM downloads WHERE id = ?').run(id);
        expect(api.searchDownloads('gone').total).toBe(0);
    });

    it('still matches captions on the LIKE fallback path', () => {
        add({ caption: 'fallback caption' });
        // Without the FTS table the MATCH query throws, forcing the LIKE path.
        api.getDb().exec('DROP TABLE downloads_fts');
        expect(api.searchDownloads('fallback').total).toBe(1);
    });
});

describe('searchDownloads — filters', () => {
    it('narrows by type', () => {
        add({ caption: 'beach', fileType: 'photo' });
        add({ caption: 'beach', fileType: 'video' });
        const r = api.searchDownloads('beach', { type: 'videos' });
        expect(r.total).toBe(1);
        expect(r.files[0].file_type).toBe('video');
    });

    it('narrows by pinned and unpinned', () => {
        const pinned = add({ caption: 'beach' });
        add({ caption: 'beach' });
        api.setDownloadPinned(pinned, 1);
        expect(api.searchDownloads('beach', { pinnedOnly: true }).files.map((f) => f.id)).toEqual([
            pinned,
        ]);
        expect(api.searchDownloads('beach', { unpinnedOnly: true }).total).toBe(1);
    });

    it('narrows to watched rows', () => {
        const seen = add({ caption: 'beach' });
        add({ caption: 'beach' });
        api.getDb()
            .prepare('UPDATE downloads SET last_viewed_at = ? WHERE id = ?')
            .run('2026-07-01T00:00:00Z', seen);
        expect(api.searchDownloads('beach', { watchedOnly: true }).files.map((f) => f.id)).toEqual([
            seen,
        ]);
    });

    it('narrows to clips (negative message_id)', () => {
        add({ caption: 'beach', messageId: 500 });
        const clip = add({ caption: 'beach', messageId: -3 });
        expect(api.searchDownloads('beach', { clippedOnly: true }).files.map((f) => f.id)).toEqual([
            clip,
        ]);
    });

    it('narrows by date range', () => {
        const a = add({ caption: 'beach' });
        const b = add({ caption: 'beach' });
        const db = api.getDb();
        db.prepare('UPDATE downloads SET created_at = ? WHERE id = ?').run(
            '2026-01-10 10:00:00',
            a,
        );
        db.prepare('UPDATE downloads SET created_at = ? WHERE id = ?').run(
            '2026-03-10 10:00:00',
            b,
        );
        const r = api.searchDownloads('beach', { dateFrom: '2026-03-01', dateTo: '2026-03-31' });
        expect(r.files.map((f) => f.id)).toEqual([b]);
    });

    it('keeps the group scope and counts only the filtered rows', () => {
        add({ caption: 'beach', groupId: '-1', fileType: 'video' });
        add({ caption: 'beach', groupId: '-2', fileType: 'video' });
        add({ caption: 'beach', groupId: '-1', fileType: 'photo' });
        const r = api.searchDownloads('beach', { groupId: '-1', type: 'videos' });
        expect(r.total).toBe(1);
        expect(r.files).toHaveLength(1);
    });
});

describe('downloads_fts migration', () => {
    it('rebuilds an old two-column index so existing captions become searchable', async () => {
        const id = add({ fileName: 'a.jpg', caption: 'migrated caption' });
        // Put the DB back into its pre-caption shape: 2-column index + old triggers.
        const db = api.getDb();
        db.exec(`
            DROP TRIGGER downloads_fts_insert;
            DROP TRIGGER downloads_fts_delete;
            DROP TRIGGER downloads_fts_update;
            DROP TABLE downloads_fts;
            CREATE VIRTUAL TABLE downloads_fts USING fts5(
                file_name, group_name, content='downloads', content_rowid='id'
            );
            INSERT INTO downloads_fts(rowid, file_name, group_name)
                SELECT id, COALESCE(file_name, ''), COALESCE(group_name, '') FROM downloads;
        `);
        expect(api.searchDownloads('migrated').total).toBe(0);
        api.closeDb();

        await open();

        const cols = api
            .getDb()
            .prepare('PRAGMA table_info(downloads_fts)')
            .all()
            .map((c) => c.name);
        expect(cols).toEqual(['file_name', 'group_name', 'caption']);
        expect(api.searchDownloads('migrated').files.map((f) => f.id)).toEqual([id]);
        // Triggers were recreated against the new shape.
        const dl = add({ caption: 'after migration' });
        expect(api.searchDownloads('after').files.map((f) => f.id)).toEqual([dl]);
    });

    it('is a no-op on an already-migrated database', async () => {
        add({ caption: 'stable caption' });
        api.closeDb();
        await open();
        expect(api.searchDownloads('stable').total).toBe(1);
    });
});
