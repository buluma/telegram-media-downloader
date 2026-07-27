// @vitest-environment jsdom
//
// Covers src/web/public/js/onboarding.js — the onboarding banner driven
// by monitor-status's `hint` field: guest short-circuit, banner
// show/hide per hint key, the primary action button's per-step target
// (Settings scroll-to vs. Groups navigation), and refreshOnboarding()'s
// passthrough.
//
// monitor-status.js is mocked directly (subscribe/refreshNow) rather
// than modeled through its WS/api internals — this module only calls
// those two exports. i18n stays real for its synchronous fallback path.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const subscribe = vi.fn();
const refreshNow = vi.fn();
vi.mock('../src/web/public/js/monitor-status.js', () => ({ subscribe, refreshNow }));

async function loadModule({ role } = {}) {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<main></main>';
    if (role) document.body.dataset.role = role;
    else delete document.body.dataset.role;
    delete window.navigateTo;
    let applyStatus;
    subscribe.mockImplementation((fn) => {
        applyStatus = fn;
        return vi.fn();
    });
    const mod = await import('../src/web/public/js/onboarding.js');
    return { ...mod, push: (status) => applyStatus(status) };
}

const banner = () => document.getElementById('onboarding-banner');

describe('initOnboarding — guest short-circuit', () => {
    it('does not subscribe at all for the guest role', async () => {
        const { initOnboarding } = await loadModule({ role: 'guest' });
        initOnboarding();
        expect(subscribe).not.toHaveBeenCalled();
        expect(banner()).toBeNull();
    });

    it('subscribes normally for any other role', async () => {
        const { initOnboarding } = await loadModule({ role: 'admin' });
        initOnboarding();
        expect(subscribe).toHaveBeenCalledTimes(1);
    });
});

describe('initOnboarding — idempotency', () => {
    it('unsubscribes the previous subscription before resubscribing', async () => {
        const unsub1 = vi.fn();
        const unsub2 = vi.fn();
        subscribe.mockImplementationOnce(() => unsub1).mockImplementationOnce(() => unsub2);
        const { initOnboarding } = await loadModule();
        initOnboarding();
        initOnboarding();
        expect(unsub1).toHaveBeenCalled();
        expect(subscribe).toHaveBeenCalledTimes(2);
    });
});

describe('banner host placement', () => {
    it('inserts the host before <main> when present', async () => {
        const { initOnboarding, push } = await loadModule();
        initOnboarding();
        push({ hint: 'configure-api' });
        expect(banner().nextElementSibling.tagName).toBe('MAIN');
    });

    it('falls back to prepending to body when there is no <main>', async () => {
        document.body.innerHTML = '';
        const { initOnboarding, push } = await loadModule();
        document.body.innerHTML = ''; // loadModule() re-adds <main>; strip it again
        initOnboarding();
        push({ hint: 'configure-api' });
        expect(document.body.firstElementChild).toBe(banner());
    });
});

describe('render — hint handling', () => {
    it('hides the banner when the hint is null/absent', async () => {
        const { initOnboarding, push } = await loadModule();
        initOnboarding();
        push({ hint: 'configure-api' });
        expect(banner().classList.contains('hidden')).toBe(false);
        push({});
        expect(banner().classList.contains('hidden')).toBe(true);
    });

    it('hides the banner for an unrecognised hint key', async () => {
        const { initOnboarding, push } = await loadModule();
        initOnboarding();
        push({ hint: 'configure-api' });
        push({ hint: 'not-a-real-hint' });
        expect(banner().classList.contains('hidden')).toBe(true);
    });

    it('shows the step title, body, and action label for a known hint', async () => {
        const { initOnboarding, push } = await loadModule();
        initOnboarding();
        push({ hint: 'add-account' });
        expect(banner().textContent).toContain('Step 2 of 3');
        expect(banner().textContent).toContain('Add account');
    });
});

describe('primary action button', () => {
    it('configure-api: navigates to settings and scrolls to the API section', async () => {
        vi.useFakeTimers();
        const navigateTo = vi.fn();
        window.navigateTo = navigateTo;
        document.body.innerHTML += '<div id="setting-api-id"></div>';
        const { initOnboarding, push } = await loadModule();
        document.body.innerHTML += '<div id="setting-api-id"></div>';
        window.navigateTo = navigateTo;
        initOnboarding();
        push({ hint: 'configure-api' });
        const target = document.getElementById('setting-api-id');
        target.scrollIntoView = vi.fn();
        const scrollSpy = target.scrollIntoView;
        banner().querySelector('#onboarding-go').click();
        expect(navigateTo).toHaveBeenCalledWith('settings');
        vi.advanceTimersByTime(200);
        expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
        vi.useRealTimers();
    });

    it('add-account: navigates to settings with no scroll target throw when the section is missing', async () => {
        vi.useFakeTimers();
        window.navigateTo = vi.fn();
        const { initOnboarding, push } = await loadModule();
        window.navigateTo = vi.fn();
        initOnboarding();
        push({ hint: 'add-account' });
        banner().querySelector('#onboarding-go').click();
        expect(() => vi.advanceTimersByTime(200)).not.toThrow();
        vi.useRealTimers();
    });

    it('enable-group: navigates straight to the groups page instead of settings', async () => {
        const navigateTo = vi.fn();
        const { initOnboarding, push } = await loadModule();
        window.navigateTo = navigateTo;
        initOnboarding();
        push({ hint: 'enable-group' });
        banner().querySelector('#onboarding-go').click();
        expect(navigateTo).toHaveBeenCalledWith('groups');
    });

    it('does nothing (no throw) when window.navigateTo is not a function', async () => {
        const { initOnboarding, push } = await loadModule();
        initOnboarding();
        push({ hint: 'configure-api' });
        expect(() => banner().querySelector('#onboarding-go').click()).not.toThrow();
    });
});

describe('refreshOnboarding', () => {
    it('delegates to monitor-status refreshNow', async () => {
        const { refreshOnboarding } = await loadModule();
        refreshOnboarding();
        expect(refreshNow).toHaveBeenCalledTimes(1);
    });
});
