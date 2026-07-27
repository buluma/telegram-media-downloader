// Route-level HTTP tests for /api/cluster/*. This router is almost
// entirely a thin HTTP shim over the core/cluster/* subsystem (P3
// territory — identity, HMAC, peers, handshake, sync, sweep, ws-channel,
// discovery, failover, relay), so every one of those modules is mocked
// wholesale. core/db.js, core/db/cluster.js, core/db/downloads.js,
// core/thumbs.js, core/delete-queue.js, and web/lib/resolve-download.js
// are also mocked — only the route's own wiring (HMAC gating, id/body
// validation, status-code mapping, audit-log calls) is under test.
//
// Two real production bugs fixed alongside these tests (both were
// undeclared-variable ReferenceErrors, discovered while reading the
// file to plan test coverage — not found by running anything):
//   - GET /cluster/peer-thumbs/:remoteId called getOrCreateThumb()
//     without ever importing it from core/thumbs.js.
//   - POST /cluster/sign-url called createShareLink() without ever
//     importing it from core/db/downloads.js.
// Both endpoints always 500'd before the fix; see the routes/cluster.js
// diff for the added imports.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';

const verifyPeerHmac = vi.fn(() => ({ ok: true, peerId: 'peer-1' }));
vi.mock('../src/core/cluster/hmac.js', () => ({
    verifyRequest: (...a) => verifyPeerHmac(...a),
    signRequest: vi.fn(() => ({ 'x-signed': '1' })),
}));

const identity = {
    getSelfPeerId: vi.fn(() => 'self-id'),
    getSelfPeerName: vi.fn(() => 'Self'),
    setSelfPeerName: vi.fn((n) => n.trim()),
    getClusterToken: vi.fn(() => 'token-abc'),
    rotateClusterToken: vi.fn(() => 'token-new'),
    setClusterToken: vi.fn((t) => t),
    getSelfIdentity: vi.fn(() => ({ peerId: 'self-id', name: 'Self' })),
    issuePairingCode: vi.fn(() => ({ code: 'ABCD1234', expiresAt: Date.now() + 300000 })),
};
vi.mock('../src/core/cluster/identity.js', () => identity);

const peersApi = {
    listPeers: vi.fn(() => []),
    getPeer: vi.fn(() => null),
    updatePeer: vi.fn(),
    removePeer: vi.fn(() => true),
    markOnline: vi.fn(),
    markOffline: vi.fn(),
};
vi.mock('../src/core/cluster/peers.js', () => peersApi);

const handshakeApi = {
    initiateHandshake: vi.fn(),
    acceptHandshake: vi.fn(),
    testPeerHealth: vi.fn(),
};
vi.mock('../src/core/cluster/handshake.js', () => handshakeApi);

const syncApi = {
    startSyncEngine: vi.fn(),
    syncAllOnce: vi.fn().mockResolvedValue({ ok: true }),
    getSyncState: vi.fn(() => ({ state: 'idle' })),
};
vi.mock('../src/core/cluster/sync.js', () => syncApi);

const sweepApi = {
    tryStartSweep: vi.fn(() => ({ started: true })),
    abortSweep: vi.fn(() => true),
    getSweepStatus: vi.fn(() => ({ running: false, stats: {} })),
    listConflicts: vi.fn(() => []),
    resolveConflict: vi.fn().mockResolvedValue({ resolved: true }),
};
vi.mock('../src/core/cluster/sweep.js', () => sweepApi);

const wsChannel = {
    initClusterWs: vi.fn(),
    broadcastClusterEvent: vi.fn(),
};
vi.mock('../src/core/cluster/ws-channel.js', () => wsChannel);

const discoveryApi = { startDiscovery: vi.fn() };
vi.mock('../src/core/cluster/discovery.js', () => discoveryApi);

const failoverApi = {
    startFailoverWatcher: vi.fn(),
    runFailoverPass: vi.fn(() => 3),
};
vi.mock('../src/core/cluster/failover.js', () => failoverApi);

const dbApi = {
    listDiscoveredPeers: vi.fn(() => []),
    recordClusterAudit: vi.fn(),
    listClusterAudit: vi.fn(() => []),
    listOwnDownloadsSince: vi.fn(() => []),
};
const fakeDb = {
    prepare: vi.fn(() => ({
        get: vi.fn(() => undefined),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 0 })),
    })),
};
vi.mock('../src/core/db.js', () => ({ ...dbApi, getDb: () => fakeDb }));

const clusterDbApi = {
    aggregateEgress: vi.fn(() => ({ bytes: 0 })),
    listFailoverLog: vi.fn(() => []),
};
vi.mock('../src/core/db/cluster.js', () => clusterDbApi);

const createShareLink = vi.fn(() => ({ id: 42 }));
vi.mock('../src/core/db/downloads.js', () => ({
    createShareLink: (...a) => createShareLink(...a),
}));

const getOrCreateThumb = vi.fn();
vi.mock('../src/core/thumbs.js', () => ({ getOrCreateThumb: (...a) => getOrCreateThumb(...a) }));

const deferDelete = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/core/delete-queue.js', () => ({ deferDelete: (...a) => deferDelete(...a) }));

const safeResolveDownload = vi.fn();
vi.mock('../src/web/lib/resolve-download.js', () => ({
    safeResolveDownload: (...a) => safeResolveDownload(...a),
}));

const readConfigSafe = vi.fn().mockResolvedValue({ groups: [], accounts: [] });
vi.mock('../src/web/lib/config-cache.js', () => ({
    readConfigSafe: (...a) => readConfigSafe(...a),
}));

const buildShareUrlPath = vi.fn((id, exp) => `/share/${id}?s=fake-sig&e=${exp}`);
vi.mock('../src/core/share.js', () => ({ buildShareUrlPath: (...a) => buildShareUrlPath(...a) }));

vi.mock('ws', () => ({ default: class FakeWebSocket extends EventEmitter {} }));

let app;
let server;
let port;
let broadcast;
let log;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

async function post(pathname, body) {
    return fetch(apiUrl(pathname), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
}

beforeAll(async () => {
    const { createClusterRouter } = await import('../src/web/routes/cluster.js');
    broadcast = vi.fn();
    log = vi.fn();
    app = express();
    app.use(express.json());
    app.use('/api', createClusterRouter({ broadcast, log }));

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
    verifyPeerHmac.mockReturnValue({ ok: true, peerId: 'peer-1' });
    peersApi.listPeers.mockReturnValue([]);
    peersApi.getPeer.mockReturnValue(null);
    peersApi.removePeer.mockReturnValue(true);
    sweepApi.tryStartSweep.mockReturnValue({ started: true });
    fakeDb.prepare.mockReturnValue({
        get: vi.fn(() => undefined),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 0 })),
    });
});

describe('HMAC gate — shared across every peer-to-peer route', () => {
    const peerRoutes = [
        { method: 'POST', path: '/api/cluster/handshake' },
        { method: 'GET', path: '/api/cluster/health' },
        { method: 'GET', path: '/api/cluster/downloads/since' },
        { method: 'GET', path: '/api/cluster/groups/snapshot' },
        { method: 'GET', path: '/api/cluster/accounts/snapshot' },
        { method: 'GET', path: '/api/cluster/files/some/path' },
        { method: 'GET', path: '/api/cluster/peer-thumbs/1' },
        { method: 'POST', path: '/api/cluster/sign-url' },
        { method: 'POST', path: '/api/cluster/relay/proxy' },
        { method: 'POST', path: '/api/cluster/files/delete' },
        { method: 'GET', path: '/api/cluster/search/peer' },
    ];

    for (const { method, path } of peerRoutes) {
        it(`${method} ${path} 401s and audits when HMAC verification fails`, async () => {
            verifyPeerHmac.mockReturnValue({ ok: false, reason: 'bad_signature' });
            const res = await fetch(apiUrl(path), {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: method === 'POST' ? '{}' : undefined,
            });
            expect(res.status).toBe(401);
            const body = await res.json();
            expect(body.code).toBe('bad_signature');
            expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'request', ok: false }),
            );
        });
    }
});

describe('POST /api/cluster/handshake', () => {
    it('accepts the handshake and returns the peer record', async () => {
        handshakeApi.acceptHandshake.mockReturnValue({ peerId: 'peer-1', name: 'Remote' });
        const res = await post('/api/cluster/handshake', {
            peer_id: 'peer-1',
            name: 'Remote',
            url: 'https://remote.example.com',
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ peerId: 'peer-1', name: 'Remote' });
        expect(handshakeApi.acceptHandshake).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://remote.example.com' }),
        );
    });

    it('defaults the caller URL to "unknown" when the body omits it', async () => {
        handshakeApi.acceptHandshake.mockReturnValue({});
        await post('/api/cluster/handshake', { peer_id: 'peer-1' });
        expect(handshakeApi.acceptHandshake).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'unknown' }),
        );
    });

    it('maps a thrown error to its own status/code', async () => {
        const err = new Error('duplicate peer');
        err.status = 409;
        err.code = 'DUPLICATE';
        handshakeApi.acceptHandshake.mockImplementation(() => {
            throw err;
        });
        const res = await post('/api/cluster/handshake', { peer_id: 'peer-1' });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('DUPLICATE');
    });
});

describe('GET /api/cluster/health', () => {
    it('marks the peer online and reports self identity', async () => {
        const res = await fetch(apiUrl('/api/cluster/health'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.peer_id).toBe('self-id');
        expect(body.ok).toBe(true);
        expect(peersApi.markOnline).toHaveBeenCalledWith('peer-1');
    });

    it('does not fail the request when markOnline throws (unpaired peer racing health)', async () => {
        peersApi.markOnline.mockImplementationOnce(() => {
            throw new Error('not paired yet');
        });
        const res = await fetch(apiUrl('/api/cluster/health'));
        expect(res.status).toBe(200);
    });
});

describe('cluster identity endpoints', () => {
    it('GET /cluster/identity returns the self identity', async () => {
        const res = await fetch(apiUrl('/api/cluster/identity'));
        expect(await res.json()).toEqual({ peerId: 'self-id', name: 'Self' });
    });

    it('PUT /cluster/identity 400s without a name', async () => {
        const res = await fetch(apiUrl('/api/cluster/identity'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(400);
    });

    it('PUT /cluster/identity sets the name and returns it cleaned', async () => {
        const res = await fetch(apiUrl('/api/cluster/identity'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '  New Name  ' }),
        });
        const body = await res.json();
        expect(body.name).toBe('New Name');
    });

    it('PUT /cluster/identity 400s when setSelfPeerName throws', async () => {
        identity.setSelfPeerName.mockImplementation(() => {
            throw new Error('name too long');
        });
        const res = await fetch(apiUrl('/api/cluster/identity'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x' }),
        });
        expect(res.status).toBe(400);
    });

    it('GET /cluster/identity/token returns the token with no-store', async () => {
        const res = await fetch(apiUrl('/api/cluster/identity/token'));
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ token: 'token-abc' });
    });

    it('POST /cluster/identity/rotate-token rotates and audits', async () => {
        const res = await post('/api/cluster/identity/rotate-token');
        expect(await res.json()).toEqual({ token: 'token-new' });
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'rotate_token' }),
        );
    });

    it('POST /cluster/identity/set-token 400s without a token', async () => {
        const res = await post('/api/cluster/identity/set-token', {});
        expect(res.status).toBe(400);
    });

    it('POST /cluster/identity/set-token sets and audits', async () => {
        const res = await post('/api/cluster/identity/set-token', { token: 'my-token' });
        expect(await res.json()).toEqual({ token: 'my-token' });
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'set_token' }),
        );
    });

    it('POST /cluster/identity/set-token 400s when setClusterToken throws', async () => {
        identity.setClusterToken.mockImplementation(() => {
            throw new Error('invalid token format');
        });
        const res = await post('/api/cluster/identity/set-token', { token: 'bad' });
        expect(res.status).toBe(400);
    });

    it('POST /cluster/identity/pairing-code issues a code and audits', async () => {
        const res = await post('/api/cluster/identity/pairing-code');
        const body = await res.json();
        expect(body.code).toBe('ABCD1234');
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'pairing_code' }),
        );
    });
});

describe('peer management', () => {
    it('GET /cluster/peers lists peers', async () => {
        peersApi.listPeers.mockReturnValue([{ peerId: 'p1' }]);
        const res = await fetch(apiUrl('/api/cluster/peers'));
        expect(await res.json()).toEqual({ peers: [{ peerId: 'p1' }] });
    });

    it('POST /cluster/peers 400s without url or a token/pairingCode', async () => {
        const res = await post('/api/cluster/peers', { url: 'https://x' });
        expect(res.status).toBe(400);
    });

    it('POST /cluster/peers initiates a handshake and returns the peer', async () => {
        handshakeApi.initiateHandshake.mockResolvedValue({ ok: true, peer: { peerId: 'p1' } });
        const res = await post('/api/cluster/peers', { url: 'https://x', token: 't' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ peer: { peerId: 'p1' } });
    });

    it('POST /cluster/peers 400s with the handshake failure code when not ok', async () => {
        handshakeApi.initiateHandshake.mockResolvedValue({
            ok: false,
            message: 'unreachable',
            code: 'TIMEOUT',
        });
        const res = await post('/api/cluster/peers', { url: 'https://x', token: 't' });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('TIMEOUT');
    });

    it('POST /cluster/peers 500s when initiateHandshake rejects', async () => {
        handshakeApi.initiateHandshake.mockRejectedValue(new Error('boom'));
        const res = await post('/api/cluster/peers', { url: 'https://x', token: 't' });
        expect(res.status).toBe(500);
    });

    it('POST /cluster/peers derives selfUrl from forwarded headers when PUBLIC_URL is unset', async () => {
        delete process.env.PUBLIC_URL;
        handshakeApi.initiateHandshake.mockResolvedValue({ ok: true, peer: {} });
        await fetch(apiUrl('/api/cluster/peers'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'me.example.com',
            },
            body: JSON.stringify({ url: 'https://x', token: 't' }),
        });
        expect(handshakeApi.initiateHandshake).toHaveBeenCalledWith(
            expect.objectContaining({ selfUrl: 'https://me.example.com' }),
        );
    });

    it('PUT /cluster/peers/:peerId 404s when the peer does not exist', async () => {
        peersApi.updatePeer.mockReturnValue(null);
        const res = await fetch(apiUrl('/api/cluster/peers/unknown'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(404);
    });

    it('PUT /cluster/peers/:peerId updates and returns the peer', async () => {
        peersApi.updatePeer.mockReturnValue({ peerId: 'p1', name: 'Renamed' });
        const res = await fetch(apiUrl('/api/cluster/peers/p1'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed' }),
        });
        expect(await res.json()).toEqual({ peer: { peerId: 'p1', name: 'Renamed' } });
    });

    it('DELETE /cluster/peers/:peerId 404s when the peer does not exist', async () => {
        peersApi.removePeer.mockReturnValue(false);
        const res = await fetch(apiUrl('/api/cluster/peers/unknown'), { method: 'DELETE' });
        expect(res.status).toBe(404);
    });

    it('DELETE /cluster/peers/:peerId removes and audits', async () => {
        const res = await fetch(apiUrl('/api/cluster/peers/p1'), { method: 'DELETE' });
        expect(await res.json()).toEqual({ success: true });
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'revoke', peerId: 'p1' }),
        );
    });

    it('POST /cluster/peers/:peerId/test 404s when the peer does not exist', async () => {
        const res = await post('/api/cluster/peers/unknown/test');
        expect(res.status).toBe(404);
    });

    it('POST /cluster/peers/:peerId/test marks online + audits on success', async () => {
        peersApi.getPeer.mockReturnValue({ peerId: 'p1' });
        handshakeApi.testPeerHealth.mockResolvedValue({ ok: true });
        await post('/api/cluster/peers/p1/test');
        expect(peersApi.markOnline).toHaveBeenCalledWith('p1');
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'test', ok: true }),
        );
    });

    it('POST /cluster/peers/:peerId/test marks offline + audits on failure', async () => {
        peersApi.getPeer.mockReturnValue({ peerId: 'p1' });
        handshakeApi.testPeerHealth.mockResolvedValue({ ok: false, code: 'ECONNREFUSED' });
        await post('/api/cluster/peers/p1/test');
        expect(peersApi.markOffline).toHaveBeenCalledWith('p1');
    });

    it('POST /cluster/peers/:peerId/test 500s when testPeerHealth rejects', async () => {
        peersApi.getPeer.mockReturnValue({ peerId: 'p1' });
        handshakeApi.testPeerHealth.mockRejectedValue(new Error('down'));
        const res = await post('/api/cluster/peers/p1/test');
        expect(res.status).toBe(500);
    });
});

describe('discovery + audit', () => {
    it('GET /cluster/discovered lists discovered peers', async () => {
        dbApi.listDiscoveredPeers.mockReturnValue([{ url: 'https://x' }]);
        const res = await fetch(apiUrl('/api/cluster/discovered'));
        expect(await res.json()).toEqual({ peers: [{ url: 'https://x' }] });
    });

    it('GET /cluster/audit clamps limit and passes filters through', async () => {
        await fetch(apiUrl('/api/cluster/audit?peerId=p1&kind=test&limit=99999'));
        expect(dbApi.listClusterAudit).toHaveBeenCalledWith({
            peerId: 'p1',
            kind: 'test',
            limit: 2000,
        });
    });
});

describe('catalog sync', () => {
    it('GET /cluster/downloads/since clamps sinceId/limit and returns rows', async () => {
        dbApi.listOwnDownloadsSince.mockReturnValue([{ id: 5 }]);
        const res = await fetch(apiUrl('/api/cluster/downloads/since?sinceId=-5&limit=99999'));
        const body = await res.json();
        expect(dbApi.listOwnDownloadsSince).toHaveBeenCalledWith({ sinceId: 0, limit: 2000 });
        expect(body.rows).toEqual([{ id: 5 }]);
    });

    it('GET /cluster/groups/snapshot strips groups from readConfigSafe', async () => {
        readConfigSafe.mockResolvedValue({ groups: [{ id: 'g1', name: 'Grp' }] });
        const res = await fetch(apiUrl('/api/cluster/groups/snapshot'));
        const body = await res.json();
        expect(body.groups).toEqual([{ id: 'g1', name: 'Grp' }]);
    });

    it('GET /cluster/accounts/snapshot redacts everything but id/label/phone/disabled', async () => {
        readConfigSafe.mockResolvedValue({
            accounts: [{ id: 'a1', label: 'A', phone: '+1', session: 'SECRET' }],
        });
        const res = await fetch(apiUrl('/api/cluster/accounts/snapshot'));
        const body = await res.json();
        expect(body.accounts).toEqual([{ id: 'a1', label: 'A', phone: '+1', disabled: false }]);
    });

    it('POST /cluster/sync/run triggers a manual sync', async () => {
        syncApi.syncAllOnce.mockResolvedValue({ synced: 3 });
        const res = await post('/api/cluster/sync/run');
        expect(await res.json()).toEqual({ synced: 3 });
    });

    it('GET /cluster/sync/state reports the sync engine state', async () => {
        const res = await fetch(apiUrl('/api/cluster/sync/state'));
        expect(await res.json()).toEqual({ state: 'idle' });
    });
});

describe('GET /cluster/downloads — merged view', () => {
    it('includes local rows when filter is "all" or "self"', async () => {
        fakeDb.prepare.mockReturnValue({
            all: vi.fn(() => [{ id: 1, created_at: '2026-01-01' }]),
        });
        const res = await fetch(apiUrl('/api/cluster/downloads?peerId=self'));
        const body = await res.json();
        expect(body.rows[0].peer_id).toBe('self-id');
    });

    it('includes peer rows for online peers when filter is "all"', async () => {
        peersApi.listPeers.mockReturnValue([{ peerId: 'p1', name: 'Peer One' }]);
        fakeDb.prepare.mockReturnValue({
            all: vi.fn(() => [{ id: 9, created_at: '2026-01-01' }]),
        });
        const res = await fetch(apiUrl('/api/cluster/downloads'));
        const body = await res.json();
        expect(body.rows.some((r) => r.peer_name === 'Peer One')).toBe(true);
    });

    it('500s when the query throws', async () => {
        fakeDb.prepare.mockImplementation(() => {
            throw new Error('db down');
        });
        const res = await fetch(apiUrl('/api/cluster/downloads'));
        expect(res.status).toBe(500);
    });
});

describe('GET /cluster/files/*path — streaming bridge', () => {
    it('400s on a null-byte path', async () => {
        const res = await fetch(apiUrl('/api/cluster/files/a%00b'));
        expect(res.status).toBe(400);
    });

    it('404s when safeResolveDownload reports missing', async () => {
        safeResolveDownload.mockResolvedValue({ ok: false, reason: 'missing' });
        const res = await fetch(apiUrl('/api/cluster/files/some/file.mp4'));
        expect(res.status).toBe(404);
    });

    it('403s when safeResolveDownload reports any other failure reason', async () => {
        safeResolveDownload.mockResolvedValue({ ok: false, reason: 'traversal' });
        const res = await fetch(apiUrl('/api/cluster/files/some/file.mp4'));
        expect(res.status).toBe(403);
    });
});

describe('GET /cluster/peer-thumbs/:remoteId', () => {
    it('400s for a non-positive id', async () => {
        const res = await fetch(apiUrl('/api/cluster/peer-thumbs/0'));
        expect(res.status).toBe(400);
    });

    it('404s when getOrCreateThumb returns nothing', async () => {
        getOrCreateThumb.mockResolvedValue(null);
        const res = await fetch(apiUrl('/api/cluster/peer-thumbs/1'));
        expect(res.status).toBe(404);
    });

    it('returns the thumb buffer with the right headers', async () => {
        getOrCreateThumb.mockResolvedValue(Buffer.from('fake-webp'));
        const res = await fetch(apiUrl('/api/cluster/peer-thumbs/1?w=200'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        expect(getOrCreateThumb).toHaveBeenCalledWith(1, '200');
    });

    it('500s and audits when getOrCreateThumb throws', async () => {
        getOrCreateThumb.mockRejectedValue(new Error('sidecar down'));
        const res = await fetch(apiUrl('/api/cluster/peer-thumbs/1'));
        expect(res.status).toBe(500);
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'thumb', ok: false }),
        );
    });
});

describe('GET /cluster/thumbs/:peerId/:remoteId — cookie-auth proxy', () => {
    it('serves the 1x1 placeholder when the peer is unknown', async () => {
        peersApi.getPeer.mockReturnValue(null);
        const res = await fetch(apiUrl('/api/cluster/thumbs/unknown-peer/1'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
    });

    it('400s for a non-positive remoteId', async () => {
        peersApi.getPeer.mockReturnValue({ peerId: 'p1', url: 'https://p1' });
        const res = await fetch(apiUrl('/api/cluster/thumbs/p1/0'));
        expect(res.status).toBe(400);
    });

    it('serves the placeholder when the upstream fetch fails', async () => {
        peersApi.getPeer.mockReturnValue({ peerId: 'p1', url: 'https://p1' });
        const realFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
        try {
            const res = await realFetch(apiUrl('/api/cluster/thumbs/p1/1'));
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('image/png');
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('POST /cluster/sign-url', () => {
    it('400s without a path', async () => {
        const res = await post('/api/cluster/sign-url', {});
        expect(res.status).toBe(400);
    });

    it('404s when the file is not catalogued', async () => {
        fakeDb.prepare.mockReturnValue({ get: vi.fn(() => undefined) });
        const res = await post('/api/cluster/sign-url', { path: '/x/y.mp4' });
        expect(res.status).toBe(404);
    });

    it('mints a signed url with no-store when the file exists', async () => {
        fakeDb.prepare.mockReturnValue({ get: vi.fn(() => ({ id: 7 })) });
        // "Host" is a forbidden fetch header (silently dropped by undici),
        // so use x-forwarded-host — same header the route itself prefers.
        const res = await fetch(apiUrl('/api/cluster/sign-url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-host': 'me.example.com' },
            body: JSON.stringify({ path: '/x/y.mp4', ttlSec: 120 }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const body = await res.json();
        expect(body.url).toContain('me.example.com');
        expect(createShareLink).toHaveBeenCalledWith(
            expect.objectContaining({ downloadId: 7, label: 'cluster:peer-1' }),
        );
    });
});

describe('dedup sweep', () => {
    it('POST /cluster/sweep/run starts a sweep', async () => {
        const res = await post('/api/cluster/sweep/run', { minSize: 2048 });
        expect(await res.json()).toEqual({ started: true });
        expect(sweepApi.tryStartSweep).toHaveBeenCalledWith({ minSize: 2048 });
    });

    it('POST /cluster/sweep/run 409s with the snapshot when already running', async () => {
        sweepApi.tryStartSweep.mockReturnValue({ started: false, snapshot: { pct: 50 } });
        const res = await post('/api/cluster/sweep/run', {});
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('ALREADY_RUNNING');
        expect(body.snapshot).toEqual({ pct: 50 });
    });

    it('defaults minSize to 1024 with no body value', async () => {
        await post('/api/cluster/sweep/run', {});
        expect(sweepApi.tryStartSweep).toHaveBeenCalledWith({ minSize: 1024 });
    });

    it('GET /cluster/sweep/status reports the current status', async () => {
        const res = await fetch(apiUrl('/api/cluster/sweep/status'));
        expect(await res.json()).toEqual({ running: false, stats: {} });
    });

    it('POST /cluster/sweep/cancel aborts and reports ok', async () => {
        const res = await post('/api/cluster/sweep/cancel');
        expect(await res.json()).toEqual({ ok: true });
    });

    it('GET /cluster/conflicts lists conflicts + stats', async () => {
        sweepApi.listConflicts.mockReturnValue([{ id: 'c1' }]);
        const res = await fetch(apiUrl('/api/cluster/conflicts'));
        const body = await res.json();
        expect(body.conflicts).toEqual([{ id: 'c1' }]);
    });

    it('POST /cluster/conflicts/:id/resolve resolves and returns the result', async () => {
        const res = await post('/api/cluster/conflicts/c1/resolve', { keep: 'local' });
        expect(await res.json()).toEqual({ resolved: true });
        expect(sweepApi.resolveConflict).toHaveBeenCalledWith('c1', 'local');
    });

    it('POST /cluster/conflicts/:id/resolve maps a thrown status', async () => {
        const err = new Error('conflict gone');
        err.status = 410;
        sweepApi.resolveConflict.mockRejectedValue(err);
        const res = await post('/api/cluster/conflicts/c1/resolve', {});
        expect(res.status).toBe(410);
    });
});

describe('POST /cluster/relay/proxy', () => {
    it('forwards the relay response with only the allow-listed headers', async () => {
        vi.doMock('../src/core/cluster/relay.js', () => ({
            handleRelay: vi.fn().mockResolvedValue({
                status: 200,
                headers: new Map([
                    ['content-type', 'application/json'],
                    ['set-cookie', 'evil=1'],
                ]),
                arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer,
            }),
        }));
        const res = await post('/api/cluster/relay/proxy', { foo: 'bar' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(res.headers.get('set-cookie')).toBeNull();
        vi.doUnmock('../src/core/cluster/relay.js');
    });

    it('maps a thrown status from handleRelay', async () => {
        vi.doMock('../src/core/cluster/relay.js', () => ({
            handleRelay: vi
                .fn()
                .mockRejectedValue(Object.assign(new Error('bad'), { status: 422 })),
        }));
        const res = await post('/api/cluster/relay/proxy', {});
        expect(res.status).toBe(422);
        vi.doUnmock('../src/core/cluster/relay.js');
    });
});

describe('POST /cluster/files/delete', () => {
    it('400s when neither remote_id nor file_path is given', async () => {
        const res = await post('/api/cluster/files/delete', {});
        expect(res.status).toBe(400);
    });

    it('400s when both remote_id and file_path are given', async () => {
        const res = await post('/api/cluster/files/delete', {
            remote_id: 1,
            file_path: '/x',
        });
        expect(res.status).toBe(400);
    });

    it('400s on a reason longer than 500 chars', async () => {
        const res = await post('/api/cluster/files/delete', {
            remote_id: 1,
            reason: 'x'.repeat(501),
        });
        expect(res.status).toBe(400);
    });

    it('404s when the row is not catalogued', async () => {
        fakeDb.prepare.mockReturnValue({ get: vi.fn(() => undefined) });
        const res = await post('/api/cluster/files/delete', { remote_id: 1 });
        expect(res.status).toBe(404);
    });

    it('deletes the row, defers the file delete, audits, and broadcasts', async () => {
        fakeDb.prepare.mockReturnValue({
            get: vi.fn(() => ({ id: 5, file_path: '/x/y.mp4', file_size: 1000 })),
            run: vi.fn(() => ({ changes: 1 })),
        });
        safeResolveDownload.mockResolvedValue({ ok: true, real: '/real/x/y.mp4' });
        const res = await post('/api/cluster/files/delete', { remote_id: 5 });
        const body = await res.json();
        expect(body).toEqual({ deleted: true, freedBytes: 1000 });
        expect(deferDelete).toHaveBeenCalledWith('/real/x/y.mp4');
        expect(dbApi.recordClusterAudit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'cross_delete' }),
        );
        expect(wsChannel.broadcastClusterEvent).toHaveBeenCalledWith('download_deleted', {
            remote_id: 5,
        });
    });

    it('reports freedBytes:0 when the local file cannot be resolved', async () => {
        fakeDb.prepare.mockReturnValue({
            get: vi.fn(() => ({ id: 5, file_path: '/x/y.mp4', file_size: 1000 })),
            run: vi.fn(() => ({ changes: 1 })),
        });
        safeResolveDownload.mockResolvedValue({ ok: false, reason: 'missing' });
        const res = await post('/api/cluster/files/delete', { remote_id: 5 });
        const body = await res.json();
        expect(body.freedBytes).toBe(0);
        expect(deferDelete).not.toHaveBeenCalled();
    });

    it('400s on an invalid (non-positive) remote_id', async () => {
        const res = await post('/api/cluster/files/delete', { remote_id: -1 });
        expect(res.status).toBe(400);
    });
});

describe('federated search', () => {
    it('GET /cluster/search/peer returns an empty array for an empty query', async () => {
        const res = await fetch(apiUrl('/api/cluster/search/peer?q='));
        expect(await res.json()).toEqual({ rows: [] });
    });

    it('GET /cluster/search/peer returns matching local rows', async () => {
        fakeDb.prepare.mockReturnValue({ all: vi.fn(() => [{ id: 1, file_name: 'cat.jpg' }]) });
        const res = await fetch(apiUrl('/api/cluster/search/peer?q=cat'));
        const body = await res.json();
        expect(body.rows).toEqual([{ id: 1, file_name: 'cat.jpg' }]);
    });

    it('GET /cluster/search returns an empty array for an empty query', async () => {
        const res = await fetch(apiUrl('/api/cluster/search?q='));
        expect(await res.json()).toEqual({ rows: [] });
    });

    it('GET /cluster/search merges local + online-peer results, deduped by file_hash', async () => {
        fakeDb.prepare.mockReturnValue({
            all: vi.fn(() => [{ id: 1, file_hash: 'h1', file_name: 'cat.jpg' }]),
        });
        peersApi.listPeers.mockReturnValue([
            { peerId: 'p1', name: 'Peer One', status: 'online', url: 'https://p1' },
            { peerId: 'p2', name: 'Peer Two', status: 'offline', url: 'https://p2' },
        ]);
        const realFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ rows: [{ id: 9, file_hash: 'h1' }] }), // dup hash
        });
        try {
            const res = await realFetch(apiUrl('/api/cluster/search?q=cat'));
            const body = await res.json();
            // Same file_hash across self + peer -> deduped to 1 row.
            expect(body.rows).toHaveLength(1);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1); // only the online peer
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('GET /cluster/search tolerates a peer fetch failure without failing the whole search', async () => {
        fakeDb.prepare.mockReturnValue({ all: vi.fn(() => []) });
        peersApi.listPeers.mockReturnValue([
            { peerId: 'p1', name: 'Peer One', status: 'online', url: 'https://p1' },
        ]);
        const realFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
        try {
            const res = await realFetch(apiUrl('/api/cluster/search?q=cat'));
            expect(res.status).toBe(200);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('failover + stats', () => {
    it('GET /cluster/failover-log clamps the limit and lists entries', async () => {
        clusterDbApi.listFailoverLog.mockReturnValue([{ id: 1 }]);
        await fetch(apiUrl('/api/cluster/failover-log?limit=99999'));
        expect(clusterDbApi.listFailoverLog).toHaveBeenCalledWith({ limit: 1000 });
    });

    it('GET /cluster/failover-log 500s when the log is unavailable', async () => {
        clusterDbApi.listFailoverLog.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/cluster/failover-log'));
        expect(res.status).toBe(500);
    });

    it('POST /cluster/failover/run reports the number applied', async () => {
        failoverApi.runFailoverPass.mockReturnValue(2);
        const res = await post('/api/cluster/failover/run');
        expect(await res.json()).toEqual({ applied: 2 });
    });

    it('GET /cluster/stats reports self + peer byte totals and egress', async () => {
        peersApi.listPeers.mockReturnValue([{ peerId: 'p1', name: 'Peer One', status: 'online' }]);
        fakeDb.prepare.mockReturnValue({ get: vi.fn(() => ({ n: 12345 })) });
        clusterDbApi.aggregateEgress.mockReturnValue({ bytes: 999 });
        const res = await fetch(apiUrl('/api/cluster/stats'));
        const body = await res.json();
        expect(body.self.totalBytes).toBe(12345);
        expect(body.peers[0]).toEqual({
            peerId: 'p1',
            name: 'Peer One',
            status: 'online',
            totalBytes: 12345,
        });
        expect(body.egress30d).toEqual({ bytes: 999 });
    });

    it('GET /cluster/stats falls back to 0 local bytes when the query throws', async () => {
        fakeDb.prepare.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/cluster/stats'));
        // localBytes has its own inner try/catch (independent of the
        // per-peer cachedBytes query) so a thrown prepare() is swallowed
        // and reported as 0 rather than failing the whole request.
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.self.totalBytes).toBe(0);
    });
});

describe('subsystem startup guards', () => {
    // The router.use(...) guard middleware is registered near the end of
    // the file, after most routes — Express only runs middleware for
    // requests that reach it, so only routes registered *after* it (here,
    // only /cluster/failover/run) actually trigger these idempotent
    // "start once" guards. Hitting it repeatedly must not restart anything.
    it('starts the sync engine, ws channel, discovery, and failover watcher at most once across many requests', async () => {
        await post('/api/cluster/failover/run');
        await post('/api/cluster/failover/run');
        await post('/api/cluster/failover/run');
        expect(syncApi.startSyncEngine.mock.calls.length).toBeLessThanOrEqual(1);
        expect(wsChannel.initClusterWs.mock.calls.length).toBeLessThanOrEqual(1);
        expect(discoveryApi.startDiscovery.mock.calls.length).toBeLessThanOrEqual(1);
        expect(failoverApi.startFailoverWatcher.mock.calls.length).toBeLessThanOrEqual(1);
    });
});
