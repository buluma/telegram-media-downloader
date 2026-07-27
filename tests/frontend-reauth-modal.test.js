// @vitest-environment jsdom
//
// Covers src/web/public/js/reauth-modal.js directly — the modal itself,
// not the api.js handoff (tests/reauth-modal.test.js already covers
// that half and explicitly defers the modal's own rendering to here).
//
// Covers: initReauthModal's idempotent install, single-flight queuing
// of concurrent 401s onto one modal, the login form's submit/cancel/
// error paths, and the tgdl:reauth-success event.
//
// sheet.js is mocked; global fetch is mocked per test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const openSheet = vi.fn();
const showToast = vi.fn();
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet }));
vi.mock('../src/web/public/js/utils.js', () => ({
    showToast,
    escapeHtml: (s) =>
        String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;'),
}));

function sheetImpl(opts) {
    const root = document.createElement('div');
    root.innerHTML = opts.content;
    document.body.appendChild(root);
    return { body: root, opts, close: vi.fn() };
}

async function loadModule() {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    delete window.__tgdlReauth;
    openSheet.mockImplementation(sheetImpl);
    return import('../src/web/public/js/reauth-modal.js');
}

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function form() {
    return document.querySelector('form');
}
function pwInput() {
    return document.querySelector('input[type="password"]');
}
function submitBtn() {
    return document.querySelector('button[type="submit"]');
}
function cancelBtn() {
    return document.querySelector('button[type="button"]');
}
function errBox() {
    return document.querySelector('.text-tg-red');
}

async function submitWith(password) {
    pwInput().value = password;
    form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());

describe('initReauthModal', () => {
    it('installs window.__tgdlReauth', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        expect(typeof window.__tgdlReauth).toBe('function');
    });

    it('is idempotent — does not replace an existing handler', async () => {
        const { initReauthModal } = await loadModule();
        const sentinel = () => {};
        window.__tgdlReauth = sentinel;
        initReauthModal();
        expect(window.__tgdlReauth).toBe(sentinel);
    });
});

describe('modal rendering', () => {
    it('opens a sheet with the expected title and form controls', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        expect(openSheet).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Session expired', size: 'sm' }),
        );
        expect(pwInput()).not.toBeNull();
        expect(pwInput().required).toBe(true);
        expect(pwInput().autocomplete).toBe('current-password');
        expect(submitBtn().textContent.trim()).toBe('Re-authenticate');
    });

    it('focuses the password field shortly after opening', async () => {
        vi.useFakeTimers();
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        const focusSpy = vi.spyOn(pwInput(), 'focus');
        vi.advanceTimersByTime(50);
        expect(focusSpy).toHaveBeenCalled();
    });

    it('escapes an id collision safely (ids are randomised, no fixed template injection)', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        expect(form().id).toMatch(/^tgdl-reauth-[a-z0-9]+-form$/);
    });
});

describe('cancel path', () => {
    it('closes the sheet and resolves cancel', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        const p = window.__tgdlReauth();
        const sheet = openSheet.mock.results[0].value;
        cancelBtn().click();
        await expect(p).resolves.toBe('cancel');
        expect(sheet.close).toHaveBeenCalled();
    });

    it('resolves cancel when the sheet is dismissed via onClose (Esc / backdrop)', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        const p = window.__tgdlReauth();
        openSheet.mock.calls[0][0].onClose();
        await expect(p).resolves.toBe('cancel');
    });

    it('only settles once even if both cancel and onClose fire', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        const p = window.__tgdlReauth();
        cancelBtn().click();
        openSheet.mock.calls[0][0].onClose();
        await expect(p).resolves.toBe('cancel');
    });
});

describe('submit path', () => {
    it('ignores a submit with an empty password', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await submitWith('');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('posts the password to /api/login', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        await submitWith('hunter2');
        expect(fetch).toHaveBeenCalledWith('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'hunter2' }),
        });
    });

    it('disables the submit button and shows the signing-in label while in flight', async () => {
        let resolveFetch;
        vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise((r) => (resolveFetch = r)));
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        pwInput().value = 'hunter2';
        form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        expect(submitBtn().disabled).toBe(true);
        expect(submitBtn().textContent).toBe('Signing in…');
        resolveFetch({ ok: true, json: async () => ({}) });
        await flush();
    });

    it('on success: dispatches tgdl:reauth-success, toasts, closes the sheet, and resolves retry', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
        const eventSpy = vi.fn();
        window.addEventListener('tgdl:reauth-success', eventSpy);
        const { initReauthModal } = await loadModule();
        initReauthModal();
        const p = window.__tgdlReauth();
        const sheet = openSheet.mock.results[0].value;
        await submitWith('hunter2');
        expect(eventSpy).toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(
            'Signed back in. Resuming where you left off.',
            'success',
            3000,
        );
        expect(sheet.close).toHaveBeenCalled();
        await expect(p).resolves.toBe('retry');
        window.removeEventListener('tgdl:reauth-success', eventSpy);
    });

    it('on a non-ok response: shows the server error, re-enables the button, and does not settle', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            json: async () => ({ error: 'wrong password' }),
        });
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        await submitWith('wrong');
        expect(errBox().textContent).toBe('wrong password');
        expect(errBox().classList.contains('hidden')).toBe(false);
        expect(submitBtn().disabled).toBe(false);
        expect(submitBtn().textContent.trim()).toBe('Re-authenticate');
        expect(showToast).not.toHaveBeenCalled();
    });

    it('falls back to a generic message when the server sends no error body', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            json: async () => {
                throw new Error('not json');
            },
        });
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        await submitWith('wrong');
        expect(errBox().textContent).toBe('Sign-in failed. Check your password and try again.');
    });

    it('shows a network-error message and re-enables the button when fetch rejects', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        await submitWith('hunter2');
        expect(errBox().textContent).toBe('offline');
        expect(submitBtn().disabled).toBe(false);
    });

    it('clears a previous error banner on a fresh submit attempt', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'first fail' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        await submitWith('wrong');
        expect(errBox().classList.contains('hidden')).toBe(false);
        await submitWith('right');
        expect(errBox().classList.contains('hidden')).toBe(true);
    });

    it('escapes a hostile server error message', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            json: async () => ({ error: '<img src=x onerror=alert(1)>' }),
        });
        const { initReauthModal } = await loadModule();
        initReauthModal();
        window.__tgdlReauth();
        await submitWith('wrong');
        expect(document.querySelector('img')).toBeNull();
    });
});

describe('single-flight queuing', () => {
    it('a second concurrent call reuses the same modal instead of opening another', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        const p1 = window.__tgdlReauth({ url: '/api/a' });
        const p2 = window.__tgdlReauth({ url: '/api/b' });
        expect(openSheet).toHaveBeenCalledTimes(1);
        cancelBtn().click();
        await expect(Promise.all([p1, p2])).resolves.toEqual(['cancel', 'cancel']);
    });

    it('opens a fresh modal for a later call once the first has settled', async () => {
        const { initReauthModal } = await loadModule();
        initReauthModal();
        const p1 = window.__tgdlReauth();
        cancelBtn().click();
        await p1;
        window.__tgdlReauth();
        expect(openSheet).toHaveBeenCalledTimes(2);
    });
});
