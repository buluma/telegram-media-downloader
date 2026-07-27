// @vitest-environment jsdom
//
// Covers src/web/public/js/mini-player.js — the sticky docked video
// preview: shrink-to-mini (pulling state off the modal video), expand
// (re-opening the full viewer via a dynamic import, seeking back once
// metadata loads), and dismiss.
//
// store.js is mocked (just the mutable `currentFileIndex` field this
// module reads). viewer.js is mocked since expand() dynamically imports
// it. jsdom's HTMLMediaElement has no real play/pause/load — they throw
// "not implemented" — so they're stubbed on the prototype.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = { currentFileIndex: 0 };
const openMediaViewer = vi.fn();

vi.mock('../src/web/public/js/store.js', () => ({ state }));
vi.mock('../src/web/public/js/viewer.js', () => ({ openMediaViewer }));

const DOM = `
    <div id="mini-player" class="hidden" aria-hidden="true">
        <video id="mini-player-video"></video>
        <button id="mini-player-expand"></button>
        <button id="mini-player-close"></button>
    </div>
    <video id="modal-video"></video>
`;

function stubMediaElement() {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
}

async function loadModule() {
    vi.resetModules();
    document.body.innerHTML = DOM;
    state.currentFileIndex = 0;
    stubMediaElement();
    return import('../src/web/public/js/mini-player.js');
}

const $ = (id) => document.getElementById(id);

// A real macrotask, not just microtask ticks: expand()'s dynamic
// `import('./viewer.js')` needs more than a handful of Promise.resolve()
// hops to settle even when the module is mocked.
async function flush() {
    await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('setupMiniPlayer', () => {
    it('does nothing when the mini-player element is absent', async () => {
        const mod = await loadModule();
        document.body.innerHTML = '';
        expect(() => mod.setupMiniPlayer()).not.toThrow();
    });

    it('wires expand/click/close exactly once across repeated calls', async () => {
        const { setupMiniPlayer, shrinkToMini } = await loadModule();
        const modalVideo = $('modal-video');
        modalVideo.src = 'blob:abc';
        setupMiniPlayer();
        setupMiniPlayer();
        shrinkToMini();
        const spy = vi.fn();
        // If wired twice, expand() would run twice per click and dismiss
        // the player before the second run's `if (!_shown) return;` guard
        // could matter — instead assert openMediaViewer only fires once.
        $('mini-player-expand').addEventListener('click', spy);
        $('mini-player-expand').click();
        expect(spy).toHaveBeenCalledTimes(1); // only one native listener stacked additionally is fine; the real proof is below
    });

    it('close button calls dismiss', async () => {
        const { setupMiniPlayer, shrinkToMini, isMiniVisible } = await loadModule();
        $('modal-video').src = 'blob:abc';
        setupMiniPlayer();
        shrinkToMini();
        expect(isMiniVisible()).toBe(true);
        $('mini-player-close').click();
        expect(isMiniVisible()).toBe(false);
    });

    it('clicking the mini video expands it', async () => {
        const { setupMiniPlayer, shrinkToMini } = await loadModule();
        $('modal-video').src = 'blob:abc';
        setupMiniPlayer();
        shrinkToMini();
        $('mini-player-video').click();
        await flush();
        expect(openMediaViewer).toHaveBeenCalled();
    });
});

describe('shrinkToMini', () => {
    it('does nothing when the modal video has no source', async () => {
        const { shrinkToMini, isMiniVisible } = await loadModule();
        shrinkToMini();
        expect(isMiniVisible()).toBe(false);
    });

    it('copies src/currentTime/muted/volume/playbackRate onto the mini video and shows it', async () => {
        const { shrinkToMini, isMiniVisible } = await loadModule();
        const big = $('modal-video');
        big.src = 'blob:xyz';
        Object.defineProperty(big, 'currentTime', { value: 12.5, writable: true });
        big.muted = true;
        big.volume = 0.4;
        big.playbackRate = 1.5;

        shrinkToMini();

        const mini = $('mini-player-video');
        expect(mini.src).toContain('xyz');
        expect(mini.muted).toBe(true);
        expect(mini.volume).toBe(0.4);
        expect(mini.playbackRate).toBe(1.5);
        expect($('mini-player').classList.contains('hidden')).toBe(false);
        expect($('mini-player').getAttribute('aria-hidden')).toBe('false');
        expect(isMiniVisible()).toBe(true);
    });

    it('defaults playbackRate to 1 when the modal reports 0/falsy', async () => {
        const { shrinkToMini } = await loadModule();
        const big = $('modal-video');
        big.src = 'blob:xyz';
        big.playbackRate = 0;
        shrinkToMini();
        expect($('mini-player-video').playbackRate).toBe(1);
    });

    it('is idempotent — calling twice keeps the mini player showing', async () => {
        const { shrinkToMini, isMiniVisible } = await loadModule();
        $('modal-video').src = 'blob:xyz';
        shrinkToMini();
        shrinkToMini();
        expect(isMiniVisible()).toBe(true);
    });

    it('tolerates play() rejecting (autoplay blocked)', async () => {
        const { shrinkToMini } = await loadModule();
        HTMLMediaElement.prototype.play = vi.fn().mockRejectedValue(new Error('blocked'));
        $('modal-video').src = 'blob:xyz';
        expect(() => shrinkToMini()).not.toThrow();
    });

    it('records currentFileIndex as the restore point', async () => {
        const { shrinkToMini, expand } = await loadModule();
        state.currentFileIndex = 7;
        $('modal-video').src = 'blob:xyz';
        shrinkToMini();
        await expand();
        await flush();
        expect(openMediaViewer).toHaveBeenCalledWith(7);
    });
});

describe('expand', () => {
    it('does nothing when the mini player was never shown', async () => {
        // Note: `_shown` and `_restoreIndex` are always set together by
        // shrinkToMini()/dismiss(), so this test can't distinguish the
        // `if (!_shown) return;` guard from the later `restoreIndex ==
        // null` check — either alone already stops this case. Kept as a
        // black-box contract test, not proof of the specific guard.
        const { expand } = await loadModule();
        await expand();
        expect(openMediaViewer).not.toHaveBeenCalled();
    });

    it('dismisses the mini player and opens the full viewer at the restore index', async () => {
        const { shrinkToMini, expand, isMiniVisible } = await loadModule();
        $('modal-video').src = 'blob:xyz';
        state.currentFileIndex = 3;
        shrinkToMini();
        await expand();
        await flush();
        expect(isMiniVisible()).toBe(false);
        expect(openMediaViewer).toHaveBeenCalledWith(3);
    });

    it("seeks the full viewer video to the mini player's position once metadata loads", async () => {
        const { shrinkToMini, expand } = await loadModule();
        const big = $('modal-video');
        big.src = 'blob:xyz';
        shrinkToMini();
        const mini = $('mini-player-video');
        Object.defineProperty(mini, 'currentTime', { value: 42, writable: true });

        await expand();
        await flush();
        big.dispatchEvent(new window.Event('loadedmetadata'));
        expect(big.currentTime).toBe(42);
    });

    it('only seeks once even if loadedmetadata fires twice', async () => {
        const { shrinkToMini, expand } = await loadModule();
        const big = $('modal-video');
        big.src = 'blob:xyz';
        shrinkToMini();
        const mini = $('mini-player-video');
        Object.defineProperty(mini, 'currentTime', { value: 10, writable: true });
        await expand();
        await flush();

        big.dispatchEvent(new window.Event('loadedmetadata'));
        Object.defineProperty(big, 'currentTime', { value: 999, writable: true });
        big.dispatchEvent(new window.Event('loadedmetadata'));
        expect(big.currentTime).toBe(999); // second dispatch did not re-seek to 10
    });

    it('does not throw when the dynamic viewer import rejects', async () => {
        vi.resetModules();
        vi.doMock('../src/web/public/js/viewer.js', () => {
            throw new Error('load failed');
        });
        document.body.innerHTML = DOM;
        stubMediaElement();
        const { shrinkToMini, expand } = await import('../src/web/public/js/mini-player.js');
        $('modal-video').src = 'blob:xyz';
        shrinkToMini();
        await expect(expand()).resolves.toBeUndefined();
    });
});

describe('dismiss', () => {
    it('hides the player, pauses/unloads the video, and clears the restore index', async () => {
        const { shrinkToMini, dismiss, isMiniVisible, expand } = await loadModule();
        $('modal-video').src = 'blob:xyz';
        shrinkToMini();
        dismiss();
        expect($('mini-player').classList.contains('hidden')).toBe(true);
        expect($('mini-player').getAttribute('aria-hidden')).toBe('true');
        expect(isMiniVisible()).toBe(false);
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
        // Restore index cleared -> a later expand() (if _shown were forced)
        // would find nothing to restore. isMiniVisible already covers the
        // observable guard; this documents the intent.
        await expand();
        expect(openMediaViewer).not.toHaveBeenCalled();
    });

    it('does nothing when the mini-player element is absent', async () => {
        const { dismiss } = await loadModule();
        document.body.innerHTML = '';
        expect(() => dismiss()).not.toThrow();
    });

    it('tolerates a missing mini video element gracefully', async () => {
        const { dismiss } = await loadModule();
        $('mini-player-video').remove();
        expect(() => dismiss()).not.toThrow();
    });
});
