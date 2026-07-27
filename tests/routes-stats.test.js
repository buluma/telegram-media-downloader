// Route-level HTTP tests for /api/stats and /api/db/stats. Mounts the
// real stats router against a temp DB/config — the interesting logic
// here (disk-usage fallback scan, per-role peer-stats gating, the
// 2s cache, the 14-day trend + top-5-groups-plus-Other rollup) is all
// real DB/fs work worth exercising directly.
//
// core/runtime.js and core/cluster/peers.js are mocked (cluster
// federation internals are out of scope here).
//
// The module-level `_statsCache` is keyed by `req.role`, and there's no
// reset hook — a tiny test-only middleware sets req.role to a UNIQUE
// string per test (instead of the real 'admin'/'guest' values) so every
// test computes fresh unless it deliberately reuses the same role to
// exercise the cache-hit path itself.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-stats-'));

const runtime = { state: 'stopped' };
vi.mock('../src/core/runtime.js', () => ({ runtime }));

const listPeers = vi.fn(() => []);
vi.mock('../src/core/cluster/peers.js', () => ({ listPeers: (...a) => listPeers(...a) }));

let dbApi;
let db;
let manager;
let app;
let server;
let port;
let getAccountManager;
const statsBroadcast = vi.fn();
let getIsConnected;
let currentRole;
let roleCounter = 0;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function freshRole() {
    roleCounter += 1;
    return `test-role-${roleCounter}`;
}

function insertPeerDownload({ peerId = 'peer-1', remoteId = 1, fileSize = 1000 } = {}) {
    db.prepare(
        `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_size, cached_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(peerId, remoteId, `/remote/${peerId}/${remoteId}`, fileSize, Date.now());
}

function insertDownload({
    groupId = '-1001',
    groupName = 'Test Group',
    messageId = Math.floor(Math.random() * 1e9),
    fileName = 'a.mp4',
    fileType = 'video',
    fileSize = 1024,
    createdAt = null,
} = {}) {
    if (createdAt) {
        return db
            .prepare(
                `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_type, file_path, file_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(groupId, groupName, messageId, fileName, fileType, '/x', fileSize, createdAt)
            .lastInsertRowid;
    }
    return db
        .prepare(
            `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_type, file_path, file_size)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(groupId, groupName, messageId, fileName, fileType, '/x', fileSize).lastInsertRowid;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');

    const { createStatsRouter } = await import('../src/web/routes/stats.js');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.role = currentRole;
        next();
    });
    app.use(
        '/api',
        createStatsRouter({
            broadcast: (msg) => statsBroadcast(msg),
            getAccountManager: (...a) => getAccountManager(...a),
            getIsConnected: (...a) => getIsConnected?.(...a),
        }),
    );

    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    dbApi.kvDelete('config');
    dbApi.kvDelete('disk_usage');
    db.prepare('DELETE FROM downloads').run();
    db.prepare('DELETE FROM peer_downloads').run();
    db.prepare('DELETE FROM groups').run();
    manager._resetConfigBus();
    runtime.state = 'stopped';
    listPeers.mockReturnValue([]);
    getAccountManager = async () => ({ count: 0 });
    getIsConnected = undefined;
    currentRole = freshRole();
});

describe('GET /api/stats', () => {
    it('reports totalFiles/totalSize from the DB catalogue', async () => {
        insertDownload({ fileSize: 500 });
        insertDownload({ fileSize: 1500 });
        const res = await fetch(apiUrl('/api/stats'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalFiles).toBe(2);
        expect(body.totalSize).toBe(2000);
        expect(body.diskUsage).toBe(2000);
        expect(body.diskUsageFormatted).toContain('KB');
    });

    it('falls back to a directory scan when the DB catalogue reports 0 size', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        fs.writeFileSync(path.join(downloadsDir, 'orphan.bin'), Buffer.alloc(300));
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.diskUsage).toBe(300);
        expect(dbApi.kvGet('disk_usage').size).toBe(300);
    });

    it('gets accounts count from getAccountManager', async () => {
        getAccountManager = async () => ({ count: 4 });
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.accounts).toBe(4);
    });

    it('falls back to counting .enc session files when getAccountManager throws', async () => {
        getAccountManager = async () => {
            throw new Error('not ready');
        };
        const sessionsDir = path.join(DATA_DIR, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, 'a.enc'), '');
        fs.writeFileSync(path.join(sessionsDir, 'b.enc'), '');
        try {
            const res = await fetch(apiUrl('/api/stats'));
            const body = await res.json();
            expect(body.accounts).toBe(2);
        } finally {
            fs.rmSync(sessionsDir, { recursive: true, force: true });
        }
    });

    it('reports apiConfigured true only when both apiId and apiHash are set', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '123';
        cfg.telegram.apiHash = 'hash';
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.apiConfigured).toBe(true);
    });

    it('reports apiConfigured false when only one of apiId/apiHash is set', async () => {
        const cfg = manager.loadConfig();
        cfg.telegram.apiId = '123';
        cfg.telegram.apiHash = '';
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.apiConfigured).toBe(false);
    });

    it('reports totalGroups/enabledGroups from config', async () => {
        const cfg = manager.loadConfig();
        cfg.groups = [
            { id: '-1', enabled: true },
            { id: '-2', enabled: false },
            { id: '-3', enabled: true },
        ];
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.totalGroups).toBe(3);
        expect(body.enabledGroups).toBe(2);
    });

    it('reports telegramConnected true when runtime.state is running', async () => {
        runtime.state = 'running';
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.telegramConnected).toBe(true);
    });

    it('reports telegramConnected true when getIsConnected() says so, even if runtime is stopped', async () => {
        getIsConnected = () => true;
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.telegramConnected).toBe(true);
    });

    it('reports telegramConnected false when neither source says connected', async () => {
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.telegramConnected).toBe(false);
    });

    it('includes peerStats with peer names/online status from listPeers', async () => {
        insertPeerDownload({ peerId: 'peer-1', remoteId: 1, fileSize: 2000 });
        insertPeerDownload({ peerId: 'peer-1', remoteId: 2, fileSize: 3000 });
        listPeers.mockReturnValue([{ peerId: 'peer-1', name: 'Friend PC', status: 'online' }]);
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.peerStats).toEqual([
            {
                peerId: 'peer-1',
                peerName: 'Friend PC',
                online: true,
                totalFiles: 2,
                totalSize: 5000,
                totalSizeFormatted: expect.any(String),
            },
        ]);
    });

    it('falls back to the raw peerId as the name when listPeers has no match', async () => {
        insertPeerDownload({ peerId: 'unknown-peer', remoteId: 1, fileSize: 100 });
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.peerStats[0].peerName).toBe('unknown-peer');
        expect(body.peerStats[0].online).toBe(false);
    });

    it('omits peerStats entirely for the guest role', async () => {
        currentRole = 'guest';
        insertPeerDownload({ peerId: 'peer-1', remoteId: 1, fileSize: 5000 });
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.peerStats).toEqual([]);
    });

    it('serves the cached response within the 2s TTL for the same role', async () => {
        insertDownload({ fileSize: 100 });
        const first = await fetch(apiUrl('/api/stats'));
        const firstBody = await first.json();
        insertDownload({ fileSize: 999999 }); // would change totalSize if recomputed
        const second = await fetch(apiUrl('/api/stats'));
        const secondBody = await second.json();
        expect(secondBody).toEqual(firstBody);
    });

    it("does not serve another role's cached response", async () => {
        insertDownload({ fileSize: 100 });
        await fetch(apiUrl('/api/stats'));
        currentRole = freshRole();
        const res = await fetch(apiUrl('/api/stats'));
        const body = await res.json();
        expect(body.totalFiles).toBe(1);
    });

    it('500s when getStats itself throws', async () => {
        db.exec('DROP TABLE downloads');
        try {
            const res = await fetch(apiUrl('/api/stats'));
            expect(res.status).toBe(500);
        } finally {
            // Recreate a minimal downloads table so later tests in this
            // file aren't affected by the drop.
            db.exec(`
                CREATE TABLE IF NOT EXISTS downloads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id TEXT NOT NULL,
                    group_name TEXT,
                    message_id INTEGER NOT NULL,
                    file_name TEXT,
                    file_size INTEGER,
                    file_type TEXT,
                    file_path TEXT,
                    status TEXT DEFAULT 'completed',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    ai_indexed_at INTEGER,
                    UNIQUE(group_id, message_id)
                );
            `);
        }
    });
});

describe('GET /api/db/stats', () => {
    it('returns zeroed table counts against an empty database', async () => {
        const res = await fetch(apiUrl('/api/db/stats'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.tableCounts.downloads).toBe(0);
        expect(body.totals.total).toBe(0);
    });

    it('reports per-file-type totals', async () => {
        insertDownload({ fileType: 'photo', fileSize: 100 });
        insertDownload({ fileType: 'video', fileSize: 200 });
        insertDownload({ fileType: 'video', fileSize: 300 });
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.totals.total).toBe(3);
        expect(body.totals.photos).toBe(1);
        expect(body.totals.videos).toBe(2);
        expect(body.totals.bytes).toBe(600);
    });

    it('groups by group_id, keeping distinctly-null-named groups separate', async () => {
        insertDownload({ groupId: '-1', groupName: 'Alpha' });
        insertDownload({ groupId: '-2', groupName: 'Beta' });
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.groups).toHaveLength(2);
    });

    it('builds a 14-day daily trend including empty days', async () => {
        const today = new Date().toISOString().slice(0, 10);
        insertDownload({ createdAt: `${today} 12:00:00` });
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.dailyTrend).toHaveLength(14);
        const todayEntry = body.dailyTrend.find((d) => d.day === today);
        expect(todayEntry.n).toBe(1);
    });

    it('builds trendByGroup with a top-5 + Other rollup', async () => {
        const today = new Date().toISOString().slice(0, 10);
        for (let i = 0; i < 6; i++) {
            insertDownload({
                groupId: `-${i}`,
                groupName: `Group ${i}`,
                createdAt: `${today} 12:00:00`,
            });
        }
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.trendByGroup.groups).toHaveLength(6); // 5 top + Other
        expect(body.trendByGroup.groups.at(-1)).toEqual({ id: '__other__', name: 'Other' });
    });

    it('omits the Other bucket when there are 5 or fewer groups', async () => {
        const today = new Date().toISOString().slice(0, 10);
        for (let i = 0; i < 3; i++) {
            insertDownload({
                groupId: `-${i}`,
                groupName: `Group ${i}`,
                createdAt: `${today} 12:00:00`,
            });
        }
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.trendByGroup.groups.some((g) => g.id === '__other__')).toBe(false);
    });

    it('reports AI coverage counts and pct', async () => {
        const id = insertDownload();
        db.prepare('UPDATE downloads SET ai_indexed_at = ? WHERE id = ?').run(Date.now(), id);
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.ai.total).toBe(1);
        expect(body.ai.indexed).toBe(1);
        expect(body.ai.pct).toBe(100);
    });

    it('reports pct 0 when there are no downloads at all', async () => {
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.ai.pct).toBe(0);
    });

    it('reports the on-disk DB file size', async () => {
        const res = await fetch(apiUrl('/api/db/stats'));
        const body = await res.json();
        expect(body.dbFileSizeBytes).toBeGreaterThan(0);
    });
});

describe('broadcastStatsSoon', () => {
    let broadcastStatsSoon;

    beforeEach(async () => {
        vi.useFakeTimers();
        const stats = await import('../src/web/routes/stats.js');
        ({ broadcastStatsSoon } = stats);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('debounces a burst of calls into a single broadcast after 400ms', async () => {
        insertDownload({ fileSize: 100 }); // avoid the real-fs disk scan fallback under fake timers
        broadcastStatsSoon();
        broadcastStatsSoon();
        broadcastStatsSoon();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(400);
        expect(statsBroadcast).toHaveBeenCalledTimes(1);
        const [msg] = statsBroadcast.mock.calls[0];
        expect(msg.type).toBe('stats_update');
        expect(msg.stats).toHaveProperty('totalFiles');
    });

    it('allows a new debounce window to start after the previous one fires', async () => {
        insertDownload({ fileSize: 100 });
        broadcastStatsSoon();
        await vi.advanceTimersByTimeAsync(400);
        broadcastStatsSoon();
        await vi.advanceTimersByTimeAsync(400);
        expect(statsBroadcast).toHaveBeenCalledTimes(2);
    });

    it('logs a warning instead of throwing when computing the payload fails', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        db.exec('DROP TABLE downloads');
        try {
            broadcastStatsSoon();
            await vi.advanceTimersByTimeAsync(400);
            expect(statsBroadcast).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                '[stats] broadcast failed:',
                expect.stringContaining('no such table'),
            );
        } finally {
            db.exec(`
                CREATE TABLE IF NOT EXISTS downloads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id TEXT NOT NULL,
                    group_name TEXT,
                    message_id INTEGER NOT NULL,
                    file_name TEXT,
                    file_size INTEGER,
                    file_type TEXT,
                    file_path TEXT,
                    status TEXT DEFAULT 'completed',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    ai_indexed_at INTEGER,
                    UNIQUE(group_id, message_id)
                );
            `);
            warnSpy.mockRestore();
        }
    });
});
