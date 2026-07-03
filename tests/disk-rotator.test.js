import { describe, it, expect, vi } from 'vitest';
import { parseSize } from '../src/core/disk-rotator.js';

describe('parseSize (disk-rotator)', () => {
    it('parses plain numbers as bytes', () => {
        expect(parseSize('1024')).toBe(1024);
        expect(parseSize(512)).toBe(512);
    });

    it('parses unit suffixes (KB / MB / GB / TB)', () => {
        expect(parseSize('10KB')).toBe(10 * 1024);
        expect(parseSize('500 MB')).toBe(500 * 1024 ** 2);
        expect(parseSize('10 GB')).toBe(10 * 1024 ** 3);
        expect(parseSize('1TB')).toBe(1024 ** 4);
    });

    it('is case-insensitive and tolerates whitespace', () => {
        expect(parseSize(' 2 gb ')).toBe(2 * 1024 ** 3);
        expect(parseSize('2gB')).toBe(2 * 1024 ** 3);
    });

    it('accepts fractional values', () => {
        expect(parseSize('1.5 GB')).toBe(Math.floor(1.5 * 1024 ** 3));
    });

    it('returns 0 for falsy / empty / nonsense input (treated as no cap)', () => {
        expect(parseSize(null)).toBe(0);
        expect(parseSize(undefined)).toBe(0);
        expect(parseSize('')).toBe(0);
        expect(parseSize('   ')).toBe(0);
        expect(parseSize('not a size')).toBe(0);
        expect(parseSize('GB10')).toBe(0);
    });

    it('rejects negative values', () => {
        expect(parseSize('-5GB')).toBe(0);
    });
});

// ── sweep(): skip-only windows must not hang ─────────────────────────────
//
// Found live 2026-07-03: every configured group had rescueMode 'on', so the
// oldest N rows (the fixed-size window sweep() re-fetched every pass) were
// ALL rescue-protected. Skipping a row never shrank the retry budget or
// changed which rows "oldest N" returned, so the outer loop re-fetched and
// re-skipped the identical rows forever — a real hang, reproduced with a
// 30s manual timeout against the live DB (confirmed the process never
// returned). Fixed by tracking already-considered ids and widening the
// fetch window on a fully-skipped pass instead of re-fetching it.

describe('DiskRotator.sweep — skip-only window handling', () => {
    async function buildRotator({ rows, capBytes, sweepBatch }) {
        vi.resetModules();
        const remaining = new Map(rows.map((r) => [r.id, r]));
        vi.doMock('../src/core/db.js', () => ({
            getTotalSizeBytes: () => [...remaining.values()].reduce((s, r) => s + r.file_size, 0),
            getOldestDownloads: (limit) =>
                [...remaining.values()].sort((a, b) => a.id - b.id).slice(0, limit),
            deleteDownloadsBy: () => {},
            setDownloadEvicted: (id) => remaining.delete(id),
        }));
        vi.doMock('../src/core/backup/queue.js', () => ({ hasMirrorDestinations: () => false }));
        vi.doMock('../src/core/delete-queue.js', () => ({ deferDelete: async () => {} }));
        vi.doMock('../src/core/thumbs.js', () => ({ purgeThumbsForDownload: async () => {} }));
        vi.doMock('../src/core/seekbar/index.js', () => ({
            purgeSeekbarForDownload: async () => {},
        }));

        const { DiskRotator } = await import('../src/core/disk-rotator.js');
        const groups = [...new Set(rows.map((r) => r.group_id))].map((id) => ({
            id,
            rescueMode: id === 'protected' ? 'on' : 'off',
        }));
        return new DiskRotator({
            loadConfig: () => ({
                diskManagement: { enabled: true, maxTotalSize: capBytes },
                advanced: sweepBatch ? { diskRotator: { sweepBatch } } : {},
                groups,
            }),
            broadcast: () => {},
            getActiveFilePaths: () => null,
        });
    }

    it('terminates instead of hanging when every candidate row is skip-only', async () => {
        // All 60 rows belong to a rescue-protected group — nothing sweep()
        // is allowed to touch. Regression test for the exact production
        // shape: uniform rescueMode across every group.
        const rows = Array.from({ length: 60 }, (_, i) => ({
            id: i + 1,
            group_id: 'protected',
            file_path: `f${i + 1}.mp4`,
            file_size: 10_000_000,
        }));
        const rotator = await buildRotator({ rows, capBytes: 1, sweepBatch: 10 });

        const result = await Promise.race([
            rotator.sweep(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('sweep() hung — did not resolve in 2s')), 2000),
            ),
        ]);

        expect(result.deleted).toBe(0);
        expect(result.after).toBe(result.before); // nothing eligible, nothing removed
    });

    it('widens past a fully-protected prefix to reach eligible rows further back', async () => {
        // First 55 rows (oldest) are protected; the next 5 are not. A fixed
        // batch of 10 would only ever see the protected prefix — sweep()
        // must widen the fetch window to reach the eligible rows.
        const rows = [
            ...Array.from({ length: 55 }, (_, i) => ({
                id: i + 1,
                group_id: 'protected',
                file_path: `p${i + 1}.mp4`,
                file_size: 10_000_000,
            })),
            ...Array.from({ length: 5 }, (_, i) => ({
                id: 56 + i,
                group_id: 'free',
                file_path: `f${56 + i}.mp4`,
                file_size: 10_000_000,
            })),
        ];
        const totalBytes = rows.length * 10_000_000;
        const rotator = await buildRotator({
            rows,
            // Exactly the 55 protected rows' worth — satisfying the cap
            // requires deleting every one of the 5 unprotected rows.
            capBytes: totalBytes - 5 * 10_000_000,
            sweepBatch: 10,
        });

        const result = await Promise.race([
            rotator.sweep(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('sweep() hung — did not resolve in 2s')), 2000),
            ),
        ]);

        expect(result.deleted).toBe(5); // only the 5 unprotected rows exist to delete
        expect(result.after).toBe(result.before - 5 * 10_000_000);
    });
});
