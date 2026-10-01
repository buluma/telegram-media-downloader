// Tests for normalized group config tables + CRUD (src/core/db/groups.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Each test gets a fully isolated tmpdir so initDb() never touches the real db.
let tmpDir;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-groups-test-'));
    process.env.TGDL_DATA_DIR = tmpDir;
    // Reset the singleton between tests
    vi.resetModules();
});
afterEach(async () => {
    // Close the DB connection so Windows can delete the temp SQLite files.
    const { closeDb } = await import('../src/core/db.js');
    closeDb();
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

import { vi } from 'vitest';

async function getModules() {
    const db = await import('../src/core/db.js');
    const groups = await import('../src/core/db/groups.js');
    return { db, groups };
}

const SAMPLE_GROUP = {
    id: '-100123456',
    name: 'Test Channel',
    type: 'channel',
    enabled: true,
    filters: {
        photos: true,
        videos: true,
        files: false,
        links: true,
        voice: false,
        audio: false,
        gifs: false,
        stickers: false,
        urls: true,
    },
    trackComments: false,
    rescueMode: 'on',
    autoForward: {
        enabled: true,
        destination: '@mychannel',
        deleteAfterForward: false,
        keepImages: true,
        keepVideos: true,
    },
    topics: { enabled: true, ids: [1, 2, 3] },
    trackUsers: { enabled: true, users: ['alice', 'bob'] },
};

describe('getAllGroupConfigs', () => {
    it('returns empty array on fresh DB', async () => {
        const { groups } = await getModules();
        const result = groups.getAllGroupConfigs();
        expect(result).toEqual([]);
    });
});

describe('upsertGroupConfig', () => {
    it('inserts a group and reads it back with all fields', async () => {
        const { groups } = await getModules();
        groups.upsertGroupConfig(SAMPLE_GROUP);
        const all = groups.getAllGroupConfigs();
        expect(all).toHaveLength(1);
        const g = all[0];
        expect(g.id).toBe('-100123456');
        expect(g.name).toBe('Test Channel');
        expect(g.type).toBe('channel');
        expect(g.enabled).toBe(true);
        expect(g.filters.photos).toBe(true);
        expect(g.filters.videos).toBe(true);
        expect(g.filters.files).toBe(false);
        expect(g.trackComments).toBe(false);
        expect(g.rescueMode).toBe('on');
        expect(g.autoForward.enabled).toBe(true);
        expect(g.autoForward.destination).toBe('@mychannel');
        expect(g.autoForward.deleteAfterForward).toBe(false);
        expect(g.autoForward.keepVideos).toBe(true);
        expect(g.topics.enabled).toBe(true);
        expect(g.topics.ids).toEqual([1, 2, 3]);
    });

    it('preserves overflow meta fields (trackUsers)', async () => {
        const { groups } = await getModules();
        groups.upsertGroupConfig(SAMPLE_GROUP);
        const g = groups.getAllGroupConfigs()[0];
        expect(g.trackUsers).toEqual({ enabled: true, users: ['alice', 'bob'] });
    });

    it('round-trips the per-group maxVideoSize through meta_json', async () => {
        const { groups } = await getModules();
        groups.upsertGroupConfig({ ...SAMPLE_GROUP, maxVideoSize: '500MB' });
        expect(groups.getAllGroupConfigs()[0].maxVideoSize).toBe('500MB');
        groups.upsertGroupConfig({ ...SAMPLE_GROUP, maxVideoSize: undefined });
        expect(groups.getAllGroupConfigs()[0].maxVideoSize).toBeUndefined();
    });

    it('updates an existing group on re-upsert', async () => {
        const { groups } = await getModules();
        groups.upsertGroupConfig(SAMPLE_GROUP);
        groups.upsertGroupConfig({ ...SAMPLE_GROUP, name: 'Renamed Channel', enabled: false });
        const all = groups.getAllGroupConfigs();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('Renamed Channel');
        expect(all[0].enabled).toBe(false);
    });

    it('handles minimal group (no optional fields)', async () => {
        const { groups } = await getModules();
        groups.upsertGroupConfig({ id: '999', name: 'Minimal', enabled: false });
        const g = groups.getAllGroupConfigs()[0];
        expect(g.id).toBe('999');
        expect(g.name).toBe('Minimal');
        expect(g.enabled).toBe(false);
        expect(g.filters.photos).toBe(true); // default
        expect(g.autoForward.enabled).toBe(false); // default
        expect(g.rescueMode).toBe('auto'); // default
    });
});

describe('syncGroupConfigs', () => {
    it('syncs multiple groups and removes stale ones', async () => {
        const { groups } = await getModules();
        // Insert initial two groups
        groups.upsertGroupConfig({ id: 'A', name: 'Group A', enabled: true });
        groups.upsertGroupConfig({ id: 'B', name: 'Group B', enabled: true });
        expect(groups.getAllGroupConfigs()).toHaveLength(2);

        // Sync with only group A — B should be deleted
        groups.syncGroupConfigs([{ id: 'A', name: 'Group A Updated', enabled: false }]);
        const all = groups.getAllGroupConfigs();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe('A');
        expect(all[0].name).toBe('Group A Updated');
    });

    it('clears all groups when synced with empty array', async () => {
        const { groups } = await getModules();
        groups.upsertGroupConfig({ id: 'X', name: 'X', enabled: true });
        groups.syncGroupConfigs([]);
        expect(groups.getAllGroupConfigs()).toHaveLength(0);
    });
});

describe('deleteGroupConfig', () => {
    it('removes group and cascades to child tables', async () => {
        const { groups, db: dbModule } = await getModules();
        groups.upsertGroupConfig(SAMPLE_GROUP);
        groups.deleteGroupConfig('-100123456');
        expect(groups.getAllGroupConfigs()).toHaveLength(0);

        // Verify cascade deleted child rows
        const rawDb = dbModule.getDb();
        const filters = rawDb
            .prepare('SELECT * FROM group_filters WHERE group_id = ?')
            .get('-100123456');
        expect(filters).toBeUndefined();
        const fwd = rawDb
            .prepare('SELECT * FROM group_forward WHERE group_id = ?')
            .get('-100123456');
        expect(fwd).toBeUndefined();
        const settings = rawDb
            .prepare('SELECT * FROM group_settings WHERE group_id = ?')
            .get('-100123456');
        expect(settings).toBeUndefined();
    });
});

describe('_migrateGroupsFromKv', () => {
    it('migrates groups from kv config blob to normalized tables', async () => {
        const { groups: groupsModule, db: dbModule } = await getModules();
        const { kvSet } = dbModule;

        // Pre-populate kv with a config containing groups
        const kv_groups = [
            {
                id: '-100111',
                name: 'Channel One',
                enabled: true,
                filters: {
                    photos: true,
                    videos: false,
                    files: true,
                    links: true,
                    voice: true,
                    audio: false,
                    gifs: false,
                    stickers: false,
                    urls: true,
                },
                trackComments: true,
                autoForward: {
                    enabled: false,
                    destination: null,
                    deleteAfterForward: true,
                    keepImages: true,
                    keepVideos: false,
                },
            },
            {
                id: '-100222',
                name: 'Channel Two',
                enabled: false,
                filters: {
                    photos: false,
                    videos: true,
                    files: false,
                    links: false,
                    voice: false,
                    audio: true,
                    gifs: false,
                    stickers: false,
                    urls: false,
                },
                trackComments: false,
                autoForward: {
                    enabled: false,
                    destination: null,
                    deleteAfterForward: true,
                    keepImages: true,
                    keepVideos: false,
                },
            },
        ];
        kvSet('config', { groups: kv_groups });

        // Run migration on the already-initialized DB
        const rawDb = dbModule.getDb();
        groupsModule._migrateGroupsFromKv(rawDb);

        const all = groupsModule.getAllGroupConfigs();
        expect(all).toHaveLength(2);
        expect(all[0].id).toBe('-100111');
        expect(all[0].name).toBe('Channel One');
        expect(all[1].id).toBe('-100222');
        expect(all[1].enabled).toBe(false);
        expect(all[1].filters.videos).toBe(true);
    });

    it('is idempotent — does not duplicate rows on second call', async () => {
        const { groups: groupsModule, db: dbModule } = await getModules();
        const { kvSet } = dbModule;

        kvSet('config', { groups: [{ id: 'G1', name: 'G1', enabled: true }] });
        const rawDb = dbModule.getDb();
        groupsModule._migrateGroupsFromKv(rawDb);
        groupsModule._migrateGroupsFromKv(rawDb);

        expect(groupsModule.getAllGroupConfigs()).toHaveLength(1);
    });

    it('skips migration when groups table already has data', async () => {
        const { groups: groupsModule, db: dbModule } = await getModules();
        const { kvSet } = dbModule;

        // Pre-populate the table
        groupsModule.upsertGroupConfig({ id: 'existing', name: 'Existing', enabled: true });
        // Put different data in kv
        kvSet('config', { groups: [{ id: 'from_kv', name: 'From KV', enabled: true }] });

        const rawDb = dbModule.getDb();
        groupsModule._migrateGroupsFromKv(rawDb);

        // Should still only have the one pre-existing group
        const all = groupsModule.getAllGroupConfigs();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe('existing');
    });
});

describe('deleteGroupDownloads', () => {
    it('deletes all rows when skipPinned is false (default)', async () => {
        const { db: dbModule, groups } = await getModules();
        const db = dbModule.getDb();
        db.prepare(
            "INSERT INTO downloads (group_id, message_id, file_path, pinned) VALUES ('G1', 1, 'a.mp4', 0), ('G1', 2, 'b.mp4', 1)",
        ).run();
        groups.deleteGroupDownloads('G1');
        const rows = db.prepare('SELECT * FROM downloads WHERE group_id = ?').all('G1');
        expect(rows).toHaveLength(0);
    });

    it('skips pinned rows when skipPinned is true', async () => {
        const { db: dbModule, groups } = await getModules();
        const db = dbModule.getDb();
        db.prepare(
            "INSERT INTO downloads (group_id, message_id, file_path, pinned) VALUES ('G1', 1, 'a.mp4', 0), ('G1', 2, 'b.mp4', 1)",
        ).run();
        const result = groups.deleteGroupDownloads('G1', { skipPinned: true });
        expect(result.deletedDownloads).toBe(1);
        const remaining = db.prepare('SELECT pinned FROM downloads WHERE group_id = ?').all('G1');
        expect(remaining).toHaveLength(1);
        expect(remaining[0].pinned).toBe(1);
    });

    it('treats NULL pinned as non-pinned when skipPinned is true', async () => {
        const { db: dbModule, groups } = await getModules();
        const db = dbModule.getDb();
        db.prepare(
            "INSERT INTO downloads (group_id, message_id, file_path, pinned) VALUES ('G1', 1, 'a.mp4', NULL), ('G1', 2, 'b.mp4', 1)",
        ).run();
        const result = groups.deleteGroupDownloads('G1', { skipPinned: true });
        expect(result.deletedDownloads).toBe(1);
        const remaining = db.prepare('SELECT pinned FROM downloads WHERE group_id = ?').all('G1');
        expect(remaining).toHaveLength(1);
        expect(remaining[0].pinned).toBe(1);
    });

    it('skips photos when skipPhotos is true', async () => {
        const { db: dbModule, groups } = await getModules();
        const db = dbModule.getDb();
        db.prepare(
            "INSERT INTO downloads (group_id, message_id, file_path, file_type, pinned) VALUES ('G1', 1, 'a.jpg', 'photo', 0), ('G1', 2, 'b.mp4', 'video', 0)",
        ).run();
        const result = groups.deleteGroupDownloads('G1', { skipPhotos: true });
        expect(result.deletedDownloads).toBe(1);
        const remaining = db
            .prepare('SELECT file_type FROM downloads WHERE group_id = ?')
            .all('G1');
        expect(remaining).toHaveLength(1);
        expect(remaining[0].file_type).toBe('photo');
    });

    it('skips both pinned and photos when both flags set', async () => {
        const { db: dbModule, groups } = await getModules();
        const db = dbModule.getDb();
        db.prepare(
            "INSERT INTO downloads (group_id, message_id, file_path, file_type, pinned) VALUES ('G1', 1, 'a.jpg', 'photo', 0), ('G1', 2, 'b.mp4', 'video', 1), ('G1', 3, 'c.mp4', 'video', 0)",
        ).run();
        const result = groups.deleteGroupDownloads('G1', { skipPinned: true, skipPhotos: true });
        expect(result.deletedDownloads).toBe(1);
        const remaining = db
            .prepare('SELECT message_id FROM downloads WHERE group_id = ? ORDER BY message_id')
            .all('G1');
        expect(remaining.map((r) => r.message_id)).toEqual([1, 2]);
    });
});
