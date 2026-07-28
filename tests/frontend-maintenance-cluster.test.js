// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-cluster.js — the Cluster admin page:
// identity (peer id, display name, cluster token reveal/copy/rotate/set),
// the peer list and its per-row Test / Edit / Revoke actions, the pairing
// wizard's input validation and error mapping, the conflicts + sweep panel,
// and the WebSocket live-update wiring.
//
// Only `init()` is exported; everything else is module-private and reached
// through the DOM it renders — the same approach as the P1 frontend files.
//
// Mocked: api.js and ws.js (the network), sheet.js (openSheet/confirmSheet
// return values drive the flows), utils.js's showToast, and i18n.js over a
// test-controlled dictionary. Left real: escapeHtml and formatRelativeTime,
// because the escaping assertions below are the point.
//
// The module holds page/ws-wired flags and cached peers at module scope, so
// every test re-imports through vi.resetModules().

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../src/web/public/js/api.js', () => ({ api }));

// ws.on(type, fn) — capture the handlers so tests can fire server events.
const wsHandlers = new Map();
const ws = {
    on: vi.fn((type, fn) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, []);
        wsHandlers.get(type).push(fn);
    }),
};
vi.mock('../src/web/public/js/ws.js', () => ({ ws }));

// i18n: a faithful stand-in for t()/tf() over a dictionary the tests control.
// The real module keeps `dict` private and only fills it via a network fetch,
// and this file's convention is that i18nTf() call sites pass NO fallback —
// they rely on the key always existing (the i18n-drift hook enforces that).
// So interpolated strings are only observable with a dictionary present.
let i18nDict = {};
const i18nT = vi.fn((key, fallback) => i18nDict[key] || fallback || key);
const i18nTf = vi.fn((key, vars, fallback) => {
    const tpl = i18nDict[key] || fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
});
vi.mock('../src/web/public/js/i18n.js', () => ({ t: i18nT, tf: i18nTf }));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

// openSheet returns a handle whose close() the flows call; the rendered node
// is retained so tests can drive the inputs inside it.
const openedSheets = [];
const openSheet = vi.fn((opts) => {
    const handle = { close: vi.fn(), opts };
    openedSheets.push(handle);
    return handle;
});
let confirmAnswer = true;
const confirmSheet = vi.fn(async () => confirmAnswer);
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet, confirmSheet }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <div id="cluster-self-id"></div>
    <button id="cluster-self-id-copy"></button>
    <div id="cluster-self-name-display"></div>
    <div id="cluster-self-name-editor" class="hidden">
        <input id="cluster-self-name" />
        <button id="cluster-self-name-save"></button>
        <button id="cluster-self-name-cancel"></button>
    </div>
    <button id="cluster-self-name-edit"></button>
    <code id="cluster-self-token">••••••••••••••••</code>
    <button id="cluster-token-toggle"></button>
    <button id="cluster-token-copy"></button>
    <button id="cluster-token-rotate"></button>
    <button id="cluster-token-set"></button>
    <button id="cluster-add-peer-btn"></button>
    <button id="cluster-pairing-code-btn"></button>
    <div id="cluster-peers-list"></div>
    <div id="cluster-peers-empty" class="hidden"></div>
    <div id="cluster-stat-peers"></div>
    <div id="cluster-stat-online"></div>
    <div id="cluster-stat-conflicts"></div>
    <div id="cluster-stat-sweep"></div>
    <div id="cluster-conflicts-list"></div>
    <div id="cluster-conflicts-empty" class="hidden"></div>
    <div id="cluster-sweep-stats"></div>
    <div id="cluster-sweep-state" class="hidden"></div>
    <button id="cluster-sweep-run"></button>
    <div id="cluster-audit-list"></div>
    <div id="cluster-audit-empty" class="hidden"></div>
`;

const IDENTITY = { peerId: 'peer-aaaa-bbbb-cccc', name: 'Heimdal' };

const PEER = (over = {}) => ({
    peerId: 'peer-remote-1',
    name: 'Mac Studio',
    url: 'https://b.example.com',
    status: 'online',
    streamMode: 'proxy',
    lastSeenAt: Date.now() - 60_000,
    ...over,
});

/** Default happy-path responses; individual tests override before init(). */
function stubApi({ peers = [], conflicts = [], stats = {}, audit = [] } = {}) {
    api.get.mockImplementation(async (url) => {
        if (url === '/api/cluster/identity') return IDENTITY;
        if (url === '/api/cluster/peers') return { peers };
        if (url === '/api/cluster/conflicts') return { conflicts, stats };
        if (url.startsWith('/api/cluster/audit')) return { entries: audit };
        if (url === '/api/cluster/identity/token') return { token: 'f'.repeat(32) };
        return {};
    });
}

/** Fresh module + DOM, then init(). Returns once the initial loads settle. */
async function boot(opts) {
    vi.resetModules();
    wsHandlers.clear();
    document.body.innerHTML = DOM;
    stubApi(opts);
    const mod = await import('../src/web/public/js/maintenance-cluster.js');
    mod.init();
    await flush();
    return mod;
}

/** Let the init() fan-out of un-awaited promises settle. */
async function flush(times = 6) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < times; i++) await Promise.resolve();
}

function fire(type, msg) {
    for (const fn of wsHandlers.get(type) || []) fn(msg);
}

/** The node passed to the most recent openSheet() call. */
function lastSheetNode() {
    return openedSheets[openedSheets.length - 1].opts.content;
}

beforeEach(() => {
    vi.clearAllMocks();
    openedSheets.length = 0;
    confirmAnswer = true;
    i18nDict = {};
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => {}) },
    });
});

afterEach(() => {
    document.body.innerHTML = '';
});

// ---- boot ---------------------------------------------------------------

describe('init', () => {
    it('loads identity, peers, conflicts and audit', async () => {
        await boot();
        const urls = api.get.mock.calls.map((c) => c[0]);
        expect(urls).toEqual(
            expect.arrayContaining([
                '/api/cluster/identity',
                '/api/cluster/peers',
                '/api/cluster/conflicts',
            ]),
        );
        expect(urls.some((u) => u.startsWith('/api/cluster/audit'))).toBe(true);
    });

    it('subscribes to every live-update channel exactly once', async () => {
        const mod = await boot();
        mod.init(); // idempotent — the wiring guards are the point
        await flush();

        for (const type of [
            'peer_added',
            'peer_removed',
            'peer_status',
            'cluster_sweep_progress',
            'cluster_sweep_done',
        ]) {
            expect(wsHandlers.get(type), type).toHaveLength(1);
        }
    });

    it('survives a page whose markup is missing', async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        stubApi();
        const mod = await import('../src/web/public/js/maintenance-cluster.js');
        expect(() => mod.init()).not.toThrow();
        await flush();
    });
});

// ---- identity -----------------------------------------------------------

describe('identity', () => {
    it('renders the peer id and display name', async () => {
        await boot();
        expect($('cluster-self-id').textContent).toBe(IDENTITY.peerId);
        expect($('cluster-self-name').value).toBe('Heimdal');
        expect($('cluster-self-name-display').textContent).toBe('Heimdal');
    });

    it('falls back to a truncated peer id when unnamed', async () => {
        await boot();
        api.get.mockImplementation(async (u) =>
            u === '/api/cluster/identity' ? { peerId: 'peer-aaaa-bbbb-cccc', name: '' } : {},
        );
        // Re-render through the save path, which refreshes _identity.
        $('cluster-self-name-edit').click();
        $('cluster-self-name-cancel').click();
        await flush();
        expect($('cluster-self-name-display').textContent).toBe('Heimdal');
    });

    it('toggles the name editor', async () => {
        await boot();
        expect($('cluster-self-name-editor').classList.contains('hidden')).toBe(true);

        $('cluster-self-name-edit').click();
        expect($('cluster-self-name-editor').classList.contains('hidden')).toBe(false);
        expect($('cluster-self-name-edit').classList.contains('hidden')).toBe(true);

        $('cluster-self-name-cancel').click();
        expect($('cluster-self-name-editor').classList.contains('hidden')).toBe(true);
    });

    it('saves a new display name', async () => {
        await boot();
        api.put.mockResolvedValue({ peerId: IDENTITY.peerId, name: 'Renamed' });
        $('cluster-self-name').value = '  Renamed  ';

        $('cluster-self-name-save').click();
        await flush();

        expect(api.put).toHaveBeenCalledWith('/api/cluster/identity', { name: 'Renamed' });
        expect(showToast).toHaveBeenCalledWith('Saved');
    });

    it('refuses to save an empty name', async () => {
        await boot();
        $('cluster-self-name').value = '   ';
        $('cluster-self-name-save').click();
        await flush();
        expect(api.put).not.toHaveBeenCalled();
    });

    it('surfaces a save failure as a toast', async () => {
        await boot();
        api.put.mockRejectedValue(new Error('name taken'));
        $('cluster-self-name').value = 'X';
        $('cluster-self-name-save').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('name taken');
    });

    it('copies the peer id to the clipboard', async () => {
        await boot();
        $('cluster-self-id-copy').click();
        await flush();
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(IDENTITY.peerId);
        expect(showToast).toHaveBeenCalledWith('Peer ID copied');
    });

    it('reports a clipboard failure rather than throwing', async () => {
        await boot();
        navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
        $('cluster-self-id-copy').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('denied');
    });

    it('does not clobber the name field while it is focused', async () => {
        await boot();
        const input = $('cluster-self-name');
        input.value = 'half-typed';
        input.focus();
        fire('peer_added', {});
        await flush();
        expect(input.value).toBe('half-typed');
    });
});

// ---- token --------------------------------------------------------------

describe('cluster token', () => {
    it('reveals the token on demand, then hides it again', async () => {
        await boot();
        const code = $('cluster-self-token');

        $('cluster-token-toggle').click();
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/cluster/identity/token');
        expect(code.textContent).toBe('f'.repeat(32));
        expect($('cluster-token-toggle').textContent).toBe('Hide');

        $('cluster-token-toggle').click();
        await flush();
        expect(code.textContent).toBe('••••••••••••••••');
        expect($('cluster-token-toggle').textContent).toBe('Show token');
    });

    it('does not fetch the token again just to hide it', async () => {
        await boot();
        $('cluster-token-toggle').click();
        await flush();
        const fetches = api.get.mock.calls.filter(
            (c) => c[0] === '/api/cluster/identity/token',
        ).length;

        $('cluster-token-toggle').click();
        await flush();

        expect(
            api.get.mock.calls.filter((c) => c[0] === '/api/cluster/identity/token'),
        ).toHaveLength(fetches);
    });

    it('copies the token', async () => {
        await boot();
        $('cluster-token-copy').click();
        await flush();
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('f'.repeat(32));
        expect(showToast).toHaveBeenCalledWith('Token copied');
    });

    it('rotates only after the operator confirms', async () => {
        await boot();
        confirmAnswer = false;
        $('cluster-token-rotate').click();
        await flush();
        expect(api.post).not.toHaveBeenCalledWith('/api/cluster/identity/rotate-token');

        confirmAnswer = true;
        api.post.mockResolvedValue({});
        $('cluster-token-rotate').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/cluster/identity/rotate-token');
        expect(showToast).toHaveBeenCalledWith(
            'Token rotated. Re-pair every peer with the new value.',
        );
    });

    it('re-reveals the rotated token when it was already showing', async () => {
        await boot();
        $('cluster-token-toggle').click();
        await flush();

        api.post.mockResolvedValue({});
        api.get.mockImplementation(async (u) =>
            u === '/api/cluster/identity/token' ? { token: 'a'.repeat(32) } : {},
        );
        $('cluster-token-rotate').click();
        await flush();

        expect($('cluster-self-token').textContent).toBe('a'.repeat(32));
    });

    it('validates the pasted token in the set-token sheet', async () => {
        await boot();
        $('cluster-token-set').click();
        await flush();

        const node = lastSheetNode();
        node.querySelector('#set-token-input').value = 'too-short';
        node.querySelector('#set-token-submit').click();
        await flush();

        expect(node.querySelector('#set-token-status').textContent).toMatch(/32\+ hex/i);
        expect(api.post).not.toHaveBeenCalledWith(
            '/api/cluster/identity/set-token',
            expect.anything(),
        );
    });

    it('applies a valid pasted token and closes the sheet', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('cluster-token-set').click();
        await flush();

        const node = lastSheetNode();
        node.querySelector('#set-token-input').value = 'B'.repeat(32);
        node.querySelector('#set-token-submit').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/cluster/identity/set-token', {
            token: 'B'.repeat(32),
        });
        expect(openedSheets[openedSheets.length - 1].close).toHaveBeenCalled();
    });

    it('shows a server rejection inside the sheet, not as a toast', async () => {
        await boot();
        api.post.mockRejectedValue(new Error('token rejected'));
        $('cluster-token-set').click();
        await flush();

        const node = lastSheetNode();
        node.querySelector('#set-token-input').value = 'c'.repeat(40);
        node.querySelector('#set-token-submit').click();
        await flush();

        expect(node.querySelector('#set-token-status').textContent).toBe('token rejected');
    });
});

// ---- peers --------------------------------------------------------------

describe('peer list', () => {
    it('shows the empty state with no peers', async () => {
        await boot({ peers: [] });
        expect($('cluster-peers-empty').classList.contains('hidden')).toBe(false);
        expect($('cluster-peers-list').innerHTML).toBe('');
    });

    it('renders a row per peer with status and stream mode', async () => {
        await boot({ peers: [PEER(), PEER({ peerId: 'p2', name: 'NAS', status: 'offline' })] });

        const rows = $('cluster-peers-list').querySelectorAll('[data-peer-id]');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('Mac Studio');
        expect(rows[0].textContent).toContain('online');
        expect(rows[0].textContent).toContain('Proxy through this peer');
        expect(rows[1].textContent).toContain('offline');
    });

    it('labels a direct-stream peer differently', async () => {
        await boot({ peers: [PEER({ streamMode: 'direct' })] });
        expect($('cluster-peers-list').textContent).toContain('Browser fetches direct');
    });

    it('escapes peer-supplied text', async () => {
        await boot({
            peers: [PEER({ name: '<img src=x onerror=alert(1)>', url: 'https://<script>' })],
        });
        const html = $('cluster-peers-list').innerHTML;
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });

    it('says never for a peer that has not been seen', async () => {
        await boot({ peers: [PEER({ lastSeenAt: null })] });
        expect($('cluster-peers-list').textContent).toContain('Never');
    });

    it('counts peers and online peers', async () => {
        await boot({
            peers: [PEER(), PEER({ peerId: 'p2', status: 'offline' }), PEER({ peerId: 'p3' })],
        });
        expect($('cluster-stat-peers').textContent).toBe('3');
        expect($('cluster-stat-online').textContent).toBe('2 / 3');
    });

    it('shows a zero online count with no peers at all', async () => {
        await boot({ peers: [] });
        expect($('cluster-stat-online').textContent).toBe('0');
    });
});

describe('peer actions', () => {
    async function bootOnePeer() {
        await boot({ peers: [PEER()] });
        return $('cluster-peers-list').querySelector('[data-peer-id]');
    }

    it('tests a peer and reports the result', async () => {
        const row = await bootOnePeer();
        api.post.mockResolvedValue({ ok: true, payload: { name: 'Mac Studio', version: '2.1' } });

        row.querySelector('[data-act="test"]').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/cluster/peers/peer-remote-1/test');
        expect(showToast).toHaveBeenCalled();
    });

    it('reports a failed probe', async () => {
        const row = await bootOnePeer();
        api.post.mockResolvedValue({ ok: false, code: 'unreachable' });
        row.querySelector('[data-act="test"]').click();
        await flush();
        expect(showToast).toHaveBeenCalled();
    });

    it('revokes only after confirmation', async () => {
        const row = await bootOnePeer();
        confirmAnswer = false;
        row.querySelector('[data-act="revoke"]').click();
        await flush();
        expect(api.delete).not.toHaveBeenCalled();

        confirmAnswer = true;
        api.delete.mockResolvedValue({});
        row.querySelector('[data-act="revoke"]').click();
        await flush();
        expect(api.delete).toHaveBeenCalledWith('/api/cluster/peers/peer-remote-1');
        expect(showToast).toHaveBeenCalledWith('Peer revoked');
    });

    it('url-encodes a peer id with awkward characters', async () => {
        await boot({ peers: [PEER({ peerId: 'peer/with space' })] });
        const row = $('cluster-peers-list').querySelector('[data-peer-id]');
        api.post.mockResolvedValue({ ok: true, payload: {} });
        row.querySelector('[data-act="test"]').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/cluster/peers/peer%2Fwith%20space/test');
    });

    it('opens an edit sheet prefilled from the peer', async () => {
        const row = await bootOnePeer();
        row.querySelector('[data-act="edit"]').click();
        await flush();

        const node = lastSheetNode();
        expect(node.querySelector('#edit-peer-name').value).toBe('Mac Studio');
        expect(node.querySelector('#edit-peer-stream-mode').value).toBe('proxy');
    });
});

// ---- pairing wizard -----------------------------------------------------

describe('add-peer wizard', () => {
    async function openWizard() {
        await boot();
        $('cluster-add-peer-btn').click();
        await flush();
        return lastSheetNode();
    }

    it('requires a URL', async () => {
        const node = await openWizard();
        node.querySelector('#add-peer-url').value = '';
        node.querySelector('#add-peer-token').value = 'a'.repeat(32);
        node.querySelector('#add-peer-submit').click();
        await flush();

        expect(node.querySelector('#add-peer-status').textContent).toMatch(/http/i);
        expect(api.post).not.toHaveBeenCalled();
    });

    it('accepts a 32+ hex cluster token', async () => {
        const node = await openWizard();
        api.post.mockResolvedValue({ peer: { name: 'NAS' } });
        node.querySelector('#add-peer-url').value = 'https://b.example.com';
        node.querySelector('#add-peer-token').value = 'a'.repeat(32);
        node.querySelector('#add-peer-submit').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/cluster/peers', {
            url: 'https://b.example.com',
            token: 'a'.repeat(32),
        });
    });

    it('accepts a short pairing code and upper-cases it', async () => {
        const node = await openWizard();
        api.post.mockResolvedValue({ peer: { name: 'NAS' } });
        node.querySelector('#add-peer-url').value = 'https://b.example.com';
        node.querySelector('#add-peer-token').value = 'ab12cd';
        node.querySelector('#add-peer-submit').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/cluster/peers', {
            url: 'https://b.example.com',
            pairingCode: 'AB12CD',
        });
    });

    it('rejects a credential that is neither shape', async () => {
        const node = await openWizard();
        node.querySelector('#add-peer-url').value = 'https://b.example.com';
        node.querySelector('#add-peer-token').value = 'no';
        node.querySelector('#add-peer-submit').click();
        await flush();

        expect(node.querySelector('#add-peer-status').textContent).toMatch(/pairing code/i);
        expect(api.post).not.toHaveBeenCalled();
    });

    it('maps a server error code to a friendlier message', async () => {
        i18nDict['cluster.error.unreachable'] = 'Peer unreachable';
        const node = await openWizard();
        api.post.mockRejectedValue(
            Object.assign(new Error('raw'), { body: { code: 'unreachable' } }),
        );
        node.querySelector('#add-peer-url').value = 'https://b.example.com';
        node.querySelector('#add-peer-token').value = 'a'.repeat(32);
        node.querySelector('#add-peer-submit').click();
        await flush();

        expect(node.querySelector('#add-peer-status').textContent).toBe('Peer unreachable');
    });

    it('falls back to the raw message for an unmapped code', async () => {
        const node = await openWizard();
        api.post.mockRejectedValue(Object.assign(new Error('boom'), { body: { code: 'weird' } }));
        node.querySelector('#add-peer-url').value = 'https://b.example.com';
        node.querySelector('#add-peer-token').value = 'a'.repeat(32);
        node.querySelector('#add-peer-submit').click();
        await flush();

        expect(node.querySelector('#add-peer-status').textContent).toBe('boom');
    });

    it('re-enables the submit button after a failure', async () => {
        const node = await openWizard();
        api.post.mockRejectedValue(new Error('nope'));
        const submit = node.querySelector('#add-peer-submit');
        node.querySelector('#add-peer-url').value = 'https://b.example.com';
        node.querySelector('#add-peer-token').value = 'a'.repeat(32);
        submit.click();
        await flush();

        expect(submit.disabled).toBe(false);
        expect(submit.textContent).toBe('Pair');
    });
});

describe('pairing code', () => {
    it('issues a code and shows it', async () => {
        await boot();
        api.post.mockResolvedValue({ code: 'AB12CD' });
        $('cluster-pairing-code-btn').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/cluster/identity/pairing-code');
        expect(lastSheetNode().textContent).toContain('AB12CD');
    });

    it('opens nothing when the server returns no code', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('cluster-pairing-code-btn').click();
        await flush();
        expect(openedSheets).toHaveLength(0);
    });

    it('toasts a failure', async () => {
        await boot();
        api.post.mockRejectedValue(new Error('rate limited'));
        $('cluster-pairing-code-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('rate limited');
    });
});

// ---- sweep + conflicts --------------------------------------------------

describe('sweep', () => {
    it('starts a sweep and shows the running state', async () => {
        await boot();
        api.post.mockResolvedValue({});
        $('cluster-sweep-run').click();
        await flush();

        expect(api.post).toHaveBeenCalledWith('/api/cluster/sweep/run');
        expect($('cluster-sweep-state').textContent).toBe('Sweep started…');
        expect($('cluster-sweep-state').classList.contains('hidden')).toBe(false);
    });

    it('re-enables the button even when the request fails', async () => {
        await boot();
        api.post.mockRejectedValue(new Error('busy'));
        $('cluster-sweep-run').click();
        await flush();

        expect($('cluster-sweep-run').disabled).toBe(false);
        expect(showToast).toHaveBeenCalledWith('busy');
    });

    it('reports the conflict count and highlights a non-zero total', async () => {
        await boot({ stats: { conflicts: 3, lastRunAt: Date.now() - 5000 } });
        const el = $('cluster-stat-conflicts');
        expect(el.textContent).toBe('3');
        expect(el.classList.contains('text-tg-orange')).toBe(true);
    });

    it('does not highlight a clean sweep', async () => {
        await boot({ stats: { conflicts: 0, lastRunAt: Date.now() } });
        const el = $('cluster-stat-conflicts');
        expect(el.textContent).toBe('0');
        expect(el.classList.contains('text-tg-orange')).toBe(false);
    });

    it('says never before the first sweep', async () => {
        await boot({ stats: {} });
        expect($('cluster-stat-sweep').textContent).toBe('Never');
    });
});

// ---- live updates -------------------------------------------------------

describe('websocket updates', () => {
    it('reloads the peer list when a peer is added or removed', async () => {
        await boot({ peers: [PEER()] });
        api.get.mockClear();

        fire('peer_added', {});
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/cluster/peers');

        api.get.mockClear();
        fire('peer_removed', {});
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/cluster/peers');
    });

    it('applies a status change in place without refetching', async () => {
        await boot({ peers: [PEER({ status: 'online' })] });
        api.get.mockClear();

        fire('peer_status', { peerId: 'peer-remote-1', status: 'offline' });
        await flush();

        expect(api.get).not.toHaveBeenCalled();
        expect($('cluster-peers-list').textContent).toContain('offline');
        expect($('cluster-stat-online').textContent).toBe('0 / 1');
    });

    it('ignores a status event for an unknown peer', async () => {
        await boot({ peers: [PEER()] });
        expect(() => fire('peer_status', { peerId: 'ghost', status: 'offline' })).not.toThrow();
        expect($('cluster-peers-list').textContent).toContain('online');
    });

    it('shows sweep progress as it arrives', async () => {
        i18nDict['cluster.sweep.running'] = 'Sweeping — {conflicts} conflict(s)';
        await boot();
        fire('cluster_sweep_progress', { conflicts: 7 });
        expect($('cluster-sweep-state').textContent).toBe('Sweeping — 7 conflict(s)');
    });

    it('defaults the running conflict count to zero', async () => {
        i18nDict['cluster.sweep.running'] = 'Sweeping — {conflicts} conflict(s)';
        await boot();
        fire('cluster_sweep_progress', {});
        expect($('cluster-sweep-state').textContent).toBe('Sweeping — 0 conflict(s)');
    });

    it('reloads conflicts when the sweep finishes', async () => {
        await boot();
        api.get.mockClear();
        fire('cluster_sweep_done', {});
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/cluster/conflicts');
    });
});

// ---- audit --------------------------------------------------------------

describe('audit log', () => {
    it('shows the empty state with no entries', async () => {
        await boot({ audit: [] });
        expect($('cluster-audit-empty').classList.contains('hidden')).toBe(false);
    });

    it('renders entries and marks failures', async () => {
        await boot({
            audit: [
                { ts: Date.now() - 1000, kind: 'handshake', detail: 'ok', ok: 1 },
                { ts: Date.now() - 2000, kind: 'sig_fail', detail: 'bad signature', ok: 0 },
            ],
        });
        const rows = $('cluster-audit-list').querySelectorAll('div');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect($('cluster-audit-list').innerHTML).toContain('text-red-300');
        expect($('cluster-audit-list').textContent).toContain('bad signature');
    });

    it('escapes audit detail text', async () => {
        await boot({
            audit: [{ ts: Date.now(), kind: 'x', detail: '<script>alert(1)</script>', ok: 1 }],
        });
        expect($('cluster-audit-list').innerHTML).not.toContain('<script>');
    });

    it('treats a failed audit fetch as empty', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        api.get.mockImplementation(async (url) => {
            if (url.startsWith('/api/cluster/audit')) throw new Error('500');
            if (url === '/api/cluster/identity') return IDENTITY;
            if (url === '/api/cluster/peers') return { peers: [] };
            return {};
        });
        const mod = await import('../src/web/public/js/maintenance-cluster.js');
        mod.init();
        await flush();

        expect($('cluster-audit-empty').classList.contains('hidden')).toBe(false);
    });
});

// ---- failure paths ------------------------------------------------------

describe('load failures', () => {
    it('toasts when identity or peers cannot be loaded', async () => {
        vi.resetModules();
        document.body.innerHTML = DOM;
        api.get.mockRejectedValue(new Error('offline'));
        const mod = await import('../src/web/public/js/maintenance-cluster.js');
        mod.init();
        await flush();

        expect(showToast).toHaveBeenCalledWith('offline');
    });
});
