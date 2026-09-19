// Verifies the duration backfill only touches videos with no known
// duration, writes the probed value, and leaves missing / unprobeable
// files NULL so a later run can retry them.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-duration-backfill-test-'));

const probes = new Map();
const probeDuration = vi.fn(async (abs) => probes.get(path.basename(abs)) ?? null);
vi.mock('../src/core/clip.js', () => ({ hasFfmpeg: () => true, probeDuration }));

let db;
let backfillDurations, getDurationStats;

function insertVideo(name, { duration = null, fileType = 'video', onDisk = true } = {}) {
    if (onDisk) {
        fs.mkdirSync(path.join(DATA_DIR, 'downloads', 'grp'), { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, 'downloads', 'grp', name), 'x');
    }
    return Number(
        db
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status, duration_sec)
                 VALUES ('grp', ?, ?, ?, ?, 'completed', ?)`,
            )
            .run(Math.floor(Math.random() * 1e9), fileType, `grp/${name}`, name, duration)
            .lastInsertRowid,
    );
}

const durationOf = (id) =>
    db.prepare('SELECT duration_sec FROM downloads WHERE id = ?').get(id).duration_sec;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = (await import('../src/core/db.js')).getDb();
    ({ backfillDurations, getDurationStats } = await import('../src/core/duration-backfill.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('backfillDurations', () => {
    it('probes only videos with no duration and reports what it did', async () => {
        probes.set('a.mp4', 125.5);
        probes.set('zero.mp4', 0);
        const a = insertVideo('a.mp4');
        const known = insertVideo('known.mp4', { duration: 42 });
        const spriteOnly = insertVideo('sprite.mp4');
        db.prepare(
            `INSERT INTO seekbar_sprites (download_id, sprite_path, meta_path, duration_sec, generated_at)
             VALUES (?, 's', 'm', 99, 0)`,
        ).run(spriteOnly);
        const photo = insertVideo('p.jpg', { fileType: 'photo' });
        const missing = insertVideo('gone.mp4', { onDisk: false });
        const unprobeable = insertVideo('bad.mp4');
        const zero = insertVideo('zero.mp4');

        expect(getDurationStats().pending).toBe(4); // a, missing, unprobeable, zero

        const progress = [];
        const result = await backfillDurations({ onProgress: (p) => progress.push(p) });

        expect(result).toMatchObject({ total: 4, processed: 4, updated: 1, missing: 1, failed: 2 });
        expect(durationOf(a)).toBe(125.5);
        expect(durationOf(known)).toBe(42);
        expect(durationOf(spriteOnly)).toBeNull();
        expect(durationOf(photo)).toBeNull();
        expect(durationOf(missing)).toBeNull();
        expect(durationOf(unprobeable)).toBeNull();
        expect(durationOf(zero)).toBeNull();
        expect(probeDuration.mock.calls.map(([p]) => path.basename(p)).sort()).toEqual([
            'a.mp4',
            'bad.mp4',
            'zero.mp4',
        ]);
        expect(progress.at(-1).stage).toBe('done');
        expect(getDurationStats().pending).toBe(3);
    });

    it('stops early when the signal is aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await backfillDurations({ signal: ac.signal });
        expect(result.cancelled).toBe(true);
        expect(result.processed).toBe(0);
    });
});
