// Covers RealtimeMonitor.passUserFilter — the tracked-user gate on the
// realtime path.
//
// Split out ahead of the rest of monitor.js (its own P3 target) because the
// same undefined === undefined comparison fixed in core/history.js lives here
// too, and the realtime path is the more consequential of the two. The
// constructor takes client/downloader/config directly and this method touches
// none of them beyond `this.config`, so no harness is needed.

import { describe, it, expect, beforeAll } from 'vitest';

let RealtimeMonitor;

beforeAll(async () => {
    ({ RealtimeMonitor } = await import('../src/core/monitor.js'));
});

const mk = (config = {}) => new RealtimeMonitor(null, null, config);

describe('RealtimeMonitor.passUserFilter', () => {
    it('passes everything when tracking is disabled', () => {
        expect(mk().passUserFilter({ senderId: 5 }, {})).toBe(true);
        expect(mk().passUserFilter({ senderId: 5 }, { trackUsers: { enabled: false } })).toBe(true);
    });

    it("passes everything in 'all' mode", () => {
        expect(
            mk().passUserFilter({ senderId: 5 }, { trackUsers: { enabled: true, mode: 'all' } }),
        ).toBe(true);
    });

    // The bug: a user added by id carries no `username`, and a sender with no
    // public username has none either — so comparing the two directly was
    // true for every such pair. An id-only whitelist admitted the entire
    // channel; an id-only blacklist rejected all of it. Both silently, and
    // both the exact opposite of what the operator configured.
    it('does not treat two missing usernames as a match (whitelist)', () => {
        const group = { trackUsers: { enabled: true, mode: 'whitelist', users: [{ id: 7 }] } };
        expect(mk().passUserFilter({ senderId: 7 }, group)).toBe(true);
        expect(mk().passUserFilter({ senderId: 8 }, group)).toBe(false);
    });

    it('does not treat two missing usernames as a match (blacklist)', () => {
        const group = { trackUsers: { enabled: true, mode: 'blacklist', users: [{ id: 7 }] } };
        expect(mk().passUserFilter({ senderId: 7 }, group)).toBe(false);
        expect(mk().passUserFilter({ senderId: 8 }, group)).toBe(true);
    });

    it('still matches on username when both sides carry one', () => {
        const group = {
            trackUsers: { enabled: true, mode: 'whitelist', users: [{ username: 'ada' }] },
        };
        expect(mk().passUserFilter({ senderId: 1, sender: { username: 'ada' } }, group)).toBe(true);
        expect(mk().passUserFilter({ senderId: 1, sender: { username: 'bob' } }, group)).toBe(
            false,
        );
    });

    it('applies the same guard to the global tracked-user list', () => {
        const monitor = mk({ globalTrackedUsers: [{ id: 9 }] });
        const group = { trackUsers: { enabled: true, mode: 'whitelist', users: [] } };
        expect(monitor.passUserFilter({ senderId: 9 }, group)).toBe(true);
        expect(monitor.passUserFilter({ senderId: 10 }, group)).toBe(false);
    });

    it('matches a sender with no id against a username entry', () => {
        const group = {
            trackUsers: { enabled: true, mode: 'whitelist', users: [{ username: 'ada' }] },
        };
        expect(mk().passUserFilter({ sender: { username: 'ada' } }, group)).toBe(true);
        expect(mk().passUserFilter({}, group)).toBe(false);
    });

    it('passes for an unrecognised mode', () => {
        const group = { trackUsers: { enabled: true, mode: 'weird', users: [] } };
        expect(mk().passUserFilter({ senderId: 1 }, group)).toBe(true);
    });
});
