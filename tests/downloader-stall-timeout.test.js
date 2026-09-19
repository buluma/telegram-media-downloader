// A gramJS media fetch that never yields a byte (dead media-DC sender after a
// reboot / network blip) used to hang download() forever: no timeout, so the
// worker stayed pinned at 0 bytes, and once every worker was pinned the queue
// never drained. These tests cover the stall watchdog around downloadMedia().
//
// `telegram` is mocked (the real package opens MTProto sockets on import).
// registerDownload() is stubbed — it is exercised elsewhere and is not part of
// what is being proved here.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-stall-'));

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

function mk(client, stallTimeoutMs = 40) {
    const config = {
        download: { path: path.join(DATA_DIR, 'downloads'), concurrent: 1, retries: 3 },
        advanced: { downloader: { stallTimeoutMs } },
    };
    const dm = new DownloadManager(client, config, null);
    dm.sleep = () => Promise.resolve(); // skip retry backoff
    dm.registerDownload = vi.fn(async (_job, filePath) => filePath);
    _live.push(dm);
    return dm;
}

const job = () => ({
    key: 'g_1',
    groupId: 'g',
    groupName: 'Stall Group',
    mediaType: 'videos',
    message: {
        id: 1,
        date: 1700000000,
        document: { id: '111', accessHash: '222', size: 2048, attributes: [] },
    },
});

describe('download() stall watchdog', () => {
    it('aborts an attempt that receives no bytes and retries it', async () => {
        let calls = 0;
        const client = {
            downloadMedia: vi.fn((_msg, opts) => {
                calls++;
                if (calls === 1) return new Promise(() => {}); // wedged forever
                fs.writeFileSync(opts.outputFile, 'bytes');
                return Promise.resolve();
            }),
        };
        const dm = mk(client);

        const filePath = await dm.download(job());

        expect(calls).toBe(2);
        expect(dm.registerDownload).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(filePath)).toBe(true);
    });

    it('fails with a stall error once retries are exhausted', async () => {
        const client = { downloadMedia: vi.fn(() => new Promise(() => {})) };
        const dm = mk(client);

        await expect(dm.download(job())).rejects.toThrow(/stalled/i);
        expect(client.downloadMedia).toHaveBeenCalledTimes(3);
    });

    it('does not trip while progress keeps arriving, even past the timeout', async () => {
        const client = {
            downloadMedia: vi.fn(async (_msg, opts) => {
                // 6 ticks x 25ms = 150ms total, well over the 40ms stall limit.
                for (let i = 1; i <= 6; i++) {
                    await new Promise((r) => setTimeout(r, 25));
                    opts.progressCallback(i * 100, 600);
                }
                fs.writeFileSync(opts.outputFile, 'bytes');
            }),
        };
        const dm = mk(client);

        await dm.download(job());

        expect(client.downloadMedia).toHaveBeenCalledTimes(1);
    });

    it('does not surface a late rejection from an abandoned attempt', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            let calls = 0;
            let rejectFirst;
            const client = {
                downloadMedia: vi.fn((_msg, opts) => {
                    calls++;
                    if (calls === 1) {
                        return new Promise((_, reject) => {
                            rejectFirst = reject;
                        });
                    }
                    fs.writeFileSync(opts.outputFile, 'bytes');
                    return Promise.resolve();
                }),
            };
            const dm = mk(client);

            await dm.download(job());
            rejectFirst(new Error('socket finally died'));
            await new Promise((r) => setTimeout(r, 20));

            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});
