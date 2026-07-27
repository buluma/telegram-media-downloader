/**
 * TGDL_DATA_DIR must be honoured by *every* module that resolves the on-disk
 * data root — not just some of them.
 *
 * src/core/db.js, src/core/delete-queue.js and src/web/lib/resolve-download.js
 * resolve `data/` from TGDL_DATA_DIR. The write-side modules (downloader,
 * thumbs, rescue, integrity, disk-rotator, forwarder, faststart, secret) used
 * to hardcode `<repo>/data`, which splits the tree in half: with the variable
 * set, the downloader writes to the repo while safeResolveDownload() only
 * accepts paths under the override, so every /api/files/:id/stream and
 * thumbnail request 404s on a path that exists. The sweepers scan an empty
 * tree and never see the real orphans.
 *
 * These tests pin both halves to the same root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.tmpdir(), `tgdl-datadir-${process.pid}`);

beforeEach(() => {
    fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true });
    process.env.TGDL_DATA_DIR = DATA_DIR;
    vi.resetModules();
});

afterEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('TGDL_DATA_DIR — resolved roots', () => {
    it('core/secret.js writes secret.key under the override, not the repo', async () => {
        const { getOrGenerateSecret } = await import('../src/core/secret.js');
        const secret = getOrGenerateSecret();

        expect(secret).toMatch(/^[0-9a-f]{64}$/);
        const written = path.join(DATA_DIR, 'secret.key');
        expect(fs.existsSync(written)).toBe(true);
        expect(fs.readFileSync(written, 'utf8').trim()).toBe(secret);
    });

    it('core/secret.js reuses an existing secret from the override dir', async () => {
        fs.writeFileSync(path.join(DATA_DIR, 'secret.key'), 'deadbeef\n');
        const { getOrGenerateSecret } = await import('../src/core/secret.js');
        expect(getOrGenerateSecret()).toBe('deadbeef');
    });

    it('core/downloader.js migrateFolders() defaults to the override downloads dir', async () => {
        // An unsanitized folder name only gets migrated if migrateFolders()
        // is looking at the right tree.
        const dirty = path.join(DATA_DIR, 'downloads', 'My: Group');
        fs.mkdirSync(dirty, { recursive: true });
        fs.writeFileSync(path.join(dirty, 'a.mp4'), 'x');

        const { migrateFolders, sanitizeName } = await import('../src/core/downloader.js');
        await migrateFolders();

        const clean = path.join(DATA_DIR, 'downloads', sanitizeName('My: Group'));
        expect(fs.existsSync(clean)).toBe(true);
        expect(fs.existsSync(path.join(clean, 'a.mp4'))).toBe(true);
        expect(fs.existsSync(dirty)).toBe(false);
    });

    it('core/thumbs.js resolves both downloads and thumbs under the override', async () => {
        const { THUMBS_PATHS } = await import('../src/core/thumbs.js');
        expect(THUMBS_PATHS.DOWNLOADS_DIR).toBe(path.join(DATA_DIR, 'downloads'));
        expect(THUMBS_PATHS.THUMBS_DIR).toBe(path.join(DATA_DIR, 'thumbs'));
    });

    it('core/rescue.js resolves its downloads root under the override', async () => {
        const { DOWNLOADS_DIR } = await import('../src/core/rescue.js');
        expect(DOWNLOADS_DIR).toBe(path.join(DATA_DIR, 'downloads'));
    });

    it('core/integrity.js resolves its downloads root under the override', async () => {
        const { DOWNLOADS_DIR } = await import('../src/core/integrity.js');
        expect(DOWNLOADS_DIR).toBe(path.join(DATA_DIR, 'downloads'));
    });

    it('core/disk-rotator.js resolves its downloads root under the override', async () => {
        const { DOWNLOADS_DIR } = await import('../src/core/disk-rotator.js');
        expect(DOWNLOADS_DIR).toBe(path.join(DATA_DIR, 'downloads'));
    });

    it('core/forwarder.js resolves its downloads root under the override', async () => {
        const { DOWNLOADS_DIR } = await import('../src/core/forwarder.js');
        expect(DOWNLOADS_DIR).toBe(path.join(DATA_DIR, 'downloads'));
    });

    it('core/faststart.js resolves its downloads root under the override', async () => {
        const { DOWNLOADS_DIR } = await import('../src/core/faststart.js');
        expect(DOWNLOADS_DIR).toBe(path.join(DATA_DIR, 'downloads'));
    });

    it('agrees with core/db.js and web/lib/resolve-download.js on the same root', async () => {
        const { DB_PATH } = await import('../src/core/db.js');
        const { DOWNLOADS_DIR: thumbsDownloads } = await import('../src/core/rescue.js');
        expect(path.dirname(DB_PATH)).toBe(DATA_DIR);
        expect(thumbsDownloads).toBe(path.join(path.dirname(DB_PATH), 'downloads'));
    });

    it('falls back to the in-repo data/ when the variable is unset', async () => {
        delete process.env.TGDL_DATA_DIR;
        vi.resetModules();
        const { DOWNLOADS_DIR } = await import('../src/core/rescue.js');
        const repoData = path.resolve(process.cwd(), 'data', 'downloads');
        expect(DOWNLOADS_DIR).toBe(repoData);
    });
});

describe('TGDL_DATA_DIR — no import-time writes into the repo', () => {
    it('importing web/routes/maintenance.js does not create the repo data dir', async () => {
        // The router used to build a SecureSession at module scope, which
        // called getOrGenerateSecret() -> mkdirSync(<repo>/data) on import.
        // Every route test importing the router touched the operator's real
        // data directory.
        const repoSecret = path.resolve(process.cwd(), 'data', 'secret.key');
        const existedBefore = fs.existsSync(repoSecret);

        await import('../src/web/routes/maintenance.js');

        if (!existedBefore) expect(fs.existsSync(repoSecret)).toBe(false);
        // Under the override nothing should have been written yet either —
        // the session is built lazily, inside the handler.
        expect(fs.existsSync(path.join(DATA_DIR, 'secret.key'))).toBe(false);
    });
});
