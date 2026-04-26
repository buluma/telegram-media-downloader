import { describe, it, expect, beforeEach } from 'vitest';
import { hashPassword, verifyPassword, loginVerify, isAuthConfigured,
         issueSession, validateSession, revokeSession } from '../src/core/web-auth.js';

describe('hashPassword / verifyPassword', () => {
    it('round-trips a password', () => {
        const stored = hashPassword('correct horse battery staple');
        expect(stored.algo).toBe('scrypt');
        expect(stored.salt).toBeTruthy();
        expect(stored.hash).toBeTruthy();
        expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    it('rejects the wrong password', () => {
        const stored = hashPassword('right');
        expect(verifyPassword('wrong', stored)).toBe(false);
    });

    it('rejects a malformed stored object', () => {
        expect(verifyPassword('x', null)).toBe(false);
        expect(verifyPassword('x', { algo: 'unknown' })).toBe(false);
    });

    it('throws on empty input', () => {
        expect(() => hashPassword('')).toThrow();
    });
});

describe('loginVerify (legacy plaintext upgrade)', () => {
    it('upgrades legacy plaintext password', () => {
        const cfg = { password: 'plain' };
        expect(loginVerify('plain', cfg)).toEqual({ ok: true, upgrade: true });
        expect(loginVerify('wrong', cfg)).toEqual({ ok: false });
    });

    it('verifies new-format passwordHash without an upgrade signal', () => {
        const cfg = { passwordHash: hashPassword('newpass') };
        expect(loginVerify('newpass', cfg)).toEqual({ ok: true });
        expect(loginVerify('wrong', cfg)).toEqual({ ok: false });
    });

    it('returns ok:false when nothing is configured', () => {
        expect(loginVerify('x', null)).toEqual({ ok: false });
        expect(loginVerify('x', {})).toEqual({ ok: false });
    });
});

describe('isAuthConfigured', () => {
    it('reflects either legacy or hashed presence', () => {
        expect(isAuthConfigured(null)).toBe(false);
        expect(isAuthConfigured({})).toBe(false);
        expect(isAuthConfigured({ password: 'x' })).toBe(true);
        expect(isAuthConfigured({ passwordHash: hashPassword('y') })).toBe(true);
    });
});

describe('session tokens', () => {
    let token;
    beforeEach(() => {
        ({ token } = issueSession());
    });

    it('issues a 64-char hex token', () => {
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('validateSession returns true for a fresh token, false after revoke', () => {
        expect(validateSession(token)).toBe(true);
        revokeSession(token);
        expect(validateSession(token)).toBe(false);
    });

    it('validateSession returns false for unknown / empty tokens', () => {
        expect(validateSession('')).toBe(false);
        expect(validateSession('00'.repeat(32))).toBe(false);
    });
});
