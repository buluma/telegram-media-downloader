// Verifies that user-configured shortcut overrides in localStorage
// REPLACE the built-in defaults — the shortcuts.js module surfaces this
// via `loadShortcutOverrides`, `setShortcutOverride`, `effectiveShortcuts`.

import { describe, it, expect, beforeEach } from 'vitest';

// Vitest in node mode doesn't have window/localStorage by default. We
// install a minimal in-memory polyfill so the module-under-test can read
// + write without hitting the real browser store.
class MemStore {
    constructor() { this.m = new Map(); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
    clear() { this.m.clear(); }
}

if (typeof globalThis.localStorage === 'undefined') {
    globalThis.localStorage = new MemStore();
}
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        localStorage: globalThis.localStorage,
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
} else if (typeof globalThis.window.matchMedia !== 'function') {
    globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        addEventListener() {},
        querySelector() { return null; },
        getElementById() { return null; },
    };
}

beforeEach(() => {
    if (globalThis.localStorage.clear) globalThis.localStorage.clear();
});

describe('shortcut overrides', () => {
    it('loadShortcutOverrides returns {} on a fresh install', async () => {
        const { loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        expect(loadShortcutOverrides()).toEqual({});
    });

    it('setShortcutOverride persists the new binding across reads', async () => {
        const { setShortcutOverride, loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        setShortcutOverride('toggle_select', 'p');
        const map = loadShortcutOverrides();
        expect(map.toggle_select).toBe('p');
    });

    it('effectiveShortcuts replaces the built-in default with the user override', async () => {
        const { setShortcutOverride, effectiveShortcuts } = await import('../src/web/public/js/shortcuts.js');
        const before = effectiveShortcuts().find(s => s.id === 'toggle_select');
        expect(before.keys).toBe('s');

        setShortcutOverride('toggle_select', 'P');
        const after = effectiveShortcuts().find(s => s.id === 'toggle_select');
        expect(after.keys).toBe('P');
    });

    it('resetShortcutOverrides reverts to defaults', async () => {
        const { setShortcutOverride, resetShortcutOverrides, loadShortcutOverrides } =
            await import('../src/web/public/js/shortcuts.js');
        setShortcutOverride('focus_search', 'k');
        expect(loadShortcutOverrides().focus_search).toBe('k');
        resetShortcutOverrides();
        expect(loadShortcutOverrides()).toEqual({});
    });

    it('discards malformed JSON without throwing', async () => {
        globalThis.localStorage.setItem('tgdl-shortcut-overrides', '{not json');
        const { loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        expect(loadShortcutOverrides()).toEqual({});
    });

    it('drops non-string override values defensively', async () => {
        globalThis.localStorage.setItem('tgdl-shortcut-overrides', JSON.stringify({
            toggle_select: 'p',
            invalid: { evil: 'object' },
            other: 42,
        }));
        const { loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        const m = loadShortcutOverrides();
        expect(m.toggle_select).toBe('p');
        expect(m.invalid).toBeUndefined();
        expect(m.other).toBeUndefined();
    });
});
