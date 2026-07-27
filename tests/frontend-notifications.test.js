// @vitest-environment jsdom
//
// Covers src/web/public/js/notifications.js — the opt-in browser
// notification wrapper and its burst-coalescing window.
//
// jsdom implements no Notification API at all, so the whole thing is
// stubbed: a constructor that records instances plus a settable static
// `permission`. That is exactly the surface the module touches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEY = 'tgdl-notifications-enabled';

let made; // every Notification constructed during a test

class FakeNotification {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => FakeNotification.permission);

    constructor(title, options = {}) {
        this.title = title;
        this.options = options;
        this.onclick = null;
        this.closed = false;
        made.push(this);
    }
    close() {
        this.closed = true;
    }
}

async function loadNotifications() {
    vi.resetModules();
    return import('../src/web/public/js/notifications.js');
}

/** Enable the feature the way requestEnable() would. */
function enable() {
    localStorage.setItem(KEY, '1');
    FakeNotification.permission = 'granted';
}

describe('notifications', () => {
    beforeEach(() => {
        made = [];
        localStorage.clear();
        FakeNotification.permission = 'granted';
        FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
        window.Notification = FakeNotification;
        globalThis.Notification = FakeNotification;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete window.Notification;
        delete globalThis.Notification;
    });

    describe('isSupported / isEnabled', () => {
        it('reports support from the presence of the Notification API', async () => {
            const n = await loadNotifications();
            expect(n.isSupported()).toBe(true);
            delete window.Notification;
            expect(n.isSupported()).toBe(false);
        });

        it('requires both the stored opt-in and granted permission', async () => {
            const n = await loadNotifications();
            expect(n.isEnabled()).toBe(false); // no opt-in yet

            localStorage.setItem(KEY, '1');
            expect(n.isEnabled()).toBe(true);

            FakeNotification.permission = 'denied';
            expect(n.isEnabled()).toBe(false);
        });
    });

    describe('requestEnable', () => {
        it('returns false when the browser has no Notification API', async () => {
            delete window.Notification;
            const n = await loadNotifications();
            await expect(n.requestEnable()).resolves.toBe(false);
        });

        it('stores the opt-in when permission is already granted', async () => {
            const n = await loadNotifications();
            await expect(n.requestEnable()).resolves.toBe(true);
            expect(localStorage.getItem(KEY)).toBe('1');
        });

        it('prompts when permission has not been decided', async () => {
            FakeNotification.permission = 'default';
            FakeNotification.requestPermission = vi.fn(async () => 'granted');
            const n = await loadNotifications();
            await expect(n.requestEnable()).resolves.toBe(true);
            expect(FakeNotification.requestPermission).toHaveBeenCalled();
            expect(localStorage.getItem(KEY)).toBe('1');
        });

        it('does not store the opt-in when the prompt is denied', async () => {
            FakeNotification.permission = 'default';
            FakeNotification.requestPermission = vi.fn(async () => 'denied');
            const n = await loadNotifications();
            await expect(n.requestEnable()).resolves.toBe(false);
            expect(localStorage.getItem(KEY)).toBeNull();
        });

        it('does not re-prompt when permission was already denied', async () => {
            FakeNotification.permission = 'denied';
            const n = await loadNotifications();
            await expect(n.requestEnable()).resolves.toBe(false);
            expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
        });
    });

    describe('disable', () => {
        it('clears the stored opt-in', async () => {
            const n = await loadNotifications();
            enable();
            n.disable();
            expect(localStorage.getItem(KEY)).toBeNull();
            expect(n.isEnabled()).toBe(false);
        });
    });

    describe('notifyDownloadComplete', () => {
        it('stays silent when notifications are not enabled', async () => {
            const n = await loadNotifications();
            n.notifyDownloadComplete({ filePath: '/a/b.mp4' });
            expect(made).toHaveLength(0);
        });

        it('shows the bare file name, not the whole path', async () => {
            const n = await loadNotifications();
            enable();
            n.notifyDownloadComplete({ filePath: '/downloads/group/clip.mp4' });
            expect(made).toHaveLength(1);
            expect(made[0].options.body).toBe('clip.mp4');
            expect(made[0].options.tag).toBe('tgdl-download');
        });

        it('handles Windows-style separators', async () => {
            const n = await loadNotifications();
            enable();
            n.notifyDownloadComplete({ filePath: 'C:\\downloads\\clip.mp4' });
            expect(made[0].options.body).toBe('clip.mp4');
        });

        it('falls back to a generic label with no path', async () => {
            const n = await loadNotifications();
            enable();
            n.notifyDownloadComplete({});
            expect(made[0].options.body).toBe('a file');
            n.notifyDownloadComplete(undefined);
            expect(made).toHaveLength(1); // coalesced, see below
        });

        it('coalesces a burst into one notification', async () => {
            vi.useFakeTimers();
            const n = await loadNotifications();
            enable();
            for (let i = 0; i < 5; i++) n.notifyDownloadComplete({ filePath: `f${i}.mp4` });
            expect(made).toHaveLength(1);
        });

        it('notifies again once the coalesce window has passed', async () => {
            vi.useFakeTimers();
            const n = await loadNotifications();
            enable();
            n.notifyDownloadComplete({ filePath: 'a.mp4' });
            vi.advanceTimersByTime(4001);
            n.notifyDownloadComplete({ filePath: 'b.mp4' });
            expect(made).toHaveLength(2);
            expect(made[1].options.body).toBe('b.mp4');
        });

        it('focuses the tab and routes to the library on click', async () => {
            const n = await loadNotifications();
            enable();
            const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
            window.navigateTo = vi.fn();

            n.notifyDownloadComplete({ filePath: 'a.mp4' });
            made[0].onclick();

            expect(focus).toHaveBeenCalled();
            expect(window.navigateTo).toHaveBeenCalledWith('viewer');
            expect(made[0].closed).toBe(true);
            delete window.navigateTo;
        });

        it('still closes itself when no router is present', async () => {
            const n = await loadNotifications();
            enable();
            vi.spyOn(window, 'focus').mockImplementation(() => {});
            delete window.navigateTo;
            n.notifyDownloadComplete({ filePath: 'a.mp4' });
            expect(() => made[0].onclick()).not.toThrow();
            expect(made[0].closed).toBe(true);
        });
    });

    describe('notifyGeneric', () => {
        it('stays silent when not enabled', async () => {
            const n = await loadNotifications();
            n.notifyGeneric('Scan done', 'body');
            expect(made).toHaveLength(0);
        });

        it('fires immediately, ignoring the per-file coalesce window', async () => {
            const n = await loadNotifications();
            enable();
            n.notifyGeneric('One', 'a');
            n.notifyGeneric('Two', 'b');
            expect(made).toHaveLength(2);
            expect(made[1].title).toBe('Two');
            expect(made[1].options.tag).toBe('tgdl-generic');
        });

        it('defaults the body to an empty string', async () => {
            const n = await loadNotifications();
            enable();
            n.notifyGeneric('Title');
            expect(made[0].options.body).toBe('');
        });

        it('swallows a constructor throw (permission revoked mid-session)', async () => {
            const n = await loadNotifications();
            enable();
            globalThis.Notification = window.Notification = class {
                constructor() {
                    throw new Error('permission revoked');
                }
            };
            expect(() => n.notifyGeneric('Title', 'body')).not.toThrow();
        });

        it('closes itself on click', async () => {
            const n = await loadNotifications();
            enable();
            vi.spyOn(window, 'focus').mockImplementation(() => {});
            n.notifyGeneric('Title');
            made[0].onclick();
            expect(made[0].closed).toBe(true);
        });
    });

    describe('flushPending', () => {
        it('summarises a coalesced burst', async () => {
            vi.useFakeTimers();
            const n = await loadNotifications();
            enable();
            for (let i = 0; i < 5; i++) n.notifyDownloadComplete({ filePath: `f${i}.mp4` });
            made.length = 0;

            n.flushPending();

            expect(made).toHaveLength(1);
            expect(made[0].title).toBe('5 downloads complete');
            expect(made[0].options.tag).toBe('tgdl-batch');
        });

        it('says nothing when only one file landed', async () => {
            vi.useFakeTimers();
            const n = await loadNotifications();
            enable();
            n.notifyDownloadComplete({ filePath: 'a.mp4' });
            made.length = 0;
            n.flushPending();
            expect(made).toHaveLength(0);
        });

        it('resets the batch so a second flush is silent', async () => {
            vi.useFakeTimers();
            const n = await loadNotifications();
            enable();
            for (let i = 0; i < 3; i++) n.notifyDownloadComplete({ filePath: `f${i}.mp4` });
            n.flushPending();
            made.length = 0;
            n.flushPending();
            expect(made).toHaveLength(0);
        });

        it('does not fire when notifications got disabled mid-burst', async () => {
            vi.useFakeTimers();
            const n = await loadNotifications();
            enable();
            for (let i = 0; i < 3; i++) n.notifyDownloadComplete({ filePath: `f${i}.mp4` });
            made.length = 0;
            n.disable();
            n.flushPending();
            expect(made).toHaveLength(0);
        });
    });
});
