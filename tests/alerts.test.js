// Unit tests for src/core/alerts.js — the ntfy alerting bridge.
//
// Covers: ntfy POST shape (URL, headers, body), failure-streak counting
// (fires once per streak, resets on success), silent-group detection
// against a real temp DB, disabled-config no-ops, and hot-config reads.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-alerts-'));

let alerts;
let dbApi;

// Captured ntfy requests
let _sent;

function fakeFetchOk(url, opts) {
    _sent.push({ url, opts });
    return Promise.resolve({ ok: true, status: 200, text: async () => '' });
}

const BASE_CFG = {
    alerts: {
        enabled: true,
        ntfy: { url: 'https://ntfy.example', topic: 'tgdl-alerts', authToken: '' },
        failureStreak: 3,
        silentGroupDays: 2,
    },
    groups: [],
};

let _cfg;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    alerts = await import('../src/core/alerts.js');
});

afterAll(() => {
    try {
        dbApi.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    _sent = [];
    _cfg = JSON.parse(JSON.stringify(BASE_CFG));
    vi.stubGlobal('fetch', fakeFetchOk);
});

describe('sendNtfy', () => {
    it('POSTs to url/topic with title header and body', async () => {
        const ok = await alerts.sendNtfy(_cfg.alerts.ntfy, {
            title: 'Test Alert',
            message: 'hello',
            tags: 'warning',
            priority: 4,
        });
        expect(ok).toBe(true);
        expect(_sent.length).toBe(1);
        expect(_sent[0].url).toBe('https://ntfy.example/tgdl-alerts');
        expect(_sent[0].opts.method).toBe('POST');
        expect(_sent[0].opts.headers.Title).toBe('Test Alert');
        expect(_sent[0].opts.headers.Priority).toBe('4');
        expect(_sent[0].opts.headers.Tags).toBe('warning');
        expect(_sent[0].opts.body).toBe('hello');
        // No auth header when token empty
        expect(_sent[0].opts.headers.Authorization).toBeUndefined();
    });

    it('sends Bearer token when configured', async () => {
        await alerts.sendNtfy(
            { ...(_cfg.alerts.ntfy || {}), authToken: 'tk_secret' },
            { title: 't', message: 'm' },
        );
        expect(_sent[0].opts.headers.Authorization).toBe('Bearer tk_secret');
    });

    it('returns false and does not throw on network failure', async () => {
        vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
        const ok = await alerts.sendNtfy(_cfg.alerts.ntfy, { title: 't', message: 'm' });
        expect(ok).toBe(false);
    });

    it('no-ops when topic missing', async () => {
        const ok = await alerts.sendNtfy(
            { url: 'https://x', topic: '' },
            { title: 't', message: 'm' },
        );
        expect(ok).toBe(false);
        expect(_sent.length).toBe(0);
    });
});

describe('failure streak tracking', () => {
    function wire(cfgOverride = {}) {
        const rt = new EventEmitter();
        const cfg = { ..._cfg, alerts: { ..._cfg.alerts, ...cfgOverride } };
        const tracker = alerts.createAlerter({ getConfig: () => cfg });
        tracker.attach(rt);
        return { rt, tracker };
    }

    it('fires once when streak hits threshold, not again until reset', async () => {
        const { rt } = wire({ failureStreak: 3 });
        for (let i = 0; i < 5; i++) {
            rt.emit('event', { type: 'download_error', payload: { error: 'x' } });
        }
        await new Promise((r) => setTimeout(r, 10));
        expect(_sent.length).toBe(1);
        expect(_sent[0].opts.headers.Title).toMatch(/download failure/i);
    });

    it('success resets the streak', async () => {
        const { rt } = wire({ failureStreak: 3 });
        rt.emit('event', { type: 'download_error', payload: {} });
        rt.emit('event', { type: 'download_error', payload: {} });
        rt.emit('event', { type: 'download_complete', payload: {} });
        rt.emit('event', { type: 'download_error', payload: {} });
        rt.emit('event', { type: 'download_error', payload: {} });
        await new Promise((r) => setTimeout(r, 10));
        expect(_sent.length).toBe(0); // never reached 3 consecutively
        // now complete the second streak
        rt.emit('event', { type: 'download_error', payload: {} });
        await new Promise((r) => setTimeout(r, 10));
        expect(_sent.length).toBe(1);
    });

    it('does nothing when alerts disabled', async () => {
        const { rt } = wire({ enabled: false });
        for (let i = 0; i < 10; i++) {
            rt.emit('event', { type: 'download_error', payload: {} });
        }
        await new Promise((r) => setTimeout(r, 10));
        expect(_sent.length).toBe(0);
    });
});

describe('silent group detection', () => {
    it('alerts for enabled groups with no downloads in N days, skips fresh ones', async () => {
        const db = dbApi.getDb();
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        // Group A: fresh download (1h ago). Group B: silent 5 days. Group C:
        // silent but monitor-disabled — must be skipped.
        db.prepare(
            `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('-100A', 'Group A', 1, 'a.jpg', 10, new Date(now - 3600e3).toISOString());
        db.prepare(
            `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('-100B', 'Group B', 2, 'b.jpg', 10, new Date(now - 5 * dayMs).toISOString());

        const cfg = {
            ..._cfg,
            groups: [
                { id: '-100A', name: 'Group A', enabled: true },
                { id: '-100B', name: 'Group B', enabled: true },
                { id: '-100C', name: 'Group C', enabled: false },
            ],
        };
        const tracker = alerts.createAlerter({ getConfig: () => cfg });
        const flagged = await tracker.checkSilentGroups();
        expect(flagged.map((g) => g.id)).toEqual(['-100B']);
        expect(_sent.length).toBe(1);
        expect(_sent[0].opts.body).toContain('Group B');

        // Second run same day — deduped, no second alert.
        await tracker.checkSilentGroups();
        expect(_sent.length).toBe(1);
    });

    it('no-ops when silentGroupDays is 0', async () => {
        const cfg = {
            ..._cfg,
            alerts: { ..._cfg.alerts, silentGroupDays: 0 },
            groups: [{ id: '-100B', name: 'Group B', enabled: true }],
        };
        const tracker = alerts.createAlerter({ getConfig: () => cfg });
        const flagged = await tracker.checkSilentGroups();
        expect(flagged).toEqual([]);
        expect(_sent.length).toBe(0);
    });
});
