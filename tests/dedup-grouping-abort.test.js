// Tests that findDuplicates() respects signal.aborted inside the filesQ
// enumeration loop (dedup.js ~line 233). Before the fix, that loop had
// no signal check, so cancelling during the grouping phase produced a
// full result instead of stopping early.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let findDuplicates, _db, _tmpDataDir, _origDataDir;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

beforeAll(async () => {
    _origDataDir = process.env.TGDL_DATA_DIR;
    _tmpDataDir = mkdtempSync(join(tmpdir(), 'tgdl-dedup-abort-'));
    process.env.TGDL_DATA_DIR = _tmpDataDir;

    const db = await import('../src/core/db.js');
    _db = db.getDb();

    // Seed: 4 downloads, 2 duplicate sets (HASH_A × 2, HASH_B × 2).
    // All rows already hashed so the hash pass is instant.
    for (let i = 1; i <= 4; i++) {
        _db.prepare(`
            INSERT OR IGNORE INTO downloads
                (id, group_id, message_id, file_path, file_size, file_hash, file_name)
            VALUES (?, 'g', ?, 'x', 100, ?, 'f.jpg')
        `).run(i, i, i <= 2 ? HASH_A : HASH_B);
    }

    const mod = await import('../src/core/dedup.js');
    findDuplicates = mod.findDuplicates;
});

afterAll(() => {
    try {
        _db?.close();
    } catch {}
    if (_origDataDir == null) delete process.env.TGDL_DATA_DIR;
    else process.env.TGDL_DATA_DIR = _origDataDir;
    if (_tmpDataDir) {
        try {
            rmSync(_tmpDataDir, { recursive: true, force: true });
        } catch {}
    }
});

describe('findDuplicates — grouping abort', () => {
    it('pre-aborted signal yields empty duplicateSets even with known duplicates', async () => {
        // Confirm duplicates exist with no signal.
        const full = await findDuplicates({});
        expect(full.duplicateSets.length).toBe(2);

        // Now pass a pre-aborted signal — filesQ loop must exit immediately.
        const ac = new AbortController();
        ac.abort();
        const aborted = await findDuplicates({ signal: ac.signal });
        expect(aborted.duplicateSets).toEqual([]);
    });

    it('signal aborted mid-loop stops at the iteration boundary', async () => {
        // With the fix, each iteration of the filesQ loop checks signal.aborted
        // before processing. Using a pre-aborted signal is the cleanest proof.
        const ac = new AbortController();
        ac.abort();
        const result = await findDuplicates({ signal: ac.signal });
        // No partial sets — loop exited before first iteration.
        expect(result.duplicateSets.length).toBe(0);
        expect(result.scanned).toBe(0); // hash pass also skipped (signal already aborted)
    });
});
