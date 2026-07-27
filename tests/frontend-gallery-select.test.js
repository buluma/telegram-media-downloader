// @vitest-environment jsdom
//
// Covers src/web/public/js/gallery-select.js — the gallery picker
// (click / ctrl-click / shift-range / lasso / long-press / keyboard).
//
// This is the first test in the suite to use jsdom. Every other frontend
// test targets pure functions and hand-stubs the two or three DOM calls
// they make; this module is DOM all the way down — `closest`, `classList`,
// `querySelectorAll`, pointer capture, live rects — so a hand-rolled fake
// would be larger than the module under test and would mostly assert
// itself. The environment is scoped to this file by the docblock above,
// so the rest of the suite still runs in plain Node.
//
// Two jsdom gaps are papered over locally:
//   - No PointerEvent constructor → pointer events are dispatched as
//     MouseEvents with `pointerType` / `pointerId` defined on them. The
//     listeners only read those two fields plus the MouseEvent ones.
//   - getBoundingClientRect always returns zeros → `layoutTiles()` stamps
//     a real grid layout onto each tile so the lasso hit-test has
//     something to intersect.

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';

let mod;
let state;

// Hooks are swapped per-test through this indirection: setupGallerySelect
// captures its `hooks` object once (it is deliberately idempotent), so the
// object identity has to stay stable for the whole file.
const hooks = {};
const onChange = () => hooks.onChange?.();
const openViewer = (p) => hooks.openViewer?.(p);
const deleteSelected = () => hooks.deleteSelected?.();

const TILE_W = 100;
const TILE_H = 100;
const COLS = 3;

/** Give every tile a deterministic rect: a COLS-wide grid of 100x100 cells. */
function layoutTiles() {
    const tiles = [...document.querySelectorAll('.media-item[data-path]')];
    tiles.forEach((t, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const left = col * TILE_W;
        const top = row * TILE_H;
        t.getBoundingClientRect = () => ({
            left,
            top,
            right: left + TILE_W,
            bottom: top + TILE_H,
            width: TILE_W,
            height: TILE_H,
            x: left,
            y: top,
        });
    });
    return tiles;
}

function renderTiles(paths) {
    const grid = document.getElementById('media-grid');
    grid.innerHTML = paths
        .map(
            (p) =>
                `<div class="media-item" data-path="${p}">` +
                `<span class="label">${p}</span>` +
                `<button data-tile-open>open</button>` +
                `</div>`,
        )
        .join('');
    return layoutTiles();
}

function tileFor(path) {
    return document.querySelector(`.media-item[data-path="${path}"]`);
}

function selectedPaths() {
    return [...document.querySelectorAll('.media-item.is-selected')].map((el) => el.dataset.path);
}

function click(target, opts = {}) {
    target.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, cancelable: true, ...opts }),
    );
}

/** Dispatch a pointer event MouseEvent-style with pointerType/pointerId attached. */
function pointer(type, target, { pointerType = 'mouse', pointerId = 1, ...opts } = {}) {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...opts });
    Object.defineProperty(ev, 'pointerType', { value: pointerType });
    Object.defineProperty(ev, 'pointerId', { value: pointerId });
    target.dispatchEvent(ev);
    return ev;
}

function key(k, opts = {}) {
    const target = opts.target || document.body;
    const ev = new window.KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...opts,
    });
    target.dispatchEvent(ev);
    return ev;
}

describe('gallery-select', () => {
    beforeAll(async () => {
        document.body.innerHTML = `
            <div id="media-grid"></div>
            <div id="gallery-lasso"></div>
            <button id="select-mode-btn"></button>
        `;
        mod = await import('../src/web/public/js/gallery-select.js');
        state = (await import('../src/web/public/js/store.js')).state;
        // Wired once for the whole file — the module is explicitly
        // idempotent and captures its grid element + hooks on first call.
        mod.setupGallerySelect({ onChange, openViewer, deleteSelected });
    });

    beforeEach(async () => {
        vi.useRealTimers();
        // A committed drag arms a click swallower that stays live for
        // TRAILING_CLICK_MS (touch fires its click well after pointerup).
        // Waiting that out would cost 350ms per test, so consume it instead:
        // the swallower unbinds itself on the first click it sees, and one
        // dispatched straight at `window` reaches the capture listener
        // without touching the grid's own delegated handler.
        await new Promise((r) => setTimeout(r, 0));
        window.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        // Leave no in-flight drag / long-press from a previous test.
        pointer('pointerup', window);
        // Module-level `_lastAnchorPath` survives between tests; exitSelectMode
        // is the only thing that clears it.
        mod.exitSelectMode();

        hooks.onChange = vi.fn();
        hooks.openViewer = vi.fn();
        hooks.deleteSelected = vi.fn();
        state.selected = new Set();
        state.selectMode = false;
        state.currentPage = 'viewer';
        document.getElementById('media-grid').className = '';
        document.getElementById('select-mode-btn').className = '';
        renderTiles(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg']);
        hooks.onChange.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('click: plain', () => {
        it('falls through to the viewer when select-mode is off', () => {
            const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
            tileFor('a.jpg').dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(false);
            expect(state.selected.size).toBe(0);
            expect(hooks.onChange).not.toHaveBeenCalled();
        });

        it('toggles the tile when select-mode is on', () => {
            state.selectMode = true;
            click(tileFor('a.jpg'));
            expect([...state.selected]).toEqual(['a.jpg']);
            expect(selectedPaths()).toEqual(['a.jpg']);
            expect(hooks.onChange).toHaveBeenCalledTimes(1);

            click(tileFor('a.jpg'));
            expect(state.selected.size).toBe(0);
            expect(selectedPaths()).toEqual([]);
        });

        it('ignores clicks that land outside a tile', () => {
            click(document.getElementById('media-grid'));
            expect(hooks.onChange).not.toHaveBeenCalled();
        });

        it('lets the tile-open button through even in select-mode', () => {
            state.selectMode = true;
            const btn = tileFor('a.jpg').querySelector('[data-tile-open]');
            const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
            btn.dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(false);
            expect(state.selected.size).toBe(0);
        });
    });

    describe('click: ctrl/cmd toggle', () => {
        it('auto-enables select-mode and toggles', () => {
            click(tileFor('b.jpg'), { ctrlKey: true });
            expect(state.selectMode).toBe(true);
            expect([...state.selected]).toEqual(['b.jpg']);
            expect(document.getElementById('media-grid').classList).toContain('in-select-mode');
            expect(document.getElementById('select-mode-btn').classList).toContain('bg-tg-blue');
        });

        it('treats metaKey the same as ctrlKey', () => {
            click(tileFor('b.jpg'), { metaKey: true });
            expect(state.selectMode).toBe(true);
            expect([...state.selected]).toEqual(['b.jpg']);
        });

        it('accumulates across tiles', () => {
            click(tileFor('a.jpg'), { ctrlKey: true });
            click(tileFor('c.jpg'), { ctrlKey: true });
            expect([...state.selected].sort()).toEqual(['a.jpg', 'c.jpg']);
        });

        it('intercepts the event so the viewer does not also open', () => {
            const ev = new window.MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
            });
            tileFor('a.jpg').dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(true);
        });

        it('fires even when the click lands on the tile-open button', () => {
            const btn = tileFor('a.jpg').querySelector('[data-tile-open]');
            click(btn, { ctrlKey: true });
            expect([...state.selected]).toEqual(['a.jpg']);
        });
    });

    describe('click: shift range', () => {
        it('selects the inclusive range from the last anchor', () => {
            click(tileFor('b.jpg'), { ctrlKey: true }); // anchor
            click(tileFor('e.jpg'), { shiftKey: true });
            expect([...state.selected].sort()).toEqual(['b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);
            expect(selectedPaths().sort()).toEqual(['b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);
        });

        it('works backwards from the anchor', () => {
            click(tileFor('e.jpg'), { ctrlKey: true });
            click(tileFor('c.jpg'), { shiftKey: true });
            expect([...state.selected].sort()).toEqual(['c.jpg', 'd.jpg', 'e.jpg']);
        });

        it('falls back to a plain toggle when there is no anchor yet', () => {
            state.selectMode = true;
            click(tileFor('c.jpg'), { shiftKey: true });
            expect([...state.selected]).toEqual(['c.jpg']);
        });

        it('adds to an existing selection rather than replacing it', () => {
            click(tileFor('a.jpg'), { ctrlKey: true });
            click(tileFor('d.jpg'), { ctrlKey: true }); // anchor moves to d
            click(tileFor('f.jpg'), { shiftKey: true });
            expect([...state.selected].sort()).toEqual(['a.jpg', 'd.jpg', 'e.jpg', 'f.jpg']);
        });

        it('does nothing when the anchor tile is no longer rendered', () => {
            click(tileFor('a.jpg'), { ctrlKey: true });
            renderTiles(['x.jpg', 'y.jpg']); // anchor a.jpg gone
            hooks.onChange.mockClear();
            click(tileFor('y.jpg'), { shiftKey: true });
            expect([...state.selected]).toEqual(['a.jpg']); // unchanged
        });
    });

    describe('lasso drag', () => {
        const drag = (from, to, opts = {}) => {
            const grid = document.getElementById('media-grid');
            pointer('pointerdown', grid, { clientX: from[0], clientY: from[1], ...opts });
            pointer('pointermove', window, { clientX: to[0], clientY: to[1] });
            pointer('pointerup', window, { clientX: to[0], clientY: to[1] });
        };

        it('selects every tile the rectangle overlaps', () => {
            // Rect (10,10)-(150,90) covers the first two tiles of row 0.
            drag([10, 10], [150, 90]);
            expect([...state.selected].sort()).toEqual(['a.jpg', 'b.jpg']);
            expect(selectedPaths().sort()).toEqual(['a.jpg', 'b.jpg']);
            expect(state.selectMode).toBe(true);
        });

        it('works when dragged up-and-left (normalised rectangle)', () => {
            drag([150, 90], [10, 10]);
            expect([...state.selected].sort()).toEqual(['a.jpg', 'b.jpg']);
        });

        it('replaces the previous selection on a plain drag', () => {
            click(tileFor('f.jpg'), { ctrlKey: true });
            drag([10, 10], [50, 50]);
            expect([...state.selected]).toEqual(['a.jpg']);
        });

        it('unions with the previous selection when ctrl is held', () => {
            click(tileFor('f.jpg'), { ctrlKey: true });
            drag([10, 10], [50, 50], { ctrlKey: true });
            expect([...state.selected].sort()).toEqual(['a.jpg', 'f.jpg']);
        });

        it('ignores a sub-threshold drag so a normal click still works', () => {
            drag([10, 10], [12, 12]);
            expect(state.selected.size).toBe(0);
            expect(state.selectMode).toBe(false);
        });

        it('clears the marquee outline after committing', () => {
            drag([10, 10], [150, 90]);
            expect(document.querySelectorAll('.is-marquee')).toHaveLength(0);
        });

        it('discards the selection on pointercancel', () => {
            const grid = document.getElementById('media-grid');
            pointer('pointerdown', grid, { clientX: 10, clientY: 10 });
            pointer('pointermove', window, { clientX: 150, clientY: 90 });
            pointer('pointercancel', window, { clientX: 150, clientY: 90 });
            expect(state.selected.size).toBe(0);
            expect(document.querySelectorAll('.is-marquee')).toHaveLength(0);
        });

        it('marks tiles live during the drag before commit', () => {
            const grid = document.getElementById('media-grid');
            pointer('pointerdown', grid, { clientX: 10, clientY: 10 });
            pointer('pointermove', window, { clientX: 150, clientY: 90 });
            expect(
                [...document.querySelectorAll('.is-marquee')].map((e) => e.dataset.path),
            ).toEqual(['a.jpg', 'b.jpg']);
            expect(state.selected.size).toBe(0); // not committed yet
            pointer('pointerup', window);
        });

        it('drives the lasso rectangle element', () => {
            const lasso = document.getElementById('gallery-lasso');
            const grid = document.getElementById('media-grid');
            pointer('pointerdown', grid, { clientX: 150, clientY: 90 });
            pointer('pointermove', window, { clientX: 10, clientY: 10 });
            expect(lasso.classList).toContain('visible');
            expect(lasso.style.left).toBe('10px');
            expect(lasso.style.top).toBe('10px');
            expect(lasso.style.width).toBe('140px');
            expect(lasso.style.height).toBe('80px');
            pointer('pointerup', window);
            expect(lasso.classList).not.toContain('visible');
        });

        it('does not start a lasso from a right-click', () => {
            drag([10, 10], [150, 90], { button: 2 });
            expect(state.selected.size).toBe(0);
        });

        it('does not start a lasso from a button inside a tile', () => {
            const btn = tileFor('a.jpg').querySelector('[data-tile-open]');
            pointer('pointerdown', btn, { clientX: 10, clientY: 10 });
            pointer('pointermove', window, { clientX: 150, clientY: 90 });
            pointer('pointerup', window, { clientX: 150, clientY: 90 });
            expect(state.selected.size).toBe(0);
        });

        it('swallows the trailing click so the release tile is not toggled', () => {
            drag([10, 10], [150, 90]);
            const before = [...state.selected];
            click(tileFor('b.jpg'));
            expect([...state.selected]).toEqual(before);
        });

        it('swallows a trailing click the browser delayed (touch click-delay)', () => {
            // On touch the click follows touchend, not pointerup, and can
            // trail it by up to ~300ms. A swallower disarmed on the next
            // macrotask loses that race and the release tile gets toggled.
            vi.useFakeTimers();
            drag([10, 10], [150, 90]);
            const before = [...state.selected];
            vi.advanceTimersByTime(250);
            click(tileFor('b.jpg'));
            vi.useRealTimers();
            expect([...state.selected]).toEqual(before);
        });

        it('stops swallowing once the trailing click has had its chance', () => {
            // When the click never arrives — drag released over empty space
            // — the swallower must not stay armed past its window and eat
            // whatever the user clicks next.
            vi.useFakeTimers();
            drag([10, 10], [150, 90]);
            vi.advanceTimersByTime(1000);
            vi.useRealTimers();

            state.selectMode = true;
            click(tileFor('e.jpg'));
            expect(state.selected.has('e.jpg')).toBe(true);
        });
    });

    describe('touch: long-press', () => {
        it('enters select-mode and selects the pressed tile after the hold', () => {
            vi.useFakeTimers();
            pointer('pointerdown', tileFor('c.jpg'), {
                pointerType: 'touch',
                clientX: 210,
                clientY: 10,
            });
            expect(state.selectMode).toBe(false); // not yet
            vi.advanceTimersByTime(500);
            expect(state.selectMode).toBe(true);
            expect([...state.selected]).toEqual(['c.jpg']);
            expect(hooks.onChange).toHaveBeenCalled();
        });

        it('keeps toggling tiles the finger crosses after the hold fires', () => {
            vi.useFakeTimers();
            pointer('pointerdown', tileFor('a.jpg'), {
                pointerType: 'touch',
                clientX: 50,
                clientY: 50,
            });
            vi.advanceTimersByTime(500);
            // Slide right across b then c.
            pointer('pointermove', window, { pointerType: 'touch', clientX: 150, clientY: 50 });
            pointer('pointermove', window, { pointerType: 'touch', clientX: 250, clientY: 50 });
            expect([...state.selected].sort()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
            pointer('pointerup', window, { pointerType: 'touch' });
        });

        it('is cancelled when the finger drifts before the timer fires (scroll)', () => {
            vi.useFakeTimers();
            pointer('pointerdown', tileFor('a.jpg'), {
                pointerType: 'touch',
                clientX: 50,
                clientY: 50,
            });
            pointer('pointermove', window, { pointerType: 'touch', clientX: 50, clientY: 90 });
            vi.advanceTimersByTime(500);
            expect(state.selectMode).toBe(false);
            expect(state.selected.size).toBe(0);
        });

        it('is cancelled by a second finger (pinch-zoom must not select)', () => {
            vi.useFakeTimers();
            pointer('pointerdown', tileFor('a.jpg'), {
                pointerType: 'touch',
                pointerId: 1,
                clientX: 50,
                clientY: 50,
            });
            pointer('pointerdown', tileFor('c.jpg'), {
                pointerType: 'touch',
                pointerId: 2,
                clientX: 250,
                clientY: 50,
            });
            vi.advanceTimersByTime(500);
            expect(state.selectMode).toBe(false);
            expect(state.selected.size).toBe(0);
            pointer('pointerup', window, { pointerType: 'touch', pointerId: 1 });
            pointer('pointerup', window, { pointerType: 'touch', pointerId: 2 });
        });

        it('is cancelled when the finger lifts before the hold completes', () => {
            vi.useFakeTimers();
            pointer('pointerdown', tileFor('a.jpg'), {
                pointerType: 'touch',
                clientX: 50,
                clientY: 50,
            });
            pointer('pointerup', window, { pointerType: 'touch' });
            vi.advanceTimersByTime(500);
            expect(state.selectMode).toBe(false);
        });

        it('does not arm on a button inside the tile', () => {
            vi.useFakeTimers();
            const btn = tileFor('a.jpg').querySelector('[data-tile-open]');
            pointer('pointerdown', btn, { pointerType: 'touch', clientX: 50, clientY: 50 });
            vi.advanceTimersByTime(500);
            expect(state.selectMode).toBe(false);
        });
    });

    describe('keyboard', () => {
        it('Ctrl/Cmd+A selects every rendered tile', () => {
            const ev = key('a', { ctrlKey: true });
            expect(ev.defaultPrevented).toBe(true);
            expect([...state.selected].sort()).toEqual([
                'a.jpg',
                'b.jpg',
                'c.jpg',
                'd.jpg',
                'e.jpg',
                'f.jpg',
            ]);
            expect(state.selectMode).toBe(true);
        });

        it('handles the uppercase key value too', () => {
            key('A', { metaKey: true });
            expect(state.selected.size).toBe(6);
        });

        it('ignores Ctrl+A when the gallery page is not showing', () => {
            state.currentPage = 'settings';
            const ev = key('a', { ctrlKey: true });
            expect(ev.defaultPrevented).toBe(false);
            expect(state.selected.size).toBe(0);
        });

        it('Escape exits select-mode and clears', () => {
            key('a', { ctrlKey: true });
            hooks.onChange.mockClear();
            const ev = key('Escape');
            expect(ev.defaultPrevented).toBe(true);
            expect(state.selectMode).toBe(false);
            expect(state.selected.size).toBe(0);
            expect(selectedPaths()).toEqual([]);
            expect(hooks.onChange).toHaveBeenCalledTimes(1);
        });

        it('leaves Escape alone when select-mode is off', () => {
            const ev = key('Escape');
            expect(ev.defaultPrevented).toBe(false);
        });

        it('Delete and Backspace trigger the bulk-delete hook', () => {
            for (const k of ['Delete', 'Backspace']) {
                state.selectMode = true;
                state.selected = new Set(['a.jpg']);
                hooks.deleteSelected.mockClear();
                const ev = key(k);
                expect(ev.defaultPrevented, k).toBe(true);
                expect(hooks.deleteSelected, k).toHaveBeenCalledTimes(1);
            }
        });

        it('does not delete on an empty selection', () => {
            state.selectMode = true;
            key('Delete');
            expect(hooks.deleteSelected).not.toHaveBeenCalled();
        });

        it('does not hijack keys while typing in a field', () => {
            const input = document.createElement('input');
            document.body.appendChild(input);
            const ev = key('a', { ctrlKey: true, target: input });
            expect(ev.defaultPrevented).toBe(false);
            expect(state.selected.size).toBe(0);
            input.remove();
        });

        it('does not hijack keys inside a contenteditable', () => {
            const div = document.createElement('div');
            div.contentEditable = 'true';
            // jsdom does not derive isContentEditable from the attribute.
            Object.defineProperty(div, 'isContentEditable', { value: true });
            document.body.appendChild(div);
            const ev = key('a', { ctrlKey: true, target: div });
            expect(ev.defaultPrevented).toBe(false);
            div.remove();
        });
    });

    describe('selectAllVisible', () => {
        it('selects every rendered tile and enables select-mode', () => {
            mod.selectAllVisible();
            expect(state.selectMode).toBe(true);
            expect(state.selected.size).toBe(6);
            expect(selectedPaths()).toHaveLength(6);
            expect(hooks.onChange).toHaveBeenCalledTimes(1);
        });

        it('is idempotent', () => {
            mod.selectAllVisible();
            const first = [...state.selected].sort();
            mod.selectAllVisible();
            expect([...state.selected].sort()).toEqual(first);
        });

        it('replaces a partial selection rather than merging a stale one', () => {
            state.selected = new Set(['gone.jpg']);
            mod.selectAllVisible();
            expect(state.selected.has('gone.jpg')).toBe(false);
        });
    });

    describe('exitSelectMode', () => {
        it('clears state, tile classes and the toolbar button', () => {
            mod.selectAllVisible();
            mod.exitSelectMode();
            expect(state.selectMode).toBe(false);
            expect(state.selected.size).toBe(0);
            expect(selectedPaths()).toEqual([]);
            expect(document.getElementById('media-grid').classList).not.toContain('in-select-mode');
            expect(document.getElementById('select-mode-btn').classList).not.toContain(
                'bg-tg-blue',
            );
        });

        it('clears any leftover marquee outlines', () => {
            tileFor('a.jpg').classList.add('is-marquee');
            mod.exitSelectMode();
            expect(document.querySelectorAll('.is-marquee')).toHaveLength(0);
        });

        it('drops the shift-range anchor so the next range needs a fresh one', () => {
            click(tileFor('a.jpg'), { ctrlKey: true });
            mod.exitSelectMode();
            state.selectMode = true;
            click(tileFor('d.jpg'), { shiftKey: true });
            expect([...state.selected]).toEqual(['d.jpg']); // toggle, not a range
        });
    });

    describe('repaintSelection', () => {
        it('paints tiles from state after a re-render', () => {
            state.selected = new Set(['b.jpg', 'd.jpg']);
            renderTiles(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
            expect(selectedPaths()).toEqual([]); // fresh DOM, no classes
            mod.repaintSelection();
            expect(selectedPaths()).toEqual(['b.jpg', 'd.jpg']);
        });

        it('removes classes for tiles no longer selected', () => {
            tileFor('a.jpg').classList.add('is-selected');
            state.selected = new Set(['b.jpg']);
            mod.repaintSelection();
            expect(selectedPaths()).toEqual(['b.jpg']);
        });

        it('syncs the grid select-mode class both ways', () => {
            state.selectMode = true;
            mod.repaintSelection();
            expect(document.getElementById('media-grid').classList).toContain('in-select-mode');
            state.selectMode = false;
            mod.repaintSelection();
            expect(document.getElementById('media-grid').classList).not.toContain('in-select-mode');
        });

        it('tolerates a null selection', () => {
            state.selected = null;
            expect(() => mod.repaintSelection()).not.toThrow();
            expect(selectedPaths()).toEqual([]);
        });
    });
});

describe('setupGallerySelect wiring guards', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
    });

    it('bails out when the grid is missing, and stays unwired', async () => {
        const fresh = await import('../src/web/public/js/gallery-select.js');
        expect(() => fresh.setupGallerySelect({})).not.toThrow();

        // Grid arrives later (page rendered after boot) — setup must still
        // be able to wire up, i.e. the early return did not set the flag.
        document.body.innerHTML = '<div id="media-grid"></div>';
        const grid = document.getElementById('media-grid');
        const spy = vi.spyOn(grid, 'addEventListener');
        fresh.setupGallerySelect({});
        expect(spy).toHaveBeenCalled();
    });

    it('is idempotent — a second call binds nothing new', async () => {
        document.body.innerHTML = '<div id="media-grid"></div>';
        const fresh = await import('../src/web/public/js/gallery-select.js');
        const grid = document.getElementById('media-grid');
        const spy = vi.spyOn(grid, 'addEventListener');
        fresh.setupGallerySelect({});
        const afterFirst = spy.mock.calls.length;
        fresh.setupGallerySelect({});
        expect(spy.mock.calls.length).toBe(afterFirst);
    });

    it('no-ops the exported helpers when the grid is absent', async () => {
        const fresh = await import('../src/web/public/js/gallery-select.js');
        expect(() => fresh.selectAllVisible()).not.toThrow();
        expect(() => fresh.repaintSelection()).not.toThrow();
        expect(() => fresh.exitSelectMode()).not.toThrow();
    });
});
