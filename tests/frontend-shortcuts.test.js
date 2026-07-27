// @vitest-environment jsdom
//
// Covers src/web/public/js/shortcuts.js — the global keydown dispatcher:
// typing-field guard, modifier-key passthrough, the cheatsheet sheet, the
// `g <letter>` chord navigation, per-action bindings, viewer-open
// suppression, and override-beats-default precedence.
//
// tests/shortcut-overrides.test.js already covers the override storage
// functions (load/set/reset/effectiveShortcuts) directly — this file
// covers initShortcuts()'s actual keydown behaviour, which nothing
// exercises yet.
//
// initShortcuts() attaches its listener straight to `document` with no
// way to remove it, and jsdom keeps the same `document` across every test
// in a file. Dispatching a real event would therefore also re-trigger
// every earlier test's now-stale listener. Instead, capture the handler
// initShortcuts() registers via a spy on addEventListener and invoke only
// that one directly — each test's loadModule() gives a fresh module
// instance (and closure) via vi.resetModules(), so this is equivalent to
// "only this test's listener exists" without needing real teardown.
//
// Real pages always have a `#media-modal` element (hidden by default) in
// the DOM skeleton. The code reads
// `!document.getElementById('media-modal')?.classList.contains('hidden')`
// — if the element is simply ABSENT, optional chaining short-circuits to
// undefined and `!undefined` is true, i.e. "viewer open". So the fixture
// always includes it, hidden, matching production.
//
// sheet.js is mocked. localStorage comes from tests/setup.js's in-memory
// polyfill.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const openSheet = vi.fn();
const sheetCount = vi.fn(() => 0);
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet, sheetCount }));

const OVERRIDE_KEY = 'tgdl-shortcut-overrides';

const BASE_DOM = '<div id="media-modal" class="hidden"></div>';

async function loadModule() {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = BASE_DOM;
    delete window.navigateTo;
    openSheet.mockReturnValue({ root: document.createElement('div') });
    sheetCount.mockReturnValue(0);
    return import('../src/web/public/js/shortcuts.js');
}

/** Boot the module and capture the one keydown handler it registers. */
async function boot() {
    const mod = await loadModule();
    const spy = vi.spyOn(document, 'addEventListener');
    mod.initShortcuts();
    const call = spy.mock.calls.find(([type]) => type === 'keydown');
    spy.mockRestore();
    return { ...mod, handler: call[1] };
}

function press(handler, k, opts = {}) {
    const target = opts.target || document.body;
    const ev = new window.KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...opts,
    });
    Object.defineProperty(ev, 'target', { value: target });
    handler(ev);
    return ev;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
    delete window.navigateTo;
});

describe('typing-field guard', () => {
    it('does not fire shortcuts while focus is in an input', async () => {
        const { handler } = await boot();
        const input = document.createElement('input');
        document.body.appendChild(input);
        const ev = press(handler, 's', { target: input });
        expect(ev.defaultPrevented).toBe(false);
    });

    it('does not fire while focus is in a textarea or select', async () => {
        const { handler } = await boot();
        for (const tag of ['textarea', 'select']) {
            const el = document.createElement(tag);
            document.body.appendChild(el);
            const ev = press(handler, '?', { target: el });
            expect(ev.defaultPrevented, tag).toBe(false);
        }
    });

    it('does not fire in a contenteditable element', async () => {
        const { handler } = await boot();
        const div = document.createElement('div');
        Object.defineProperty(div, 'isContentEditable', { value: true });
        document.body.appendChild(div);
        const ev = press(handler, '?', { target: div });
        expect(ev.defaultPrevented).toBe(false);
    });

    it('ignores a keydown with no target', async () => {
        const { handler } = await boot();
        const ev = new window.KeyboardEvent('keydown', { key: '?', cancelable: true });
        Object.defineProperty(ev, 'target', { value: null });
        expect(() => handler(ev)).not.toThrow();
    });
});

describe('modifier passthrough', () => {
    it('ignores Ctrl/Cmd/Alt combos so browser/OS shortcuts still work', async () => {
        // 's' alone never calls preventDefault() even when it DOES fire
        // (it just clicks the select-mode button), so defaultPrevented
        // can't tell whether the modifier guard actually ran. Assert the
        // real side effect — the button must not be clicked — instead.
        const { handler } = await boot();
        const btn = document.createElement('button');
        btn.id = 'select-mode-btn';
        const spy = vi.fn();
        btn.addEventListener('click', spy);
        document.body.appendChild(btn);
        for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
            press(handler, 's', { [mod]: true });
        }
        expect(spy, 'select-mode-btn should stay unclicked').not.toHaveBeenCalled();
    });
});

describe('cheatsheet', () => {
    it('opens on ? and marks the sheet root', async () => {
        const { handler } = await boot();
        const ev = press(handler, '?');
        expect(ev.defaultPrevented).toBe(true);
        expect(openSheet).toHaveBeenCalledTimes(1);
        expect(openSheet.mock.calls[0][0]).toMatchObject({
            title: 'Keyboard shortcuts',
            size: 'sm',
        });
        const handle = openSheet.mock.results[0].value;
        expect(handle.root.getAttribute('data-shortcuts')).toBe('1');
    });

    it('also opens on Shift+/', async () => {
        const { handler } = await boot();
        const ev = press(handler, '/', { shiftKey: true });
        expect(ev.defaultPrevented).toBe(true);
        expect(openSheet).toHaveBeenCalledTimes(1);
    });

    it('does not reopen when a shortcuts sheet is already showing', async () => {
        const { handler } = await boot();
        sheetCount.mockReturnValue(1);
        document.body.innerHTML = `${BASE_DOM}<div class="sheet-root" data-shortcuts="1"></div>`;
        press(handler, '?');
        expect(openSheet).not.toHaveBeenCalled();
    });

    it('reopens when sheetCount is > 0 but no shortcuts sheet is on top', async () => {
        const { handler } = await boot();
        sheetCount.mockReturnValue(1);
        document.body.innerHTML = `${BASE_DOM}<div class="sheet-root"></div>`; // some other sheet
        press(handler, '?');
        expect(openSheet).toHaveBeenCalledTimes(1);
    });

    it('renders one row per shortcut plus the typing-tip footer', async () => {
        const { handler } = await boot();
        press(handler, '?');
        const content = openSheet.mock.calls[0][0].content;
        expect(content.querySelectorAll('li').length).toBeGreaterThan(10);
        expect(content.textContent).toContain("none of these fire while you're typing");
    });

    it('reflects a user override in the cheatsheet label', async () => {
        const { handler } = await boot();
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ toggle_select: 'p' }));
        press(handler, '?');
        const content = openSheet.mock.calls[0][0].content;
        const kbds = [...content.querySelectorAll('kbd')].map((k) => k.textContent);
        expect(kbds).toContain('p');
        expect(kbds).not.toContain('s');
    });
});

describe('viewer-open suppression', () => {
    function setViewerOpen(open) {
        const modal = document.getElementById('media-modal');
        modal.classList.toggle('hidden', !open);
    }

    it('suppresses gallery shortcuts while the viewer modal is open', async () => {
        const { handler } = await boot();
        setViewerOpen(true);
        const btn = document.createElement('button');
        btn.id = 'select-mode-btn';
        const spy = vi.fn();
        btn.addEventListener('click', spy);
        document.body.appendChild(btn);
        press(handler, 's');
        expect(spy).not.toHaveBeenCalled();
    });

    it('still allows the cheatsheet while the viewer is open', async () => {
        const { handler } = await boot();
        setViewerOpen(true);
        press(handler, '?');
        expect(openSheet).toHaveBeenCalled();
    });

    it('runs gallery shortcuts normally when the viewer modal is hidden', async () => {
        const { handler } = await boot();
        const btn = document.createElement('button');
        btn.id = 'select-mode-btn';
        const spy = vi.fn();
        btn.addEventListener('click', spy);
        document.body.appendChild(btn);
        press(handler, 's');
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe('built-in key bindings', () => {
    it('/ focuses the sidebar search box', async () => {
        const { handler } = await boot();
        const search = document.createElement('input');
        search.id = 'sidebar-groups-search';
        document.body.appendChild(search);
        const focusSpy = vi.spyOn(search, 'focus');
        const ev = press(handler, '/');
        expect(ev.defaultPrevented).toBe(true);
        expect(focusSpy).toHaveBeenCalled();
    });

    it('l/L opens the paste-link drawer', async () => {
        const { handler } = await boot();
        const btn = document.createElement('button');
        btn.id = 'paste-url-btn';
        const spy = vi.fn();
        btn.addEventListener('click', spy);
        document.body.appendChild(btn);
        press(handler, 'l');
        press(handler, 'L');
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('s/S toggles gallery select mode', async () => {
        const { handler } = await boot();
        const btn = document.createElement('button');
        btn.id = 'select-mode-btn';
        const spy = vi.fn();
        btn.addEventListener('click', spy);
        document.body.appendChild(btn);
        press(handler, 's');
        press(handler, 'S');
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('tolerates missing target elements for l/s without throwing', async () => {
        const { handler } = await boot();
        expect(() => press(handler, 'l')).not.toThrow();
        expect(() => press(handler, 's')).not.toThrow();
    });
});

describe('g <letter> chord navigation', () => {
    it('navigates to viewer/groups/engine/settings on g then v/g/e/s', async () => {
        const cases = { v: 'viewer', g: 'groups', e: 'engine', s: 'settings' };
        for (const [letter, dest] of Object.entries(cases)) {
            const { handler } = await boot();
            window.navigateTo = vi.fn();
            press(handler, 'g');
            press(handler, letter);
            expect(window.navigateTo, letter).toHaveBeenCalledWith(dest);
        }
    });

    it('does not navigate for a letter with no mapping', async () => {
        const { handler } = await boot();
        window.navigateTo = vi.fn();
        press(handler, 'g');
        press(handler, 'z');
        expect(window.navigateTo).not.toHaveBeenCalled();
    });

    it('expires the chord after 800ms', async () => {
        const { handler } = await boot();
        window.navigateTo = vi.fn();
        const realNow = Date.now;
        let t = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => t);
        press(handler, 'g');
        t += 801;
        press(handler, 'v');
        expect(window.navigateTo).not.toHaveBeenCalled();
        Date.now = realNow;
    });

    it('does not throw when navigateTo is not defined', async () => {
        const { handler } = await boot();
        press(handler, 'g');
        expect(() => press(handler, 'v')).not.toThrow();
    });

    // An abandoned chord must not eat the next single-key binding. The guard
    // used to swallow ANY [a-z] within the 800ms window, so "g" followed by a
    // change of mind and "l" hit dispatchG('l') — which maps nothing — and
    // returned, dropping the paste-URL binding on the floor.
    it('lets a non-chord letter fall through to its own binding', async () => {
        const { handler } = await boot();
        window.navigateTo = vi.fn();
        const btn = document.createElement('button');
        btn.id = 'paste-url-btn';
        const clicked = vi.fn();
        btn.addEventListener('click', clicked);
        document.body.appendChild(btn);

        press(handler, 'g');
        press(handler, 'l');

        expect(window.navigateTo).not.toHaveBeenCalled();
        expect(clicked).toHaveBeenCalledTimes(1);
    });

    it('an abandoned chord does not linger — the next s toggles select mode', async () => {
        const { handler } = await boot();
        window.navigateTo = vi.fn();
        const btn = document.createElement('button');
        btn.id = 'select-mode-btn';
        const clicked = vi.fn();
        btn.addEventListener('click', clicked);
        document.body.appendChild(btn);

        press(handler, 'g');
        press(handler, 'z'); // unmapped letter aborts the chord
        press(handler, 's'); // must be the standalone binding, not go_settings

        expect(window.navigateTo).not.toHaveBeenCalled();
        expect(clicked).toHaveBeenCalledTimes(1);
    });

    it('only fires once per chord, consuming the buffered g', async () => {
        const { handler } = await boot();
        window.navigateTo = vi.fn();
        press(handler, 'g');
        press(handler, 'v');
        press(handler, 'v'); // second 'v' alone should not re-trigger without a fresh 'g'
        expect(window.navigateTo).toHaveBeenCalledTimes(1);
    });
});

describe('user override precedence', () => {
    it('an override wins over the built-in binding for the same key', async () => {
        const { handler } = await boot();
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ cheatsheet: 'k' }));
        const ev = press(handler, 'k');
        expect(ev.defaultPrevented).toBe(true);
        expect(openSheet).toHaveBeenCalledTimes(1);
    });

    it('an override on a non-conflicting key does not disturb other bindings', async () => {
        const { handler } = await boot();
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ toggle_select: 'p' }));
        const btn = document.createElement('button');
        btn.id = 'select-mode-btn';
        const spy = vi.fn();
        btn.addEventListener('click', spy);
        document.body.appendChild(btn);
        press(handler, 'p');
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockClear();
        // The built-in 's' binding is untouched by an override on a
        // DIFFERENT action id, so it still fires too.
        press(handler, 's');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('routes an overridden go_* action through dispatchG, not a raw click', async () => {
        const { handler } = await boot();
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ go_engine: 'e' }));
        window.navigateTo = vi.fn();
        press(handler, 'e');
        expect(window.navigateTo).toHaveBeenCalledWith('engine');
    });

    it('open_paste and focus_search overrides run their bound action', async () => {
        const { handler } = await boot();
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ open_paste: 'o', focus_search: 'f' }));
        const pasteBtn = document.createElement('button');
        pasteBtn.id = 'paste-url-btn';
        const pasteSpy = vi.fn();
        pasteBtn.addEventListener('click', pasteSpy);
        document.body.appendChild(pasteBtn);
        const search = document.createElement('input');
        search.id = 'sidebar-groups-search';
        document.body.appendChild(search);
        const focusSpy = vi.spyOn(search, 'focus');

        press(handler, 'o');
        press(handler, 'f');
        expect(pasteSpy).toHaveBeenCalledTimes(1);
        expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores an override with no matching action id (play_pause etc. are viewer-owned)', async () => {
        const { handler } = await boot();
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ play_pause: 'm' }));
        expect(() => press(handler, 'm')).not.toThrow();
    });
});
