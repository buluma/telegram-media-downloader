// Hash worker pool — feed a known buffer, expect a known SHA-256.
// Validates BOTH the worker-thread pool path AND the in-process fallback,
// since `HASH_WORKER_DISABLE=1` should produce a byte-identical digest.

import { describe, it, expect, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-hash-'));
const TEST_FILE = path.join(TMP_DIR, 'sample.bin');
// 1 MiB of pseudo-random bytes plus the literal string "telegram-media-downloader"
// so the digest is deterministic but representative of a real file.
const PAYLOAD = Buffer.concat([
    Buffer.from('telegram-media-downloader', 'utf8'),
    Buffer.from(new Uint8Array(1024 * 1024).map((_, i) => i & 0xff)),
]);
fs.writeFileSync(TEST_FILE, PAYLOAD);
const EXPECTED = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

afterAll(async () => {
    try {
        const mod = await import('../src/core/hash-worker.js');
        await mod.shutdownHashPool();
    } catch {}
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('hash-worker pool', () => {
    it('returns the same SHA-256 as crypto.createHash for a known buffer', {
        timeout: 15_000,
    }, async () => {
        const { hashFile } = await import('../src/core/hash-worker.js');
        const hex = await hashFile(TEST_FILE);
        expect(hex).toBe(EXPECTED);
    });

    it('matches the in-process streamer (sha256OfFile) byte-for-byte', async () => {
        const { sha256OfFile } = await import('../src/core/checksum.js');
        const a = await sha256OfFile(TEST_FILE);
        expect(a).toBe(EXPECTED);
    });

    it('handles concurrent requests for the same file deterministically', async () => {
        const { hashFile } = await import('../src/core/hash-worker.js');
        const results = await Promise.all([
            hashFile(TEST_FILE),
            hashFile(TEST_FILE),
            hashFile(TEST_FILE),
            hashFile(TEST_FILE),
        ]);
        for (const r of results) expect(r).toBe(EXPECTED);
    });

    it('rejects with a sensible error when the file is missing', async () => {
        const { hashFile } = await import('../src/core/hash-worker.js');
        await expect(hashFile(path.join(TMP_DIR, 'does-not-exist.bin'))).rejects.toThrow();
    });
});

describe('hash-worker timeout', () => {
    it('rejects when per-job timeout fires and pool recovers', async () => {
        // We need a file path that never reaches EOF so the hash worker
        // stalls and eventually times out.
        //   - Unix:  /dev/urandom is an infinite character device.
        //   - Win32: no equivalent — skip this timeout test.
        if (process.platform === 'win32') {
            return; // skip — no /dev/urandom equivalent on Windows
        }
        const infinitePath = '/dev/urandom';

        const prevTimeout = process.env.HASH_WORKER_TIMEOUT_MS;
        process.env.HASH_WORKER_TIMEOUT_MS = '100';
        const { hashFile, shutdownHashPool } = await import('../src/core/hash-worker.js');
        try {
            // Reset pool so new timeout value is picked up on next dispatch.
            await shutdownHashPool();

            const stalledPromise = hashFile(infinitePath);
            await expect(stalledPromise).rejects.toThrow(/timed out/i);

            // Pool must recover: normal hash works on the replacement slot.
            const hex = await hashFile(TEST_FILE);
            expect(hex).toBe(EXPECTED);
        } finally {
            if (prevTimeout === undefined) delete process.env.HASH_WORKER_TIMEOUT_MS;
            else process.env.HASH_WORKER_TIMEOUT_MS = prevTimeout;
        }
    }, 8000);
});

describe('hash-worker disabled fallback', () => {
    it('produces the same digest with HASH_WORKER_DISABLE=1', async () => {
        // We can't `delete process.env.HASH_WORKER_DISABLE` mid-suite
        // without restarting the worker, so the disabled flag is exercised
        // via the public API: importing checksum's pool entry point with
        // a fresh module pulls the env at lookup time.
        const prev = process.env.HASH_WORKER_DISABLE;
        process.env.HASH_WORKER_DISABLE = '1';
        try {
            const { sha256OfFileViaPool } = await import('../src/core/checksum.js');
            const hex = await sha256OfFileViaPool(TEST_FILE);
            expect(hex).toBe(EXPECTED);
        } finally {
            if (prev === undefined) delete process.env.HASH_WORKER_DISABLE;
            else process.env.HASH_WORKER_DISABLE = prev;
        }
    });
});
