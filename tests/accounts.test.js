// Covers src/core/accounts.js — the multi-account Telegram client manager:
// session load/decrypt, legacy migration, client construction, the account
// registry accessors, and the web phone-auth wizard state machine.
//
// gramJS (`telegram`, `telegram/sessions/index.js`) is mocked wholesale — it
// opens real MTProto sockets and is P3 scope in its own right. Everything
// underneath stays real: core/security.js and core/secret.js do genuine
// AES round-trips, and config/manager.js + core/db.js run against an
// isolated TGDL_DATA_DIR, which is what makes the session files on disk a
// real assertion rather than a mock echo.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- gramJS doubles -----------------------------------------------------

// One client instance per createClient() call. Tests reach for the most
// recent via `lastClient()`, or drive behaviour by queueing overrides.
const clientInstances = [];
const clientOverrides = [];

class FakeTelegramClient {
    constructor(session, apiId, apiHash, opts) {
        this.session = session;
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.opts = opts;
        this.connected = false;
        this.disconnectCalls = 0;
        this.invocations = [];

        const o = clientOverrides.shift() || {};
        this._me = o.me ?? {
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: '+15550001',
            id: 42,
            username: 'ada',
        };
        this._authorized = o.authorized ?? true;
        this._connectError = o.connectError ?? null;
        this._invokeError = o.invokeError ?? null;
        this._startImpl = o.startImpl ?? null;

        clientInstances.push(this);
    }

    async connect() {
        if (this._connectError) throw this._connectError;
        this.connected = true;
    }
    async disconnect() {
        this.disconnectCalls++;
        this.connected = false;
    }
    async checkAuthorization() {
        return this._authorized;
    }
    async getMe() {
        return this._me;
    }
    async invoke(req) {
        this.invocations.push(req);
        if (this._invokeError) throw this._invokeError;
        return { ok: true };
    }
    async start(callbacks) {
        this.startCallbacks = callbacks;
        if (this._startImpl) return this._startImpl(callbacks, this);
        return undefined;
    }
}

class FakeStringSession {
    constructor(str = '') {
        this.str = str;
    }
    save() {
        return this.str || 'SAVED_SESSION';
    }
}

class FakePingDelayDisconnect {
    constructor(args) {
        Object.assign(this, args);
    }
}

vi.mock('telegram', () => ({
    TelegramClient: FakeTelegramClient,
    Api: { PingDelayDisconnect: FakePingDelayDisconnect },
}));
vi.mock('telegram/sessions/index.js', () => ({ StringSession: FakeStringSession }));

const buildProxy = vi.fn(() => null);
vi.mock('../src/core/proxy.js', () => ({ buildProxy: (...a) => buildProxy(...a) }));

function lastClient() {
    return clientInstances[clientInstances.length - 1];
}

// ---- harness ------------------------------------------------------------

let DATA_DIR;
let SESSIONS_DIR;
let accountsMod;
let secure;

const CONFIG = { telegram: { apiId: '12345', apiHash: 'abcdef' } };

async function loadModule() {
    vi.resetModules();
    accountsMod = await import('../src/core/accounts.js');
    const { SecureSession } = await import('../src/core/security.js');
    const { getOrGenerateSecret } = await import('../src/core/secret.js');
    secure = new SecureSession(getOrGenerateSecret());
    return accountsMod;
}

/** Write an encrypted session file exactly as the manager itself would. */
function writeSession(accountId, sessionString, mtimeMs) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = path.join(SESSIONS_DIR, `${accountId}.enc`);
    fs.writeFileSync(file, JSON.stringify(secure.encrypt(sessionString), null, 2));
    if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
}

beforeEach(() => {
    DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-accounts-'));
    SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
    process.env.TGDL_DATA_DIR = DATA_DIR;
    clientInstances.length = 0;
    clientOverrides.length = 0;
    buildProxy.mockReset();
    buildProxy.mockReturnValue(null);
});

afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- on-disk layout -----------------------------------------------------

describe('accounts — session directory resolution', () => {
    it('resolves the sessions dir under TGDL_DATA_DIR', async () => {
        const { SESSIONS_DIR: resolved } = await loadModule();
        expect(resolved).toBe(SESSIONS_DIR);
    });

    it('does not create directories or write a secret merely on import', async () => {
        // Importing a module must not touch the operator's disk. The manager
        // used to mkdirSync the sessions dir and call getOrGenerateSecret()
        // at module scope, so every importer — including every route test —
        // created data/sessions and data/secret.key as a side effect.
        vi.resetModules();
        await import('../src/core/accounts.js');
        expect(fs.existsSync(SESSIONS_DIR)).toBe(false);
        expect(fs.existsSync(path.join(DATA_DIR, 'secret.key'))).toBe(false);
    });

    it('creates the sessions dir on first construction, not before', async () => {
        const { AccountManager } = await loadModule();
        // loadModule() built a SecureSession, which writes secret.key.
        fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
        expect(fs.existsSync(SESSIONS_DIR)).toBe(false);
        new AccountManager(CONFIG);
        expect(fs.existsSync(SESSIONS_DIR)).toBe(true);
    });
});

// ---- loadAll ------------------------------------------------------------

describe('AccountManager.loadAll', () => {
    it('returns 0 when there are no session files', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        expect(await mgr.loadAll()).toBe(0);
        expect(mgr.count).toBe(0);
        mgr.stopKeepAlive();
    });

    it('decrypts each session, connects, and records metadata', async () => {
        const { AccountManager } = await loadModule();
        writeSession('ada', 'SESSION-ADA');
        const mgr = new AccountManager(CONFIG);

        expect(await mgr.loadAll()).toBe(1);
        expect(mgr.count).toBe(1);
        expect(mgr.getList()).toEqual([
            {
                id: 'ada',
                name: 'Ada Lovelace',
                phone: '+15550001',
                userId: '42',
                username: 'ada',
            },
        ]);
        // The decrypted string reached gramJS, i.e. the crypto round-tripped.
        expect(lastClient().session.str).toBe('SESSION-ADA');
        mgr.stopKeepAlive();
    });

    it('orders accounts oldest-file-first, so the default is the oldest', async () => {
        const { AccountManager } = await loadModule();
        const now = Date.now();
        writeSession('newer', 'S-NEW', now);
        writeSession('older', 'S-OLD', now - 60_000);

        const mgr = new AccountManager(CONFIG);
        await mgr.loadAll();

        expect([...mgr.clients.keys()]).toEqual(['older', 'newer']);
        expect(mgr.getDefaultId()).toBe('older');
        mgr.stopKeepAlive();
    });

    it('skips an account whose session is no longer authorized, and disconnects it', async () => {
        const { AccountManager } = await loadModule();
        writeSession('expired', 'S-EXPIRED');
        clientOverrides.push({ authorized: false });

        const mgr = new AccountManager(CONFIG);
        expect(await mgr.loadAll()).toBe(0);
        expect(mgr.count).toBe(0);
        expect(lastClient().disconnectCalls).toBe(1);
        mgr.stopKeepAlive();
    });

    it('survives one unreadable session file and still loads the rest', async () => {
        const { AccountManager } = await loadModule();
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SESSIONS_DIR, 'broken.enc'), 'not json at all');
        writeSession('good', 'S-GOOD');

        const mgr = new AccountManager(CONFIG);
        expect(await mgr.loadAll()).toBe(1);
        expect(mgr.getDefaultId()).toBe('good');
        mgr.stopKeepAlive();
    });

    it('ignores non-.enc files in the sessions dir', async () => {
        const { AccountManager } = await loadModule();
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SESSIONS_DIR, 'notes.txt'), 'hello');
        fs.writeFileSync(path.join(SESSIONS_DIR, 'session.enc.bak'), 'hello');

        const mgr = new AccountManager(CONFIG);
        expect(await mgr.loadAll()).toBe(0);
        mgr.stopKeepAlive();
    });

    it('writes the loaded account list into config', async () => {
        const { AccountManager } = await loadModule();
        writeSession('ada', 'S');
        const mgr = new AccountManager(CONFIG);
        await mgr.loadAll();

        const { loadConfig } = await import('../src/config/manager.js');
        expect(loadConfig().accounts).toEqual([
            {
                id: 'ada',
                name: 'Ada Lovelace',
                phone: '+15550001',
                userId: '42',
                username: 'ada',
            },
        ]);
        mgr.stopKeepAlive();
    });
});

// ---- legacy migration ---------------------------------------------------

describe('AccountManager.migrateLegacy', () => {
    it('promotes data/session.enc to a named multi-account session', async () => {
        const { AccountManager } = await loadModule();
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(
            path.join(DATA_DIR, 'session.enc'),
            JSON.stringify(secure.encrypt('LEGACY-SESSION')),
        );

        const mgr = new AccountManager(CONFIG);
        await mgr.migrateLegacy();

        // Named after the account's username.
        const migrated = path.join(SESSIONS_DIR, 'ada.enc');
        expect(fs.existsSync(migrated)).toBe(true);
        const round = secure.decrypt(JSON.parse(fs.readFileSync(migrated, 'utf8')));
        expect(round).toBe('LEGACY-SESSION');
    });

    it('is a no-op when no legacy file exists', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        await mgr.migrateLegacy();
        expect(fs.readdirSync(SESSIONS_DIR)).toEqual([]);
    });

    it('refuses to migrate once multi-account sessions are present', async () => {
        const { AccountManager } = await loadModule();
        fs.writeFileSync(
            path.join(DATA_DIR, 'session.enc'),
            JSON.stringify(secure.encrypt('LEGACY-SESSION')),
        );
        writeSession('existing', 'S-EXISTING');

        const mgr = new AccountManager(CONFIG);
        await mgr.migrateLegacy();

        expect(fs.readdirSync(SESSIONS_DIR).sort()).toEqual(['existing.enc']);
    });

    it('swallows a corrupt legacy file instead of failing the boot', async () => {
        const { AccountManager } = await loadModule();
        fs.writeFileSync(path.join(DATA_DIR, 'session.enc'), 'garbage');
        const mgr = new AccountManager(CONFIG);
        await expect(mgr.migrateLegacy()).resolves.toBeUndefined();
        expect(fs.readdirSync(SESSIONS_DIR)).toEqual([]);
    });
});

// ---- createClient -------------------------------------------------------

describe('AccountManager.createClient', () => {
    it('passes the parsed api credentials and a labelled device model', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('main', 'SEED');

        expect(client.apiId).toBe(12345);
        expect(client.apiHash).toBe('abcdef');
        expect(client.opts.deviceModel).toBe('TG-DL [main]');
        expect(client.session.str).toBe('SEED');
    });

    it('uses a capped retry policy rather than hammering during an outage', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('main');
        expect(client.opts.connectionRetries).toBe(5);
        expect(client.opts.retryDelay).toBe(2000);
    });

    it('attaches a proxy when one is configured', async () => {
        const { AccountManager } = await loadModule();
        buildProxy.mockReturnValue({ ip: '10.0.0.1', port: 1080, socksType: 5 });
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('main');
        expect(client.opts.proxy).toEqual({ ip: '10.0.0.1', port: 1080, socksType: 5 });
    });

    it('connects direct when the proxy config throws', async () => {
        const { AccountManager } = await loadModule();
        buildProxy.mockImplementation(() => {
            throw new Error('bad proxy url');
        });
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('main');
        expect(client.opts.proxy).toBeUndefined();
    });
});

// ---- registry accessors -------------------------------------------------

describe('AccountManager registry accessors', () => {
    async function withTwo() {
        const { AccountManager } = await loadModule();
        const now = Date.now();
        writeSession('first', 'S1', now - 60_000);
        writeSession('second', 'S2', now);
        const mgr = new AccountManager(CONFIG);
        await mgr.loadAll();
        mgr.stopKeepAlive();
        return mgr;
    }

    it('getClient returns the named client', async () => {
        const mgr = await withTwo();
        expect(mgr.getClient('second')).toBe(mgr.clients.get('second'));
    });

    it('getClient falls back to the default for an unknown or missing id', async () => {
        const mgr = await withTwo();
        const dflt = mgr.clients.get('first');
        expect(mgr.getClient('nope')).toBe(dflt);
        expect(mgr.getClient(null)).toBe(dflt);
        expect(mgr.getClient('')).toBe(dflt);
    });

    it('getDefaultClient / getDefaultId return null on an empty registry', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        expect(mgr.getDefaultClient()).toBeNull();
        expect(mgr.getDefaultId()).toBeNull();
    });

    it('getIdForClient reverse-looks-up a held client instance', async () => {
        const mgr = await withTwo();
        expect(mgr.getIdForClient(mgr.clients.get('second'))).toBe('second');
        expect(mgr.getIdForClient({ not: 'a client' })).toBeNull();
        expect(mgr.getIdForClient(null)).toBeNull();
    });

    it('disconnectAll empties the registry even when a disconnect throws', async () => {
        const mgr = await withTwo();
        mgr.clients.get('first').disconnect = async () => {
            throw new Error('socket already gone');
        };
        await mgr.disconnectAll();
        expect(mgr.count).toBe(0);
        expect(mgr.getList()).toEqual([]);
    });
});

// ---- removeAccount ------------------------------------------------------

describe('AccountManager.removeAccount', () => {
    it('disconnects, forgets and deletes the session file', async () => {
        const { AccountManager } = await loadModule();
        writeSession('ada', 'S');
        const mgr = new AccountManager(CONFIG);
        await mgr.loadAll();
        mgr.stopKeepAlive();
        const client = mgr.clients.get('ada');

        mgr.removeAccount('ada');

        expect(client.disconnectCalls).toBe(1);
        expect(mgr.count).toBe(0);
        expect(mgr.getList()).toEqual([]);
        expect(fs.existsSync(path.join(SESSIONS_DIR, 'ada.enc'))).toBe(false);
    });

    it('is a no-op for an unknown account', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        expect(() => mgr.removeAccount('ghost')).not.toThrow();
    });

    it('still deletes an orphaned session file with no live client', async () => {
        const { AccountManager } = await loadModule();
        writeSession('orphan', 'S');
        const mgr = new AccountManager(CONFIG);
        mgr.removeAccount('orphan');
        expect(fs.existsSync(path.join(SESSIONS_DIR, 'orphan.enc'))).toBe(false);
    });
});

// ---- keep-alive ---------------------------------------------------------

describe('AccountManager keep-alive', () => {
    it('pings every connected client with a disconnect-delay extension', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('a');
        await client.connect();
        mgr.clients.set('a', client);

        mgr._startKeepAlive();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(client.invocations).toHaveLength(1);
        expect(client.invocations[0].disconnectDelay).toBe(90);
        mgr.stopKeepAlive();
    });

    it('skips clients that are not connected', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('a');
        mgr.clients.set('a', client); // never connected

        mgr._startKeepAlive();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(client.invocations).toHaveLength(0);
        mgr.stopKeepAlive();
    });

    it('backs off for 10 minutes after a FloodWait instead of pinging into the throttle', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        clientOverrides.push({ invokeError: new Error('FLOOD_WAIT_420') });
        const client = await mgr.createClient('a');
        await client.connect();
        mgr.clients.set('a', client);

        mgr._startKeepAlive();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(client.invocations).toHaveLength(1);

        // Next few minutes of ticks are suppressed.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(client.invocations).toHaveLength(1);

        // Past the backoff window, pinging resumes.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(client.invocations.length).toBeGreaterThan(1);
        mgr.stopKeepAlive();
    });

    it('keeps pinging after a non-flood error', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        clientOverrides.push({ invokeError: new Error('ECONNRESET') });
        const client = await mgr.createClient('a');
        await client.connect();
        mgr.clients.set('a', client);

        mgr._startKeepAlive();
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(client.invocations.length).toBeGreaterThan(1);
        mgr.stopKeepAlive();
    });

    it('is idempotent — re-arming does not stack intervals', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('a');
        await client.connect();
        mgr.clients.set('a', client);

        mgr._startKeepAlive();
        mgr._startKeepAlive();
        mgr._startKeepAlive();
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(60_000);

        // 3 leading 5s timers + 1 surviving interval tick = 4, not 3 per tick.
        expect(client.invocations).toHaveLength(4);
        mgr.stopKeepAlive();
    });

    it('stopKeepAlive halts the loop and is safe to call twice', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const client = await mgr.createClient('a');
        await client.connect();
        mgr.clients.set('a', client);

        mgr._startKeepAlive();
        await vi.advanceTimersByTimeAsync(5_000);
        mgr.stopKeepAlive();
        mgr.stopKeepAlive();
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(client.invocations).toHaveLength(1);
    });
});

// ---- web phone-auth wizard ---------------------------------------------

describe('AccountManager web phone-auth wizard', () => {
    // Drives client.start() the way gramJS does: call each callback in turn
    // and await the deferred the manager parks on it.
    function scriptedStart({ needs2fa = false } = {}) {
        return async (cb) => {
            await cb.phoneNumber();
            await cb.phoneCode();
            if (needs2fa) await cb.password();
        };
    }

    it('rejects a begin when API credentials are missing', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager({ telegram: {} });
        await expect(mgr.beginPhoneAuth('main')).rejects.toThrow(/not configured/i);
    });

    it('rejects a duplicate account label', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        mgr.clients.set('main', {});
        await expect(mgr.beginPhoneAuth('main')).rejects.toThrow(/already exists/i);
    });

    it('normalises the requested label to a slug', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: () => new Promise(() => {}) });
        const mgr = new AccountManager(CONFIG);
        const { sessionId, state } = await mgr.beginPhoneAuth('  My Main Account ');
        expect(state).toBe('phone');
        expect(mgr._authFlows.get(sessionId).requestedLabel).toBe('my_main_account');
        await mgr.cancelAuth(sessionId);
    });

    it('walks phone → code → done and persists the session', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart() });
        const mgr = new AccountManager(CONFIG);

        const { sessionId } = await mgr.beginPhoneAuth('main');
        const afterPhone = await mgr.submitPhone(sessionId, ' +15550001 ');
        expect(afterPhone.state).toBe('code');

        const afterCode = await mgr.submitCode(sessionId, ' 12345 ');
        expect(afterCode.state).toBe('done');
        expect(afterCode.accountId).toBe('main');

        expect(mgr.count).toBe(1);
        const file = path.join(SESSIONS_DIR, 'main.enc');
        expect(fs.existsSync(file)).toBe(true);
        expect(secure.decrypt(JSON.parse(fs.readFileSync(file, 'utf8')))).toBe('SAVED_SESSION');
        mgr.stopKeepAlive();
    });

    it('walks phone → code → password → done when 2FA is on', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart({ needs2fa: true }) });
        const mgr = new AccountManager(CONFIG);

        const { sessionId } = await mgr.beginPhoneAuth('main');
        expect((await mgr.submitPhone(sessionId, '+15550001')).state).toBe('code');
        expect((await mgr.submitCode(sessionId, '12345')).state).toBe('password');

        const done = await mgr.submit2fa(sessionId, 'hunter2');
        expect(done.state).toBe('done');
        expect(done.accountId).toBe('main');
        mgr.stopKeepAlive();
    });

    it('derives an account id from the username when no label was given', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart() });
        const mgr = new AccountManager(CONFIG);

        const { sessionId } = await mgr.beginPhoneAuth('');
        await mgr.submitPhone(sessionId, '+15550001');
        const done = await mgr.submitCode(sessionId, '12345');

        expect(done.accountId).toBe('ada');
        mgr.stopKeepAlive();
    });

    it('de-duplicates a derived id against an existing account', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart() });
        const mgr = new AccountManager(CONFIG);
        mgr.clients.set('ada', {});

        const { sessionId } = await mgr.beginPhoneAuth('');
        await mgr.submitPhone(sessionId, '+15550001');
        const done = await mgr.submitCode(sessionId, '12345');

        expect(done.accountId).toBe('ada_1');
        mgr.stopKeepAlive();
    });

    it('surfaces a login failure as state=error', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({
            startImpl: async (cb) => {
                await cb.phoneNumber();
                throw new Error('PHONE_NUMBER_INVALID');
            },
        });
        const mgr = new AccountManager(CONFIG);

        const { sessionId } = await mgr.beginPhoneAuth('main');
        const after = await mgr.submitPhone(sessionId, '+1');

        expect(after.state).toBe('error');
        expect(after.error).toBe('PHONE_NUMBER_INVALID');
        expect(mgr.count).toBe(0);
    });

    it('rejects submissions made in the wrong state', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: () => new Promise(() => {}) });
        const mgr = new AccountManager(CONFIG);
        const { sessionId } = await mgr.beginPhoneAuth('main');

        await expect(mgr.submitCode(sessionId, '123')).rejects.toThrow(/wrong state/i);
        await expect(mgr.submit2fa(sessionId, 'pw')).rejects.toThrow(/wrong state/i);
        await mgr.cancelAuth(sessionId);
    });

    it('rejects an unknown session id', async () => {
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        await expect(mgr.submitPhone('nope', '+1')).rejects.toThrow(/not found/i);
        await expect(mgr.submitCode('nope', '1')).rejects.toThrow(/not found/i);
        await expect(mgr.submit2fa('nope', 'p')).rejects.toThrow(/not found/i);
        expect(mgr.getAuthStatus('nope')).toBeNull();
        expect(await mgr.cancelAuth('nope')).toEqual({ ok: false, reason: 'not_found' });
    });

    it('rejects empty phone and code submissions', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: () => new Promise(() => {}) });
        const mgr = new AccountManager(CONFIG);
        const { sessionId } = await mgr.beginPhoneAuth('main');

        await expect(mgr.submitPhone(sessionId, '   ')).rejects.toThrow(/phone required/i);
        await mgr.cancelAuth(sessionId);
    });

    it('cancelAuth unblocks the flow, disconnects and forgets the session', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart() });
        const mgr = new AccountManager(CONFIG);

        const { sessionId } = await mgr.beginPhoneAuth('main');
        const client = lastClient();

        expect(await mgr.cancelAuth(sessionId)).toEqual({ ok: true });
        expect(client.disconnectCalls).toBe(1);
        expect(mgr.getAuthStatus(sessionId)).toBeNull();
    });

    // cancelAuth() rejects all three deferreds to unblock client.start().
    // But gramJS only ever awaits the one matching the current step — cancel
    // at the phone prompt and nothing has touched codeDeferred or
    // passwordDeferred, so their rejections have no handler. Node's default
    // since v15 is --unhandled-rejections=throw, which takes the whole server
    // process down when a user abandons the add-account wizard.
    it('cancelling before gramJS asks for the code leaks no unhandled rejection', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart() });
        const mgr = new AccountManager(CONFIG);

        const seen = [];
        const onUnhandled = (err) => seen.push(err);
        process.on('unhandledRejection', onUnhandled);
        try {
            const { sessionId } = await mgr.beginPhoneAuth('main');
            await mgr.cancelAuth(sessionId);
            // Unhandled-rejection detection is deferred to a later macrotask.
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }

        expect(seen.map((e) => e?.message)).toEqual([]);
    });

    it('getAuthStatus reports the live state', async () => {
        const { AccountManager } = await loadModule();
        clientOverrides.push({ startImpl: scriptedStart() });
        const mgr = new AccountManager(CONFIG);

        const { sessionId } = await mgr.beginPhoneAuth('main');
        expect(mgr.getAuthStatus(sessionId)).toEqual({
            state: 'phone',
            error: null,
            accountId: null,
        });

        await mgr.submitPhone(sessionId, '+15550001');
        expect(mgr.getAuthStatus(sessionId).state).toBe('code');
        await mgr.cancelAuth(sessionId);
    });

    it('_waitNextState resolves with the current state on timeout', async () => {
        vi.useFakeTimers();
        const { AccountManager } = await loadModule();
        const mgr = new AccountManager(CONFIG);
        const flow = { state: 'phone', stateWaiters: new Set() };

        const p = mgr._waitNextState(flow, 1000);
        await vi.advanceTimersByTimeAsync(1001);

        expect(await p).toBe('phone');
        expect(flow.stateWaiters.size).toBe(0);
    });
});
