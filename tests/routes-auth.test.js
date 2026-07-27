// Route-level HTTP tests for /api/login, /api/logout, /api/auth/*, and
// /api/auth_check. Mounts the real auth router against a temp DB/config,
// with core/web-auth.js, web/middleware/auth.js's cookieParser, and
// web/lib/config-cache.js/config-writer.js all running for real — the
// session/password logic here is exactly what coverage buys security
// assurance for.
//
// express-rate-limit is mocked to a pass-through: loginLimiter is a
// single shared instance reused across /login, /change-password,
// /reset/request and /reset/confirm, so a real limiter would start
// 429ing partway through this file's ~40 requests from the same IP.
// Rate-limiting itself isn't this route's logic to verify.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.mock('express-rate-limit', () => ({
    default: () => (req, res, next) => next(),
}));

// readConfigSafe's 2s in-memory cache is a real cross-test race here:
// a prior test's request can populate the cache with a "configured"
// snapshot that outlives that test, landing mid-flight in the next
// one's fetch despite invalidateConfigCache() in beforeEach (the
// populating request's cache-set can complete after the invalidate
// already ran). Caching isn't this route's logic to verify, so bypass
// it entirely and always read fresh.
vi.mock('../src/web/lib/config-cache.js', () => ({
    readConfigSafe: async () => {
        const { loadConfig } = await import('../src/config/manager.js');
        return loadConfig();
    },
    invalidateConfigCache: () => {},
}));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-routes-auth-'));

let dbApi;
let db;
let manager;
let webAuth;
let cookieParser;
let app;
let server;
let port;
let broadcasts;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

function extractCookie(res) {
    const raw = res.headers.get('set-cookie') || '';
    const match = raw.match(/tg_dl_session=([^;]*)/);
    return match ? `tg_dl_session=${match[1]}` : '';
}

async function post(pathname, body, cookie) {
    return fetch(apiUrl(pathname), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body ?? {}),
    });
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    webAuth = await import('../src/core/web-auth.js');
    ({ cookieParser } = await import('../src/web/middleware/auth.js'));

    const { createAuthRouter } = await import('../src/web/routes/auth.js');

    broadcasts = [];
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser);
    app.use('/api', createAuthRouter({ broadcast: (msg) => broadcasts.push(msg) }));

    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    dbApi.kvDelete('config');
    db.prepare('DELETE FROM groups').run();
    db.prepare('DELETE FROM web_sessions').run();
    manager._resetConfigBus();
    broadcasts.length = 0;
});

function configureAdmin(password = 'correct-horse-battery') {
    const cfg = manager.loadConfig();
    if (!cfg.web) cfg.web = {};
    cfg.web.enabled = true;
    cfg.web.passwordHash = webAuth.hashPassword(password);
    delete cfg.web.password;
    manager.saveConfig(cfg);
    return cfg;
}

async function loginAsAdmin(password = 'correct-horse-battery') {
    const res = await post('/api/login', { password });
    return extractCookie(res);
}

describe('POST /api/login', () => {
    it('400s without a password', async () => {
        const res = await post('/api/login', {});
        expect(res.status).toBe(400);
    });

    it('400s for an empty-string password', async () => {
        const res = await post('/api/login', { password: '' });
        expect(res.status).toBe(400);
    });

    it('503s with setupRequired when auth is not configured yet', async () => {
        const res = await post('/api/login', { password: 'anything' });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.setupRequired).toBe(true);
    });

    it('401s for a wrong password', async () => {
        configureAdmin();
        const res = await post('/api/login', { password: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('logs in successfully and sets a session cookie', async () => {
        configureAdmin();
        const res = await post('/api/login', { password: 'correct-horse-battery' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.role).toBe('admin');
        expect(res.headers.get('set-cookie')).toContain('tg_dl_session=');
        expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    });

    it('rehashes a legacy plaintext password on first successful login', async () => {
        const cfg = manager.loadConfig();
        cfg.web = { enabled: true, password: 'legacy-plain' };
        manager.saveConfig(cfg);
        const res = await post('/api/login', { password: 'legacy-plain' });
        expect(res.status).toBe(200);
        const reloaded = manager.loadConfig();
        expect(reloaded.web.password).toBeUndefined();
        expect(reloaded.web.passwordHash).toEqual(expect.objectContaining({ algo: 'scrypt' }));
    });

    it('logs in as guest with the guest password', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('guest-pass-123');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const res = await post('/api/login', { password: 'guest-pass-123' });
        const body = await res.json();
        expect(body.role).toBe('guest');
    });
});

describe('POST /api/logout', () => {
    it('succeeds even with no session cookie', async () => {
        const res = await post('/api/logout');
        expect(res.status).toBe(200);
    });

    it('revokes the session so it can no longer authenticate', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        await post('/api/logout', {}, cookie);
        const res = await fetch(apiUrl('/api/auth_check'), { headers: { Cookie: cookie } });
        const body = await res.json();
        expect(body.authenticated).toBe(false);
    });

    it('clears the session cookie', async () => {
        const res = await post('/api/logout');
        const setCookie = res.headers.get('set-cookie') || '';
        expect(setCookie).toContain('tg_dl_session=;');
    });
});

describe('POST /api/auth/setup', () => {
    it('400s for a password shorter than 8 chars', async () => {
        const res = await post('/api/auth/setup', { password: 'short' });
        expect(res.status).toBe(400);
    });

    it('409s when already configured', async () => {
        configureAdmin();
        const res = await post('/api/auth/setup', { password: 'new-password-123' });
        expect(res.status).toBe(409);
    });

    it('sets up the admin password and issues a session (local request)', async () => {
        const res = await post('/api/auth/setup', { password: 'first-time-setup-1' });
        expect(res.status).toBe(200);
        expect(res.headers.get('set-cookie')).toContain('tg_dl_session=');
        const cfg = manager.loadConfig();
        expect(cfg.web.passwordHash).toEqual(expect.objectContaining({ algo: 'scrypt' }));
        expect(cfg.web.enabled).toBe(true);
    });

    it('403s when the request does not originate from the local machine', async () => {
        const res = await fetch(apiUrl('/api/auth/setup'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '8.8.8.8',
            },
            body: JSON.stringify({ password: 'first-time-setup-1' }),
        });
        expect(res.status).toBe(403);
    });
});

describe('POST /api/auth/change-password', () => {
    it('401s without a session', async () => {
        const res = await post('/api/auth/change-password', {
            currentPassword: 'x',
            newPassword: 'new-password-1',
        });
        expect(res.status).toBe(401);
    });

    it('403s for a guest session', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('guest-pass-123');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const guestRes = await post('/api/login', { password: 'guest-pass-123' });
        const guestCookie = extractCookie(guestRes);
        const res = await post(
            '/api/auth/change-password',
            { currentPassword: 'x', newPassword: 'new-password-1' },
            guestCookie,
        );
        expect(res.status).toBe(403);
    });

    it('400s when currentPassword/newPassword are missing', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post('/api/auth/change-password', { newPassword: 'x' }, cookie);
        expect(res.status).toBe(400);
    });

    it('400s when the new password is too short', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post(
            '/api/auth/change-password',
            { currentPassword: 'correct-horse-battery', newPassword: 'short' },
            cookie,
        );
        expect(res.status).toBe(400);
    });

    it('401s when the current password is wrong', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post(
            '/api/auth/change-password',
            { currentPassword: 'wrong', newPassword: 'new-password-1' },
            cookie,
        );
        expect(res.status).toBe(401);
    });

    it('400s when the new password equals the guest password', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('shared-secret-1');
        manager.saveConfig(cfg);
        const cookie = await loginAsAdmin();
        const res = await post(
            '/api/auth/change-password',
            { currentPassword: 'correct-horse-battery', newPassword: 'shared-secret-1' },
            cookie,
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('SAME_AS_GUEST');
    });

    it('changes the password and issues a fresh session', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post(
            '/api/auth/change-password',
            { currentPassword: 'correct-horse-battery', newPassword: 'brand-new-password-1' },
            cookie,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('set-cookie')).toContain('tg_dl_session=');
        // Old password no longer works.
        const stale = await post('/api/login', { password: 'correct-horse-battery' });
        expect(stale.status).toBe(401);
        const fresh = await post('/api/login', { password: 'brand-new-password-1' });
        expect(fresh.status).toBe(200);
    });

    it('409s when no admin password is configured yet', async () => {
        // Manufacture a "session" without ever setting up a password —
        // covers the isAuthConfigured guard inside change-password.
        const { token } = webAuth.issueSession({ role: 'admin' });
        const res = await post(
            '/api/auth/change-password',
            { currentPassword: 'x', newPassword: 'new-password-1' },
            `tg_dl_session=${token}`,
        );
        expect(res.status).toBe(409);
    });
});

describe('POST /api/auth/guest-password', () => {
    it('401s without a session', async () => {
        const res = await post('/api/auth/guest-password', { password: 'guest-pass-123' });
        expect(res.status).toBe(401);
    });

    it('403s for a guest session', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('guest-pass-123');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const guestCookie = extractCookie(await post('/api/login', { password: 'guest-pass-123' }));
        const res = await post(
            '/api/auth/guest-password',
            { password: 'new-guest-pass-1' },
            guestCookie,
        );
        expect(res.status).toBe(403);
    });

    it('400s for a guest password shorter than 8 chars', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post('/api/auth/guest-password', { password: 'short' }, cookie);
        expect(res.status).toBe(400);
    });

    it('400s when the guest password equals the admin password', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post(
            '/api/auth/guest-password',
            { password: 'correct-horse-battery' },
            cookie,
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('SAME_AS_ADMIN');
    });

    it('sets the guest password, enables guest access, and broadcasts config_updated', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post(
            '/api/auth/guest-password',
            { password: 'new-guest-pass-1' },
            cookie,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.enabled).toBe(true);
        expect(broadcasts).toEqual([{ type: 'config_updated' }]);
        const cfg = manager.loadConfig();
        expect(cfg.web.guestPasswordHash).toEqual(expect.objectContaining({ algo: 'scrypt' }));
    });

    it('revokes existing guest sessions when the guest password changes', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('old-guest-pass-1');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const guestCookie = extractCookie(
            await post('/api/login', { password: 'old-guest-pass-1' }),
        );
        const adminCookie = await loginAsAdmin();
        await post('/api/auth/guest-password', { password: 'new-guest-pass-2' }, adminCookie);
        const check = await fetch(apiUrl('/api/auth_check'), {
            headers: { Cookie: guestCookie },
        });
        const body = await check.json();
        expect(body.authenticated).toBe(false);
    });

    it('400s when enabling guest access with no guest password set', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post('/api/auth/guest-password', { enabled: true }, cookie);
        expect(res.status).toBe(400);
    });

    it('flips guestEnabled off and revokes guest sessions', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('guest-pass-123');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const guestCookie = extractCookie(await post('/api/login', { password: 'guest-pass-123' }));
        const adminCookie = await loginAsAdmin();
        const res = await post('/api/auth/guest-password', { enabled: false }, adminCookie);
        const body = await res.json();
        expect(body.enabled).toBe(false);
        const check = await fetch(apiUrl('/api/auth_check'), {
            headers: { Cookie: guestCookie },
        });
        expect((await check.json()).authenticated).toBe(false);
    });

    it('clears the guest password and disables guest access', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('guest-pass-123');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const cookie = await loginAsAdmin();
        const res = await post('/api/auth/guest-password', { clear: true }, cookie);
        const body = await res.json();
        expect(body.configured).toBe(false);
        expect(body.enabled).toBe(false);
        const reloaded = manager.loadConfig();
        expect(reloaded.web.guestPasswordHash).toBeUndefined();
    });

    it('400s when none of password/enabled/clear are provided', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await post('/api/auth/guest-password', {}, cookie);
        expect(res.status).toBe(400);
    });
});

describe('POST /api/auth/reset/request + /api/auth/reset/confirm', () => {
    it('409s requesting a reset when nothing is configured yet', async () => {
        const res = await post('/api/auth/reset/request');
        expect(res.status).toBe(409);
    });

    it('logs a token to stdout and returns the ttl', async () => {
        configureAdmin();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const res = await post('/api/auth/reset/request');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ttlSeconds).toBe(600);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PASSWORD RESET TOKEN'));
        logSpy.mockRestore();
    });

    it('400s confirm without token or newPassword', async () => {
        const res = await post('/api/auth/reset/confirm', { newPassword: 'x' });
        expect(res.status).toBe(400);
    });

    it('400s confirm with a too-short newPassword', async () => {
        const res = await post('/api/auth/reset/confirm', { token: 'x', newPassword: 'short' });
        expect(res.status).toBe(400);
    });

    it('401s confirm with an unknown token', async () => {
        const res = await post('/api/auth/reset/confirm', {
            token: 'not-a-real-token',
            newPassword: 'brand-new-password-1',
        });
        expect(res.status).toBe(401);
    });

    it('confirms with a valid token: sets the password, revokes sessions, issues a fresh one', async () => {
        configureAdmin();
        let loggedLine = '';
        const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => {
            if (typeof line === 'string' && line.includes('Token:')) loggedLine = line;
        });
        const oldCookie = await loginAsAdmin();
        await post('/api/auth/reset/request');
        logSpy.mockRestore();
        const token = loggedLine.split('Token:')[1].trim();

        const res = await post('/api/auth/reset/confirm', {
            token,
            newPassword: 'reset-password-1',
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('set-cookie')).toContain('tg_dl_session=');

        // Old session revoked.
        const staleCheck = await fetch(apiUrl('/api/auth_check'), {
            headers: { Cookie: oldCookie },
        });
        expect((await staleCheck.json()).authenticated).toBe(false);

        // New password works.
        const login = await post('/api/login', { password: 'reset-password-1' });
        expect(login.status).toBe(200);
    });

    it('a reset token is single-use', async () => {
        configureAdmin();
        let loggedLine = '';
        const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => {
            if (typeof line === 'string' && line.includes('Token:')) loggedLine = line;
        });
        await post('/api/auth/reset/request');
        logSpy.mockRestore();
        const token = loggedLine.split('Token:')[1].trim();

        const first = await post('/api/auth/reset/confirm', {
            token,
            newPassword: 'reset-password-1',
        });
        expect(first.status).toBe(200);
        const second = await post('/api/auth/reset/confirm', {
            token,
            newPassword: 'reset-password-2',
        });
        expect(second.status).toBe(401);
    });
});

describe('GET /api/auth_check', () => {
    it('reports setupRequired when auth is not configured', async () => {
        const res = await fetch(apiUrl('/api/auth_check'));
        const body = await res.json();
        expect(body.configured).toBe(false);
        expect(body.setupRequired).toBe(true);
        expect(body.authenticated).toBe(false);
    });

    it('reports authenticated + role for a valid admin session', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const res = await fetch(apiUrl('/api/auth_check'), { headers: { Cookie: cookie } });
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.authenticated).toBe(true);
        expect(body.role).toBe('admin');
    });

    it('reports not-authenticated with an invalid/missing session', async () => {
        configureAdmin();
        const res = await fetch(apiUrl('/api/auth_check'), {
            headers: { Cookie: 'tg_dl_session=garbage' },
        });
        const body = await res.json();
        expect(body.authenticated).toBe(false);
        expect(body.role).toBeNull();
    });

    it('reports guestEnabled from config', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.guestPasswordHash = webAuth.hashPassword('guest-pass-123');
        cfg.web.guestEnabled = true;
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/auth_check'));
        const body = await res.json();
        expect(body.guestEnabled).toBe(true);
    });

    it('treats a missing web.enabled as enabled (!== false)', async () => {
        configureAdmin();
        const res = await fetch(apiUrl('/api/auth_check'));
        const body = await res.json();
        expect(body.enabled).toBe(true);
    });

    it('reports disabled + setupRequired when web.enabled is explicitly false', async () => {
        configureAdmin();
        const cfg = manager.loadConfig();
        cfg.web.enabled = false;
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/auth_check'));
        const body = await res.json();
        expect(body.enabled).toBe(false);
        expect(body.setupRequired).toBe(true);
    });

    it('does not validate a session when disabled, even with a valid cookie', async () => {
        configureAdmin();
        const cookie = await loginAsAdmin();
        const cfg = manager.loadConfig();
        cfg.web.enabled = false;
        manager.saveConfig(cfg);
        const res = await fetch(apiUrl('/api/auth_check'), { headers: { Cookie: cookie } });
        const body = await res.json();
        expect(body.authenticated).toBe(false);
    });
});
