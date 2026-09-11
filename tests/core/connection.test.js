import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../src/core/connection.js';

describe('ConnectionManager', () => {
    afterEach(() => vi.useRealTimers());

    it('starts an unref health timer and stops it cleanly', () => {
        vi.useFakeTimers();
        const client = { connected: true, checkAuthorization: vi.fn().mockResolvedValue(true) };
        const manager = new ConnectionManager(client, { interval: 1000 });

        manager.start();
        manager.start();
        expect(manager.running).toBe(true);
        expect(client.checkAuthorization).toHaveBeenCalledTimes(1);

        manager.stop();
        manager.stop();
        expect(manager.running).toBe(false);
        expect(manager.timer).toBeNull();
    });

    it('reconnects after a failed health check and resets failures', async () => {
        const client = {
            connected: false,
            checkAuthorization: vi.fn(),
            disconnect: vi.fn().mockResolvedValue(),
            connect: vi.fn().mockResolvedValue(),
        };
        const manager = new ConnectionManager(client, { interval: 1000 });
        manager.running = true;

        await manager.check();

        expect(client.disconnect).toHaveBeenCalledOnce();
        expect(client.connect).toHaveBeenCalledOnce();
        expect(manager.failures).toBe(0);
        expect(manager.backoffUntil).toBeNull();
    });

    it('backs off after reconnect failure and skips checks during the backoff', async () => {
        const client = {
            connected: false,
            checkAuthorization: vi.fn(),
            disconnect: vi.fn().mockResolvedValue(),
            connect: vi.fn().mockRejectedValue(new Error('still down')),
        };
        const manager = new ConnectionManager(client);
        manager.running = true;

        await manager.check();
        const retryCount = client.disconnect.mock.calls.length;
        await manager.check();

        expect(manager.failures).toBe(1);
        expect(client.disconnect).toHaveBeenCalledTimes(retryCount);
    });
});
