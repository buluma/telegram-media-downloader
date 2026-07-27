// @vitest-environment jsdom
//
// Covers src/web/public/js/gestures.js — long-press, pull-to-refresh,
// swipe and drag-to-dismiss.
//
// Each helper returns an unsubscribe function, and every one of them is
// exercised here: a gesture module that keeps listening after teardown is
// exactly the kind of bug that only shows up as "the second page load
// fires everything twice".
//
// jsdom has no PointerEvent constructor, so pointer events are dispatched
// as MouseEvents with pointerType/pointerId defined on them — the same
// approach as tests/frontend-gallery-select.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    attachLongPress,
    attachPullToRefresh,
    attachSwipe,
    attachDragDismiss,
} from '../src/web/public/js/gestures.js';

function pointer(type, target, { pointerType = 'touch', pointerId = 1, ...opts } = {}) {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...opts });
    Object.defineProperty(ev, 'pointerType', { value: pointerType });
    Object.defineProperty(ev, 'pointerId', { value: pointerId });
    target.dispatchEvent(ev);
    return ev;
}

describe('attachLongPress', () => {
    let host;
    let onLongPress;
    let off;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = `<div id="host"><div class="row" id="a">A</div></div>`;
        host = document.getElementById('host');
        onLongPress = vi.fn();
    });

    afterEach(() => {
        off?.();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('fires after the hold threshold', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { clientX: 10, clientY: 10 });
        vi.advanceTimersByTime(499);
        expect(onLongPress).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it('delegates to the matching child when a selector is given', () => {
        off = attachLongPress(host, { selector: '.row', onLongPress });
        pointer('pointerdown', document.getElementById('a'), { clientX: 0, clientY: 0 });
        vi.advanceTimersByTime(500);
        expect(onLongPress.mock.calls[0][0].id).toBe('a');
    });

    it('ignores a press that matches no child', () => {
        off = attachLongPress(host, { selector: '.nope', onLongPress });
        pointer('pointerdown', document.getElementById('a'));
        vi.advanceTimersByTime(500);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('cancels when the finger drifts past the tap distance', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { clientX: 0, clientY: 0 });
        pointer('pointermove', host, { clientX: 11, clientY: 0 });
        vi.advanceTimersByTime(500);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('tolerates small movement within the tap distance', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { clientX: 0, clientY: 0 });
        pointer('pointermove', host, { clientX: 5, clientY: 5 });
        vi.advanceTimersByTime(500);
        expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it('cancels when the press is released early', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { clientX: 0, clientY: 0 });
        pointer('pointerup', host);
        vi.advanceTimersByTime(500);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('cancels on pointercancel', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { clientX: 0, clientY: 0 });
        pointer('pointercancel', host);
        vi.advanceTimersByTime(500);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('ignores movement and release from a different finger', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { pointerId: 1, clientX: 0, clientY: 0 });
        pointer('pointermove', host, { pointerId: 2, clientX: 500, clientY: 500 });
        pointer('pointerup', host, { pointerId: 2 });
        vi.advanceTimersByTime(500);
        expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it('ignores non-primary mouse buttons', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { pointerType: 'mouse', button: 2 });
        vi.advanceTimersByTime(500);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('accepts a primary mouse press', () => {
        off = attachLongPress(host, { onLongPress });
        pointer('pointerdown', host, { pointerType: 'mouse', button: 0 });
        vi.advanceTimersByTime(500);
        expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it('survives a throwing handler', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        off = attachLongPress(host, {
            onLongPress: () => {
                throw new Error('boom');
            },
        });
        pointer('pointerdown', host, { clientX: 0, clientY: 0 });
        expect(() => vi.advanceTimersByTime(500)).not.toThrow();
        expect(err).toHaveBeenCalled();
    });

    it('suppresses the click that follows the long press', () => {
        off = attachLongPress(host, { selector: '.row', onLongPress });
        const row = document.getElementById('a');
        pointer('pointerdown', row, { clientX: 0, clientY: 0 });
        vi.advanceTimersByTime(500);

        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        row.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        // The marker is consumed, so the next click goes through.
        expect(row.dataset.longPressFired).toBeUndefined();

        const second = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        row.dispatchEvent(second);
        expect(second.defaultPrevented).toBe(false);
    });

    it('lets a normal click through when no long press fired', () => {
        off = attachLongPress(host, { selector: '.row', onLongPress });
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        document.getElementById('a').dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
    });

    it('stops listening after unsubscribe', () => {
        off = attachLongPress(host, { onLongPress });
        off();
        off = null;
        pointer('pointerdown', host, { clientX: 0, clientY: 0 });
        vi.advanceTimersByTime(500);
        expect(onLongPress).not.toHaveBeenCalled();
    });
});

describe('attachPullToRefresh', () => {
    let container;
    let onRefresh;
    let off;

    beforeEach(() => {
        document.body.innerHTML = `<div id="list"><p>row</p></div>`;
        container = document.getElementById('list');
        // jsdom has no layout; scrollTop is writable and defaults to 0.
        onRefresh = vi.fn(async () => {});
    });

    afterEach(() => {
        off?.();
        vi.restoreAllMocks();
    });

    const indicator = () => container.querySelector(':scope > .ptr-indicator');

    it('returns a no-op teardown when there is no container', () => {
        const teardown = attachPullToRefresh(null, { onRefresh });
        expect(() => teardown()).not.toThrow();
    });

    it('injects the indicator as the first child', () => {
        off = attachPullToRefresh(container, { onRefresh });
        expect(indicator()).not.toBeNull();
        expect(container.firstChild).toBe(indicator());
    });

    it('reuses an existing indicator instead of stacking them', () => {
        off = attachPullToRefresh(container, { onRefresh });
        const first = indicator();
        const off2 = attachPullToRefresh(container, { onRefresh });
        expect(container.querySelectorAll('.ptr-indicator')).toHaveLength(1);
        expect(indicator()).toBe(first);
        off2();
    });

    it('grows the indicator as the user drags down', () => {
        off = attachPullToRefresh(container, { onRefresh });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 40 });
        expect(indicator().style.height).toBe('40px');
    });

    it('caps the indicator height at the threshold', () => {
        off = attachPullToRefresh(container, { onRefresh, threshold: 70 });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 500 });
        expect(indicator().style.height).toBe('70px');
    });

    it('flips the arrow once past the threshold', () => {
        off = attachPullToRefresh(container, { onRefresh, threshold: 70 });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 50 });
        expect(indicator().firstChild.style.transform).toBe('rotate(0deg)');
        pointer('pointermove', container, { clientY: 90 });
        expect(indicator().firstChild.style.transform).toBe('rotate(180deg)');
    });

    it('claims the move event so the page does not scroll with it', () => {
        off = attachPullToRefresh(container, { onRefresh });
        pointer('pointerdown', container, { clientY: 0 });
        const ev = pointer('pointermove', container, { clientY: 40 });
        expect(ev.defaultPrevented).toBe(true);
    });

    it('does nothing when the list is already scrolled', () => {
        off = attachPullToRefresh(container, { onRefresh });
        container.scrollTop = 100;
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 200 });
        pointer('pointerup', container, { clientY: 200 });
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('aborts when the drag turns upward', () => {
        off = attachPullToRefresh(container, { onRefresh });
        pointer('pointerdown', container, { clientY: 50 });
        pointer('pointermove', container, { clientY: 20 });
        expect(indicator().style.height).toBe('0px');
        pointer('pointerup', container, { clientY: 20 });
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('refreshes on release past the threshold and restores afterwards', async () => {
        off = attachPullToRefresh(container, { onRefresh, threshold: 70 });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 100 });
        pointer('pointerup', container, { clientY: 100 });

        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(indicator().style.height).toBe('40px'); // spinner showing
        expect(indicator().innerHTML).toContain('Refreshing');

        await vi.waitFor(() => expect(indicator().style.height).toBe('0px'));
        expect(indicator().innerHTML).toContain('Pull to refresh');
    });

    it('restores the indicator even when the refresh rejects', async () => {
        off = attachPullToRefresh(container, {
            onRefresh: async () => {
                throw new Error('network');
            },
            threshold: 70,
        });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 100 });
        pointer('pointerup', container, { clientY: 100 });
        await vi.waitFor(() => expect(indicator().style.height).toBe('0px'));
    });

    it('snaps back without refreshing below the threshold', () => {
        off = attachPullToRefresh(container, { onRefresh, threshold: 70 });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 30 });
        pointer('pointerup', container, { clientY: 30 });
        expect(onRefresh).not.toHaveBeenCalled();
        expect(indicator().style.height).toBe('0px');
    });

    it('tolerates a missing onRefresh callback', () => {
        off = attachPullToRefresh(container, { threshold: 70 });
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 100 });
        expect(() => pointer('pointerup', container, { clientY: 100 })).not.toThrow();
    });

    it('stops listening after unsubscribe', () => {
        off = attachPullToRefresh(container, { onRefresh, threshold: 70 });
        off();
        off = null;
        pointer('pointerdown', container, { clientY: 0 });
        pointer('pointermove', container, { clientY: 100 });
        pointer('pointerup', container, { clientY: 100 });
        expect(onRefresh).not.toHaveBeenCalled();
    });
});

describe('attachSwipe', () => {
    let el;
    let onSwipe;
    let off;

    beforeEach(() => {
        document.body.innerHTML = `<div id="el"></div>`;
        el = document.getElementById('el');
        onSwipe = vi.fn();
    });

    afterEach(() => {
        off?.();
    });

    const swipe = (from, to, opts = {}) => {
        pointer('pointerdown', el, { clientX: from[0], clientY: from[1], ...opts });
        pointer('pointerup', el, { clientX: to[0], clientY: to[1], ...opts });
    };

    it('reports a left swipe with its signed distance', () => {
        off = attachSwipe(el, { onSwipe });
        swipe([200, 0], [100, 0]);
        expect(onSwipe).toHaveBeenCalledWith('left', -100);
    });

    it('reports a right swipe', () => {
        off = attachSwipe(el, { onSwipe });
        swipe([0, 0], [100, 0]);
        expect(onSwipe).toHaveBeenCalledWith('right', 100);
    });

    it('ignores a drag shorter than the threshold', () => {
        off = attachSwipe(el, { onSwipe, threshold: 60 });
        swipe([0, 0], [59, 0]);
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it('fires exactly at the threshold', () => {
        off = attachSwipe(el, { onSwipe, threshold: 60 });
        swipe([0, 0], [60, 0]);
        expect(onSwipe).toHaveBeenCalledWith('right', 60);
    });

    it('ignores a mostly-vertical drag', () => {
        off = attachSwipe(el, { onSwipe, threshold: 60 });
        swipe([0, 0], [70, 70]);
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it('honours a custom threshold', () => {
        off = attachSwipe(el, { onSwipe, threshold: 10 });
        swipe([0, 0], [20, 0]);
        expect(onSwipe).toHaveBeenCalledWith('right', 20);
    });

    it('ignores a release from a different finger', () => {
        off = attachSwipe(el, { onSwipe });
        pointer('pointerdown', el, { pointerId: 1, clientX: 0, clientY: 0 });
        pointer('pointerup', el, { pointerId: 2, clientX: 200, clientY: 0 });
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it('ignores a release with no matching press', () => {
        off = attachSwipe(el, { onSwipe });
        pointer('pointerup', el, { clientX: 200, clientY: 0 });
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it('ignores non-primary mouse buttons', () => {
        off = attachSwipe(el, { onSwipe });
        swipe([0, 0], [200, 0], { pointerType: 'mouse', button: 2 });
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it('does not fire twice for one gesture', () => {
        off = attachSwipe(el, { onSwipe });
        swipe([0, 0], [200, 0]);
        pointer('pointerup', el, { clientX: 400, clientY: 0 });
        expect(onSwipe).toHaveBeenCalledTimes(1);
    });

    it('treats pointercancel as the end of the gesture', () => {
        off = attachSwipe(el, { onSwipe });
        pointer('pointerdown', el, { clientX: 0, clientY: 0 });
        pointer('pointercancel', el, { clientX: 200, clientY: 0 });
        expect(onSwipe).toHaveBeenCalledWith('right', 200);
    });

    it('stops listening after unsubscribe', () => {
        off = attachSwipe(el, { onSwipe });
        off();
        off = null;
        swipe([0, 0], [200, 0]);
        expect(onSwipe).not.toHaveBeenCalled();
    });
});

describe('attachDragDismiss', () => {
    let el;
    let onDismiss;
    let off;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = `<div id="sheet"></div>`;
        el = document.getElementById('sheet');
        onDismiss = vi.fn();
    });

    afterEach(() => {
        off?.();
        vi.useRealTimers();
    });

    it('tracks the drag with a translateY', () => {
        off = attachDragDismiss(el, { onDismiss });
        pointer('pointerdown', el, { clientY: 0 });
        pointer('pointermove', el, { clientY: 50 });
        expect(el.style.transform).toBe('translateY(50px)');
    });

    it('disables the transition while dragging and restores it on release', () => {
        off = attachDragDismiss(el, { onDismiss });
        pointer('pointerdown', el, { clientY: 0 });
        expect(el.style.transition).toBe('none');
        pointer('pointerup', el, { clientY: 0 });
        expect(el.style.transition).toBe('');
    });

    it('clamps upward drags to zero', () => {
        off = attachDragDismiss(el, { onDismiss });
        pointer('pointerdown', el, { clientY: 100 });
        pointer('pointermove', el, { clientY: 20 });
        expect(el.style.transform).toBe('translateY(0px)');
    });

    it('dismisses after the exit animation when dragged past the threshold', () => {
        off = attachDragDismiss(el, { onDismiss, threshold: 80 });
        pointer('pointerdown', el, { clientY: 0 });
        pointer('pointermove', el, { clientY: 120 });
        pointer('pointerup', el, { clientY: 120 });

        expect(el.style.transform).toBe('translateY(100vh)');
        expect(onDismiss).not.toHaveBeenCalled(); // still animating
        vi.advanceTimersByTime(180);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('snaps back below the threshold', () => {
        off = attachDragDismiss(el, { onDismiss, threshold: 80 });
        pointer('pointerdown', el, { clientY: 0 });
        pointer('pointermove', el, { clientY: 30 });
        pointer('pointerup', el, { clientY: 30 });
        expect(el.style.transform).toBe('');
        vi.advanceTimersByTime(500);
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('ignores a different finger mid-drag', () => {
        off = attachDragDismiss(el, { onDismiss });
        pointer('pointerdown', el, { pointerId: 1, clientY: 0 });
        pointer('pointermove', el, { pointerId: 2, clientY: 200 });
        expect(el.style.transform).toBe('');
    });

    it('ignores non-primary mouse buttons', () => {
        off = attachDragDismiss(el, { onDismiss });
        pointer('pointerdown', el, { pointerType: 'mouse', button: 2, clientY: 0 });
        pointer('pointermove', el, { clientY: 200 });
        expect(el.style.transform).toBe('');
    });

    it('tolerates a missing onDismiss callback', () => {
        off = attachDragDismiss(el, { threshold: 80 });
        pointer('pointerdown', el, { clientY: 0 });
        pointer('pointermove', el, { clientY: 120 });
        pointer('pointerup', el, { clientY: 120 });
        expect(() => vi.advanceTimersByTime(180)).not.toThrow();
    });

    it('stops listening after unsubscribe', () => {
        off = attachDragDismiss(el, { onDismiss, threshold: 80 });
        off();
        off = null;
        pointer('pointerdown', el, { clientY: 0 });
        pointer('pointermove', el, { clientY: 200 });
        pointer('pointerup', el, { clientY: 200 });
        vi.advanceTimersByTime(180);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(el.style.transform).toBe('');
    });
});
