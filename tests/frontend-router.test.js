// Covers the SPA hash router in src/web/public/js/router.js.
//
// Two things make this worth testing beyond plain navigation: the guest
// role guard (deep-linked admin routes must bounce to /viewer, not just
// nav clicks) and the no-match fallback. Both are silent when they break.
//
// router.js keeps module-level state (registered routes, active route,
// listening flag), so each test re-imports it through vi.resetModules().
// The browser globals it touches — location.hash, history, addEventListener
// — are stubbed by hand; no jsdom.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let listeners;

function installWindow(initialHash = '') {
    listeners = new Map();
    const location = { hash: initialHash };
    const history = {
        pushState: vi.fn((_s, _t, url) => {
            location.hash = url;
        }),
        replaceState: vi.fn((_s, _t, url) => {
            location.hash = url;
        }),
    };
    const win = {
        location,
        history,
        addEventListener: (ev, fn) => {
            if (!listeners.has(ev)) listeners.set(ev, []);
            listeners.get(ev).push(fn);
        },
    };
    globalThis.window = win;
    globalThis.location = location;
    globalThis.history = history;
    return win;
}

function fire(ev) {
    for (const fn of listeners.get(ev) || []) fn();
}

async function loadRouter() {
    vi.resetModules();
    return import('../src/web/public/js/router.js');
}

describe('router', () => {
    let warn;

    beforeEach(() => {
        installWindow();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
        delete globalThis.location;
        delete globalThis.history;
    });

    describe('matching and params', () => {
        it('dispatches a static route', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/queue', hit);
            r.navigate('#/queue');
            expect(hit).toHaveBeenCalledTimes(1);
            expect(hit.mock.calls[0][0]).toMatchObject({ pattern: '/queue', path: '/queue' });
        });

        it('extracts named params', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/viewer/:groupId/:fileId', hit);
            r.navigate('#/viewer/-1001234/99');
            expect(hit.mock.calls[0][0].params).toEqual({ groupId: '-1001234', fileId: '99' });
        });

        it('percent-decodes param values', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/groups/:id', hit);
            r.navigate('#/groups/a%2Fb');
            expect(hit.mock.calls[0][0].params.id).toBe('a/b');
        });

        it('does not let a param span a path separator', async () => {
            const r = await loadRouter();
            const one = vi.fn();
            const two = vi.fn();
            r.route('/viewer/:groupId', one);
            r.route('/viewer/:groupId/:fileId', two);
            r.navigate('#/viewer/12/34');
            expect(one).not.toHaveBeenCalled();
            expect(two).toHaveBeenCalledTimes(1);
        });

        it('parses the query string into an object', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/viewer', hit);
            r.navigate('#/viewer?tab=videos&q=cat%20dog');
            expect(hit.mock.calls[0][0]).toMatchObject({
                path: '/viewer',
                query: { tab: 'videos', q: 'cat dog' },
            });
        });

        it('gives an empty query object when there is none', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/viewer', hit);
            r.navigate('#/viewer');
            expect(hit.mock.calls[0][0].query).toEqual({});
        });

        it('accepts a hash without the leading #', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/engine', hit);
            r.navigate('/engine');
            expect(hit).toHaveBeenCalledTimes(1);
            expect(window.location.hash).toBe('#/engine');
        });

        it('treats an empty hash as /viewer', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/viewer', hit);
            r.start();
            await Promise.resolve(); // start() dispatches in a microtask
            expect(hit).toHaveBeenCalledTimes(1);
            expect(hit.mock.calls[0][0].path).toBe('/viewer');
        });

        it('matches the first registered route when two patterns overlap', async () => {
            const r = await loadRouter();
            const first = vi.fn();
            const second = vi.fn();
            r.route('/settings/:section', first);
            r.route('/settings/:other', second);
            r.navigate('#/settings/appearance');
            expect(first).toHaveBeenCalledTimes(1);
            expect(second).not.toHaveBeenCalled();
        });
    });

    describe('no-match fallback', () => {
        it('warns and redirects to /viewer', async () => {
            const r = await loadRouter();
            const viewer = vi.fn();
            r.route('/viewer', viewer);
            r.navigate('#/nope');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('no match for "/nope"'));
            expect(window.location.hash).toBe('#/viewer');
            expect(viewer).toHaveBeenCalledTimes(1);
        });

        it('does not loop when /viewer itself is unregistered', async () => {
            const r = await loadRouter();
            r.navigate('#/viewer');
            expect(warn).not.toHaveBeenCalled();
            expect(r.getActiveRoute()).toBeNull();
        });

        it('redirects with replaceState so back does not return to the dead route', async () => {
            const r = await loadRouter();
            r.route('/viewer', vi.fn());
            r.navigate('#/nope');
            expect(history.replaceState).toHaveBeenCalled();
        });
    });

    describe('guest role guard', () => {
        const asGuest = () => {
            window.__tgdlRole = 'guest';
        };

        for (const path of [
            '/groups',
            '/groups/-100123',
            '/backfill',
            '/queue',
            '/engine',
            '/stories',
            '/account/add',
            '/maintenance',
            '/maintenance/duplicates',
        ]) {
            it(`bounces a guest from ${path}`, async () => {
                const r = await loadRouter();
                asGuest();
                const admin = vi.fn();
                const viewer = vi.fn();
                r.route(path, admin);
                r.route('/viewer', viewer);
                r.navigate(`#${path}`);
                expect(admin).not.toHaveBeenCalled();
                expect(viewer).toHaveBeenCalledTimes(1);
                expect(window.location.hash).toBe('#/viewer');
            });
        }

        it('does not bounce a prefix that merely starts with the same letters', async () => {
            const r = await loadRouter();
            asGuest();
            const hit = vi.fn();
            r.route('/queued-thing', hit);
            r.navigate('#/queued-thing');
            expect(hit).toHaveBeenCalledTimes(1);
        });

        it('lets a guest reach the settings sections they own', async () => {
            for (const section of ['appearance', 'video-player']) {
                const r = await loadRouter();
                asGuest();
                const hit = vi.fn();
                r.route('/settings/:section', hit);
                r.route('/viewer', vi.fn());
                r.navigate(`#/settings/${section}`);
                expect(hit, section).toHaveBeenCalledTimes(1);
            }
        });

        it('bounces a guest from operational settings sections', async () => {
            for (const section of ['system', 'accounts', 'downloads', 'network']) {
                const r = await loadRouter();
                asGuest();
                const hit = vi.fn();
                const viewer = vi.fn();
                r.route('/settings/:section', hit);
                r.route('/viewer', viewer);
                r.navigate(`#/settings/${section}`);
                expect(hit, section).not.toHaveBeenCalled();
                expect(viewer, section).toHaveBeenCalledTimes(1);
            }
        });

        it('lets a guest reach the settings root', async () => {
            const r = await loadRouter();
            asGuest();
            const hit = vi.fn();
            r.route('/settings', hit);
            r.navigate('#/settings');
            expect(hit).toHaveBeenCalledTimes(1);
        });

        it('lets an admin through every admin route', async () => {
            const r = await loadRouter();
            window.__tgdlRole = 'admin';
            const hit = vi.fn();
            r.route('/engine', hit);
            r.navigate('#/engine');
            expect(hit).toHaveBeenCalledTimes(1);
        });

        it('does not guard when no role is set', async () => {
            const r = await loadRouter();
            delete window.__tgdlRole;
            const hit = vi.fn();
            r.route('/engine', hit);
            r.navigate('#/engine');
            expect(hit).toHaveBeenCalledTimes(1);
        });

        afterEach(() => {
            if (globalThis.window) delete globalThis.window.__tgdlRole;
        });
    });

    describe('beforeNavigate guard', () => {
        it('cancels the transition when the guard returns exactly false', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/queue', hit);
            r.setBeforeNavigate(() => false);
            r.navigate('#/queue');
            expect(hit).not.toHaveBeenCalled();
            expect(r.getActiveRoute()).toBeNull();
        });

        it('proceeds for any other return value', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/queue', hit);
            r.setBeforeNavigate(() => undefined);
            r.navigate('#/queue');
            expect(hit).toHaveBeenCalledTimes(1);
        });

        it('receives the previous and next route', async () => {
            const r = await loadRouter();
            const guard = vi.fn();
            r.route('/queue', vi.fn());
            r.route('/engine', vi.fn());
            r.setBeforeNavigate(guard);
            r.navigate('#/queue');
            r.navigate('#/engine');
            expect(guard.mock.calls[0][0]).toBeNull();
            expect(guard.mock.calls[1][0]).toMatchObject({ path: '/queue' });
            expect(guard.mock.calls[1][1]).toMatchObject({ path: '/engine' });
        });
    });

    describe('navigate', () => {
        it('pushes history by default and replaces on request', async () => {
            const r = await loadRouter();
            r.route('/queue', vi.fn());
            r.route('/engine', vi.fn());
            r.navigate('#/queue');
            expect(history.pushState).toHaveBeenCalledTimes(1);
            r.navigate('#/engine', { replace: true });
            expect(history.replaceState).toHaveBeenCalledTimes(1);
        });

        it('re-dispatches without touching history when the hash is unchanged', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/queue', hit);
            r.navigate('#/queue');
            history.pushState.mockClear();
            r.navigate('#/queue');
            expect(hit).toHaveBeenCalledTimes(2);
            expect(history.pushState).not.toHaveBeenCalled();
        });
    });

    describe('handler errors', () => {
        it('swallows a throwing handler and still records the active route', async () => {
            const r = await loadRouter();
            r.route('/queue', () => {
                throw new Error('boom');
            });
            expect(() => r.navigate('#/queue')).not.toThrow();
            expect(r.getActiveRoute()).toMatchObject({ path: '/queue' });
            expect(console.error).toHaveBeenCalled();
        });
    });

    describe('start', () => {
        it('subscribes to hashchange and popstate exactly once', async () => {
            const r = await loadRouter();
            r.route('/viewer', vi.fn());
            r.start();
            r.start();
            expect(listeners.get('hashchange')).toHaveLength(1);
            expect(listeners.get('popstate')).toHaveLength(1);
        });

        it('dispatches on a hashchange fired by the browser', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/engine', hit);
            r.route('/viewer', vi.fn());
            r.start();
            await Promise.resolve();
            window.location.hash = '#/engine';
            fire('hashchange');
            expect(hit).toHaveBeenCalledTimes(1);
        });

        it('dispatches on popstate (browser back)', async () => {
            const r = await loadRouter();
            const hit = vi.fn();
            r.route('/viewer', hit);
            r.start();
            await Promise.resolve();
            hit.mockClear();
            fire('popstate');
            expect(hit).toHaveBeenCalledTimes(1);
        });
    });

    describe('getActiveRoute', () => {
        it('is null before the first dispatch and tracks the current route after', async () => {
            const r = await loadRouter();
            expect(r.getActiveRoute()).toBeNull();
            r.route('/queue', vi.fn());
            r.navigate('#/queue');
            expect(r.getActiveRoute()).toMatchObject({ pattern: '/queue', path: '/queue' });
        });
    });
});
