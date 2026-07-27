// Route-level HTTP tests for /api/proxy/test and /api/download/url.
//
// /api/proxy/test is security-sensitive (SSRF guard against probing
// the host's internal network), so its validation logic is tested
// thoroughly. The actual TCP connect is exercised against a mocked
// `net.Socket` rather than a real network call — real connect/error/
// timeout behavior isn't this route's logic to verify.
//
// /api/download/url mirrors stories.js's download endpoint shape
// (standalone-downloader creation + drain loop vs. reusing the
// runtime's downloader); core/url-resolver.js, core/runtime.js,
// core/downloader.js and core/security.js are mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';

class MockSocket extends EventEmitter {
    setTimeout() {}
    connect(port, host) {
        MockSocket.lastConnect = { port, host };
        MockSocket.instances.push(this);
    }
    destroy() {
        this.destroyed = true;
    }
}
MockSocket.instances = [];
vi.mock('net', () => ({ default: { Socket: MockSocket }, Socket: MockSocket }));

const parseTelegramUrl = vi.fn();
const parseUrlList = vi.fn((s) => [s]);
class UrlParseError extends Error {}
vi.mock('../src/core/url-resolver.js', () => ({ parseTelegramUrl, parseUrlList, UrlParseError }));

let loadConfig;
vi.mock('../src/config/manager.js', () => ({ loadConfig: (...a) => loadConfig(...a) }));

const runtime = { _downloader: null };
vi.mock('../src/core/runtime.js', () => ({ runtime }));

const RateLimiter = vi.fn();
vi.mock('../src/core/security.js', () => ({ RateLimiter }));

let fakeDownloader;
const DownloadManager = vi.fn().mockImplementation(function () {
    return fakeDownloader;
});
vi.mock('../src/core/downloader.js', () => ({ DownloadManager }));

let app;
let server;
let port;
let getAccountManager;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function makeFakeDownloader() {
    return {
        init: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
        enqueue: vi.fn().mockResolvedValue(true),
        stop: vi.fn().mockResolvedValue(undefined),
        pendingCount: 0,
        active: new Set(),
    };
}

function makeFakeClient({
    entity = { id: '-100123', title: 'Test Chat' },
    message = { media: { document: { mimeType: 'video/mp4', attributes: [] } } },
} = {}) {
    return {
        getEntity: vi.fn().mockResolvedValue(entity),
        getMessages: vi.fn().mockResolvedValue([message]),
    };
}

function makeFakeAm({ count = 1, clients = [['acc1', makeFakeClient()]] } = {}) {
    return {
        count,
        clients,
        getDefaultClient: () => clients[0]?.[1],
        getIdForClient: () => 'acc-1',
        metadata: { get: () => ({ name: 'Test Account' }) },
    };
}

beforeAll(async () => {
    const { createLinkDownloadRouter } = await import('../src/web/routes/link-download.js');
    app = express();
    app.use(express.json());
    app.use(
        '/api',
        createLinkDownloadRouter({ getAccountManager: (...a) => getAccountManager(...a) }),
    );
    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
});

beforeEach(() => {
    vi.clearAllMocks();
    MockSocket.instances = [];
    MockSocket.lastConnect = null;
    runtime._downloader = null;
    fakeDownloader = makeFakeDownloader();
    getAccountManager = async () => makeFakeAm();
    loadConfig = () => ({ security: { allowedProxyTestHosts: ['proxy.example.com'] } });
});

describe('POST /api/proxy/test', () => {
    it('400s without host or port', async () => {
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com' }),
        });
        expect(res.status).toBe(400);
    });

    it('400s for a non-string host', async () => {
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 123, port: 1080 }),
        });
        expect(res.status).toBe(400);
    });

    it('400s for a host longer than 253 chars', async () => {
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'a'.repeat(254), port: 1080 }),
        });
        expect(res.status).toBe(400);
    });

    it.each([
        ['127.0.0.1', 'loopback'],
        ['10.0.0.5', 'private class A'],
        ['192.168.1.1', 'private class C'],
        ['172.16.0.1', 'private class B'],
        ['169.254.1.1', 'link-local'],
        ['0.0.0.0', 'unspecified'],
        ['224.0.0.1', 'multicast'],
        ['::1', 'IPv6 loopback'],
        ['fe80::1', 'IPv6 link-local'],
        ['fc00::1', 'IPv6 ULA'],
        ['localhost', 'localhost name'],
        ['printer.local', '.local suffix'],
        ['router.internal', '.internal suffix'],
    ])('blocks %s (%s) as a private/loopback SSRF target', async (host) => {
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port: 1080 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/private|loopback|link-local/i);
    });

    it('400s when allowedProxyTestHosts is not configured at all', async () => {
        loadConfig = () => ({});
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/allowedProxyTestHosts must be configured/);
    });

    it('400s when the host is not in the allowlist', async () => {
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'evil.example.com', port: 1080 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/not in allowedProxyTestHosts/);
    });

    it('matches the allowlist case-insensitively and trims whitespace', async () => {
        loadConfig = () => ({ security: { allowedProxyTestHosts: ['  Proxy.Example.COM  '] } });
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'PROXY.example.com', port: 1080 }),
        });
        // Not a 400 from the allowlist check — proceeds to connect.
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        MockSocket.instances[0].emit('connect');
        const res = await resPromise;
        expect(res.status).toBe(200);
    });

    it('ignores non-string entries in allowedProxyTestHosts', async () => {
        loadConfig = () => ({
            security: { allowedProxyTestHosts: [null, 42, '  ', 'proxy.example.com'] },
        });
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        MockSocket.instances[0].emit('connect');
        const res = await resPromise;
        expect(res.status).toBe(200);
    });

    it.each([
        [0, 'host and port required'], // 0 is falsy — caught by the earlier !port check
        [Number.NaN, 'host and port required'], // JSON.stringify(NaN) -> null
        [-1, 'port must be 1-65535'],
        [65536, 'port must be 1-65535'],
    ])('400s for an out-of-range port (%s)', async (badPort, expectedError) => {
        const res = await fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: badPort }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe(expectedError);
    });

    it('reports ok:true with elapsed ms on a successful connect', async () => {
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        MockSocket.instances[0].emit('connect');
        const res = await resPromise;
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(typeof body.ms).toBe('number');
        expect(MockSocket.lastConnect).toEqual({ port: 1080, host: 'proxy.example.com' });
    });

    it('still resolves ok:true even if sock.destroy() itself throws', async () => {
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        const sock = MockSocket.instances[0];
        sock.destroy = () => {
            throw new Error('already destroyed');
        };
        sock.emit('connect');
        const res = await resPromise;
        const body = await res.json();
        expect(body.ok).toBe(true);
    });

    it('reports ok:false with the error message on a connection error', async () => {
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        MockSocket.instances[0].emit('error', new Error('ECONNREFUSED'));
        const res = await resPromise;
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe('ECONNREFUSED');
    });

    it('reports ok:false with "timeout" on a socket timeout', async () => {
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        MockSocket.instances[0].emit('timeout');
        const res = await resPromise;
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe('timeout');
    });

    it('only resolves once even if connect and error both fire', async () => {
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example.com', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        const sock = MockSocket.instances[0];
        sock.emit('connect');
        sock.emit('error', new Error('late error'));
        const res = await resPromise;
        const body = await res.json();
        expect(body.ok).toBe(true);
    });

    it('lowercases and trims the host before connecting', async () => {
        const resPromise = fetch(apiUrl('/api/proxy/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: '  Proxy.Example.com  ', port: 1080 }),
        });
        await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
        expect(MockSocket.lastConnect.host).toBe('proxy.example.com');
        MockSocket.instances[0].emit('connect');
        await resPromise;
    });
});

describe('POST /api/download/url', () => {
    it('400s with neither url nor urls', async () => {
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('409s when no accounts are loaded', async () => {
        getAccountManager = async () => makeFakeAm({ count: 0 });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        expect(res.status).toBe(409);
    });

    it('queues a single resolvable url and reports success', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.results).toHaveLength(1);
        expect(body.results[0].ok).toBe(true);
        expect(body.results[0].mediaType).toBe('videos');
        expect(fakeDownloader.enqueue).toHaveBeenCalled();
    });

    describe('detectMediaType variants', () => {
        const cases = [
            ['sticker', { sticker: true }, 'stickers'],
            ['photo (photo field)', { photo: true }, 'photos'],
            ['photo (className)', { className: 'MessageMediaPhoto' }, 'photos'],
            ['audio', { document: { mimeType: 'audio/mpeg' } }, 'audio'],
            ['voice (ogg audio)', { document: { mimeType: 'audio/ogg' } }, 'voice'],
            ['gif (mime)', { document: { mimeType: 'image/gif' } }, 'gifs'],
            [
                'gif (animated attribute)',
                {
                    document: {
                        mimeType: 'application/octet-stream',
                        attributes: [{ className: 'DocumentAttributeAnimated' }],
                    },
                },
                'gifs',
            ],
            ['sticker (webp document)', { document: { mimeType: 'image/webp' } }, 'stickers'],
            [
                'sticker (tgsticker)',
                { document: { mimeType: 'application/x-tgsticker' } },
                'stickers',
            ],
            ['generic document', { document: { mimeType: 'application/zip' } }, 'documents'],
        ];

        for (const [label, media, expected] of cases) {
            it(`detects ${label} as ${expected}`, async () => {
                parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
                const client = makeFakeClient({ message: { media } });
                getAccountManager = async () => makeFakeAm({ clients: [['acc1', client]] });
                const res = await fetch(apiUrl('/api/download/url'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: 'https://t.me/x/1' }),
                });
                const body = await res.json();
                expect(body.results[0].mediaType).toBe(expected);
            });
        }
    });

    it('accepts a urls array directly, bypassing parseUrlList', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: ['https://t.me/x/1', 'https://t.me/x/2'] }),
        });
        expect(parseUrlList).not.toHaveBeenCalled();
        expect(parseTelegramUrl).toHaveBeenCalledTimes(2);
    });

    it('reports per-url failure when no account can read the message', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        const client = makeFakeClient();
        client.getMessages.mockResolvedValue([]);
        getAccountManager = async () => makeFakeAm({ clients: [['acc1', client]] });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        const body = await res.json();
        expect(body.results[0].ok).toBe(false);
        expect(body.results[0].error).toBe('No account could read the message');
    });

    it('tries the next account when the first cannot read the message', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        const failing = makeFakeClient();
        failing.getEntity.mockRejectedValue(new Error('no access'));
        const working = makeFakeClient();
        getAccountManager = async () =>
            makeFakeAm({
                clients: [
                    ['acc1', failing],
                    ['acc2', working],
                ],
            });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        const body = await res.json();
        expect(body.results[0].ok).toBe(true);
    });

    it('reports failure when the resolved message has no downloadable media', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        const client = makeFakeClient({ message: {} });
        getAccountManager = async () => makeFakeAm({ clients: [['acc1', client]] });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        const body = await res.json();
        expect(body.results[0].ok).toBe(false);
        expect(body.results[0].error).toBe('Message has no downloadable media');
    });

    it('processes a bulk list, isolating one bad url from the rest', async () => {
        parseTelegramUrl.mockImplementation((raw) => {
            if (raw === 'bad') throw new UrlParseError('not a t.me link');
            return { chatRef: 'x', messageId: 1 };
        });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: ['https://t.me/x/1', 'bad'] }),
        });
        const body = await res.json();
        expect(body.results).toHaveLength(2);
        expect(body.results[0].ok).toBe(true);
        expect(body.results[1].ok).toBe(false);
        expect(body.results[1].error).toBe('not a t.me link');
    });

    it('falls back to a generic "Failed" message for a non-UrlParseError, non-Error-message throw', async () => {
        parseTelegramUrl.mockImplementation(() => {
            throw { weird: true };
        });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        const body = await res.json();
        expect(body.results[0].error).toBe('Failed');
    });

    it('reuses the running runtime downloader instead of creating a standalone one', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        const running = makeFakeDownloader();
        runtime._downloader = running;
        await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        expect(running.enqueue).toHaveBeenCalled();
        expect(running.init).not.toHaveBeenCalled();
        expect(DownloadManager).not.toHaveBeenCalled();
    });

    it('creates and drains a standalone downloader when the runtime has none running', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        expect(res.status).toBe(200);
        expect(fakeDownloader.init).toHaveBeenCalled();
        expect(fakeDownloader.start).toHaveBeenCalled();
        await new Promise((r) => setTimeout(r, 20));
        expect(fakeDownloader.stop).toHaveBeenCalled();
    });

    it('actually waits (polling every 1s) while jobs are still pending, then stops', async () => {
        vi.useFakeTimers();
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        let pending = 1;
        Object.defineProperty(fakeDownloader, 'pendingCount', { get: () => pending });
        const resPromise = fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        await vi.waitFor(() => expect(fakeDownloader.init).toHaveBeenCalled());
        expect(fakeDownloader.stop).not.toHaveBeenCalled();
        pending = 0;
        await vi.advanceTimersByTimeAsync(1000);
        expect(fakeDownloader.stop).toHaveBeenCalled();
        vi.useRealTimers();
        const res = await resPromise;
        expect(res.status).toBe(200);
    });

    it('logs a warning instead of crashing when the standalone drain loop itself throws', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        fakeDownloader.pendingCount = 0;
        Object.defineProperty(fakeDownloader, 'active', {
            get() {
                throw new Error('engine state corrupted');
            },
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        expect(res.status).toBe(200);
        await new Promise((r) => setTimeout(r, 20));
        expect(warnSpy).toHaveBeenCalledWith(
            '[download/url] standalone drain failed:',
            'engine state corrupted',
        );
        warnSpy.mockRestore();
    });

    it('falls back to #accountId when no metadata name/username/phone is available', async () => {
        parseTelegramUrl.mockReturnValue({ chatRef: 'x', messageId: 1 });
        getAccountManager = async () => ({
            count: 1,
            clients: [['acc1', makeFakeClient()]],
            getDefaultClient: () => makeFakeClient(),
            getIdForClient: () => 'acc-7',
            metadata: { get: () => null },
        });
        await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        const [job] = fakeDownloader.enqueue.mock.calls[0];
        expect(job.accountName).toBe('#acc-7');
    });

    it('500s and logs when something outside the per-url try/catch throws', async () => {
        getAccountManager = async () => {
            throw new Error('account manager exploded');
        };
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await fetch(apiUrl('/api/download/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://t.me/x/1' }),
        });
        expect(res.status).toBe(500);
        errSpy.mockRestore();
    });
});
