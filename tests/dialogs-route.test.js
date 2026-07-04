// Route-level tests for /api/dialogs. Mounts the real dialogs router on a
// minimal Express app with fake Telegram clients, and verifies:
//   1. the dialog list is a FULL iterDialogs sweep, not the old capped
//      getDialogs({limit:500}) snapshot — dialogs past position 500 must
//      still appear (regression guard for the "can't find my group" trap);
//   2. `?q=` server-side search filters by name, username, and id;
//   3. the capped getDialogs fallback still works when iterDialogs throws
//      before yielding anything.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-dialogs-'));

let app;
let server;
let port;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

// ---- fake Telegram client ---------------------------------------------------

function makeDialog(i, { archived = false, name, username, bot = false } = {}) {
    return {
        id: `-100${String(90000000 + i)}`,
        title: name || `Chat ${i}`,
        name: name || `Chat ${i}`,
        isGroup: true,
        isChannel: false,
        isUser: false,
        archived,
        username: username || null,
        entity: { participantsCount: 5, bot },
    };
}

// 600 active dialogs (index 0..599) + 30 archived. The needle group sits at
// position 550 — beyond the old getDialogs({limit:500}) cap, so it only
// shows up if the router really sweeps everything.
const ACTIVE = Array.from({ length: 600 }, (_, i) =>
    i === 550 ? makeDialog(i, { name: 'Needle Group', username: 'needle_grp' }) : makeDialog(i),
);
const ARCHIVED = Array.from({ length: 30 }, (_, i) => makeDialog(1000 + i, { archived: true }));

function makeFakeClient({ failIter = false } = {}) {
    return {
        connected: true,
        async *iterDialogs({ archived } = {}) {
            if (failIter) throw new Error('FLOOD_WAIT_42');
            const list = archived ? ARCHIVED : ACTIVE;
            for (const d of list) yield d;
        },
        // Old capped API — the fallback path. Serves at most `limit` rows.
        async getDialogs({ limit = 100, archived = false } = {}) {
            const list = archived ? ARCHIVED : ACTIVE;
            return list.slice(0, limit);
        },
    };
}

async function mountRouter(client) {
    const { createDialogsRouter, invalidateDialogsCache } = await import(
        '../src/web/routes/dialogs.js'
    );
    invalidateDialogsCache();
    const fakeAM = {
        clients: new Map([['acct1', client]]),
        metadata: new Map([['acct1', { id: 'acct1', name: 'Test', phone: '', username: 'test' }]]),
    };
    const a = express();
    a.use(express.json());
    a.use(
        '/api',
        createDialogsRouter({
            getAccountManager: async () => fakeAM,
            getTelegramClient: () => null,
        }),
    );
    return a;
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    app = await mountRouter(makeFakeClient());
    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('GET /api/dialogs — full sweep', () => {
    it('returns dialogs beyond the old 500 cap', async () => {
        const res = await fetch(apiUrl('/api/dialogs?fresh=1'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        // 600 active + 30 archived
        expect(body.dialogs.length).toBe(630);
        const needle = body.dialogs.find((d) => d.name === 'Needle Group');
        expect(needle).toBeTruthy();
    });

    it('marks archived dialogs', async () => {
        const res = await fetch(apiUrl('/api/dialogs'));
        const body = await res.json();
        const archived = body.dialogs.filter((d) => d.archived);
        expect(archived.length).toBe(30);
    });
});

describe('GET /api/dialogs?q= — server-side search', () => {
    it('filters by name substring, case-insensitive', async () => {
        const res = await fetch(apiUrl('/api/dialogs?q=needle'));
        const body = await res.json();
        expect(body.dialogs.length).toBe(1);
        expect(body.dialogs[0].name).toBe('Needle Group');
    });

    it('filters by username', async () => {
        const res = await fetch(apiUrl('/api/dialogs?q=needle_grp'));
        const body = await res.json();
        expect(body.dialogs.length).toBe(1);
    });

    it('filters by id substring', async () => {
        const needleId = ACTIVE[550].id; // -10090000550
        const res = await fetch(apiUrl(`/api/dialogs?q=${needleId.slice(4)}`));
        const body = await res.json();
        expect(body.dialogs.some((d) => d.id === needleId)).toBe(true);
    });

    it('empty q returns everything', async () => {
        const res = await fetch(apiUrl('/api/dialogs?q='));
        const body = await res.json();
        expect(body.dialogs.length).toBe(630);
    });
});

describe('iterDialogs failure fallback', () => {
    it('falls back to capped getDialogs when the sweep throws before yielding', async () => {
        const failApp = await mountRouter(makeFakeClient({ failIter: true }));
        const failServer = await new Promise((res) => {
            const s = failApp.listen(0, '127.0.0.1', () => res(s));
        });
        const failPort = failServer.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${failPort}/api/dialogs?fresh=1`);
            expect(res.status).toBe(200);
            const body = await res.json();
            // Capped fallback: 500 active + 200-cap on archived (30 exist)
            expect(body.dialogs.length).toBe(530);
        } finally {
            await new Promise((res) => failServer.close(res));
        }
    });
});
