// @vitest-environment jsdom
//
// Covers src/web/public/js/transitions.js — the page-transition
// helper. REDUCED/DESKTOP are computed once at import time from
// window.matchMedia, so every test stubs matchMedia BEFORE importing
// and re-imports via vi.resetModules(). jsdom has no real
// Element.animate(), so it's stubbed per element with a controllable
// `finished` promise.

import { describe, it, expect, vi } from 'vitest';

function installMatchMedia({ reduced = false, desktop = true } = {}) {
    window.matchMedia = vi.fn((q) => ({
        matches: q.includes('prefers-reduced-motion') ? reduced : desktop,
    }));
}

function makeEl() {
    const el = document.createElement('div');
    el.classList.add('hidden');
    el.animate = vi.fn(() => ({ finished: Promise.resolve() }));
    return el;
}

async function loadModule(opts) {
    vi.resetModules();
    installMatchMedia(opts);
    return import('../src/web/public/js/transitions.js');
}

describe('reduced motion', () => {
    it('resolves immediately and skips animate() entirely when reduced motion is on', async () => {
        const { transitionViews } = await loadModule({ reduced: true });
        const from = makeEl();
        const to = makeEl();
        await transitionViews(from, to);
        expect(from.animate).not.toHaveBeenCalled();
        expect(to.animate).not.toHaveBeenCalled();
    });

    it('still un-hides `to` even when skipping the animation', async () => {
        const { transitionViews } = await loadModule({ reduced: true });
        const to = makeEl();
        await transitionViews(null, to);
        expect(to.classList.contains('hidden')).toBe(false);
    });

    it('resolves immediately with no `to` element at all under reduced motion', async () => {
        const { transitionViews } = await loadModule({ reduced: true });
        const from = makeEl();
        await expect(transitionViews(from, null)).resolves.toBeUndefined();
        expect(from.animate).not.toHaveBeenCalled();
    });
});

describe('normal motion — desktop (cross-fade)', () => {
    it('animates both from and to with opacity-only keyframes', async () => {
        const { transitionViews } = await loadModule({ reduced: false, desktop: true });
        const from = makeEl();
        const to = makeEl();
        await transitionViews(from, to);
        expect(from.animate).toHaveBeenCalledWith(
            [{ opacity: 1 }, { opacity: 0 }],
            expect.objectContaining({ duration: 180 }),
        );
        expect(to.animate).toHaveBeenCalledWith(
            [{ opacity: 0 }, { opacity: 1 }],
            expect.any(Object),
        );
    });

    it('un-hides `to` before animating it in', async () => {
        const { transitionViews } = await loadModule({ desktop: true });
        const to = makeEl();
        await transitionViews(null, to);
        expect(to.classList.contains('hidden')).toBe(false);
    });

    it('skips animating `from` when it is null', async () => {
        const { transitionViews } = await loadModule({ desktop: true });
        const to = makeEl();
        await transitionViews(null, to);
        expect(to.animate).toHaveBeenCalled();
    });

    it('skips animating `to` when it is null', async () => {
        const { transitionViews } = await loadModule({ desktop: true });
        const from = makeEl();
        await transitionViews(from, null);
        expect(from.animate).toHaveBeenCalled();
    });

    it('resolves even when one element rejects (allSettled, not all)', async () => {
        const { transitionViews } = await loadModule({ desktop: true });
        const from = makeEl();
        from.animate = vi.fn(() => ({ finished: Promise.reject(new Error('cancelled')) }));
        const to = makeEl();
        await expect(transitionViews(from, to)).resolves.toBeUndefined();
    });
});

describe('normal motion — mobile (horizontal slide)', () => {
    it('uses translate3d keyframes instead of opacity-only', async () => {
        const { transitionViews } = await loadModule({ desktop: false });
        const from = makeEl();
        const to = makeEl();
        await transitionViews(from, to);
        const [fromKeyframes] = from.animate.mock.calls[0];
        expect(fromKeyframes[0]).toEqual({ transform: 'translate3d(0,0,0)', opacity: 1 });
        expect(fromKeyframes[1].transform).toContain('translate3d(');
    });

    it('forward direction slides from negative to zero on `to`', async () => {
        const { transitionViews } = await loadModule({ desktop: false });
        const to = makeEl();
        await transitionViews(null, to, 'forward');
        const [toKeyframes] = to.animate.mock.calls[0];
        expect(toKeyframes[0].transform).toBe('translate3d(24px,0,0)');
        expect(toKeyframes[1].transform).toBe('translate3d(0,0,0)');
    });

    it('back direction flips the slide sign', async () => {
        const { transitionViews } = await loadModule({ desktop: false });
        const to = makeEl();
        await transitionViews(null, to, 'back');
        const [toKeyframes] = to.animate.mock.calls[0];
        expect(toKeyframes[0].transform).toBe('translate3d(-24px,0,0)');
    });
});

describe('animation options', () => {
    it('uses a 180ms duration, the shared easing curve, and fill: both', async () => {
        const { transitionViews } = await loadModule({ desktop: true });
        const from = makeEl();
        const to = makeEl();
        await transitionViews(from, to);
        const [, opts] = from.animate.mock.calls[0];
        expect(opts).toEqual({
            duration: 180,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
            fill: 'both',
        });
    });
});
