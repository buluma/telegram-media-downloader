import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoForwarder } from '../src/core/forwarder.js';

function makeClient(overrides = {}) {
    return {
        getInputEntity: vi.fn().mockRejectedValue(new Error('not cached')),
        getEntity: vi.fn().mockRejectedValue(new Error('not found')),
        getDialogs: vi.fn().mockResolvedValue([]),
        invoke: vi.fn().mockResolvedValue({ chats: [] }),
        sendFile: vi.fn().mockResolvedValue({ id: 999 }),
        ...overrides,
    };
}

function makeConfig(groupOverrides = {}) {
    return {
        groups: [
            {
                id: '-1001234567890',
                autoForward: { enabled: true, destination: 'me', deleteAfterForward: false },
                ...groupOverrides,
            },
        ],
    };
}

describe('AutoForwarder.process', () => {
    it('skips when group has no autoForward config', async () => {
        const client = makeClient();
        const config = { groups: [{ id: '123' }] };
        const fwd = new AutoForwarder(client, config);

        await fwd.process({ filePath: '/tmp/a.jpg', groupId: '123', groupName: 'G', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('skips when autoForward.enabled is false', async () => {
        const client = makeClient();
        const config = makeConfig({ autoForward: { enabled: false, destination: 'me' } });
        const fwd = new AutoForwarder(client, config);

        await fwd.process({ filePath: '/tmp/a.jpg', groupId: '-1001234567890', groupName: 'G', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('skips when group not in config', async () => {
        const client = makeClient();
        const config = makeConfig();
        const fwd = new AutoForwarder(client, config);

        await fwd.process({ filePath: '/tmp/a.jpg', groupId: 'unknown', groupName: 'G', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('calls sendFile when autoForward enabled', async () => {
        const client = makeClient();
        const config = makeConfig();
        const fwd = new AutoForwarder(client, config);

        await fwd.process({
            filePath: '/tmp/a.jpg',
            groupId: '-1001234567890',
            groupName: 'TestGroup',
            message: { id: 42, message: 'hello' },
        });
        expect(client.sendFile).toHaveBeenCalledOnce();
    });

    it('uses per-group forwardAccount client when configured', async () => {
        const defaultClient = makeClient();
        const altClient = makeClient();
        const accountManager = { getClient: vi.fn(() => altClient) };
        const config = makeConfig({ forwardAccount: 'alt' });
        const fwd = new AutoForwarder(defaultClient, config, accountManager);

        await fwd.process({
            filePath: '/tmp/a.jpg',
            groupId: '-1001234567890',
            groupName: 'G',
            message: { id: 1, message: '' },
        });
        expect(accountManager.getClient).toHaveBeenCalledWith('alt');
        expect(altClient.sendFile).toHaveBeenCalledOnce();
        expect(defaultClient.sendFile).not.toHaveBeenCalled();
    });
});

describe('AutoForwarder.resolveDestination', () => {
    let fwd;

    beforeEach(() => {
        fwd = new AutoForwarder(makeClient(), makeConfig());
    });

    it('returns "me" for destination "me"', async () => {
        expect(await fwd.resolveDestination('me', makeClient())).toBe('me');
    });

    it('returns "me" for destination "saved"', async () => {
        expect(await fwd.resolveDestination('saved', makeClient())).toBe('me');
    });

    it('returns destination string for username', async () => {
        const result = await fwd.resolveDestination('somechannel', makeClient());
        expect(result).toBe('somechannel');
    });

    it('resolves numeric ID via getInputEntity', async () => {
        const peer = { _: 'InputPeerChannel' };
        const client = makeClient({ getInputEntity: vi.fn().mockResolvedValue(peer) });
        const result = await fwd.resolveDestination('-1009876543210', client);
        expect(result).toBe(peer);
    });

    it('falls back to getEntity when getInputEntity fails', async () => {
        const entity = { id: BigInt('9876543210') };
        const client = makeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('miss')),
            getEntity: vi.fn().mockResolvedValue(entity),
        });
        const result = await fwd.resolveDestination('-1009876543210', client);
        expect(result).toBe(entity);
    });

    it('falls back to manual InputPeerChannel for -100 IDs when all lookups fail', async () => {
        const client = makeClient();
        const result = await fwd.resolveDestination('-1009876543210', client);
        expect(result).toBeDefined();
        // Should be an InputPeerChannel-like object (from gramjs Api)
        expect(typeof result).toBe('object');
    });

    it('returns null when storage channel cannot be created', async () => {
        const client = makeClient({
            getDialogs: vi.fn().mockRejectedValue(new Error('no dialogs')),
        });
        fwd.storageChannelId = null;
        const result = await fwd.resolveDestination('storage', client);
        expect(result).toBeNull();
    });

    it('returns cached storageChannelId if set', async () => {
        const cached = { id: BigInt(123) };
        fwd.storageChannelId = cached;
        const result = await fwd.resolveDestination('storage', makeClient());
        expect(result).toBe(cached);
    });

    it('finds existing storage channel from dialogs', async () => {
        const entity = { id: BigInt(555) };
        const client = makeClient({
            getDialogs: vi.fn().mockResolvedValue([
                { title: 'Telegram Downloader Storage', entity },
            ]),
        });
        fwd.storageChannelId = null;
        const result = await fwd.resolveDestination('storage', client);
        expect(result).toBe(entity);
        expect(fwd.storageChannelId).toBe(entity);
    });
});
