// Google Drive provider — mock-only test against a stubbed `googleapis`
// module. Verifies the provider:
//   - rejects missing OAuth fields
//   - resolves the root folder id (creating one when folderName is given
//     and no folderId is supplied)
//   - uploads tag files with appProperties: { 'tgdl-backup': '1' }
//   - de-duplicates same-named uploads via update() rather than create()
//   - handles missing files in stat() / delete() without throwing

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const SOURCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gd-src-'));
const sourceFile = path.join(SOURCE_DIR, 'sample.txt');
fs.writeFileSync(sourceFile, 'hello drive world');

// In-memory drive state. Each test resets it via beforeEach.
const state = {
    files: new Map(), // id → { id, name, parents, mimeType, size, appProperties, modifiedTime, md5Checksum }
    nextId: 1,
    log: [], // method-call log for assertions
};

function _newId() {
    return `f-${state.nextId++}`;
}

const driveStub = {
    about: {
        get: async (_args) => {
            state.log.push(['about.get']);
            return { data: { user: { emailAddress: 'tester@example.com' } } };
        },
    },
    files: {
        list: async (args) => {
            state.log.push(['files.list', args]);
            const matchByName = /name='([^']+)'/.exec(args.q || '');
            const matchByParent = /'([^']+)' in parents/.exec(args.q || '');
            const wantsFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(
                args.q || '',
            );
            const wantsNotFolder = /mimeType!='application\/vnd\.google-apps\.folder'/.test(
                args.q || '',
            );
            const trashedFalse = /trashed=false/.test(args.q || '');
            const out = [];
            for (const f of state.files.values()) {
                if (matchByName && f.name !== matchByName[1]) continue;
                if (matchByParent && !(f.parents || []).includes(matchByParent[1])) continue;
                if (wantsFolder && f.mimeType !== 'application/vnd.google-apps.folder') continue;
                if (wantsNotFolder && f.mimeType === 'application/vnd.google-apps.folder') continue;
                if (trashedFalse && f.trashed) continue;
                out.push(f);
            }
            return { data: { files: out } };
        },
        create: async (args) => {
            state.log.push(['files.create', args.requestBody]);
            const id = _newId();
            const file = {
                id,
                name: args.requestBody.name,
                parents: args.requestBody.parents || [],
                mimeType: args.requestBody.mimeType || 'application/octet-stream',
                appProperties: args.requestBody.appProperties || {},
                size: 17,
                modifiedTime: new Date().toISOString(),
                md5Checksum: 'fake-md5',
            };
            state.files.set(id, file);
            // Drain the media body if any.
            if (args.media?.body && typeof args.media.body.on === 'function') {
                await new Promise((res) => {
                    args.media.body.on('data', () => {});
                    args.media.body.on('end', res);
                    args.media.body.on('error', res);
                    args.media.body.resume?.();
                });
            }
            return { data: file };
        },
        update: async (args) => {
            state.log.push(['files.update', args.fileId]);
            const f = state.files.get(args.fileId);
            if (!f) throw Object.assign(new Error('not found'), { code: 404 });
            f.modifiedTime = new Date().toISOString();
            return { data: f };
        },
        delete: async (args) => {
            state.log.push(['files.delete', args.fileId]);
            state.files.delete(args.fileId);
            return {};
        },
        get: async (args) => {
            const f = state.files.get(args.fileId);
            if (!f) throw Object.assign(new Error('not found'), { code: 404 });
            return { data: f };
        },
    },
};

vi.mock('googleapis', () => {
    class OAuth2 {
        constructor() {}
        setCredentials() {}
    }
    return {
        google: {
            auth: { OAuth2 },
            drive: () => driveStub,
        },
    };
});

let GoogleDriveProvider;
const ctx = { destinationId: 1, log: () => {}, signal: new AbortController().signal };

beforeEach(async () => {
    state.files.clear();
    state.nextId = 1;
    state.log = [];
    const mod = await import('../src/core/backup/providers/gdrive.js');
    GoogleDriveProvider = mod.GoogleDriveProvider;
});

// Reclaim the fixture directory — see the note in the dropbox provider test.
// Leaving these behind filled the disk and made unrelated suites fail ENOSPC.
afterAll(() => {
    fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
});

describe('backup/providers/gdrive (mocked)', () => {
    it('rejects missing OAuth fields with an actionable hint', async () => {
        const p = new GoogleDriveProvider();
        await expect(p.init({ clientId: 'x' }, ctx)).rejects.toThrow(/refreshToken/);
    });

    it('init creates the backup folder when folderId is empty', async () => {
        const p = new GoogleDriveProvider();
        await p.init(
            {
                clientId: 'cid',
                clientSecret: 'sec',
                refreshToken: 'rt',
                folderName: 'tgdl-backup',
            },
            ctx,
        );
        // A folder with name 'tgdl-backup' under root should have been
        // created (no pre-existing match).
        const created = state.log.find(
            (c) =>
                c[0] === 'files.create' &&
                c[1].mimeType === 'application/vnd.google-apps.folder' &&
                c[1].name === 'tgdl-backup',
        );
        expect(created).toBeTruthy();
    });

    it('upload stamps appProperties + scopes parents to the backup folder', async () => {
        const p = new GoogleDriveProvider();
        await p.init(
            {
                clientId: 'cid',
                clientSecret: 'sec',
                refreshToken: 'rt',
                folderName: 'tgdl-backup',
            },
            ctx,
        );

        const r = await p.upload(sourceFile, 'group/photos/sample.txt', {}, ctx);
        expect(r.remotePath).toBe('group/photos/sample.txt');

        // The leaf file create call should carry appProperties.tgdl-backup.
        const fileCreates = state.log.filter(
            (c) =>
                c[0] === 'files.create' && c[1].mimeType !== 'application/vnd.google-apps.folder',
        );
        expect(fileCreates.length).toBe(1);
        expect(fileCreates[0][1].appProperties['tgdl-backup']).toBe('1');
        expect(fileCreates[0][1].parents).toBeTruthy();
        expect(fileCreates[0][1].parents.length).toBe(1);
    });

    it('re-uploading the same path uses update() not create()', async () => {
        const p = new GoogleDriveProvider();
        await p.init(
            {
                clientId: 'cid',
                clientSecret: 'sec',
                refreshToken: 'rt',
                folderName: 'tgdl-backup',
            },
            ctx,
        );
        await p.upload(sourceFile, 'sample.txt', {}, ctx);
        const beforeUpdates = state.log.filter((c) => c[0] === 'files.update').length;
        await p.upload(sourceFile, 'sample.txt', {}, ctx);
        const afterUpdates = state.log.filter((c) => c[0] === 'files.update').length;
        expect(afterUpdates).toBe(beforeUpdates + 1);
    });

    it('stat returns null for a missing file (not throw)', async () => {
        const p = new GoogleDriveProvider();
        await p.init(
            {
                clientId: 'cid',
                clientSecret: 'sec',
                refreshToken: 'rt',
                folderName: 'tgdl-backup',
            },
            ctx,
        );
        const st = await p.stat('does/not/exist.txt', ctx);
        expect(st).toBeNull();
    });

    it('escapes backslashes as well as quotes in Drive folder-name queries', async () => {
        const p = new GoogleDriveProvider();
        state.log.length = 0;
        // folderName is the one raw name that reaches a Drive query; file
        // paths have their backslashes turned into separators first.
        await p.init(
            {
                clientId: 'cid',
                clientSecret: 'sec',
                refreshToken: 'rt',
                folderName: "it's\\",
            },
            ctx,
        );
        const qs = state.log.filter((e) => e[0] === 'files.list').map((e) => e[1].q);
        // A lone `\'` would let a trailing backslash escape the closing quote.
        expect(qs.some((q) => q.includes(String.raw`name='it\'s\\'`))).toBe(true);
    });

    it('delete is idempotent — missing file is a no-op', async () => {
        const p = new GoogleDriveProvider();
        await p.init(
            {
                clientId: 'cid',
                clientSecret: 'sec',
                refreshToken: 'rt',
                folderName: 'tgdl-backup',
            },
            ctx,
        );
        await expect(p.delete('does/not/exist.txt', ctx)).resolves.toBeUndefined();
    });
});
