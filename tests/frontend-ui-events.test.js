// @vitest-environment jsdom
//
// Covers src/web/public/js/ui-events.js — the app-wide delegated click
// handler for [data-action] elements. The listener attaches to
// document.body at import time with no teardown API, and jsdom keeps
// the same document across every test in a file — so, as with
// shortcuts.js, the handler is captured via a spy on addEventListener
// and invoked directly instead of dispatched through the (potentially
// accumulating) real listener chain.

import { describe, it, expect, vi } from 'vitest';

async function loadModule() {
    vi.resetModules();
    document.body.innerHTML = '';
    const spy = vi.spyOn(document.body, 'addEventListener');
    const mod = await import('../src/web/public/js/ui-events.js');
    const handler = spy.mock.calls.find(([t]) => t === 'click')[1];
    spy.mockRestore();
    return { ...mod, handler };
}

function click(el) {
    return { target: el, preventDefault: vi.fn() };
}

describe('registerAction wiring', () => {
    it('wires the click listener exactly once at import time', async () => {
        const spy = vi.spyOn(document.body, 'addEventListener');
        vi.resetModules();
        await import('../src/web/public/js/ui-events.js');
        expect(spy.mock.calls.filter(([t]) => t === 'click')).toHaveLength(1);
        spy.mockRestore();
    });
});

describe('delegated click handling', () => {
    it('calls the registered handler for a matching data-action element', async () => {
        const { registerAction, handler } = await loadModule();
        const fn = vi.fn();
        registerAction('doThing', fn);
        const el = document.createElement('button');
        el.setAttribute('data-action', 'doThing');
        document.body.appendChild(el);
        const ev = click(el);
        handler(ev);
        expect(fn).toHaveBeenCalledWith(ev, el);
    });

    it('walks up from a descendant of the [data-action] element', async () => {
        const { registerAction, handler } = await loadModule();
        const fn = vi.fn();
        registerAction('doThing', fn);
        const el = document.createElement('button');
        el.setAttribute('data-action', 'doThing');
        const icon = document.createElement('i');
        el.appendChild(icon);
        document.body.appendChild(el);
        handler(click(icon));
        expect(fn).toHaveBeenCalledWith(expect.anything(), el);
    });

    it('does nothing when the click has no [data-action] ancestor', async () => {
        const { registerAction, handler } = await loadModule();
        const fn = vi.fn();
        registerAction('doThing', fn);
        const el = document.createElement('div');
        document.body.appendChild(el);
        expect(() => handler(click(el))).not.toThrow();
        expect(fn).not.toHaveBeenCalled();
    });

    it('does nothing when the action name has no registered handler', async () => {
        const { handler } = await loadModule();
        const el = document.createElement('button');
        el.setAttribute('data-action', 'unregistered');
        document.body.appendChild(el);
        expect(() => handler(click(el))).not.toThrow();
    });

    it('passes data-arg as the first argument when present', async () => {
        const { registerAction, handler } = await loadModule();
        const fn = vi.fn();
        registerAction('doThing', fn);
        const el = document.createElement('button');
        el.setAttribute('data-action', 'doThing');
        el.setAttribute('data-arg', 'group-42');
        document.body.appendChild(el);
        const ev = click(el);
        handler(ev);
        expect(fn).toHaveBeenCalledWith('group-42', ev, el);
    });

    it('treats an empty-string data-arg as present (not absent)', async () => {
        const { registerAction, handler } = await loadModule();
        const fn = vi.fn();
        registerAction('doThing', fn);
        const el = document.createElement('button');
        el.setAttribute('data-action', 'doThing');
        el.setAttribute('data-arg', '');
        document.body.appendChild(el);
        const ev = click(el);
        handler(ev);
        expect(fn).toHaveBeenCalledWith('', ev, el);
    });

    it('a later registerAction call for the same name replaces the earlier handler', async () => {
        const { registerAction, handler } = await loadModule();
        const first = vi.fn();
        const second = vi.fn();
        registerAction('doThing', first);
        registerAction('doThing', second);
        const el = document.createElement('button');
        el.setAttribute('data-action', 'doThing');
        document.body.appendChild(el);
        handler(click(el));
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalled();
    });
});
