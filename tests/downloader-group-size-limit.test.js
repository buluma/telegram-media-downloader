// Per-group video size limit: a group's maxVideoSize overrides the system
// diskManagement.maxVideoSize, and falls back to it when unset. Covers the
// real enforcement path in DownloadManager.download().
//
// `telegram` is mocked (the real package opens MTProto sockets on import);
// registerDownload() is stubbed — it is exercised elsewhere.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-grp-size-'));

vi.mock('telegram', () => ({
    Api: {
        InputDocumentFileLocation: class {},
        InputPhotoFileLocation: class {},
        MessageMediaWebPage: class {},
        MessageMediaPhoto: class {},
        MessageMediaDocument: class {},
        Photo: class {},
        Document: class {},
    },
}));

let DownloadManager;
let dbApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    ({ DownloadManager } = await import('../src/core/downloader.js'));
});

afterAll(() => {
    try {
        dbApi.getDb().close();
    } catch {
        /* already closed */
    }
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const _live = [];
afterEach(async () => {
    for (const dm of _live.splice(0)) {
        try {
            await dm.stop();
        } catch {
            /* already stopped */
        }
    }
});

const KB = 1024;
const downloadMedia = () =>
    vi.fn((_msg, opts) => {
        fs.writeFileSync(opts.outputFile, 'bytes');
        return Promise.resolve();
    });

function mk({ system, groups = [] }) {
    const client = { downloadMedia: downloadMedia() };
    const config = {
        download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 1, retries: 1 },
        diskManagement: system ? { maxVideoSize: system } : {},
        groups,
    };
    const dm = new DownloadManager(client, config, null);
    dm.sleep = () => Promise.resolve();
    dm.registerDownload = vi.fn(async (_job, filePath) => filePath);
    _live.push(dm);
    return { dm, client };
}

// A 3 KB video in group `gid`.
const job = (gid, id = 1) => ({
    key: `${gid}_${id}`,
    groupId: gid,
    groupName: 'Grp',
    mediaType: 'videos',
    message: {
        id,
        date: 1700000000,
        video: {},
        document: { id: String(100 + id), accessHash: '2', size: 3 * KB, attributes: [] },
    },
});

describe('per-group video size limit', () => {
    it('applies the system limit when the group has no override', async () => {
        const { dm, client } = mk({ system: '1KB', groups: [{ id: 'g' }] });
        await expect(dm.download(job('g'))).rejects.toThrow(/File too large/);
        expect(client.downloadMedia).not.toHaveBeenCalled();
    });

    it('lets a group raise the limit above the system default', async () => {
        const { dm, client } = mk({ system: '1KB', groups: [{ id: 'g', maxVideoSize: '1MB' }] });
        await dm.download(job('g', 2));
        expect(client.downloadMedia).toHaveBeenCalledTimes(1);
    });

    it('lets a group tighten the limit below the system default', async () => {
        const { dm, client } = mk({ system: '1MB', groups: [{ id: 'g', maxVideoSize: '1KB' }] });
        await expect(dm.download(job('g', 3))).rejects.toThrow(/File too large \(3 KB > 1KB\)/);
        expect(client.downloadMedia).not.toHaveBeenCalled();
    });

    it('lets a group opt out of the system limit with "none"', async () => {
        const { dm, client } = mk({ system: '1KB', groups: [{ id: 'g', maxVideoSize: 'none' }] });
        await dm.download(job('g', 4));
        expect(client.downloadMedia).toHaveBeenCalledTimes(1);
    });

    it("does not leak one group's override into another", async () => {
        const { dm } = mk({
            system: '1KB',
            groups: [{ id: 'a', maxVideoSize: '1MB' }, { id: 'b' }],
        });
        await dm.download(job('a', 5));
        await expect(dm.download(job('b', 6))).rejects.toThrow(/File too large/);
    });

    it('enforces a group limit even when there is no system limit', async () => {
        const { dm } = mk({ groups: [{ id: 'g', maxVideoSize: '1KB' }] });
        await expect(dm.download(job('g', 7))).rejects.toThrow(/File too large/);
    });
});
