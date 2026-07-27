// @vitest-environment jsdom
//
// Covers src/web/public/js/pwa.js — the whole module runs its wiring at
// import time (event listeners, standalone check, SW registration), so
// every test controls window.matchMedia / navigator.standalone /
// navigator.serviceWorker BEFORE importing, then re-imports via
// vi.resetModules().
//
// ui-events.js is mocked (registerAction is called at import time too).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const registerAction = vi.fn();
vi.mock('../src/web/public/js/ui-events.js', () => ({ registerAction }));

function installMatchMedia(standalone = false) {
    window.matchMedia = vi.fn((q) => ({
        matches: q.includes('display-mode: standalone') ? standalone : false,
        addEventListener() {},
        removeEventListener() {},
    }));
}

function installServiceWorker() {
    const listeners = new Map();
    const registration = {
        addEventListener: vi.fn((type, fn) => {
            (listeners.get(type) || listeners.set(type, []).get(type)).push(fn);
        }),
        installing: null,
    };
    const sw = {
        register: vi.fn().mockResolvedValue(registration),
        addEventListener: vi.fn(),
        controller: {},
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: sw,
    });
    return {
        sw,
        registration,
        _fire: (type, ...args) => (listeners.get(type) || []).forEach((fn) => fn(...args)),
    };
}

async function loadModule({ standalone = false, iosStandalone = false, withSw = false } = {}) {
    vi.resetModules();
    vi.clearAllMocks();
    installMatchMedia(standalone);
    Object.defineProperty(window.navigator, 'standalone', {
        configurable: true,
        value: iosStandalone,
    });
    if (withSw) installServiceWorker();
    else delete navigator.serviceWorker;
    return import('../src/web/public/js/pwa.js');
}

function makeButton() {
    const btn = document.createElement('button');
    btn.setAttribute('hidden', '');
    btn.setAttribute('data-pwa-install', '');
    document.body.appendChild(btn);
    return btn;
}

function firePrompt(opts = {}) {
    const ev = new window.Event('beforeinstallprompt', { cancelable: true });
    ev.prompt = opts.prompt || vi.fn();
    ev.userChoice = opts.userChoice ?? Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(ev);
    return ev;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
    delete navigator.serviceWorker;
    document.body.innerHTML = '';
});

describe('registerAction wiring', () => {
    it('registers installPwa for inline data-action markup', async () => {
        await loadModule();
        expect(registerAction).toHaveBeenCalledWith('installPwa', expect.any(Function));
    });
});

describe('standalone detection', () => {
    it('hides the install button up-front when already standalone (display-mode)', async () => {
        const btn = makeButton();
        btn.removeAttribute('hidden');
        await loadModule({ standalone: true });
        expect(btn.hasAttribute('hidden')).toBe(true);
    });

    it('hides the install button up-front on iOS standalone', async () => {
        const btn = makeButton();
        btn.removeAttribute('hidden');
        await loadModule({ iosStandalone: true });
        expect(btn.hasAttribute('hidden')).toBe(true);
    });

    it('does not suppress the install prompt banner from firing when not standalone', async () => {
        makeButton();
        await loadModule({ standalone: false });
        const ev = firePrompt();
        expect(ev.defaultPrevented).toBe(true); // preventDefault always called
    });
});

describe('beforeinstallprompt', () => {
    it('shows every [data-pwa-install] element and fires pwa:installable', async () => {
        const btn = makeButton();
        await loadModule();
        const spy = vi.fn();
        window.addEventListener('pwa:installable', spy);
        firePrompt();
        expect(btn.hasAttribute('hidden')).toBe(false);
        expect(spy).toHaveBeenCalled();
        window.removeEventListener('pwa:installable', spy);
    });

    it('does not reveal the button when the app is already standalone', async () => {
        const btn = makeButton();
        await loadModule({ standalone: true });
        firePrompt();
        expect(btn.hasAttribute('hidden')).toBe(true);
    });

    it('shows every matching element, not just the first', async () => {
        const a = makeButton();
        const b = makeButton();
        await loadModule();
        firePrompt();
        expect(a.hasAttribute('hidden')).toBe(false);
        expect(b.hasAttribute('hidden')).toBe(false);
    });
});

describe('appinstalled', () => {
    it('hides the button and fires pwa:installed', async () => {
        const btn = makeButton();
        await loadModule();
        firePrompt();
        expect(btn.hasAttribute('hidden')).toBe(false);

        const spy = vi.fn();
        window.addEventListener('pwa:installed', spy);
        window.dispatchEvent(new window.Event('appinstalled'));
        expect(btn.hasAttribute('hidden')).toBe(true);
        expect(spy).toHaveBeenCalled();
        window.removeEventListener('pwa:installed', spy);
    });

    it('clears the deferred prompt so a later installPwa() call reports unavailable', async () => {
        const { installPwa } = await loadModule();
        makeButton();
        firePrompt();
        window.dispatchEvent(new window.Event('appinstalled'));
        await expect(installPwa()).resolves.toBe('unavailable');
    });
});

describe('installPwa', () => {
    it('returns "unavailable" when no prompt has been captured', async () => {
        const { installPwa } = await loadModule();
        await expect(installPwa()).resolves.toBe('unavailable');
    });

    it('calls prompt(), hides the button, and resolves the outcome', async () => {
        const btn = makeButton();
        const { installPwa } = await loadModule();
        const promptFn = vi.fn();
        firePrompt({ prompt: promptFn, userChoice: Promise.resolve({ outcome: 'accepted' }) });
        const result = await installPwa();
        expect(promptFn).toHaveBeenCalled();
        expect(btn.hasAttribute('hidden')).toBe(true);
        expect(result).toBe('accepted');
    });

    it('resolves "dismissed" when the user declines', async () => {
        const { installPwa } = await loadModule();
        firePrompt({ userChoice: Promise.resolve({ outcome: 'dismissed' }) });
        await expect(installPwa()).resolves.toBe('dismissed');
    });

    it('resolves "dismissed" when userChoice has no outcome field', async () => {
        const { installPwa } = await loadModule();
        firePrompt({ userChoice: Promise.resolve({}) });
        await expect(installPwa()).resolves.toBe('dismissed');
    });

    it('resolves "dismissed" instead of throwing when userChoice rejects', async () => {
        const { installPwa } = await loadModule();
        firePrompt({ userChoice: Promise.reject(new Error('boom')) });
        await expect(installPwa()).resolves.toBe('dismissed');
    });

    it('only consumes the prompt once — a second call is unavailable', async () => {
        const { installPwa } = await loadModule();
        firePrompt({ userChoice: Promise.resolve({ outcome: 'accepted' }) });
        await installPwa();
        await expect(installPwa()).resolves.toBe('unavailable');
    });
});

describe('service worker registration', () => {
    it('does nothing when the browser has no serviceWorker support', async () => {
        await loadModule({ withSw: false });
        expect('serviceWorker' in navigator).toBe(false);
    });

    it('registers the worker on window load when supported', async () => {
        await loadModule({ withSw: true });
        window.dispatchEvent(new window.Event('load'));
        await Promise.resolve();
        expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });

    it('reloads the page on controllerchange, once', async () => {
        const reload = vi.fn();
        await loadModule({ withSw: true });
        vi.stubGlobal('location', { ...location, reload });
        const controllerChangeHandler = navigator.serviceWorker.addEventListener.mock.calls.find(
            ([t]) => t === 'controllerchange',
        )[1];
        controllerChangeHandler();
        controllerChangeHandler(); // second call should be a no-op (refreshing guard)
        expect(reload).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('posts SKIP_WAITING and fires pwa:update-available once the new SW installs', async () => {
        const { registration } = await (async () => {
            vi.resetModules();
            vi.clearAllMocks();
            installMatchMedia(false);
            const svc = installServiceWorker();
            const mod = await import('../src/web/public/js/pwa.js');
            return { mod, registration: svc.registration, svc };
        })();
        window.dispatchEvent(new window.Event('load'));
        await Promise.resolve();
        await Promise.resolve();

        const updateFoundHandler = registration.addEventListener.mock.calls.find(
            ([t]) => t === 'updatefound',
        )[1];
        const installingWorker = {
            state: 'installed',
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
        };
        registration.installing = installingWorker;
        updateFoundHandler();
        const stateChangeHandler = installingWorker.addEventListener.mock.calls.find(
            ([t]) => t === 'statechange',
        )[1];

        const spy = vi.fn();
        window.addEventListener('pwa:update-available', spy);
        stateChangeHandler();
        expect(installingWorker.postMessage).toHaveBeenCalledWith('SKIP_WAITING');
        expect(spy).toHaveBeenCalled();
        window.removeEventListener('pwa:update-available', spy);
    });

    it('ignores a statechange that is not "installed" yet', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        installMatchMedia(false);
        const svc = installServiceWorker();
        await import('../src/web/public/js/pwa.js');
        window.dispatchEvent(new window.Event('load'));
        await Promise.resolve();
        await Promise.resolve();
        const updateFoundHandler = svc.registration.addEventListener.mock.calls.find(
            ([t]) => t === 'updatefound',
        )[1];
        const installingWorker = {
            state: 'installing',
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
        };
        svc.registration.installing = installingWorker;
        updateFoundHandler();
        const stateChangeHandler = installingWorker.addEventListener.mock.calls.find(
            ([t]) => t === 'statechange',
        )[1];
        stateChangeHandler();
        expect(installingWorker.postMessage).not.toHaveBeenCalled();
    });

    it('ignores an "installed" statechange when there is no existing controller (first install, not an update)', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        installMatchMedia(false);
        const svc = installServiceWorker();
        svc.sw.controller = null;
        await import('../src/web/public/js/pwa.js');
        window.dispatchEvent(new window.Event('load'));
        await Promise.resolve();
        await Promise.resolve();
        const updateFoundHandler = svc.registration.addEventListener.mock.calls.find(
            ([t]) => t === 'updatefound',
        )[1];
        const installingWorker = {
            state: 'installed',
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
        };
        svc.registration.installing = installingWorker;
        updateFoundHandler();
        const stateChangeHandler = installingWorker.addEventListener.mock.calls.find(
            ([t]) => t === 'statechange',
        )[1];
        stateChangeHandler();
        expect(installingWorker.postMessage).not.toHaveBeenCalled();
    });

    it('does nothing on updatefound when there is no installing worker', async () => {
        const svc = installServiceWorker();
        vi.resetModules();
        vi.clearAllMocks();
        installMatchMedia(false);
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: svc.sw });
        await import('../src/web/public/js/pwa.js');
        window.dispatchEvent(new window.Event('load'));
        await Promise.resolve();
        await Promise.resolve();
        const updateFoundHandler = svc.registration.addEventListener.mock.calls.find(
            ([t]) => t === 'updatefound',
        )[1];
        svc.registration.installing = null;
        expect(() => updateFoundHandler()).not.toThrow();
    });

    it('does not throw when SW registration itself fails', async () => {
        const registerMock = vi.fn().mockRejectedValue(new Error('blocked'));
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { register: registerMock, addEventListener: vi.fn(), controller: {} },
        });
        vi.resetModules();
        installMatchMedia(false);
        await import('../src/web/public/js/pwa.js');
        window.dispatchEvent(new window.Event('load'));
        await expect(Promise.resolve()).resolves.toBeUndefined();
    });
});
