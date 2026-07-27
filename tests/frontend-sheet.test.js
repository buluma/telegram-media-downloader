// @vitest-environment jsdom
//
// Covers src/web/public/js/sheet.js — the bottom-sheet / modal primitive
// every dialog in the dashboard is built on, plus the promptSheet and
// confirmSheet wrappers.
//
// sheet.js captures two MediaQueryLists at module scope (prefers-reduced-
// motion and the 768px desktop breakpoint), so matchMedia is stubbed
// BEFORE each import. Most tests run with reduced-motion on, which makes
// close() synchronous and keeps the assertions readable; the animated
// path gets its own group.
//
// The module also keeps a shared `stack` at module scope — that is what
// makes Esc close only the topmost sheet — so each test re-imports through
// vi.resetModules() to avoid inheriting a previous test's stack.

import { describe, it, expect, afterEach, vi } from 'vitest';

function installMatchMedia({ reduced = true, desktop = false } = {}) {
    window.matchMedia = vi.fn((query) => ({
        matches: query.includes('reduced-motion') ? reduced : desktop,
        addEventListener() {},
        removeEventListener() {},
    }));
}

async function loadSheet(opts) {
    vi.resetModules();
    installMatchMedia(opts);
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    delete document.body.dataset.sheetOpen;
    return import('../src/web/public/js/sheet.js');
}

const roots = () => document.querySelectorAll('.sheet-root');
const topRoot = () => roots()[roots().length - 1];

describe('openSheet', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('structure', () => {
        it('renders a modal dialog with the title', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'Group settings' });
            const root = topRoot();
            expect(root.getAttribute('role')).toBe('dialog');
            expect(root.getAttribute('aria-modal')).toBe('true');
            expect(root.getAttribute('aria-label')).toBe('Group settings');
            expect(root.querySelector('.sheet-title').textContent).toBe('Group settings');
        });

        it('escapes the title instead of injecting markup', async () => {
            const s = await loadSheet();
            s.openSheet({ title: '<img src=x onerror=alert(1)>' });
            const root = topRoot();
            expect(root.querySelector('img')).toBeNull();
            expect(root.querySelector('.sheet-title').textContent).toBe(
                '<img src=x onerror=alert(1)>',
            );
        });

        it('omits the header (and close button) when no title is given', async () => {
            const s = await loadSheet();
            s.openSheet({ content: 'body' });
            expect(topRoot().querySelector('.sheet-header')).toBeNull();
            expect(topRoot().querySelector('.sheet-close')).toBeNull();
            // The drag handle survives so the sheet is still swipe-dismissable.
            expect(topRoot().querySelector('.sheet-handle')).not.toBeNull();
        });

        it('maps the size keyword to a desktop width, defaulting to md', async () => {
            const s = await loadSheet();
            for (const [size, cls] of [
                ['sm', 'max-w-sm'],
                ['md', 'max-w-md'],
                ['lg', 'max-w-2xl'],
                ['fit', 'max-w-fit'],
            ]) {
                s.openSheet({ size });
                expect(topRoot().querySelector('.sheet-card').className, size).toContain(cls);
                s.closeTopSheet();
            }
            s.openSheet({ size: 'nonsense' });
            expect(topRoot().querySelector('.sheet-card').className).toContain('max-w-md');
        });

        it('accepts string content as markup', async () => {
            const s = await loadSheet();
            s.openSheet({ content: '<p id="inner">hi</p>' });
            expect(topRoot().querySelector('#inner')).not.toBeNull();
        });

        it('accepts an element as content without re-parsing it', async () => {
            const s = await loadSheet();
            const el = document.createElement('form');
            el.id = 'live-node';
            s.openSheet({ content: el });
            expect(topRoot().querySelector('#live-node')).toBe(el);
        });
    });

    describe('body scroll lock', () => {
        it('locks while open and releases on close', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            expect(document.body.style.overflow).toBe('hidden');
            expect(document.body.dataset.sheetOpen).toBe('1');

            s.closeTopSheet();
            expect(document.body.style.overflow).toBe('');
            expect(document.body.dataset.sheetOpen).toBeUndefined();
        });

        it('stays locked until the last of several sheets closes', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            s.openSheet({ title: 'B' });
            s.closeTopSheet();
            expect(document.body.style.overflow).toBe('hidden');
            s.closeTopSheet();
            expect(document.body.style.overflow).toBe('');
        });
    });

    describe('closing', () => {
        it('closes on the header × button', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            topRoot().querySelector('.sheet-close').click();
            expect(roots()).toHaveLength(0);
        });

        it('closes on a backdrop click', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            topRoot().querySelector('.sheet-backdrop').click();
            expect(roots()).toHaveLength(0);
        });

        it('ignores clicks inside the card', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A', content: '<p id="inner">x</p>' });
            topRoot().querySelector('#inner').click();
            expect(roots()).toHaveLength(1);
        });

        it('closes on Escape', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
            expect(roots()).toHaveLength(0);
        });

        it('ignores other keys', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
            expect(roots()).toHaveLength(1);
        });

        it('runs the onClose callback', async () => {
            const s = await loadSheet();
            const onClose = vi.fn();
            s.openSheet({ title: 'A', onClose });
            s.closeTopSheet();
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('survives a throwing onClose', async () => {
            const s = await loadSheet();
            s.openSheet({
                title: 'A',
                onClose: () => {
                    throw new Error('boom');
                },
            });
            expect(() => s.closeTopSheet()).not.toThrow();
            expect(roots()).toHaveLength(0);
        });

        it('is idempotent — a second close is a no-op', async () => {
            const s = await loadSheet();
            const onClose = vi.fn();
            const handle = s.openSheet({ title: 'A', onClose });
            handle.close();
            handle.close();
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('restores focus to whatever was focused before', async () => {
            const s = await loadSheet();
            const trigger = document.createElement('button');
            document.body.appendChild(trigger);
            trigger.focus();
            expect(document.activeElement).toBe(trigger);

            s.openSheet({ title: 'A' });
            s.closeTopSheet();
            expect(document.activeElement).toBe(trigger);
        });
    });

    describe('non-dismissible sheets', () => {
        it('ignores Escape and backdrop clicks', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A', dismissible: false });
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
            topRoot().querySelector('.sheet-backdrop').click();
            expect(roots()).toHaveLength(1);
        });

        it('still closes on the header × button', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A', dismissible: false });
            topRoot().querySelector('.sheet-close').click();
            expect(roots()).toHaveLength(0);
        });
    });

    describe('stacking', () => {
        it('counts open sheets', async () => {
            const s = await loadSheet();
            expect(s.sheetCount()).toBe(0);
            s.openSheet({ title: 'A' });
            s.openSheet({ title: 'B' });
            expect(s.sheetCount()).toBe(2);
        });

        it('Escape closes only the topmost sheet', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            s.openSheet({ title: 'B' });
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
            expect(s.sheetCount()).toBe(1);
            expect(topRoot().getAttribute('aria-label')).toBe('A');
        });

        it('a backdrop click does not fall through to the sheet underneath', async () => {
            const s = await loadSheet();
            s.openSheet({ title: 'A' });
            const first = topRoot();
            s.openSheet({ title: 'B' });
            // Click the *lower* sheet's backdrop while B is on top.
            first.querySelector('.sheet-backdrop').click();
            expect(s.sheetCount()).toBe(2);
        });

        it('closeTopSheet is a no-op with nothing open', async () => {
            const s = await loadSheet();
            expect(() => s.closeTopSheet()).not.toThrow();
            expect(s.sheetCount()).toBe(0);
        });
    });

    describe('focus trap', () => {
        it('wraps Tab from the last focusable back to the first', async () => {
            const s = await loadSheet();
            s.openSheet({
                title: 'A',
                content: '<button id="one">1</button><button id="two">2</button>',
            });
            const root = topRoot();
            const two = root.querySelector('#two');
            two.focus();

            const ev = new window.KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            two.dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(true);
            // First focusable is the header close button.
            expect(document.activeElement).toBe(root.querySelector('.sheet-close'));
        });

        it('wraps Shift+Tab from the first focusable to the last', async () => {
            const s = await loadSheet();
            s.openSheet({ content: '<button id="one">1</button><button id="two">2</button>' });
            const root = topRoot();
            const one = root.querySelector('#one');
            one.focus();

            const ev = new window.KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            });
            one.dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(root.querySelector('#two'));
        });

        it('lets Tab through in the middle of the list', async () => {
            const s = await loadSheet();
            s.openSheet({
                content:
                    '<button id="one">1</button><button id="two">2</button><button id="three">3</button>',
            });
            const root = topRoot();
            root.querySelector('#two').focus();
            const ev = new window.KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            root.querySelector('#two').dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(false);
        });

        it('swallows Tab when the sheet has nothing focusable', async () => {
            const s = await loadSheet();
            s.openSheet({ content: '<p>text only</p>' });
            const ev = new window.KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            topRoot().querySelector('p').dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(true);
        });

        it('skips inert elements when computing the trap boundaries', async () => {
            const s = await loadSheet();
            s.openSheet({
                content: '<button id="one">1</button><button id="two" inert>2</button>',
            });
            const root = topRoot();
            root.querySelector('#one').focus();
            const ev = new window.KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            root.querySelector('#one').dispatchEvent(ev);
            // #one is the last non-inert focusable, so Tab wraps to the first.
            expect(ev.defaultPrevented).toBe(true);
        });
    });

    describe('initial focus', () => {
        it('focuses the first focusable control shortly after opening', async () => {
            vi.useFakeTimers();
            const s = await loadSheet();
            s.openSheet({ content: '<input id="field">' });
            vi.advanceTimersByTime(50);
            expect(document.activeElement).toBe(topRoot().querySelector('#field'));
        });

        it('falls back to the card itself when nothing is focusable', async () => {
            vi.useFakeTimers();
            const s = await loadSheet();
            s.openSheet({ content: '<p>text</p>' });
            vi.advanceTimersByTime(50);
            expect(document.activeElement).toBe(topRoot().querySelector('.sheet-card'));
        });
    });

    describe('with animation (reduced-motion off)', () => {
        it('defers teardown until the exit animation finishes', async () => {
            vi.useFakeTimers();
            const s = await loadSheet({ reduced: false });
            const onClose = vi.fn();
            s.openSheet({ title: 'A', onClose });

            s.closeTopSheet();
            expect(roots()).toHaveLength(1); // still animating out
            expect(onClose).not.toHaveBeenCalled();

            vi.advanceTimersByTime(220);
            expect(roots()).toHaveLength(0);
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('adds the open class on the next frame', async () => {
            const s = await loadSheet({ reduced: false });
            s.openSheet({ title: 'A' });
            const root = topRoot();
            await new Promise((r) => requestAnimationFrame(r));
            expect(root.classList.contains('sheet-open')).toBe(true);
        });
    });
});

describe('promptSheet', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /**
     * Open a prompt and flush the 60ms deferred wiring. Deliberately NOT
     * async: it returns the pending prompt promise, and awaiting *that*
     * here would block until a user action that has not happened yet.
     */
    function openPrompt(s, opts) {
        vi.useFakeTimers();
        const p = s.promptSheet(opts);
        vi.advanceTimersByTime(60);
        return p;
    }

    it('resolves with the entered value on confirm', async () => {
        const s = await loadSheet();
        const p = openPrompt(s, { title: 'Name' });
        const root = topRoot();
        root.querySelector('[data-prompt-input]').value = 'heimdal';
        root.querySelector('[data-prompt-ok]').click();
        await expect(p).resolves.toBe('heimdal');
    });

    it('resolves null on cancel', async () => {
        const s = await loadSheet();
        const p = openPrompt(s, { title: 'Name' });
        topRoot().querySelector('[data-prompt-cancel]').click();
        await expect(p).resolves.toBeNull();
    });

    it('resolves null when dismissed with Escape', async () => {
        const s = await loadSheet();
        const p = openPrompt(s, { title: 'Name' });
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        await expect(p).resolves.toBeNull();
    });

    it('submits on Enter in the input', async () => {
        const s = await loadSheet();
        const p = openPrompt(s, { title: 'Name' });
        const input = topRoot().querySelector('[data-prompt-input]');
        input.value = 'typed';
        input.dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        await expect(p).resolves.toBe('typed');
    });

    it('pre-fills the default value and honours the input type', async () => {
        const s = await loadSheet();
        const p = openPrompt(s, {
            title: 'Password',
            inputType: 'password',
            defaultValue: 'seed',
            placeholder: 'enter it',
        });
        const input = topRoot().querySelector('[data-prompt-input]');
        expect(input.type).toBe('password');
        expect(input.value).toBe('seed');
        expect(input.getAttribute('placeholder')).toBe('enter it');
        expect(input.getAttribute('autocomplete')).toBe('current-password');
        topRoot().querySelector('[data-prompt-cancel]').click();
        await p;
    });

    it('renders a multi-line message as separate lines, escaped', async () => {
        const s = await loadSheet();
        const p = openPrompt(s, { title: 'T', message: 'line1\n<b>line2</b>' });
        const root = topRoot();
        expect(root.querySelectorAll('br')).toHaveLength(1);
        expect(root.querySelector('b')).toBeNull();
        expect(root.textContent).toContain('<b>line2</b>');
        s.closeTopSheet();
        await p;
    });

    it('keeps the confirmed value when the close handler also settles', async () => {
        // Pins the observable contract — confirm wins over the onClose
        // settle(null) that follows. Note this cannot fail while `settle`
        // only calls resolve(): a promise settles once by definition, so
        // the internal `decided` flag is belt-and-braces, not the thing
        // under test here.
        const s = await loadSheet();
        const p = openPrompt(s, { title: 'Name' });
        const root = topRoot();
        root.querySelector('[data-prompt-input]').value = 'first';
        root.querySelector('[data-prompt-ok]').click();
        s.closeTopSheet();
        await expect(p).resolves.toBe('first');
    });
});

describe('confirmSheet', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** Same contract as openPrompt above — returns the pending promise. */
    function openConfirm(s, opts) {
        vi.useFakeTimers();
        const p = s.confirmSheet(opts);
        vi.advanceTimersByTime(60);
        return p;
    }

    it('resolves true on confirm', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'Delete?' });
        topRoot().querySelector('[data-confirm-ok]').click();
        await expect(p).resolves.toBe(true);
    });

    it('resolves false on cancel', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'Delete?' });
        topRoot().querySelector('[data-confirm-cancel]').click();
        await expect(p).resolves.toBe(false);
    });

    it('resolves false when dismissed with Escape', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'Delete?' });
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        await expect(p).resolves.toBe(false);
    });

    it('confirms on Enter', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'Delete?' });
        topRoot().dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        await expect(p).resolves.toBe(true);
    });

    it('accepts the legacy message/confirmLabel/cancelLabel names', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, {
            title: 'T',
            message: 'legacy body',
            confirmLabel: 'Yes do it',
            cancelLabel: 'No thanks',
        });
        const root = topRoot();
        expect(root.textContent).toContain('legacy body');
        expect(root.querySelector('[data-confirm-ok]').textContent).toBe('Yes do it');
        expect(root.querySelector('[data-confirm-cancel]').textContent).toBe('No thanks');
        root.querySelector('[data-confirm-cancel]').click();
        await p;
    });

    it('accepts the newer body/confirmText/cancelText names', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, {
            title: 'T',
            body: 'modern body',
            confirmText: 'Proceed',
            cancelText: 'Back',
        });
        const root = topRoot();
        expect(root.textContent).toContain('modern body');
        expect(root.querySelector('[data-confirm-ok]').textContent).toBe('Proceed');
        expect(root.querySelector('[data-confirm-cancel]').textContent).toBe('Back');
        root.querySelector('[data-confirm-cancel]').click();
        await p;
    });

    it('paints the confirm button red for either destructive flag', async () => {
        for (const opts of [{ danger: true }, { destructive: true }]) {
            const s = await loadSheet();
            const p = openConfirm(s, { title: 'T', ...opts });
            expect(topRoot().querySelector('[data-confirm-ok]').className).toContain('bg-red-500');
            topRoot().querySelector('[data-confirm-cancel]').click();
            await p;
        }
    });

    it('uses the neutral button by default', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'T' });
        expect(topRoot().querySelector('[data-confirm-ok]').className).toContain('bg-tg-blue');
        topRoot().querySelector('[data-confirm-cancel]').click();
        await p;
    });

    it('escapes the message rather than rendering it', async () => {
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'T', message: '<img src=x>' });
        expect(topRoot().querySelector('img')).toBeNull();
        expect(topRoot().textContent).toContain('<img src=x>');
        topRoot().querySelector('[data-confirm-cancel]').click();
        await p;
    });

    it('keeps the confirmed value when the close handler also settles', async () => {
        // Same caveat as the promptSheet case above: this pins behaviour,
        // not the `decided` guard, which Promise semantics already cover.
        const s = await loadSheet();
        const p = openConfirm(s, { title: 'T' });
        topRoot().querySelector('[data-confirm-ok]').click();
        s.closeTopSheet();
        await expect(p).resolves.toBe(true);
    });
});
