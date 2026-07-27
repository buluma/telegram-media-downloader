// @vitest-environment jsdom
//
// Covers src/web/public/js/onboarding-dismiss.js — the "Hide for now" ✕
// button injected onto the onboarding banner. This module doesn't own
// the banner's render cycle, so tests build the banner markup manually
// (mirroring onboarding.js's structure) and drive the subscribe
// callback directly.
//
// monitor-status.js is mocked. localStorage uses the real jsdom
// implementation (tests/setup.js already polyfills it).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const subscribe = vi.fn();
vi.mock('../src/web/public/js/monitor-status.js', () => ({ subscribe }));

function makeBanner({ title = 'Step 1 of 3', hidden = false } = {}) {
    document.body.innerHTML = `
        <div id="onboarding-banner" class="${hidden ? 'hidden' : ''}">
            <div class="max-w-5xl mx-auto flex items-start gap-3">
                <div class="flex-1 min-w-0">
                    <div class="font-semibold">${title}</div>
                </div>
            </div>
        </div>`;
    return document.getElementById('onboarding-banner');
}

beforeEach(() => localStorage.clear());

async function loadModule() {
    vi.resetModules();
    vi.clearAllMocks();
    let onPush;
    subscribe.mockImplementation((fn) => {
        onPush = fn;
    });
    const mod = await import('../src/web/public/js/onboarding-dismiss.js');
    return { ...mod, push: () => onPush() };
}

describe('initOnboardingDismiss', () => {
    it('subscribes to monitor-status pushes', async () => {
        const { initOnboardingDismiss } = await loadModule();
        initOnboardingDismiss();
        expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('does nothing (no throw) when the banner element is absent', async () => {
        document.body.innerHTML = '';
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        expect(() => push()).not.toThrow();
    });
});

describe('injectInto (via push)', () => {
    it('does not inject a dismiss button when the banner is hidden', async () => {
        const banner = makeBanner({ hidden: true });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        expect(banner.querySelector('#onboarding-dismiss')).toBeNull();
    });

    it('injects a dismiss button onto a visible banner', async () => {
        const banner = makeBanner();
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        expect(banner.querySelector('#onboarding-dismiss')).not.toBeNull();
    });

    it('adds pr-9 to the inner wrapper to reserve space for the button', async () => {
        const banner = makeBanner();
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        expect(banner.firstElementChild.classList.contains('pr-9')).toBe(true);
    });

    it('does not add pr-9 twice on repeated pushes', async () => {
        const banner = makeBanner();
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        push();
        const classes = [...banner.firstElementChild.classList].filter((c) => c === 'pr-9');
        expect(classes).toHaveLength(1);
    });

    it('does not duplicate the button across repeated pushes', async () => {
        const banner = makeBanner();
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        push();
        expect(banner.querySelectorAll('#onboarding-dismiss')).toHaveLength(1);
    });

    it('hides the banner immediately on push when already dismissed for this exact title', async () => {
        localStorage.setItem('onboarding-dismissed', 'Step 1 of 3');
        const banner = makeBanner({ title: 'Step 1 of 3' });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        expect(banner.classList.contains('hidden')).toBe(true);
        expect(banner.querySelector('#onboarding-dismiss')).toBeNull();
    });

    it('shows the banner again once the title has moved on to a new step', async () => {
        localStorage.setItem('onboarding-dismissed', 'Step 1 of 3');
        const banner = makeBanner({ title: 'Step 2 of 3' });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        expect(banner.classList.contains('hidden')).toBe(false);
        expect(banner.querySelector('#onboarding-dismiss')).not.toBeNull();
    });

    it('handles a banner with no title element gracefully', async () => {
        document.body.innerHTML = '<div id="onboarding-banner"><div></div></div>';
        const banner = document.getElementById('onboarding-banner');
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        expect(() => push()).not.toThrow();
        expect(banner.querySelector('#onboarding-dismiss')).not.toBeNull();
    });
});

describe('dismiss click', () => {
    it('stores the exact title text and hides the banner', async () => {
        const banner = makeBanner({ title: 'Step 3 of 3' });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        banner.querySelector('#onboarding-dismiss').click();
        expect(banner.classList.contains('hidden')).toBe(true);
        expect(localStorage.getItem('onboarding-dismissed')).toBe('Step 3 of 3');
    });

    it('a push right after dismissal is a no-op — injectInto bails on the hidden class before touching the button', async () => {
        // The button itself isn't removed by dismissal; it only disappears
        // once onboarding.js's own render cycle wipes the banner's innerHTML
        // (not simulated here). This pins that a subsequent push doesn't
        // duplicate the button or otherwise touch the now-hidden banner.
        const banner = makeBanner({ title: 'Step 3 of 3' });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        banner.querySelector('#onboarding-dismiss').click();
        push();
        expect(banner.querySelectorAll('#onboarding-dismiss')).toHaveLength(1);
        expect(banner.classList.contains('hidden')).toBe(true);
    });

    it('does not persist dismissal when the title text is empty', async () => {
        document.body.innerHTML =
            '<div id="onboarding-banner"><div class="font-semibold"></div></div>';
        const banner = document.getElementById('onboarding-banner');
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        banner.querySelector('#onboarding-dismiss').click();
        expect(localStorage.getItem('onboarding-dismissed')).toBeNull();
        expect(banner.classList.contains('hidden')).toBe(true);
    });
});

describe('localStorage failure resilience', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('degrades silently to in-memory when setItem throws (private mode / quota)', async () => {
        const banner = makeBanner({ title: 'Step 1 of 3' });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        push();
        const origSetItem = localStorage.setItem;
        localStorage.setItem = () => {
            throw new Error('quota exceeded');
        };
        expect(() => banner.querySelector('#onboarding-dismiss').click()).not.toThrow();
        expect(banner.classList.contains('hidden')).toBe(true);
        localStorage.setItem = origSetItem;
    });

    it('treats a getItem failure as "not dismissed" instead of throwing', async () => {
        const origGetItem = localStorage.getItem;
        localStorage.getItem = () => {
            throw new Error('blocked');
        };
        const banner = makeBanner({ title: 'Step 1 of 3' });
        const { initOnboardingDismiss, push } = await loadModule();
        initOnboardingDismiss();
        expect(() => push()).not.toThrow();
        expect(banner.querySelector('#onboarding-dismiss')).not.toBeNull();
        localStorage.getItem = origGetItem;
    });
});
