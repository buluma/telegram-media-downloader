import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-secret-'));
let secret;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    secret = await import('../src/core/secret.js');
});

afterAll(() => {
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('getOrGenerateSecret', () => {
    it('generates once and reuses the stored secret', () => {
        const a = secret.getOrGenerateSecret();
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(secret.getOrGenerateSecret()).toBe(a);
    });

    it.skipIf(process.platform === 'win32')(
        'replaces an empty leftover file and tightens its permissions',
        () => {
            const file = path.join(DATA_DIR, 'secret.key');
            fs.writeFileSync(file, '');
            fs.chmodSync(file, 0o644);
            const s = secret.getOrGenerateSecret();
            expect(fs.readFileSync(file, 'utf8')).toBe(s);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        },
    );
});
