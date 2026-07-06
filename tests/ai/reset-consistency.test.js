// Reset actions must not leave ghost rows in media_scan_state.
//
// resetAllAiData() wipes every AI artefact and re-queues every download,
// so stale 'failed'/'done' scan-state rows would immediately lie to the
// issues panel ("durable scanner failures" for rows that were just
// re-queued) and to retry-failed. Same story for the faces-only reindex
// path, scoped to scanner='faces'.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-reset-consistency-'));

let db;
let resetAllAiData;
let markScanFailed, markScanDone, getScanStateCounts;

let _seq = 0;
function insertPhoto() {
    _seq += 1;
    const id = db
        .prepare(
            `INSERT INTO downloads (group_id, message_id, file_type, file_path, file_name, status)
             VALUES ('grp1', ?, 'photo', ?, ?, 'completed')`,
        )
        .run(200000 + _seq, `/data/downloads/images/r${_seq}.jpg`, `r${_seq}.jpg`).lastInsertRowid;
    return Number(id);
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../../src/core/db.js');
    db = dbMod.getDb();
    ({ resetAllAiData } = await import('../../src/core/db/faces.js'));
    ({ markScanFailed, markScanDone, getScanStateCounts } = await import(
        '../../src/core/db/scan-state.js'
    ));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('resetAllAiData', () => {
    it('clears media_scan_state for every scanner', () => {
        const a = insertPhoto();
        const b = insertPhoto();
        const c = insertPhoto();
        markScanFailed(a, 'wd14', 'sidecar 500');
        markScanFailed(b, 'embed', 'boom');
        markScanDone(c, 'faces');

        const r = resetAllAiData();
        expect(r.scanState).toBe(3);

        for (const sc of ['wd14', 'ocr', 'faces', 'embed']) {
            const counts = getScanStateCounts(sc);
            expect(counts.failed).toBe(0);
            expect(counts.done).toBe(0);
        }
    });
});
