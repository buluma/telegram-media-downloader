// @vitest-environment jsdom
//
// Covers src/web/public/js/theme.js — light/dark/auto persistence and the
// class + meta + event fan-out that applies it.
//
// Two things shape this file:
//   - theme.js calls initTheme() at module scope (to beat the dark-flash on
//     reload), so importing it IS the first test action. Each test
//     re-imports through vi.resetModules().
//   - jsdom's matchMedia always reports `matches: false` and never emits
//     change events, so it is replaced with a controllable stub that must
//     be installed BEFORE the import — theme.js captures the MediaQueryList
//     once at module scope.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEY = 'tgdl-theme';

let mql; // the stub MediaQueryList handed to theme.js

/** Install a matchMedia stub. `prefersLight` seeds `matches`. */
function installMatchMedia(prefersLight = false) {
    const listeners = new Set();
    mql = {
        matches: prefersLight,
        addEventListener: vi.fn((ev, fn) => ev === 'change' && listeners.add(fn)),
        removeEventListener: vi.fn((ev, fn) => listeners.delete(fn)),
        // Test-only: flip the OS preference and notify, the way a real
        // MediaQueryList would when the system theme changes.
        _change(nowLight) {
            mql.matches = nowLight;
            for (const fn of listeners) fn({ matches: nowLight });
        },
        _listenerCount: () => listeners.size,
    };
    window.matchMedia = vi.fn(() => mql);
    return mql;
}

async function loadTheme({ prefersLight = false, stored = null } = {}) {
    vi.resetModules();
    localStorage.clear();
    if (stored) localStorage.setItem(KEY, stored);
    installMatchMedia(prefersLight);
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
    return import('../src/web/public/js/theme.js');
}

const root = () => document.documentElement;

describe('theme', () => {
    beforeEach(() => {
        document.head.innerHTML = '<meta name="color-scheme" content="dark">';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('initTheme (runs on import)', () => {
        it('defaults to auto and resolves dark when the OS prefers dark', async () => {
            const theme = await loadTheme({ prefersLight: false });
            expect(theme.getTheme()).toBe('auto');
            expect(root().classList.contains('theme-dark')).toBe(true);
            expect(root().classList.contains('theme-light')).toBe(false);
            expect(root().dataset.theme).toBe('auto');
        });

        it('resolves auto to light when the OS prefers light', async () => {
            await loadTheme({ prefersLight: true });
            expect(root().classList.contains('theme-light')).toBe(true);
            expect(root().classList.contains('theme-dark')).toBe(false);
        });

        it('applies a stored explicit choice over the OS preference', async () => {
            await loadTheme({ prefersLight: true, stored: 'dark' });
            expect(root().classList.contains('theme-dark')).toBe(true);
            expect(root().dataset.theme).toBe('dark');
        });

        it('subscribes to OS theme changes exactly once', async () => {
            await loadTheme();
            expect(mql.addEventListener).toHaveBeenCalledTimes(1);
            expect(mql._listenerCount()).toBe(1);
        });
    });

    describe('getTheme', () => {
        it('reports auto when nothing is stored', async () => {
            const theme = await loadTheme();
            expect(theme.getTheme()).toBe('auto');
        });

        it('reports the stored setting, not the resolved scheme', async () => {
            const theme = await loadTheme({ prefersLight: true, stored: 'auto' });
            expect(theme.getTheme()).toBe('auto');
        });
    });

    describe('setTheme', () => {
        it('persists and applies an explicit choice', async () => {
            const theme = await loadTheme();
            theme.setTheme('light');
            expect(localStorage.getItem(KEY)).toBe('light');
            expect(root().classList.contains('theme-light')).toBe(true);
            expect(root().dataset.theme).toBe('light');
        });

        it('ignores an unrecognised setting entirely', async () => {
            const theme = await loadTheme();
            theme.setTheme('neon');
            expect(localStorage.getItem(KEY)).toBeNull();
            expect(root().dataset.theme).toBe('auto');
        });

        it('swaps the class rather than accumulating both', async () => {
            const theme = await loadTheme();
            theme.setTheme('light');
            theme.setTheme('dark');
            expect(root().classList.contains('theme-dark')).toBe(true);
            expect(root().classList.contains('theme-light')).toBe(false);
        });

        it('mirrors the resolved scheme onto the color-scheme meta tag', async () => {
            const theme = await loadTheme();
            theme.setTheme('light');
            expect(document.querySelector('meta[name="color-scheme"]').content).toBe('light');
            theme.setTheme('dark');
            expect(document.querySelector('meta[name="color-scheme"]').content).toBe('dark');
        });

        it('writes the setting to data-theme but the scheme to the meta tag', async () => {
            const theme = await loadTheme({ prefersLight: true });
            theme.setTheme('auto');
            expect(root().dataset.theme).toBe('auto');
            expect(document.querySelector('meta[name="color-scheme"]').content).toBe('light');
        });

        it('survives a page with no color-scheme meta tag', async () => {
            document.head.innerHTML = '';
            const theme = await loadTheme();
            expect(() => theme.setTheme('light')).not.toThrow();
            expect(root().classList.contains('theme-light')).toBe(true);
        });

        it('announces the change with both the setting and the resolved scheme', async () => {
            const theme = await loadTheme({ prefersLight: true });
            const seen = vi.fn();
            document.addEventListener('themechange', seen);
            theme.setTheme('auto');
            expect(seen).toHaveBeenCalledTimes(1);
            expect(seen.mock.calls[0][0].detail).toEqual({ setting: 'auto', scheme: 'light' });
            document.removeEventListener('themechange', seen);
        });
    });

    describe('following the OS while on auto', () => {
        it('re-applies when the system flips to light', async () => {
            await loadTheme({ prefersLight: false });
            expect(root().classList.contains('theme-dark')).toBe(true);
            mql._change(true);
            expect(root().classList.contains('theme-light')).toBe(true);
        });

        it('ignores the system once an explicit choice is set', async () => {
            const theme = await loadTheme({ prefersLight: false });
            theme.setTheme('dark');
            mql._change(true);
            expect(root().classList.contains('theme-dark')).toBe(true);
            expect(root().classList.contains('theme-light')).toBe(false);
        });

        it('resumes following after switching back to auto', async () => {
            const theme = await loadTheme({ prefersLight: false });
            theme.setTheme('dark');
            theme.setTheme('auto');
            mql._change(true);
            expect(root().classList.contains('theme-light')).toBe(true);
        });
    });
});
