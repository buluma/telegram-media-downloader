// @vitest-environment jsdom
//
// Covers src/web/public/js/header-mobile.js — the mobile overflow ⋮ menu
// (which just delegates to desktop buttons) and the notification bell
// (buffer, unread badge, debounced localStorage flush, tab-title flash).
//
// localStorage comes from tests/setup.js's in-memory polyfill. document.hidden
// is getter-only in jsdom, so it needs Object.defineProperty to toggle.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function setDocumentHidden(value) {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
}

// Defaults live in a top-level beforeEach (below), NOT here — a test that
// does `localStorage.setItem(x); await loadModule()` needs that seed data
// to survive the load. Clearing storage / hidden state here unconditionally
// would run after the test's own setup and wipe it (same bug class as
// tests/frontend-statusbar.test.js and tests/frontend-maintenance-recovery
// .test.js). Any seed data must be set BEFORE loadModule() — only reads
// happen at import time (setupNotifyBell() runs on initHeaderMobile(),
// which the test calls after loading) — this module has no import-time
// localStorage read, so either order actually works here, but staying
// consistent with the established pattern.
async function loadModule() {
    vi.resetModules();
    return import('../src/web/public/js/header-mobile.js');
}

beforeEach(() => {
    localStorage.clear();
    setDocumentHidden(false);
    document.title = 'TGDL';
});

const $ = (id) => document.getElementById(id);

const OVERFLOW_DOM = `
    <button id="header-overflow-btn" aria-expanded="false"></button>
    <div id="header-overflow-menu">
        <div data-overflow="paste-url"></div>
        <div data-overflow="stories"></div>
        <div data-overflow="refresh"></div>
        <div data-overflow="vm-grid"></div>
        <div data-overflow="vm-compact"></div>
        <div data-overflow="vm-list"></div>
        <div data-overflow="unknown-action"></div>
    </div>
    <button id="paste-url-btn"></button>
    <button id="stories-btn"></button>
    <button id="refresh-btn"></button>
    <div id="view-mode-menu">
        <button data-vm="grid"></button>
        <button data-vm="compact"></button>
        <button data-vm="list"></button>
    </div>
`;

const BELL_DOM = `
    <button id="notify-bell-btn" aria-expanded="false"></button>
    <span id="notify-bell-badge" class="hidden"></span>
    <div id="notify-bell-menu">
        <button id="notify-clear-btn"></button>
        <div id="notify-list"></div>
        <div id="notify-empty" class="hidden"></div>
    </div>
`;

describe('setupOverflowMenu (via initHeaderMobile)', () => {
    beforeEach(() => {
        document.body.innerHTML = OVERFLOW_DOM + BELL_DOM;
    });
    afterEach(() => vi.restoreAllMocks());

    it('toggles open/closed and updates aria-expanded', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('header-overflow-btn').click();
        expect($('header-overflow-menu').classList.contains('open')).toBe(true);
        expect($('header-overflow-btn').getAttribute('aria-expanded')).toBe('true');
        $('header-overflow-btn').click();
        expect($('header-overflow-menu').classList.contains('open')).toBe(false);
        expect($('header-overflow-btn').getAttribute('aria-expanded')).toBe('false');
    });

    it('does nothing when the overflow elements are absent from the page', async () => {
        document.body.innerHTML = BELL_DOM;
        const { initHeaderMobile } = await loadModule();
        expect(() => initHeaderMobile()).not.toThrow();
    });

    it('delegates each action row to its desktop button via .click()', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        const pasteBtn = $('paste-url-btn');
        const spy = vi.fn();
        pasteBtn.addEventListener('click', spy);
        document.querySelector('[data-overflow="paste-url"]').click();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('delegates the view-mode rows to the matching desktop chip', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        const spy = vi.fn();
        document
            .querySelector('#view-mode-menu [data-vm="compact"]')
            .addEventListener('click', spy);
        document.querySelector('[data-overflow="vm-compact"]').click();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('closes the menu after any row action, including an unrecognised one', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('header-overflow-btn').click(); // open
        document.querySelector('[data-overflow="unknown-action"]').click();
        expect($('header-overflow-menu').classList.contains('open')).toBe(false);
    });

    it('closes on an outside click, but not on a click inside the menu or button', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('header-overflow-btn').click();
        document.querySelector('[data-overflow="paste-url"]').click(); // inside, also closes via action — reopen to test properly
        $('header-overflow-btn').click(); // reopen
        document.getElementById('header-overflow-menu').click(); // hits menu itself, not a row -> should stay open per "menu.contains" check
        expect($('header-overflow-menu').classList.contains('open')).toBe(true);
        document.body.click();
        expect($('header-overflow-menu').classList.contains('open')).toBe(false);
    });

    it('closes on Escape', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('header-overflow-btn').click();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect($('header-overflow-menu').classList.contains('open')).toBe(false);
    });

    it('ignores other keys', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('header-overflow-btn').click();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
        expect($('header-overflow-menu').classList.contains('open')).toBe(true);
    });
});

describe('notification bell', () => {
    beforeEach(() => {
        document.body.innerHTML = OVERFLOW_DOM + BELL_DOM;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does nothing when the bell elements are absent', async () => {
        document.body.innerHTML = OVERFLOW_DOM;
        const { initHeaderMobile } = await loadModule();
        expect(() => initHeaderMobile()).not.toThrow();
    });

    it('shows the empty state with no buffered notifications', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        expect($('notify-empty').classList.contains('hidden')).toBe(false);
        expect($('notify-list').innerHTML).toBe('');
    });

    it('restores the persisted unread badge on load', async () => {
        localStorage.setItem('tgdl-notify-unread', '5');
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        expect($('notify-bell-badge').textContent).toBe('5');
        expect($('notify-bell-badge').classList.contains('hidden')).toBe(false);
    });

    it('caps the displayed badge at 99+', async () => {
        localStorage.setItem('tgdl-notify-unread', '150');
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        expect($('notify-bell-badge').textContent).toBe('99+');
    });

    it('opening the bell marks everything read and clears the badge', async () => {
        localStorage.setItem('tgdl-notify-unread', '3');
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('notify-bell-btn').click();
        expect($('notify-bell-menu').classList.contains('open')).toBe(true);
        expect($('notify-bell-badge').classList.contains('hidden')).toBe(true);
        expect(localStorage.getItem('tgdl-notify-unread')).toBe('0');
    });

    it('clear wipes the buffer, badge and persisted unread count', async () => {
        localStorage.setItem(
            'tgdl-notify-buffer',
            JSON.stringify([{ ts: Date.now(), source: 'x', level: 'warn', msg: 'm' }]),
        );
        localStorage.setItem('tgdl-notify-unread', '1');
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('notify-clear-btn').click();
        expect($('notify-list').innerHTML).toBe('');
        expect($('notify-empty').classList.contains('hidden')).toBe(false);
        expect(localStorage.getItem('tgdl-notify-buffer')).toBe('[]');
        expect(localStorage.getItem('tgdl-notify-unread')).toBe('0');
    });

    it('renders buffered entries newest-first with icon, source and escaped message', async () => {
        localStorage.setItem(
            'tgdl-notify-buffer',
            JSON.stringify([
                { ts: Date.now(), source: 'monitor', level: 'warn', msg: 'first' },
                { ts: Date.now(), source: 'downloader', level: 'error', msg: '<img src=x>' },
            ]),
        );
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        const rows = [...$('notify-list').querySelectorAll('.notify-row')];
        expect(rows).toHaveLength(2);
        expect(rows[0].dataset.level).toBe('error'); // newest (second pushed) first
        expect(rows[0].querySelector('img')).toBeNull();
        expect(rows[0].textContent).toContain('<img src=x>');
        expect(rows[0].querySelector('i').className).toBe('ri-error-warning-line');
        expect(rows[1].querySelector('i').className).toBe('ri-alert-line');
    });

    it('closes on Escape and on an outside click', async () => {
        const { initHeaderMobile } = await loadModule();
        initHeaderMobile();
        $('notify-bell-btn').click();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect($('notify-bell-menu').classList.contains('open')).toBe(false);

        $('notify-bell-btn').click();
        document.body.click();
        expect($('notify-bell-menu').classList.contains('open')).toBe(false);
    });
});

describe('pushLogToNotify', () => {
    beforeEach(() => {
        document.body.innerHTML = OVERFLOW_DOM + BELL_DOM;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('ignores info-level entries entirely', async () => {
        vi.useFakeTimers();
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ level: 'info', msg: 'boring' });
        vi.advanceTimersByTime(200);
        expect(localStorage.getItem('tgdl-notify-buffer')).toBeNull();
    });

    it('defaults a missing level to info and still ignores it', async () => {
        vi.useFakeTimers();
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ msg: 'no level' });
        vi.advanceTimersByTime(200);
        expect(localStorage.getItem('tgdl-notify-buffer')).toBeNull();
    });

    it('does nothing at all when handed a falsy entry', async () => {
        const { pushLogToNotify } = await loadModule();
        expect(() => pushLogToNotify(null)).not.toThrow();
    });

    it('buffers warn/error entries and flushes to localStorage after the debounce', async () => {
        vi.useFakeTimers();
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ level: 'warn', source: 'monitor', msg: 'slow' });
        expect(localStorage.getItem('tgdl-notify-buffer')).toBeNull(); // not flushed yet
        vi.advanceTimersByTime(100);
        const buf = JSON.parse(localStorage.getItem('tgdl-notify-buffer'));
        expect(buf).toHaveLength(1);
        expect(buf[0]).toMatchObject({ source: 'monitor', level: 'warn', msg: 'slow' });
    });

    it('coalesces a burst into a single flush', async () => {
        vi.useFakeTimers();
        const { pushLogToNotify } = await loadModule();
        for (let i = 0; i < 20; i++) pushLogToNotify({ level: 'warn', msg: `m${i}` });
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(100);
        expect(JSON.parse(localStorage.getItem('tgdl-notify-buffer'))).toHaveLength(20);
    });

    it('keeps the flushed buffer at 50 entries after a 60-entry burst', async () => {
        // Note: _writeBuffer() itself does `.slice(-NOTIFY_MAX)` on every
        // write, so the on-disk result is capped at 50 either way — this
        // pins that observable contract, not the separate `while (buf.length
        // > NOTIFY_MAX) buf.shift()` cap inside pushLogToNotify, which exists
        // purely so the in-memory array doesn't grow unbounded across a huge
        // burst during the debounce window. That guard has no independently
        // observable effect through the public API (deleting it doesn't
        // change what ends up on disk), so it isn't mutation-tested here.
        vi.useFakeTimers();
        const { pushLogToNotify } = await loadModule();
        for (let i = 0; i < 60; i++) pushLogToNotify({ level: 'warn', msg: `m${i}` });
        vi.advanceTimersByTime(100);
        const buf = JSON.parse(localStorage.getItem('tgdl-notify-buffer'));
        expect(buf).toHaveLength(50);
        expect(buf[0].msg).toBe('m10'); // oldest 10 evicted
        expect(buf[49].msg).toBe('m59');
    });

    it('truncates an overlong message to 400 chars', async () => {
        vi.useFakeTimers();
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ level: 'error', msg: 'x'.repeat(1000) });
        vi.advanceTimersByTime(100);
        const buf = JSON.parse(localStorage.getItem('tgdl-notify-buffer'));
        expect(buf[0].msg).toHaveLength(400);
    });

    it('increments the unread badge while the bell is closed', async () => {
        vi.useFakeTimers();
        const { initHeaderMobile, pushLogToNotify } = await loadModule();
        initHeaderMobile();
        pushLogToNotify({ level: 'warn', msg: 'one' });
        pushLogToNotify({ level: 'warn', msg: 'two' });
        expect($('notify-bell-badge').textContent).toBe('2');
        vi.advanceTimersByTime(100);
        expect(localStorage.getItem('tgdl-notify-unread')).toBe('2');
    });

    it('does not increment the unread badge while the bell menu is open', async () => {
        vi.useFakeTimers();
        const { initHeaderMobile, pushLogToNotify } = await loadModule();
        initHeaderMobile();
        $('notify-bell-btn').click(); // open — marks read, badge hidden
        pushLogToNotify({ level: 'warn', msg: 'while open' });
        expect($('notify-bell-badge').classList.contains('hidden')).toBe(true);
    });

    it('renders the new entry immediately when the bell is already open', async () => {
        vi.useFakeTimers();
        const { initHeaderMobile, pushLogToNotify } = await loadModule();
        initHeaderMobile();
        $('notify-bell-btn').click();
        pushLogToNotify({ level: 'warn', msg: 'live update' });
        expect($('notify-list').textContent).toContain('live update');
    });

    it('flashes the tab title only while the page is hidden, and restores it on visibilitychange', async () => {
        setDocumentHidden(true);
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ level: 'error', msg: 'urgent thing happened' });
        expect(document.title).toContain('urgent thing happened');
        expect(document.title).toContain('TGDL');

        setDocumentHidden(false);
        document.dispatchEvent(new window.Event('visibilitychange'));
        expect(document.title).toBe('TGDL');
    });

    it('does not touch the tab title while the page is visible', async () => {
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ level: 'error', msg: 'urgent' });
        expect(document.title).toBe('TGDL');
    });

    it('truncates a long message in the flashed title', async () => {
        setDocumentHidden(true);
        const { pushLogToNotify } = await loadModule();
        pushLogToNotify({ level: 'error', msg: 'x'.repeat(100) });
        expect(document.title.length).toBeLessThan(60);
    });
});
