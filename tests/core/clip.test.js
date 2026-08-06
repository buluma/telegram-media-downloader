// Tests for src/core/clip.js — trims a real short synthetic MP4 with real
// ffmpeg/ffprobe (same "real files on disk" convention as
// routes-downloads.test.js) rather than mocking the spawn, since the whole
// point of the module is correctly shelling out and parsing ffmpeg's
// behaviour.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-clip-test-'));
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

let dbApi, downloadsApi, clipApi;
// Checked synchronously at collection time — `describe.skipIf` evaluates
// before `beforeAll` runs, so this can't wait on the async import below.
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

function makeTestVideo(relPath, durationSec = 4) {
    const abs = path.join(DOWNLOADS_DIR, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const r = spawnSync(
        'ffmpeg',
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            `testsrc=duration=${durationSec}:size=64x64:rate=10`,
            '-f',
            'lavfi',
            '-i',
            `sine=duration=${durationSec}`,
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-y',
            abs,
        ],
        { windowsHide: true },
    );
    if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr}`);
    return abs;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../../src/core/db.js');
    dbApi.getDb();
    downloadsApi = await import('../../src/core/db/downloads.js');
    clipApi = await import('../../src/core/clip.js');
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

beforeEach(() => {
    dbApi.getDb().prepare('DELETE FROM downloads').run();
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
});

describe('createClip — validation', () => {
    it('rejects a nonexistent download id', async () => {
        const r = await clipApi.createClip(999999, 0, 1);
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/not found/i);
    });

    it('rejects when startSec >= endSec', async () => {
        const ins = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileName: 'a.mp4',
            filePath: 'G/videos/a.mp4',
            fileType: 'video',
        });
        const r = await clipApi.createClip(ins.lastInsertRowid, 3, 1);
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/range/i);
    });

    it('rejects negative startSec', async () => {
        const ins = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileName: 'a.mp4',
            filePath: 'G/videos/a.mp4',
            fileType: 'video',
        });
        const r = await clipApi.createClip(ins.lastInsertRowid, -1, 2);
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/range/i);
    });

    it('rejects a non-video row', async () => {
        const ins = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileName: 'a.pdf',
            filePath: 'G/docs/a.pdf',
            fileType: 'document',
        });
        const r = await clipApi.createClip(ins.lastInsertRowid, 0, 1);
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/video/i);
    });

    it('404s (errors) when the on-disk file is missing', async () => {
        const ins = downloadsApi.insertDownload({
            groupId: '-1',
            groupName: 'G',
            messageId: 1,
            fileName: 'gone.mp4',
            filePath: 'G/videos/gone.mp4',
            fileType: 'video',
        });
        const r = await clipApi.createClip(ins.lastInsertRowid, 0, 1);
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/not found|missing/i);
    });
});

describe.skipIf(!hasFfmpeg)('createClip — real trim', () => {
    it('trims a range and inserts a new downloads row', async () => {
        makeTestVideo('G/videos/src.mp4', 4);
        const ins = downloadsApi.insertDownload({
            groupId: '-42',
            groupName: 'G',
            messageId: 1,
            fileName: 'src.mp4',
            filePath: 'G/videos/src.mp4',
            fileType: 'video',
        });

        const r = await clipApi.createClip(ins.lastInsertRowid, 1, 3);
        expect(r.status).toBe('ok');
        expect(r.id).toBeGreaterThan(0);
        expect(r.id).not.toBe(ins.lastInsertRowid);
        expect(r.fileSize).toBeGreaterThan(0);

        const row = downloadsApi.getDownloadById(r.id);
        expect(row).toBeTruthy();
        expect(row.file_type).toBe('video');
        expect(row.group_id).toBe('-42');
        // Source row must be untouched — clip is a copy, not a mutation.
        const srcRow = downloadsApi.getDownloadById(ins.lastInsertRowid);
        expect(srcRow.file_path).toBe('G/videos/src.mp4');

        const clipAbs = path.join(DOWNLOADS_DIR, row.file_path);
        expect(fs.existsSync(clipAbs)).toBe(true);
    });

    it('two clips from the same source get distinct message_ids (no UNIQUE collision)', async () => {
        makeTestVideo('G/videos/src2.mp4', 4);
        const ins = downloadsApi.insertDownload({
            groupId: '-43',
            groupName: 'G',
            messageId: 1,
            fileName: 'src2.mp4',
            filePath: 'G/videos/src2.mp4',
            fileType: 'video',
        });

        const r1 = await clipApi.createClip(ins.lastInsertRowid, 0, 1);
        const r2 = await clipApi.createClip(ins.lastInsertRowid, 1, 2);
        expect(r1.status).toBe('ok');
        expect(r2.status).toBe('ok');
        expect(r1.id).not.toBe(r2.id);
    });

    it('rejects endSec beyond the source duration', async () => {
        makeTestVideo('G/videos/short.mp4', 2);
        const ins = downloadsApi.insertDownload({
            groupId: '-44',
            groupName: 'G',
            messageId: 1,
            fileName: 'short.mp4',
            filePath: 'G/videos/short.mp4',
            fileType: 'video',
        });
        const r = await clipApi.createClip(ins.lastInsertRowid, 0, 999);
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/duration|range/i);
    });

    // Regression: two clips whose start/end round to the same integer
    // second used to produce identical filenames — the second fs.rename
    // silently overwrote the first clip's file while both got their own
    // DB row, leaving one row's file_path aliasing another's.
    it('two clips with the same rounded start/end do not collide on disk', async () => {
        makeTestVideo('G/videos/same-round.mp4', 4);
        const ins = downloadsApi.insertDownload({
            groupId: '-45',
            groupName: 'G',
            messageId: 1,
            fileName: 'same-round.mp4',
            filePath: 'G/videos/same-round.mp4',
            fileType: 'video',
        });

        // 1.0/2.0 and 0.9/2.1 both round to "1s"/"2s" — same outName under
        // the old naming scheme despite being genuinely different ranges.
        const r1 = await clipApi.createClip(ins.lastInsertRowid, 1.0, 2.0);
        const r2 = await clipApi.createClip(ins.lastInsertRowid, 0.9, 2.1);
        expect(r1.status).toBe('ok');
        expect(r2.status).toBe('ok');
        expect(r1.filePath).not.toBe(r2.filePath);

        const abs1 = path.join(DOWNLOADS_DIR, r1.filePath);
        const abs2 = path.join(DOWNLOADS_DIR, r2.filePath);
        expect(fs.existsSync(abs1)).toBe(true);
        expect(fs.existsSync(abs2)).toBe(true);

        // Both DB rows must still point at files that actually exist —
        // the bug this guards against left one row's file_path pointing
        // at nothing (or at the other row's file) after the overwrite.
        const row1 = downloadsApi.getDownloadById(r1.id);
        const row2 = downloadsApi.getDownloadById(r2.id);
        expect(row1.file_path).toBe(r1.filePath);
        expect(row2.file_path).toBe(r2.filePath);
    });
});
