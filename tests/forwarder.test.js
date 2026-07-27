// Covers the auto-forwarder's two decision points: process()'s early-exit
// gate (no group / disabled / missing autoForward block) and
// resolveDestination()'s ID-resolution chain (alias → InputEntity → Entity →
// raw -100 InputPeerChannel fallback).

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoForwarder } from '../src/core/forwarder.js';

function fakeClient(overrides = {}) {
    return {
        getInputEntity: vi.fn(),
        getEntity: vi.fn(),
        getDialogs: vi.fn(),
        invoke: vi.fn(),
        sendFile: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('AutoForwarder.process — early-exit gates', () => {
    it('no-ops when the group is not in config', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, { groups: [] });
        await fwd.process({ groupId: '999', groupName: 'unknown', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('no-ops when the group has no autoForward block', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, { groups: [{ id: '1' }] });
        await fwd.process({ groupId: '1', groupName: 'g', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('no-ops when autoForward is disabled', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, {
            groups: [{ id: '1', autoForward: { enabled: false, destination: 'me' } }],
        });
        await fwd.process({ groupId: '1', groupName: 'g', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });
});

describe('AutoForwarder.process — dedup skip', () => {
    it('no-ops when deduped flag is true, even if group + autoForward are enabled', async () => {
        const client = fakeClient({ sendFile: vi.fn() });
        const fwd = new AutoForwarder(client, {
            groups: [{ id: '1', autoForward: { enabled: true, destination: 'me' } }],
        });
        await fwd.process({
            groupId: '1',
            groupName: 'g',
            filePath: '/some/file.jpg',
            message: {},
            mediaType: 'photos',
            deduped: true,
        });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('proceeds normally when deduped is false', async () => {
        const tmpFile = path.join(os.tmpdir(), `fwd-test-${Date.now()}.jpg`);
        await fs.writeFile(tmpFile, 'x');
        try {
            const client = fakeClient({
                getInputEntity: vi.fn().mockResolvedValue('me'),
                sendFile: vi.fn().mockResolvedValue({ id: 42 }),
            });
            const fwd = new AutoForwarder(client, {
                groups: [{ id: '1', autoForward: { enabled: true, destination: 'me' } }],
            });
            await fwd.process({
                groupId: '1',
                groupName: 'g',
                filePath: tmpFile,
                message: {},
                mediaType: 'photos',
                deduped: false,
            });
            expect(client.sendFile).toHaveBeenCalled();
        } finally {
            await fs.unlink(tmpFile).catch(() => {});
        }
    });
});

describe('AutoForwarder.resolveDestination — alias + caching', () => {
    it('returns "me" for the "me" alias verbatim', async () => {
        const fwd = new AutoForwarder(fakeClient(), { groups: [] });
        await expect(fwd.resolveDestination('me', fakeClient())).resolves.toBe('me');
    });

    it('returns "me" for the "saved" alias (Saved Messages)', async () => {
        const fwd = new AutoForwarder(fakeClient(), { groups: [] });
        await expect(fwd.resolveDestination('saved', fakeClient())).resolves.toBe('me');
    });

    it('returns the cached storageChannelId on subsequent storage lookups', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, { groups: [] });
        const cached = { id: 'cached-channel' };
        fwd.storageChannelId = cached;
        await expect(fwd.resolveDestination('storage', client)).resolves.toBe(cached);
        expect(client.getDialogs).not.toHaveBeenCalled();
    });

    it('passes plain strings through as username/phone', async () => {
        const fwd = new AutoForwarder(fakeClient(), { groups: [] });
        await expect(fwd.resolveDestination('@channel_name', fakeClient())).resolves.toBe(
            '@channel_name',
        );
    });
});

describe('AutoForwarder.resolveDestination — numeric ID chain', () => {
    it('returns the InputEntity when the cheap getInputEntity path succeeds', async () => {
        const peer = { _: 'InputPeerChannel', cached: true };
        const client = fakeClient({ getInputEntity: vi.fn().mockResolvedValue(peer) });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('-1001234567890', client)).resolves.toBe(peer);
        expect(client.getEntity).not.toHaveBeenCalled();
    });

    it('falls back to getEntity when getInputEntity throws', async () => {
        const entity = { _: 'Channel', id: 'resolved' };
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('not cached')),
            getEntity: vi.fn().mockResolvedValue(entity),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('-1001234567890', client)).resolves.toBe(entity);
    });

    it('falls back to a manual InputPeerChannel for -100… IDs when both lookups fail', async () => {
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('nope')),
            getEntity: vi.fn().mockRejectedValue(new Error('nope')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const out = await fwd.resolveDestination('-1001234567890', client);
        expect(out?.className || out?.constructor?.name).toMatch(/InputPeerChannel/);
        expect(BigInt(out.channelId)).toBe(1234567890n);
    });

    it('falls back to InputPeerChat for plain negative IDs (legacy chats)', async () => {
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('nope')),
            getEntity: vi.fn().mockRejectedValue(new Error('nope')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const out = await fwd.resolveDestination('-42', client);
        expect(out?.className || out?.constructor?.name).toMatch(/InputPeerChat/);
        expect(BigInt(out.chatId)).toBe(42n);
    });

    it('returns the parsed BigInt when neither -100 nor - prefix matches', async () => {
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('nope')),
            getEntity: vi.fn().mockRejectedValue(new Error('nope')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const out = await fwd.resolveDestination('1234567890', client);
        expect(typeof out).toBe('bigint');
        expect(out).toBe(1234567890n);
    });
});

describe('AutoForwarder.resolveDestination — storage channel discovery', () => {
    it('caches the dialog match when one already exists', async () => {
        const found = { title: 'Telegram Downloader Storage', entity: { _: 'Channel', id: 5n } };
        const client = fakeClient({
            getDialogs: vi.fn().mockResolvedValue([{ title: 'Other channel', entity: {} }, found]),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const first = await fwd.resolveDestination('storage', client);
        const second = await fwd.resolveDestination('storage', client);
        expect(first).toBe(found.entity);
        expect(second).toBe(found.entity);
        expect(client.getDialogs).toHaveBeenCalledTimes(1);
    });

    it('creates a new storage channel when no match is found', async () => {
        const created = { _: 'Channel', id: 'new' };
        const client = fakeClient({
            getDialogs: vi.fn().mockResolvedValue([]),
            invoke: vi.fn().mockResolvedValue({ chats: [created] }),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('storage', client)).resolves.toBe(created);
        expect(client.invoke).toHaveBeenCalled();
    });

    it('returns null when the storage-channel discovery throws', async () => {
        const client = fakeClient({
            getDialogs: vi.fn().mockRejectedValue(new Error('rpc down')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('storage', client)).resolves.toBeNull();
    });
});

describe('AutoForwarder.process — 60-second delete grace period', () => {
    it('delays deferDelete by 60s after a successful forward', async () => {
        // Dynamic imports before fake timers — vitest + fake-timers can
        // deadlock when import() is called inside a mocked timer context.
        const deleteQueue = await import('../src/core/delete-queue.js');
        const dbModule = await import('../src/core/db.js');

        // Real filesystem work happens BEFORE the clock is faked. process()
        // also awaits a real fs.access (forwarder.js), whose callback lands
        // from libuv — see waitForGraceTimer below for why that matters.
        const tmpFile = path.join(os.tmpdir(), `fwd-grace-${Date.now()}.jpg`);
        await fs.writeFile(tmpFile, 'data');

        // Narrow `toFake`: the default also fakes setImmediate, which would
        // leave this test no way to yield a real macrotask — and a pending
        // libuv fs callback can only land on one.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        // Stub deferDelete so the test doesn't touch the real filesystem.
        const deleteSpy = vi.spyOn(deleteQueue, 'deferDelete').mockResolvedValue(undefined);

        // Stub getDb so the sharedCount check doesn't need a real DB.
        vi.spyOn(dbModule, 'getDb').mockReturnValue({
            prepare: () => ({ get: () => ({ n: 1 }) }),
        });

        const client = fakeClient({
            getInputEntity: vi.fn().mockResolvedValue('me'),
            sendFile: vi.fn().mockResolvedValue({ id: 1 }),
        });
        const config = {
            groups: [
                {
                    id: '1',
                    autoForward: {
                        enabled: true,
                        destination: 'me',
                        deleteAfterForward: true,
                        keepImages: false,
                        keepVideos: false,
                    },
                },
            ],
        };
        const fwd = new AutoForwarder(client, config);
        const processPromise = fwd.process({
            groupId: '1',
            groupName: 'g',
            filePath: tmpFile,
            message: {},
            mediaType: 'photos',
            deduped: false,
        });

        // Wait until the grace timer actually exists before touching the
        // clock. Advancing on a fixed guess is a race: process() parks on a
        // real fs.access first, and if that callback has not landed yet the
        // 60s timer is scheduled *after* the advance, so it never fires and
        // the await below hangs until the test times out. That is the flake
        // this loop removes — it only ever showed up under full-suite load,
        // when a busy thread pool delays the fs callback.
        const waitForGraceTimer = async () => {
            for (let i = 0; i < 500; i++) {
                if (vi.getTimerCount() > 0) return;
                await new Promise((r) => setImmediate(r));
            }
            throw new Error('the 60s grace timer was never scheduled');
        };
        await waitForGraceTimer();

        // Scheduled but not yet elapsed: the delete must still be pending.
        expect(deleteSpy).not.toHaveBeenCalled();

        // Straddle the boundary so the assertion pins the grace period at
        // 60s, not merely "some delay happened".
        await vi.advanceTimersByTimeAsync(59_999);
        expect(deleteSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await processPromise;

        expect(deleteSpy).toHaveBeenCalledWith(tmpFile);

        vi.useRealTimers();
        vi.restoreAllMocks();
        await fs.unlink(tmpFile).catch(() => {});
    });
});
