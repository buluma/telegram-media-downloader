// @vitest-environment jsdom
//
// Covers src/web/public/js/viewer.js — the media modal: the file-kind
// dispatcher and its ten preview containers, the metadata/pin/backup/AI
// furniture, review mode with its action toolbar and single-letter
// shortcuts, slideshow auto-advance, the document-level keyboard map, and
// the VideoPlayer class (load/unload, seeking, volume + speed persistence,
// the error auto-retry, buffered ranges and the sprite hover preview).
//
// tests/viewer-classifier.test.js already covers `_classifyFile` by carving
// the function out of the source text — that one is a drift guard and stays
// as it is. This file imports the real module.
//
// Harness notes:
//   - jsdom has no media pipeline, so HTMLMediaElement's play/pause/load and
//     the paused/duration/currentTime/buffered/readyState/error accessors are
//     stubbed onto the prototype with plain backing fields.
//   - Fullscreen, Picture-in-Picture and Image() are stubbed for the same
//     reason. Image instances are recorded so sprite-load callbacks can be
//     fired by hand.
//   - SUPPORTS_HOVER is computed once at module load from window.matchMedia.
//     jsdom has no matchMedia, which lands on the desktop branch; the touch
//     branch gets its own module instance with matchMedia defined.

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';

// ---- module mocks --------------------------------------------------------

const state = { files: [], currentFileIndex: 0, currentFilter: 'all' };
vi.mock('../src/web/public/js/store.js', () => ({ state }));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

const swipeOpts = { onSwipe: null, threshold: null };
const dismissOpts = { onDismiss: null, threshold: null };
const attachSwipe = vi.fn((_el, opts) => Object.assign(swipeOpts, opts));
const attachDragDismiss = vi.fn((_el, opts) => Object.assign(dismissOpts, opts));
vi.mock('../src/web/public/js/gestures.js', () => ({ attachSwipe, attachDragDismiss }));

let i18nDict = {};
const i18nT = vi.fn((key, fallback) => i18nDict[key] || fallback || key);
const i18nTf = vi.fn((key, vars, fallback) => {
    const tpl = i18nDict[key] || fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
});
vi.mock('../src/web/public/js/i18n.js', () => ({ t: i18nT, tf: i18nTf, applyToDOM: vi.fn() }));

const wsHandlers = new Map();
const ws = {
    on: vi.fn((type, fn) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, []);
        wsHandlers.get(type).push(fn);
    }),
};
vi.mock('../src/web/public/js/ws.js', () => ({ ws }));

// The three text renderers all fetch; stub them and keep the real
// langFromExt, which is what drives the "JavaScript" / "Python" type chip.
const renderTextInto = vi.fn();
const renderCodeInto = vi.fn();
const renderMarkdownInto = vi.fn();
vi.mock('../src/web/public/js/viewer-text.js', async (importOriginal) => ({
    ...(await importOriginal()),
    renderTextInto,
    renderCodeInto,
    renderMarkdownInto,
}));

const renderArchiveInto = vi.fn();
vi.mock('../src/web/public/js/viewer-archive.js', () => ({ renderArchiveInto }));

const openShareSheet = vi.fn();
vi.mock('../src/web/public/js/share.js', () => ({ openShareSheet }));

// ---- environment stubs ---------------------------------------------------

const images = [];
class FakeImage {
    constructor() {
        this.naturalWidth = 1600;
        this.naturalHeight = 90;
        images.push(this);
    }
    set src(v) {
        this._src = v;
    }
    get src() {
        return this._src;
    }
}

function defineMediaAccessor(name, fallback) {
    Object.defineProperty(window.HTMLMediaElement.prototype, name, {
        configurable: true,
        get() {
            return this[`_${name}`] === undefined ? fallback : this[`_${name}`];
        },
        set(v) {
            this[`_${name}`] = v;
        },
    });
}

beforeAll(() => {
    window.HTMLMediaElement.prototype.play = function () {
        this._paused = false;
        return playResult();
    };
    window.HTMLMediaElement.prototype.pause = function () {
        this._paused = true;
    };
    window.HTMLMediaElement.prototype.load = vi.fn();
    defineMediaAccessor('paused', true);
    defineMediaAccessor('ended', false);
    defineMediaAccessor('duration', Number.NaN);
    defineMediaAccessor('currentTime', 0);
    defineMediaAccessor('readyState', 0);
    defineMediaAccessor('error', null);
    defineMediaAccessor('buffered', { length: 0 });
    defineMediaAccessor('volume', 1);
    defineMediaAccessor('muted', false);
    defineMediaAccessor('playbackRate', 1);
    defineMediaAccessor('loop', false);
    defineMediaAccessor('currentSrc', '');

    window.HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(() => Promise.resolve());
    window.Element.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    globalThis.Image = FakeImage;
});

let playResult = () => Promise.resolve();

const $ = (id) => document.getElementById(id);

function setFullscreenElement(el) {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: el });
}
function setPipElement(el) {
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: el });
}
function setPipEnabled(on) {
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: on });
}

// ---- fixture -------------------------------------------------------------

const DOM = `
    <div id="media-modal" class="hidden">
        <span id="modal-counter"></span>
        <button id="modal-fullscreen-btn"></button>
        <button id="modal-close"></button>
        <button id="modal-prev"></button>
        <button id="modal-next"></button>
        <div id="modal-swipe">
            <div id="image-container" class="hidden"><img id="modal-image" /></div>
            <div id="video-container" class="hidden">
                <div id="video-tap-layer"></div>
                <video id="modal-video"></video>
                <div id="video-seek-back-overlay"><span id="video-seek-back-label"></span></div>
                <div id="video-seek-fwd-overlay"><span id="video-seek-fwd-label"></span></div>
                <button id="video-center-play"></button>
                <div id="video-spinner" class="hidden"></div>
                <div id="video-error" class="hidden"><span id="video-error-msg"></span>
                    <button id="video-retry-btn"></button></div>
                <div id="video-speed-menu" class="hidden">
                    <button class="speed-opt" data-speed="0.5"></button>
                    <button class="speed-opt" data-speed="1"></button>
                    <button class="speed-opt" data-speed="1.5"></button>
                    <button class="speed-opt" data-speed="2"></button>
                </div>
                <div id="video-controls">
                    <div id="video-progress-container">
                        <div id="video-buffered-layer"></div>
                        <div id="video-progress-fill"></div>
                        <div id="video-progress-dot"></div>
                        <div id="video-hover-time" class="hidden"></div>
                        <div id="video-sprite-preview" class="hidden">
                            <div id="video-sprite-frame"></div>
                            <div id="video-sprite-pending"></div>
                            <div id="video-sprite-time"></div>
                        </div>
                    </div>
                    <button id="video-play-btn"></button>
                    <button id="video-skip-back"></button>
                    <button id="video-skip-fwd"></button>
                    <button id="video-mute-btn"></button>
                    <input id="video-volume" type="range" min="0" max="1" step="0.01" />
                    <span id="video-current-time"></span>
                    <span id="video-duration"></span>
                    <button id="video-settings-btn"></button>
                    <button id="video-pip-btn"></button>
                    <button id="video-fullscreen-btn"></button>
                </div>
            </div>
            <div id="pdf-container" class="hidden"><iframe id="pdf-frame"></iframe></div>
            <div id="audio-container" class="hidden">
                <span id="audio-title"></span><span id="audio-meta"></span>
                <audio id="modal-audio"></audio>
            </div>
            <div id="text-container" class="hidden">
                <button id="text-wrap-toggle"></button>
                <span id="text-status"></span><pre id="text-block"></pre>
            </div>
            <div id="code-container" class="hidden">
                <button id="code-wrap-toggle"></button>
                <span id="code-status"></span><pre><code id="code-block"></code></pre>
            </div>
            <div id="markdown-container" class="hidden">
                <span id="markdown-status"></span><div id="markdown-body"></div>
            </div>
            <div id="archive-container" class="hidden">
                <span id="archive-status"></span><div id="archive-body"></div>
            </div>
            <div id="office-container" class="hidden"></div>
            <div id="fallback-container" class="hidden"></div>
        </div>
        <div id="viewer-review-bar" class="hidden">
            <div id="viewer-review-meta" class="hidden"></div>
            <div id="viewer-review-actions" class="hidden"></div>
        </div>
        <div id="modal-ai-panel" class="hidden">
            <div id="modal-ocr-block" class="hidden"><span id="modal-ocr-text"></span></div>
        </div>
        <div id="modal-filename"></div>
        <span id="modal-type-chip"></span>
        <div id="modal-meta"></div>
        <div id="modal-caption" class="hidden"></div>
        <button id="modal-pin"><i id="modal-pin-icon"></i></button>
        <button id="modal-backup"><i id="modal-backup-icon"></i></button>
        <button id="modal-share"></button>
        <a id="modal-download"></a>
    </div>
`;

const FILE = (over = {}) => ({
    id: 7,
    name: 'cat.jpg',
    type: 'images',
    fullPath: 'media/cat.jpg',
    sizeFormatted: '1.2 MB',
    modified: '2026-07-01T10:00:00Z',
    ...over,
});

// Default: every endpoint answers 404 unless a test says otherwise, so a
// forgotten stub shows up as a missing effect rather than a hang.
function stubFetch(routes = {}) {
    globalThis.fetch = vi.fn(async (url) => {
        for (const [pattern, res] of Object.entries(routes)) {
            if (String(url).includes(pattern)) {
                return typeof res === 'function' ? res(url) : res;
            }
        }
        return { ok: false, status: 404, json: async () => ({}) };
    });
}

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function flush(times = 8) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    // A macrotask too: the share button resolves a dynamic import(), which
    // never settles on the microtask queue alone. Skipped under fake timers —
    // there the clock only moves when a test advances it, so waiting on a
    // real setTimeout would hang.
    if (!vi.isFakeTimers()) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < times; i++) await Promise.resolve();
}

// The module instance a test last loaded. Retired in afterEach — see there.
let lastMod = null;

async function load({ matchMedia } = {}) {
    vi.resetModules();
    wsHandlers.clear();
    images.length = 0;
    document.body.innerHTML = DOM;
    // The prefetch <link> lives in <head>, which survives the body wipe. A
    // fresh module starts with a null ref but the previous element is still
    // in the document, so clear it or the next assertion sees a stale link.
    for (const l of document.head.querySelectorAll('link[rel="prefetch"]')) l.remove();
    state.files = [];
    state.currentFileIndex = 0;
    state.currentFilter = 'all';
    if (matchMedia) window.matchMedia = matchMedia;
    else delete window.matchMedia;
    const mod = await import('../src/web/public/js/viewer.js');
    lastMod = mod;
    return mod;
}

async function openWith(files, index = 0, mod = null) {
    const m = mod || (await load());
    state.files = files;
    m.openMediaViewer(index);
    await flush();
    return m;
}

function fireWs(type, msg) {
    for (const fn of wsHandlers.get(type) || []) fn(msg);
}

function key(init) {
    return document.dispatchEvent(
        new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    i18nDict = {};
    playResult = () => Promise.resolve();
    localStorage.clear();
    stubFetch();
    setFullscreenElement(null);
    setPipElement(null);
    setPipEnabled(true);
    delete window.Viewer;
    delete window.openGroup;
    delete window.tgdlShrinkToMini;
    delete window.tgdlDeleteCurrentFile;
});

afterEach(() => {
    // Retire the module instance this test loaded. vi.resetModules() gives the
    // next test a fresh module but does not stop the old one: a sprite poll
    // scheduled on the real clock (4 s and up) keeps firing into later tests,
    // fetching /api/seekbar/meta/ and constructing Image objects that land in
    // the shared `images` array. closeMediaViewer() unloads the player, which
    // clears that timer.
    try {
        lastMod?.closeMediaViewer();
    } catch {
        /* the DOM may already be half torn down — nothing left to stop */
    }
    lastMod = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
    for (const l of document.head.querySelectorAll('link[rel="prefetch"]')) l.remove();
});

// ---- kind dispatch -------------------------------------------------------

describe('openMediaViewer — preview dispatch', () => {
    const shown = () =>
        [
            'image-container',
            'video-container',
            'pdf-container',
            'audio-container',
            'text-container',
            'code-container',
            'markdown-container',
            'archive-container',
            'office-container',
            'fallback-container',
        ].filter((id) => !$(id).classList.contains('hidden'));

    it('shows an image and nothing else', async () => {
        await openWith([FILE()]);
        expect(shown()).toEqual(['image-container']);
        expect($('modal-image').getAttribute('src')).toContain('cat.jpg');
        expect($('media-modal').classList.contains('hidden')).toBe(false);
        expect(document.body.style.overflow).toBe('hidden');
    });

    it('shows a video and hands the url to the player', async () => {
        await openWith([FILE({ name: 'clip.mp4', type: 'videos', fullPath: 'media/clip.mp4' })]);
        expect(shown()).toEqual(['video-container']);
        expect($('modal-video').getAttribute('src')).toContain('clip.mp4');
    });

    it('shows a pdf with the toolbar hint appended', async () => {
        await openWith([FILE({ name: 'doc.pdf', type: 'documents' })]);
        expect(shown()).toEqual(['pdf-container']);
        expect($('pdf-frame').src).toContain('#toolbar=1');
    });

    it('shows an audio player with title and meta', async () => {
        await openWith([FILE({ name: 'song.mp3', type: 'audio' })]);
        expect(shown()).toEqual(['audio-container']);
        expect($('audio-title').textContent).toBe('song.mp3');
        expect($('audio-meta').textContent).toContain('1.2 MB');
    });

    it('routes plain text, code, markdown and archives to their renderers', async () => {
        const mod = await load();
        await openWith([FILE({ name: 'notes.txt', type: 'documents' })], 0, mod);
        expect(renderTextInto).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: 'notes.txt' }),
        );

        await openWith([FILE({ name: 'main.py', type: 'documents' })], 0, mod);
        expect(renderCodeInto).toHaveBeenCalledWith(expect.objectContaining({ ext: 'py' }));

        await openWith([FILE({ name: 'README.md', type: 'documents' })], 0, mod);
        expect(renderMarkdownInto).toHaveBeenCalled();

        await openWith([FILE({ name: 'bundle.zip', type: 'documents' })], 0, mod);
        expect(renderArchiveInto).toHaveBeenCalledWith(
            expect.objectContaining({ filePath: 'media/cat.jpg' }),
        );
    });

    it('falls back for office documents', async () => {
        await openWith([FILE({ name: 'sheet.xlsx', type: 'documents' })]);
        expect(shown()).toEqual(['fallback-container']);
        expect($('fallback-container').textContent).toContain('Office document');
    });

    it('falls back for an unknown extension', async () => {
        await openWith([FILE({ name: 'firmware.bin', type: 'documents' })]);
        // The heading is the filename itself; the generic title only appears
        // for a nameless record. Assert the body copy instead.
        expect($('fallback-container').textContent).toContain(
            "This file type doesn't have a built-in preview.",
        );
        expect($('fallback-container').querySelector('a').getAttribute('download')).not.toBeNull();
    });

    it('falls back when a preview container is missing from the page', async () => {
        const mod = await load();
        // Simulates a stale deploy where the markup lags the script — the
        // dispatcher must not leave the modal blank.
        $('pdf-container').remove();
        await openWith([FILE({ name: 'doc.pdf', type: 'documents' })], 0, mod);
        expect($('fallback-container').classList.contains('hidden')).toBe(false);
    });

    it('escapes the filename in the fallback pane', async () => {
        const evil = '<img src=x onerror=alert(1)>.bin';
        await openWith([FILE({ name: evil, type: 'documents' })]);
        const pane = $('fallback-container');
        expect(pane.querySelector('img')).toBeNull();
        expect(pane.textContent).toContain(evil);
    });

    it('does nothing when the index points at no file', async () => {
        const mod = await load();
        state.files = [];
        mod.openMediaViewer(0);
        await flush();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });

    it('tears the previous preview down before showing the next', async () => {
        const mod = await load();
        await openWith([FILE({ name: 'song.mp3', type: 'audio' })], 0, mod);
        expect($('modal-audio').getAttribute('src')).toBeTruthy();
        await openWith([FILE()], 0, mod);
        // The audio element must stop streaming when we flip to an image.
        expect($('modal-audio').getAttribute('src')).toBeNull();
        expect($('audio-container').classList.contains('hidden')).toBe(true);
    });

    it('blanks the pdf frame when navigating away from it', async () => {
        const mod = await load();
        await openWith([FILE({ name: 'doc.pdf', type: 'documents' })], 0, mod);
        await openWith([FILE()], 0, mod);
        expect($('pdf-frame').src).toBe('about:blank');
    });
});

// ---- image preview details ----------------------------------------------

describe('image preview', () => {
    it('fades in on load and hides the unavailable placeholder', async () => {
        await openWith([FILE()]);
        const img = $('modal-image');
        img.onload();
        expect(img.style.opacity).toBe('1');
    });

    it('paints an unavailable placeholder on error and reuses it next time', async () => {
        const mod = await load();
        await openWith([FILE()], 0, mod);
        const img = $('modal-image');
        img.onerror();
        const first = $('image-container').querySelectorAll('.viewer-unavailable');
        expect(first).toHaveLength(1);
        expect(first[0].classList.contains('hidden')).toBe(false);

        img.onerror();
        expect($('image-container').querySelectorAll('.viewer-unavailable')).toHaveLength(1);
    });

    it('re-hides the placeholder once a later image loads', async () => {
        await openWith([FILE()]);
        const img = $('modal-image');
        img.onerror();
        img.onload();
        expect(
            $('image-container').querySelector('.viewer-unavailable').classList.contains('hidden'),
        ).toBe(true);
    });

    it('zooms on wheel, clamped to 1x..5x', async () => {
        await openWith([FILE()]);
        const img = $('modal-image');
        const wheel = (deltaY) => img.onwheel({ deltaY, preventDefault() {} });
        wheel(-1);
        expect(img.style.transform).toBe('scale(1.1)');
        for (let i = 0; i < 40; i++) wheel(-1);
        expect(img.style.transform).toBe('scale(5)');
        for (let i = 0; i < 60; i++) wheel(1);
        expect(img.style.transform).toBe('scale(1)');
    });

    it('resets the zoom transform on every open', async () => {
        const mod = await load();
        await openWith([FILE()], 0, mod);
        $('modal-image').onwheel({ deltaY: -1, preventDefault() {} });
        await openWith([FILE({ name: 'other.jpg' })], 0, mod);
        expect($('modal-image').style.transform).toBe('translate(0px, 0px) scale(1)');
    });
});

// ---- modal furniture -----------------------------------------------------

describe('modal furniture', () => {
    it('fills filename, meta, counter and download link', async () => {
        await openWith([FILE(), FILE({ name: 'b.jpg' })], 1);
        expect($('modal-filename').textContent).toBe('b.jpg');
        expect($('modal-counter').textContent).toBe('2 / 2');
        expect($('modal-meta').textContent).toContain('1.2 MB');
        expect($('modal-download').getAttribute('href')).toBeTruthy();
    });

    it('renders a clickable group chip when the file carries one', async () => {
        await openWith([FILE({ groupId: '-100', groupName: 'My Group' })]);
        const chip = $('modal-meta').querySelector('[data-group-id]');
        expect(chip.dataset.groupId).toBe('-100');
        expect(chip.textContent).toBe('My Group');
    });

    it('escapes a hostile group name', async () => {
        await openWith([FILE({ groupId: '-1', groupName: '<script>x</script>' })]);
        expect($('modal-meta').querySelector('script')).toBeNull();
        expect($('modal-meta').textContent).toContain('<script>x</script>');
    });

    it('shows and clears the caption', async () => {
        const mod = await load();
        await openWith([FILE({ caption: 'a photo' })], 0, mod);
        expect($('modal-caption').classList.contains('hidden')).toBe(false);
        expect($('modal-caption').textContent).toBe('a photo');

        await openWith([FILE()], 0, mod);
        expect($('modal-caption').classList.contains('hidden')).toBe(true);
        expect($('modal-caption').textContent).toBe('');
    });

    it('labels the type chip per kind, naming the language for code', async () => {
        const mod = await load();
        const label = async (over) => {
            await openWith([FILE(over)], 0, mod);
            return $('modal-type-chip').textContent;
        };
        expect(await label({})).toBe('Image');
        expect(await label({ name: 'clip.mp4', type: 'videos' })).toBe('Video');
        expect(await label({ name: 'song.mp3', type: 'audio' })).toBe('Audio');
        expect(await label({ name: 'doc.pdf', type: 'documents' })).toBe('PDF');
        expect(await label({ name: 'a.md', type: 'documents' })).toBe('Markdown');
        expect(await label({ name: 'a.txt', type: 'documents' })).toBe('Text');
        expect(await label({ name: 'a.zip', type: 'documents' })).toBe('Archive');
        expect(await label({ name: 'a.docx', type: 'documents' })).toBe('Document');
        expect(await label({ name: 'a.js', type: 'documents' })).toBe('JavaScript');
        expect(await label({ name: 'a.ts', type: 'documents' })).toBe('TypeScript');
        // Unknown extension falls back to the extension itself, upper-cased.
        expect(await label({ name: 'a.bin', type: 'documents' })).toBe('BIN');
    });

    it('marks the file viewed exactly once per open', async () => {
        await openWith([FILE({ id: 42 })]);
        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/downloads/42/viewed',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('skips the viewed ping for a file with no id', async () => {
        await openWith([FILE({ id: null })]);
        const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/viewed'))).toBe(false);
    });
});

// ---- pin + backup buttons ------------------------------------------------

describe('pin and backup buttons', () => {
    it('reflects the pinned state', async () => {
        const mod = await load();
        await openWith([FILE({ pinned: true })], 0, mod);
        expect($('modal-pin-icon').className).toContain('ri-pushpin-2-fill');
        expect($('modal-pin').title).toBe('Unpin');

        await openWith([FILE({ pinned: false })], 0, mod);
        expect($('modal-pin-icon').className).toContain('ri-pushpin-line');
        expect($('modal-pin').title).toBe('Pin');
    });

    it('queries backup status once per file and paints the result', async () => {
        stubFetch({ '/backup-status': jsonRes({ backedUp: true }) });
        const file = FILE();
        const mod = await load();
        await openWith([file], 0, mod);
        expect($('modal-backup-icon').className).toContain('ri-cloud-fill');
        expect(file._backupChecked).toBe(true);

        globalThis.fetch.mockClear();
        mod.openMediaViewer(0);
        await flush();
        const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/backup-status'))).toBe(false);
    });

    it('leaves the button alone when the status call fails', async () => {
        stubFetch({ '/backup-status': jsonRes({}, 500) });
        const file = FILE();
        await openWith([file]);
        expect($('modal-backup-icon').className).toContain('ri-cloud-line');
        expect(file._backupChecked).toBeUndefined();
    });

    it('flips the button when a backup_done event names the open file', async () => {
        const mod = await load();
        await openWith([FILE({ id: 7 })], 0, mod);
        fireWs('backup_done', { downloadId: 7 });
        expect($('modal-backup-icon').className).toContain('ri-cloud-fill');
    });

    it('ignores a backup_done for some other file', async () => {
        const mod = await load();
        await openWith([FILE({ id: 7 })], 0, mod);
        fireWs('backup_done', { downloadId: 99 });
        fireWs('backup_done', {});
        expect($('modal-backup-icon').className).toContain('ri-cloud-line');
    });
});

// ---- AI panel ------------------------------------------------------------

describe('AI panel', () => {
    it('shows OCR text for an image that has some', async () => {
        stubFetch({ '/api/ai/text/': jsonRes({ result: { text: '  hello world  ' } }) });
        await openWith([FILE()]);
        expect($('modal-ai-panel').classList.contains('hidden')).toBe(false);
        expect($('modal-ocr-text').textContent).toBe('hello world');
    });

    it('stays hidden when the OCR result is blank', async () => {
        stubFetch({ '/api/ai/text/': jsonRes({ result: { text: '   ' } }) });
        await openWith([FILE()]);
        expect($('modal-ai-panel').classList.contains('hidden')).toBe(true);
    });

    it('stays hidden for a non-image', async () => {
        stubFetch({ '/api/ai/text/': jsonRes({ result: { text: 'x' } }) });
        await openWith([FILE({ name: 'clip.mp4', type: 'videos' })]);
        const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/ai/text/'))).toBe(false);
    });

    it('is cleared when the next file opens', async () => {
        stubFetch({ '/api/ai/text/': jsonRes({ result: { text: 'hello' } }) });
        const mod = await load();
        await openWith([FILE()], 0, mod);
        expect($('modal-ai-panel').classList.contains('hidden')).toBe(false);
        stubFetch();
        await openWith([FILE({ id: 8, name: 'b.jpg' })], 0, mod);
        expect($('modal-ai-panel').classList.contains('hidden')).toBe(true);
        expect($('modal-ocr-block').classList.contains('hidden')).toBe(true);
    });
});

// ---- prefetch ------------------------------------------------------------

describe('neighbour prefetch', () => {
    const link = () => document.head.querySelector('link[rel="prefetch"]');

    it('prefetches the next image', async () => {
        await openWith([FILE(), FILE({ name: 'next.jpg', fullPath: 'media/next.jpg' })]);
        expect(link().href).toContain('next.jpg');
    });

    it('drops the link when the neighbour is not an image', async () => {
        const mod = await load();
        await openWith([FILE(), FILE({ name: 'next.jpg', fullPath: 'media/next.jpg' })], 0, mod);
        expect(link()).not.toBeNull();
        await openWith([FILE(), FILE({ name: 'clip.mp4', type: 'videos' })], 0, mod);
        expect(link()).toBeNull();
    });

    it('reuses the existing link element rather than stacking them up', async () => {
        const mod = await load();
        await openWith(
            [
                FILE(),
                FILE({ name: 'b.jpg', fullPath: 'media/b.jpg' }),
                FILE({ name: 'c.jpg', fullPath: 'media/c.jpg' }),
            ],
            0,
            mod,
        );
        mod.openMediaViewer(1);
        await flush();
        expect(document.head.querySelectorAll('link[rel="prefetch"]')).toHaveLength(1);
        expect(link().href).toContain('c.jpg');
    });

    it('leaves the link untouched when the neighbour is unchanged', async () => {
        const mod = await load();
        await openWith([FILE(), FILE({ name: 'b.jpg', fullPath: 'media/b.jpg' })], 0, mod);
        const before = link();
        mod.openMediaViewer(0);
        await flush();
        expect(link()).toBe(before);
    });
});

// ---- slideshow -----------------------------------------------------------

describe('slideshow auto-advance', () => {
    it('advances after the configured interval', async () => {
        vi.useFakeTimers();
        localStorage.setItem('viewer-auto-advance', '1');
        localStorage.setItem('viewer-slideshow-interval', '3');
        const mod = await load();
        state.files = [FILE(), FILE({ name: 'b.jpg' })];
        mod.openMediaViewer(0);
        await vi.advanceTimersByTimeAsync(2999);
        expect($('modal-filename').textContent).toBe('cat.jpg');
        await vi.advanceTimersByTimeAsync(2);
        expect($('modal-filename').textContent).toBe('b.jpg');
    });

    it('stays put when auto-advance is off', async () => {
        vi.useFakeTimers();
        const mod = await load();
        state.files = [FILE(), FILE({ name: 'b.jpg' })];
        mod.openMediaViewer(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('clamps the interval into 2..15 seconds', async () => {
        vi.useFakeTimers();
        localStorage.setItem('viewer-auto-advance', '1');
        localStorage.setItem('viewer-slideshow-interval', '900');
        const mod = await load();
        state.files = [FILE(), FILE({ name: 'b.jpg' })];
        mod.openMediaViewer(0);
        await vi.advanceTimersByTimeAsync(15_001);
        expect($('modal-filename').textContent).toBe('b.jpg');
    });

    it('does not advance once the modal is closed', async () => {
        vi.useFakeTimers();
        localStorage.setItem('viewer-auto-advance', '1');
        localStorage.setItem('viewer-slideshow-interval', '2');
        const mod = await load();
        state.files = [FILE(), FILE({ name: 'b.jpg' })];
        mod.openMediaViewer(0);
        $('media-modal').classList.add('hidden');
        await vi.advanceTimersByTimeAsync(3000);
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('cancels the pending timer when the viewer closes', async () => {
        vi.useFakeTimers();
        localStorage.setItem('viewer-auto-advance', '1');
        localStorage.setItem('viewer-slideshow-interval', '2');
        const mod = await load();
        state.files = [FILE(), FILE({ name: 'b.jpg' })];
        mod.openMediaViewer(0);
        mod.closeMediaViewer();
        // Re-showing the modal must not resurrect the cancelled advance.
        $('media-modal').classList.remove('hidden');
        await vi.advanceTimersByTimeAsync(3000);
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });
});

// ---- one-shot + review opens --------------------------------------------

describe('openMediaViewerSingle', () => {
    it('stages one file into the store and opens it', async () => {
        const mod = await load();
        mod.openMediaViewerSingle(FILE({ name: 'solo.jpg' }));
        await flush();
        expect(state.files).toHaveLength(1);
        expect($('modal-filename').textContent).toBe('solo.jpg');
        expect($('modal-counter').textContent).toBe('1 / 1');
    });

    it('ignores a record with no path', async () => {
        const mod = await load();
        mod.openMediaViewerSingle({ name: 'nope.jpg' });
        await flush();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });
});

describe('review mode', () => {
    const ACTIONS = () => [
        { key: 'w', label: 'Whitelist', icon: 'ri-check-line', handler: vi.fn() },
        { key: 'd', label: 'Delete', danger: true, handler: vi.fn() },
    ];

    async function openReview(actions = ACTIONS(), opts = {}, files = null) {
        const mod = await load();
        mod.openMediaViewerForReview(
            files || [FILE(), FILE({ id: 8, name: 'b.jpg' }), FILE({ id: 9, name: 'c.jpg' })],
            0,
            { actions, ...opts },
        );
        await flush();
        return { mod, actions };
    }

    it('renders one button per action with its shortcut hint', async () => {
        await openReview();
        const bar = $('viewer-review-actions');
        expect($('viewer-review-bar').classList.contains('hidden')).toBe(false);
        const btns = bar.querySelectorAll('[data-review-act]');
        expect(btns).toHaveLength(2);
        expect(btns[0].textContent).toContain('Whitelist');
        expect(btns[0].textContent).toContain('w');
        expect(btns[1].className).toContain('red');
    });

    it('paints the optional meta renderer', async () => {
        const metaRender = vi.fn((f) => `<b>${f.name}</b>`);
        await openReview(ACTIONS(), { metaRender });
        expect($('viewer-review-meta').classList.contains('hidden')).toBe(false);
        expect($('viewer-review-meta').innerHTML).toBe('<b>cat.jpg</b>');
        expect(metaRender).toHaveBeenCalledWith(expect.objectContaining({ name: 'cat.jpg' }), 0);
    });

    it('hides the meta slot when no renderer was supplied', async () => {
        await openReview();
        expect($('viewer-review-meta').classList.contains('hidden')).toBe(true);
    });

    it('stays hidden for a normal open', async () => {
        await openWith([FILE()]);
        expect($('viewer-review-bar').classList.contains('hidden')).toBe(true);
        expect($('viewer-review-actions').classList.contains('hidden')).toBe(true);
    });

    it('runs the handler on click with the current file and index', async () => {
        const { actions } = await openReview();
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect(actions[0].handler).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'cat.jpg' }),
            0,
        );
    });

    it('runs the handler on the matching letter key, case-insensitively', async () => {
        const { mod, actions } = await openReview();
        mod.setupViewerEvents();
        key({ key: 'W' });
        await flush();
        expect(actions[0].handler).toHaveBeenCalled();
    });

    it('leaves modifier combos to the browser', async () => {
        const { mod, actions } = await openReview();
        mod.setupViewerEvents();
        key({ key: 'w', metaKey: true });
        await flush();
        expect(actions[0].handler).not.toHaveBeenCalled();
    });

    it('advances when the handler asks it to', async () => {
        const actions = [{ key: 'w', label: 'W', handler: vi.fn(async () => 'advance') }];
        await openReview(actions);
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect($('modal-filename').textContent).toBe('b.jpg');
    });

    it('stops advancing at the last file', async () => {
        const actions = [{ key: 'w', label: 'W', handler: vi.fn(async () => 'advance') }];
        const mod = await load();
        mod.openMediaViewerForReview([FILE()], 0, { actions });
        await flush();
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('drops the file from the list on remove-and-advance and reports it', async () => {
        const afterRemove = vi.fn();
        const actions = [
            { key: 'd', label: 'D', handler: vi.fn(async () => 'remove-and-advance'), afterRemove },
        ];
        await openReview(actions);
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect(state.files).toHaveLength(2);
        expect($('modal-filename').textContent).toBe('b.jpg');
        expect(afterRemove).toHaveBeenCalledWith(expect.objectContaining({ name: 'cat.jpg' }));
    });

    it('steps back when the removed file was the last one', async () => {
        const actions = [
            { key: 'd', label: 'D', handler: vi.fn(async () => 'remove-and-advance') },
        ];
        const mod = await load();
        mod.openMediaViewerForReview([FILE(), FILE({ id: 8, name: 'b.jpg' })], 1, { actions });
        await flush();
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('closes the viewer when the last file is removed', async () => {
        const actions = [
            { key: 'd', label: 'D', handler: vi.fn(async () => 'remove-and-advance') },
        ];
        const mod = await load();
        mod.openMediaViewerForReview([FILE()], 0, { actions });
        await flush();
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });

    it('swallows a throwing handler without navigating', async () => {
        const actions = [
            {
                key: 'w',
                label: 'W',
                handler: vi.fn(async () => {
                    throw new Error('server said no');
                }),
            },
        ];
        await openReview(actions);
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('survives an afterRemove that throws', async () => {
        const actions = [
            {
                key: 'd',
                label: 'D',
                handler: vi.fn(async () => 'remove-and-advance'),
                afterRemove: () => {
                    throw new Error('boom');
                },
            },
        ];
        await openReview(actions);
        $('viewer-review-actions').querySelector('[data-review-act="0"]').click();
        await flush();
        expect($('modal-filename').textContent).toBe('b.jpg');
    });

    it('ignores an empty file list', async () => {
        const mod = await load();
        mod.openMediaViewerForReview([], 0, { actions: ACTIONS() });
        await flush();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });

    it('clamps an out-of-range start index', async () => {
        const mod = await load();
        mod.openMediaViewerForReview([FILE(), FILE({ id: 8, name: 'b.jpg' })], 99, {
            actions: ACTIONS(),
        });
        await flush();
        expect($('modal-filename').textContent).toBe('b.jpg');
    });

    it('drops the review wiring on close', async () => {
        const { mod, actions } = await openReview();
        mod.setupViewerEvents();
        mod.closeMediaViewer();
        await openWith([FILE()], 0, mod);
        key({ key: 'w' });
        await flush();
        expect(actions[0].handler).not.toHaveBeenCalled();
        expect($('viewer-review-bar').classList.contains('hidden')).toBe(true);
    });
});

// ---- close ---------------------------------------------------------------

describe('closeMediaViewer', () => {
    it('hides the modal and restores page scrolling', async () => {
        const mod = await openWith([FILE()]);
        mod.closeMediaViewer();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
        expect(document.body.style.overflow).toBe('');
        expect($('modal-image').getAttribute('src')).toBeNull();
    });

    it('leaves fullscreen on the way out', async () => {
        const mod = await openWith([FILE()]);
        setFullscreenElement($('image-container'));
        document.exitFullscreen = vi.fn(() => Promise.resolve());
        mod.closeMediaViewer();
        expect(document.exitFullscreen).toHaveBeenCalled();
    });

    it('hands a playing video to the mini-player when the user opted in', async () => {
        const mod = await openWith([
            FILE({ name: 'clip.mp4', type: 'videos', fullPath: 'media/clip.mp4' }),
        ]);
        const video = $('modal-video');
        video.play();
        localStorage.setItem('viewer-shrink-on-close', '1');
        window.tgdlShrinkToMini = vi.fn();
        mod.closeMediaViewer();
        expect(window.tgdlShrinkToMini).toHaveBeenCalled();
    });

    it('does not shrink when the preference is off', async () => {
        const mod = await openWith([
            FILE({ name: 'clip.mp4', type: 'videos', fullPath: 'media/clip.mp4' }),
        ]);
        $('modal-video').play();
        window.tgdlShrinkToMini = vi.fn();
        mod.closeMediaViewer();
        expect(window.tgdlShrinkToMini).not.toHaveBeenCalled();
    });

    it('does not shrink a paused video', async () => {
        const mod = await openWith([
            FILE({ name: 'clip.mp4', type: 'videos', fullPath: 'media/clip.mp4' }),
        ]);
        localStorage.setItem('viewer-shrink-on-close', '1');
        window.tgdlShrinkToMini = vi.fn();
        mod.closeMediaViewer();
        expect(window.tgdlShrinkToMini).not.toHaveBeenCalled();
    });

    it('survives a mini-player handoff that throws', async () => {
        const mod = await openWith([
            FILE({ name: 'clip.mp4', type: 'videos', fullPath: 'media/clip.mp4' }),
        ]);
        $('modal-video').play();
        localStorage.setItem('viewer-shrink-on-close', '1');
        window.tgdlShrinkToMini = () => {
            throw new Error('mini exploded');
        };
        mod.closeMediaViewer();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });
});

// ---- navigation ----------------------------------------------------------

describe('navigation', () => {
    const THREE = () => [
        FILE({ id: 1, name: 'a.jpg', type: 'images' }),
        FILE({ id: 2, name: 'b.mp4', type: 'videos' }),
        FILE({ id: 3, name: 'c.jpg', type: 'images' }),
    ];

    it('steps forward and back through the whole list', async () => {
        const mod = await openWith(THREE(), 0);
        mod.setupViewerEvents();
        $('modal-next').click();
        await flush();
        expect($('modal-filename').textContent).toBe('b.mp4');
        $('modal-prev').click();
        await flush();
        expect($('modal-filename').textContent).toBe('a.jpg');
    });

    it('walks the active filter rather than the raw list', async () => {
        const mod = await openWith(THREE(), 0);
        mod.setupViewerEvents();
        state.currentFilter = 'images';
        // b.mp4 sits between the two images but is filtered out.
        $('modal-next').click();
        await flush();
        expect($('modal-filename').textContent).toBe('c.jpg');
    });

    it('stops at the end of the filtered list', async () => {
        const mod = await openWith(THREE(), 2);
        mod.setupViewerEvents();
        $('modal-next').click();
        await flush();
        expect($('modal-filename').textContent).toBe('c.jpg');
    });

    it('falls back to raw index stepping when the current file is filtered out', async () => {
        const mod = await openWith(THREE(), 1);
        mod.setupViewerEvents();
        state.currentFilter = 'images';
        $('modal-next').click();
        await flush();
        expect($('modal-filename').textContent).toBe('c.jpg');
    });

    it('does not step past the start of the raw list', async () => {
        const mod = await openWith(THREE(), 0);
        mod.setupViewerEvents();
        state.currentFilter = 'documents';
        $('modal-prev').click();
        await flush();
        expect($('modal-filename').textContent).toBe('a.jpg');
    });

    it('navigates on swipe', async () => {
        const mod = await openWith(THREE(), 0);
        mod.setupViewerEvents();
        expect(swipeOpts.threshold).toBe(60);
        swipeOpts.onSwipe('left');
        await flush();
        expect($('modal-filename').textContent).toBe('b.mp4');
        swipeOpts.onSwipe('right');
        await flush();
        expect($('modal-filename').textContent).toBe('a.jpg');
    });

    it('closes on drag-dismiss', async () => {
        const mod = await openWith(THREE(), 0);
        mod.setupViewerEvents();
        dismissOpts.onDismiss();
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });
});

// ---- keyboard ------------------------------------------------------------

describe('keyboard shortcuts', () => {
    async function open(files = [FILE(), FILE({ id: 2, name: 'b.jpg' })], index = 0) {
        const mod = await openWith(files, index);
        mod.setupViewerEvents();
        return mod;
    }

    it('does nothing while the modal is closed', async () => {
        const mod = await load();
        mod.setupViewerEvents();
        key({ key: 'Escape' });
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });

    it('closes on Escape', async () => {
        await open();
        key({ key: 'Escape' });
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });

    it('steps with the arrow keys for non-video media', async () => {
        await open();
        key({ key: 'ArrowRight' });
        await flush();
        expect($('modal-filename').textContent).toBe('b.jpg');
        key({ key: 'ArrowLeft' });
        await flush();
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('leaves the arrow keys to the player while a video is open', async () => {
        await open([FILE({ name: 'clip.mp4', type: 'videos' }), FILE({ id: 2, name: 'b.jpg' })], 0);
        const video = $('modal-video');
        video.duration = 100;
        video.currentTime = 50;
        key({ key: 'ArrowRight' });
        await flush();
        // Seeks inside the clip instead of navigating away from it.
        expect($('modal-filename').textContent).toBe('clip.mp4');
        expect(video.currentTime).toBe(55);
    });

    it('steps with p and n regardless of media kind', async () => {
        await open();
        key({ key: 'n' });
        await flush();
        expect($('modal-filename').textContent).toBe('b.jpg');
        key({ key: 'p' });
        await flush();
        expect($('modal-filename').textContent).toBe('cat.jpg');
    });

    it('toggles the pin with t', async () => {
        await open();
        const pin = vi.fn();
        $('modal-pin').addEventListener('click', pin);
        key({ key: 't' });
        expect(pin).toHaveBeenCalled();
    });

    it('delegates delete to the app hook', async () => {
        await open();
        window.tgdlDeleteCurrentFile = vi.fn();
        key({ key: 'd' });
        expect(window.tgdlDeleteCurrentFile).toHaveBeenCalled();
    });

    it('enables both autoplay settings with a, reporting what changed', async () => {
        await open();
        key({ key: 'a' });
        expect(localStorage.getItem('viewer-autoplay')).toBe('1');
        expect(localStorage.getItem('viewer-auto-advance')).toBe('1');
        expect(showToast).toHaveBeenCalledWith('Autoplay + auto-advance enabled');

        showToast.mockClear();
        key({ key: 'a' });
        expect(showToast).toHaveBeenCalledWith('Autoplay + auto-advance already active', 'info');
    });

    it('reports the single setting it turned on', async () => {
        localStorage.setItem('viewer-autoplay', '1');
        await open();
        key({ key: 'a' });
        expect(showToast).toHaveBeenCalledWith('Auto-advance enabled');

        localStorage.clear();
        localStorage.setItem('viewer-auto-advance', '1');
        showToast.mockClear();
        key({ key: 'a' });
        expect(showToast).toHaveBeenCalledWith('Autoplay enabled');
    });

    it('stays out of the way while the user is typing', async () => {
        await open();
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect($('media-modal').classList.contains('hidden')).toBe(false);
    });
});

// ---- toolbar buttons -----------------------------------------------------

describe('modal toolbar', () => {
    it('opens the group from the meta chip and closes the viewer', async () => {
        const mod = await openWith([FILE({ groupId: '-100', groupName: 'My Group' })]);
        mod.setupViewerEvents();
        window.openGroup = vi.fn();
        $('modal-meta').querySelector('[data-group-id]').click();
        expect(window.openGroup).toHaveBeenCalledWith('-100', 'My Group');
        expect($('media-modal').classList.contains('hidden')).toBe(true);
    });

    it('ignores a click that misses the chip', async () => {
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        window.openGroup = vi.fn();
        $('modal-meta').click();
        expect(window.openGroup).not.toHaveBeenCalled();
    });

    it('queues a backup and reports the destination count', async () => {
        stubFetch({ '/backup': jsonRes({ queued: 2 }) });
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        $('modal-backup').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('Queued to 2 destination(s)');
        expect($('modal-backup-icon').className).toContain('ri-cloud-fill');
    });

    it('says so when every destination already has the file', async () => {
        stubFetch({ '/backup': jsonRes({ queued: 0 }) });
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        $('modal-backup').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('Already backed up to all destinations');
    });

    it('surfaces a backup error', async () => {
        stubFetch({ '/backup': jsonRes({ error: 'no destinations' }, 500) });
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        $('modal-backup').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('no destinations', 'error');
    });

    it('surfaces a backup network failure', async () => {
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('offline');
        });
        $('modal-backup').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('Backup request failed', 'error');
    });

    it('pins and unpins', async () => {
        stubFetch({ '/pin': jsonRes({ ok: true }) });
        const file = FILE();
        const mod = await openWith([file]);
        mod.setupViewerEvents();
        $('modal-pin').click();
        await flush();
        expect(file.pinned).toBe(true);
        expect(showToast).toHaveBeenCalledWith('Pinned');

        $('modal-pin').click();
        await flush();
        expect(file.pinned).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Unpinned');
    });

    it('leaves the pin state alone when the server refuses', async () => {
        stubFetch({ '/pin': jsonRes({}, 403) });
        const file = FILE();
        const mod = await openWith([file]);
        mod.setupViewerEvents();
        $('modal-pin').click();
        await flush();
        expect(file.pinned).toBeUndefined();
    });

    it('opens the share sheet for the current file', async () => {
        const mod = await openWith([FILE({ id: 42, name: 'cat.jpg' })]);
        mod.setupViewerEvents();
        $('modal-share').click();
        await flush();
        expect(openShareSheet).toHaveBeenCalledWith({ downloadId: 42, fileName: 'cat.jpg' });
    });

    it('refuses to share a file with no id', async () => {
        const mod = await openWith([FILE({ id: null })]);
        mod.setupViewerEvents();
        $('modal-share').click();
        await flush();
        expect(openShareSheet).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('No file selected', 'error');
    });

    it('fullscreens the visible preview container', async () => {
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        $('modal-fullscreen-btn').click();
        await flush();
        expect($('image-container').requestFullscreen).toHaveBeenCalled();
    });

    it('exits fullscreen when already in it', async () => {
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        setFullscreenElement($('image-container'));
        document.exitFullscreen = vi.fn(() => Promise.resolve());
        $('modal-fullscreen-btn').click();
        await flush();
        expect(document.exitFullscreen).toHaveBeenCalled();
    });

    it('reports a refused fullscreen request', async () => {
        const mod = await openWith([FILE()]);
        mod.setupViewerEvents();
        $('image-container').requestFullscreen = vi.fn(() =>
            Promise.reject(new Error('denied by policy')),
        );
        $('modal-fullscreen-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('denied by policy'),
            'error',
        );
    });

    it('toggles the text wrap preference for both panes', async () => {
        const mod = await load();
        mod.setupViewerEvents();
        $('text-wrap-toggle').click();
        expect(localStorage.getItem('viewer-text-wrap')).toBe('1');
        expect($('text-block').classList.contains('wrap')).toBe(true);
        // #code-block is a <code> inside a <pre> — the class lands on the <pre>.
        expect($('code-block').parentElement.classList.contains('wrap')).toBe(true);

        $('code-wrap-toggle').click();
        expect(localStorage.getItem('viewer-text-wrap')).toBe('0');
        expect($('text-block').classList.contains('wrap')).toBe(false);
    });

    it('applies a stored wrap preference at boot', async () => {
        localStorage.setItem('viewer-text-wrap', '1');
        const mod = await load();
        mod.setupViewerEvents();
        expect($('text-block').classList.contains('wrap')).toBe(true);
    });

    it('closes the speed menu on an outside pointerdown', async () => {
        const mod = await load();
        mod.setupViewerEvents();
        const menu = $('video-speed-menu');
        menu.classList.remove('hidden');
        document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('leaves the speed menu open when the click is inside it', async () => {
        const mod = await load();
        mod.setupViewerEvents();
        const menu = $('video-speed-menu');
        menu.classList.remove('hidden');
        menu.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        expect(menu.classList.contains('hidden')).toBe(false);
    });
});

// ---- VideoPlayer ---------------------------------------------------------

describe('VideoPlayer', () => {
    const VIDEO = (over = {}) =>
        FILE({ name: 'clip.mp4', type: 'videos', fullPath: 'media/clip.mp4', ...over });

    async function openVideo(over = {}, mod = null) {
        const m = await openWith([VIDEO(over)], 0, mod);
        return { mod: m, video: $('modal-video') };
    }

    it('resets the transport UI on load', async () => {
        const { video } = await openVideo();
        expect($('video-current-time').textContent).toBe('00:00');
        expect($('video-progress-fill').style.width).toBe('0%');
        expect($('video-center-play').classList.contains('hidden')).toBe(false);
        expect($('video-spinner').classList.contains('hidden')).toBe(false);
        expect(video.getAttribute('src')).toContain('clip.mp4');
    });

    it('restores volume, mute, speed and loop from storage', async () => {
        localStorage.setItem('video-volume', '0.25');
        localStorage.setItem('video-muted', '1');
        localStorage.setItem('video-speed', '1.5');
        localStorage.setItem('viewer-loop', '1');
        const { video } = await openVideo();
        expect(video.volume).toBe(0.25);
        expect(video.muted).toBe(true);
        expect(video.playbackRate).toBe(1.5);
        expect(video.loop).toBe(true);
    });

    it('ignores a corrupt stored speed', async () => {
        localStorage.setItem('video-speed', 'not-a-number');
        const { video } = await openVideo();
        expect(video.playbackRate).toBe(1);
    });

    it('toggles play from the transport buttons', async () => {
        const { video } = await openVideo();
        $('video-play-btn').click();
        expect(video.paused).toBe(false);
        $('video-play-btn').click();
        expect(video.paused).toBe(true);
        $('video-center-play').click();
        expect(video.paused).toBe(false);
    });

    it('skips by the configured step', async () => {
        localStorage.setItem('viewer-skip-step', '15');
        const { video } = await openVideo();
        video.duration = 100;
        video.currentTime = 50;
        $('video-skip-fwd').click();
        expect(video.currentTime).toBe(65);
        $('video-skip-back').click();
        expect(video.currentTime).toBe(50);
    });

    it('clamps a seek into the clip bounds', async () => {
        const { video } = await openVideo();
        video.duration = 30;
        video.currentTime = 25;
        $('video-skip-fwd').click();
        expect(video.currentTime).toBe(30);
        video.currentTime = 2;
        $('video-skip-back').click();
        expect(video.currentTime).toBe(0);
    });

    it('refuses to seek a clip of unknown duration', async () => {
        const { video } = await openVideo();
        video.currentTime = 10;
        $('video-skip-fwd').click();
        expect(video.currentTime).toBe(10);
    });

    it('paints the progress bar and persists the position on timeupdate', async () => {
        const { video } = await openVideo();
        video.duration = 200;
        video.currentTime = 50;
        video.ontimeupdate();
        expect($('video-progress-fill').style.width).toBe('25%');
        expect($('video-progress-dot').style.left).toBe('25%');
        expect($('video-current-time').textContent).toBe('00:50');
        expect(localStorage.getItem('video-progress-media/clip.mp4')).toBe('50');
    });

    it('throttles the position save to one every two seconds', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const { video } = await openVideo();
        video.duration = 200;
        video.currentTime = 50;
        video.ontimeupdate();
        video.currentTime = 60;
        video.ontimeupdate();
        expect(localStorage.getItem('video-progress-media/clip.mp4')).toBe('50');
        vi.setSystemTime(1_002_500);
        video.currentTime = 70;
        video.ontimeupdate();
        expect(localStorage.getItem('video-progress-media/clip.mp4')).toBe('70');
    });

    it('drops the saved position once the clip is nearly finished', async () => {
        const { video } = await openVideo();
        localStorage.setItem('video-progress-media/clip.mp4', '10');
        video.duration = 100;
        video.currentTime = 96;
        video.ontimeupdate();
        expect(localStorage.getItem('video-progress-media/clip.mp4')).toBeNull();
    });

    it('resumes from the saved position and says so', async () => {
        localStorage.setItem('video-progress-media/clip.mp4', '65');
        const { video } = await openVideo();
        video.duration = 200;
        video.onloadedmetadata();
        expect(video.currentTime).toBe(65);
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('01:05'));
    });

    it('honours the remember-position opt-out', async () => {
        localStorage.setItem('viewer-no-resume', '1');
        localStorage.setItem('video-progress-media/clip.mp4', '65');
        const { video } = await openVideo();
        video.duration = 200;
        video.onloadedmetadata();
        expect(video.currentTime).toBe(0);
    });

    it('ignores a saved position at or past the end', async () => {
        localStorage.setItem('video-progress-media/clip.mp4', '300');
        const { video } = await openVideo();
        video.duration = 200;
        video.onloadedmetadata();
        expect(video.currentTime).toBe(0);
    });

    it('resumes only once per load', async () => {
        localStorage.setItem('video-progress-media/clip.mp4', '65');
        const { video } = await openVideo();
        video.duration = 200;
        video.onloadedmetadata();
        video.currentTime = 5;
        video.onloadedmetadata();
        expect(video.currentTime).toBe(5);
    });

    it('applies the resume inline when metadata is already there', async () => {
        localStorage.setItem('video-progress-media/clip.mp4', '30');
        const mod = await load();
        const video = $('modal-video');
        video.readyState = 1;
        video.duration = 100;
        await openWith([VIDEO()], 0, mod);
        expect(video.currentTime).toBe(30);
    });

    it('autoplays when the setting is on', async () => {
        localStorage.setItem('viewer-autoplay', '1');
        const mod = await load();
        $('modal-video').readyState = 2;
        await openWith([VIDEO()], 0, mod);
        expect($('modal-video').paused).toBe(false);
    });

    it('retries muted when the browser refuses to autoplay with sound', async () => {
        localStorage.setItem('viewer-autoplay', '1');
        let calls = 0;
        playResult = () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
        };
        const mod = await load();
        $('modal-video').readyState = 2;
        await openWith([VIDEO()], 0, mod);
        await flush();
        expect($('modal-video').muted).toBe(true);
        expect(calls).toBe(2);
    });

    it('waits for canplay on a cold cache', async () => {
        localStorage.setItem('viewer-autoplay', '1');
        const mod = await load();
        const video = $('modal-video');
        video.readyState = 0;
        await openWith([VIDEO()], 0, mod);
        expect(video.paused).toBe(true);
        video.dispatchEvent(new window.Event('canplay'));
        expect(video.paused).toBe(false);
    });

    it('mutes and unmutes, restoring audible volume', async () => {
        const { video } = await openVideo();
        $('video-mute-btn').click();
        expect(video.muted).toBe(true);
        video.volume = 0;
        $('video-mute-btn').click();
        expect(video.muted).toBe(false);
        expect(video.volume).toBe(0.5);
    });

    it('drives the volume icon from the level', async () => {
        const { video } = await openVideo();
        const icon = () => $('video-mute-btn').innerHTML;
        video.volume = 0.8;
        video.onvolumechange();
        expect(icon()).toContain('ri-volume-up-line');
        video.volume = 0.2;
        video.onvolumechange();
        expect(icon()).toContain('ri-volume-down-line');
        video.muted = true;
        video.onvolumechange();
        expect(icon()).toContain('ri-volume-mute-line');
    });

    it('persists volume and mute on change', async () => {
        const { video } = await openVideo();
        video.volume = 0.42;
        video.muted = true;
        video.onvolumechange();
        expect(localStorage.getItem('video-volume')).toBe('0.42');
        expect(localStorage.getItem('video-muted')).toBe('1');
    });

    it('adjusts the volume from the slider and the wheel', async () => {
        const { video } = await openVideo();
        const slider = $('video-volume');
        slider.value = '0.3';
        slider.oninput();
        expect(video.volume).toBeCloseTo(0.3);

        $('video-container').onwheel({ deltaY: -1, preventDefault() {} });
        expect(video.volume).toBeCloseTo(0.35);
        $('video-container').onwheel({ deltaY: 1, preventDefault() {} });
        expect(video.volume).toBeCloseTo(0.3);
    });

    it('mutes automatically at zero volume and unmutes above it', async () => {
        const { video } = await openVideo();
        const slider = $('video-volume');
        slider.value = '0';
        slider.oninput();
        expect(video.muted).toBe(true);
        slider.value = '0.4';
        slider.oninput();
        expect(video.muted).toBe(false);
    });

    it('sets and persists the playback speed from the menu', async () => {
        const { video } = await openVideo();
        $('video-settings-btn').click();
        expect($('video-speed-menu').classList.contains('hidden')).toBe(false);
        document.querySelector('.speed-opt[data-speed="1.5"]').click();
        expect(video.playbackRate).toBe(1.5);
        expect(localStorage.getItem('video-speed')).toBe('1.5');
        expect($('video-speed-menu').classList.contains('hidden')).toBe(true);
    });

    it('marks the active speed option and clears the previous one', async () => {
        const { video } = await openVideo();
        video.playbackRate = 1.5;
        video.onratechange();
        const opt = document.querySelector('.speed-opt[data-speed="1.5"]');
        expect(opt.querySelector('i.ri-check-line')).not.toBeNull();
        expect($('video-settings-btn').textContent).toBe('1.5x');

        video.playbackRate = 1;
        video.onratechange();
        expect(opt.querySelector('i.ri-check-line')).toBeNull();
        expect($('video-settings-btn').textContent).toBe('1x');
    });

    it('ignores a malformed speed option', async () => {
        const { video } = await openVideo();
        const opt = document.querySelector('.speed-opt[data-speed="1.5"]');
        opt.dataset.speed = 'fast';
        video.playbackRate = 1;
        opt.click();
        expect(video.playbackRate).toBe(1);
    });

    it('swaps the play icon as playback starts and stops', async () => {
        const { video } = await openVideo();
        video.play();
        video.onplay();
        expect($('video-play-btn').innerHTML).toContain('ri-pause-fill');
        expect($('video-center-play').classList.contains('hidden')).toBe(true);
        video.pause();
        video.onpause();
        expect($('video-play-btn').innerHTML).toContain('ri-play-fill');
        expect($('video-center-play').classList.contains('hidden')).toBe(false);
    });

    it('clears the saved position when the clip ends', async () => {
        const { video } = await openVideo();
        localStorage.setItem('video-progress-media/clip.mp4', '50');
        video.onended();
        expect(localStorage.getItem('video-progress-media/clip.mp4')).toBeNull();
    });

    it('auto-advances after the clip ends when the setting is on', async () => {
        vi.useFakeTimers();
        localStorage.setItem('viewer-auto-advance', '1');
        const mod = await load();
        state.files = [VIDEO(), FILE({ id: 2, name: 'b.jpg' })];
        mod.openMediaViewer(0);
        $('modal-video').onended();
        await vi.advanceTimersByTimeAsync(100);
        expect($('modal-filename').textContent).toBe('b.jpg');
    });

    it('does not auto-advance a looping clip', async () => {
        vi.useFakeTimers();
        localStorage.setItem('viewer-auto-advance', '1');
        localStorage.setItem('viewer-loop', '1');
        const mod = await load();
        state.files = [VIDEO(), FILE({ id: 2, name: 'b.jpg' })];
        mod.openMediaViewer(0);
        $('modal-video').onended();
        await vi.advanceTimersByTimeAsync(100);
        expect($('modal-filename').textContent).toBe('clip.mp4');
    });

    it('shows the spinner while buffering and hides it once playable', async () => {
        const { video } = await openVideo();
        video.oncanplay();
        expect($('video-spinner').classList.contains('hidden')).toBe(true);
        video.onwaiting();
        expect($('video-spinner').classList.contains('hidden')).toBe(false);
        video.onplaying();
        expect($('video-spinner').classList.contains('hidden')).toBe(true);
        video.onstalled();
        expect($('video-spinner').classList.contains('hidden')).toBe(false);
        video.onloadeddata();
        expect($('video-spinner').classList.contains('hidden')).toBe(true);
    });

    it('paints the duration label on a duration change', async () => {
        const { video } = await openVideo();
        video.duration = 3725;
        video.ondurationchange();
        expect($('video-duration').textContent).toBe('1:02:05');
    });

    it('renders buffered ranges as bars', async () => {
        const { video } = await openVideo();
        video.duration = 100;
        video.buffered = {
            length: 2,
            start: (i) => [0, 50][i],
            end: (i) => [20, 80][i],
        };
        video.onprogress();
        const bars = $('video-buffered-layer').querySelectorAll('div');
        expect(bars).toHaveLength(2);
        expect(bars[0].style.width).toBe('20%');
        expect(bars[1].style.left).toBe('50%');
    });

    it('skips buffered rendering for a clip of unknown duration', async () => {
        const { video } = await openVideo();
        video.buffered = { length: 1, start: () => 0, end: () => 10 };
        video.onprogress();
        expect($('video-buffered-layer').innerHTML).toBe('');
    });

    describe('errors', () => {
        it('silently retries a spurious unsupported-source error once', async () => {
            const { video } = await openVideo();
            video.error = { code: 4, message: 'src not supported' };
            video.onerror();
            expect($('video-error').classList.contains('hidden')).toBe(true);
            expect(video.getAttribute('src')).toContain('clip.mp4');

            // The second one is real — surface it.
            video.onerror();
            expect($('video-error').classList.contains('hidden')).toBe(false);
            expect($('video-error-msg').textContent).toContain('Error 4');
        });

        it('surfaces any other error immediately', async () => {
            const { video } = await openVideo();
            video.error = { code: 2, message: 'network' };
            video.onerror();
            expect($('video-error').classList.contains('hidden')).toBe(false);
            expect($('video-error-msg').textContent).toBe('Error 2: network');
        });

        it('handles an error event with no error object', async () => {
            const { video } = await openVideo();
            video.error = null;
            video.onerror();
            expect($('video-error-msg').textContent).toBe('Playback failed');
        });

        it('reloads the same source from the retry button', async () => {
            const { video } = await openVideo();
            video.error = { code: 2, message: 'network' };
            video.onerror();
            $('video-retry-btn').click();
            expect($('video-error').classList.contains('hidden')).toBe(true);
            expect(video.paused).toBe(false);
        });

        it('gives a fresh clip a fresh retry budget', async () => {
            const mod = await load();
            const video = $('modal-video');
            await openWith([VIDEO()], 0, mod);
            video.error = { code: 4, message: 'x' };
            video.onerror();
            video.onerror();
            expect($('video-error').classList.contains('hidden')).toBe(false);

            await openWith([VIDEO({ name: 'other.mp4' })], 0, mod);
            video.onerror();
            expect($('video-error').classList.contains('hidden')).toBe(true);
        });
    });

    describe('keyboard map', () => {
        async function openPlaying() {
            const mod = await openWith([VIDEO()], 0);
            mod.setupViewerEvents();
            const video = $('modal-video');
            video.duration = 100;
            video.currentTime = 50;
            return video;
        }

        it('toggles play on space and k', async () => {
            const video = await openPlaying();
            key({ key: ' ' });
            expect(video.paused).toBe(false);
            key({ key: 'k' });
            expect(video.paused).toBe(true);
        });

        it('seeks ten seconds with j and l', async () => {
            const video = await openPlaying();
            key({ key: 'l' });
            expect(video.currentTime).toBe(60);
            key({ key: 'j' });
            expect(video.currentTime).toBe(50);
        });

        it('doubles the arrow step with shift', async () => {
            const video = await openPlaying();
            key({ key: 'ArrowRight', shiftKey: true });
            expect(video.currentTime).toBe(60);
            key({ key: 'ArrowLeft', shiftKey: true });
            expect(video.currentTime).toBe(50);
        });

        it('nudges the volume with the up and down arrows', async () => {
            const video = await openPlaying();
            video.volume = 0.5;
            key({ key: 'ArrowUp' });
            expect(video.volume).toBeCloseTo(0.55);
            key({ key: 'ArrowDown' });
            expect(video.volume).toBeCloseTo(0.5);
        });

        it('mutes with m', async () => {
            const video = await openPlaying();
            key({ key: 'm' });
            expect(video.muted).toBe(true);
            video.volume = 0;
            key({ key: 'm' });
            expect(video.volume).toBe(0.5);
        });

        it('steps the speed with the comma and period keys', async () => {
            const video = await openPlaying();
            key({ key: '.' });
            expect(video.playbackRate).toBe(1.25);
            key({ key: ',' });
            expect(video.playbackRate).toBe(1);
        });

        it('clamps the speed to 0.25x..2x', async () => {
            const video = await openPlaying();
            for (let i = 0; i < 10; i++) key({ key: '.' });
            expect(video.playbackRate).toBe(2);
            for (let i = 0; i < 20; i++) key({ key: ',' });
            expect(video.playbackRate).toBe(0.25);
        });

        it('jumps to a decile with the number keys', async () => {
            const video = await openPlaying();
            key({ key: '3' });
            expect(video.currentTime).toBe(30);
            key({ key: '0' });
            expect(video.currentTime).toBe(0);
        });

        it('toggles fullscreen with f', async () => {
            const video = await openPlaying();
            key({ key: 'f' });
            await flush();
            expect($('video-container').requestFullscreen).toHaveBeenCalled();
            expect(video).toBeTruthy();
        });

        it('reports a refused fullscreen request', async () => {
            await openPlaying();
            $('video-container').requestFullscreen = vi.fn(() => Promise.reject(new Error('nope')));
            key({ key: 'f' });
            await flush();
            expect(showToast).toHaveBeenCalledWith(expect.stringContaining('nope'), 'error');
        });

        it('leaves unmapped keys alone', async () => {
            const video = await openPlaying();
            key({ key: 'z' });
            expect(video.currentTime).toBe(50);
        });
    });

    describe('picture-in-picture', () => {
        it('enters PiP', async () => {
            const { video } = await openVideo();
            $('video-pip-btn').click();
            await flush();
            expect(video.requestPictureInPicture).toHaveBeenCalled();
        });

        it('exits PiP when already in it', async () => {
            await openVideo();
            setPipElement($('modal-video'));
            document.exitPictureInPicture = vi.fn(() => Promise.resolve());
            $('video-pip-btn').click();
            await flush();
            expect(document.exitPictureInPicture).toHaveBeenCalled();
        });

        it('reports a refused PiP request', async () => {
            const { video } = await openVideo();
            video.requestPictureInPicture = vi.fn(() => Promise.reject(new Error('unsupported')));
            $('video-pip-btn').click();
            await flush();
            expect(showToast).toHaveBeenCalledWith(expect.stringContaining('unsupported'), 'error');
        });

        it('hides the button when the browser has no PiP', async () => {
            setPipEnabled(false);
            await openVideo();
            expect($('video-pip-btn').style.display).toBe('none');
        });

        it('honours the hide-PiP and hide-speed preferences', async () => {
            localStorage.setItem('viewer-hide-pip', '1');
            localStorage.setItem('viewer-hide-speed', '1');
            await openVideo();
            expect($('video-pip-btn').style.display).toBe('none');
            expect($('video-settings-btn').style.display).toBe('none');
        });
    });

    describe('seek bar', () => {
        function stubBarRect(width = 200, left = 0) {
            $('video-progress-container').getBoundingClientRect = () => ({
                left,
                width,
                top: 0,
                height: 4,
                right: left + width,
                bottom: 4,
            });
        }

        it('seeks to the pressed position and pauses while dragging', async () => {
            const { video } = await openVideo();
            stubBarRect();
            video.duration = 100;
            video.play();
            const bar = $('video-progress-container');
            bar.onpointerdown({ clientX: 50, pointerId: 1, preventDefault() {} });
            expect(video.currentTime).toBe(25);
            expect(video.paused).toBe(true);

            bar.onpointermove({ clientX: 150, pointerId: 1 });
            expect(video.currentTime).toBe(75);

            bar.onpointerup({ pointerId: 1 });
            expect(video.paused).toBe(false);
        });

        it('leaves a paused clip paused after a drag', async () => {
            const { video } = await openVideo();
            stubBarRect();
            video.duration = 100;
            const bar = $('video-progress-container');
            bar.onpointerdown({ clientX: 50, pointerId: 1, preventDefault() {} });
            bar.onpointerup({ pointerId: 1 });
            expect(video.paused).toBe(true);
        });

        it('clamps a press outside the bar', async () => {
            const { video } = await openVideo();
            stubBarRect();
            video.duration = 100;
            const bar = $('video-progress-container');
            bar.onpointerdown({ clientX: -500, pointerId: 1, preventDefault() {} });
            expect(video.currentTime).toBe(0);
            bar.onpointerdown({ clientX: 5000, pointerId: 1, preventDefault() {} });
            expect(video.currentTime).toBe(100);
        });

        it('ignores a move that is not part of a drag', async () => {
            const { video } = await openVideo();
            stubBarRect();
            video.duration = 100;
            video.currentTime = 10;
            $('video-progress-container').onpointermove({ clientX: 150 });
            expect(video.currentTime).toBe(10);
        });

        it('ignores a cancelled drag', async () => {
            const { video } = await openVideo();
            stubBarRect();
            video.duration = 100;
            const bar = $('video-progress-container');
            bar.onpointercancel({ pointerId: 1 });
            expect(video.paused).toBe(true);
        });

        it('shows a time-only tooltip when the sprite feature is off', async () => {
            stubFetch({ '/api/config': jsonRes({ advanced: { seekbar: { enabled: false } } }) });
            const { video } = await openVideo();
            await flush();
            stubBarRect();
            video.duration = 100;
            $('video-progress-container').onpointermove({ clientX: 100 });
            expect($('video-hover-time').textContent).toBe('00:50');
            expect($('video-hover-time').classList.contains('hidden')).toBe(false);
            expect($('video-sprite-preview').classList.contains('hidden')).toBe(true);
        });

        it('hides the tooltip when the pointer leaves', async () => {
            const { video } = await openVideo();
            stubBarRect();
            video.duration = 100;
            const bar = $('video-progress-container');
            bar.onpointermove({ clientX: 100 });
            bar.onpointerleave();
            expect($('video-hover-time').classList.contains('hidden')).toBe(true);
        });

        it('does not paint a hover preview for a clip of unknown duration', async () => {
            await openVideo();
            $('video-progress-container').onpointermove({ clientX: 100 });
            expect($('video-hover-time').classList.contains('hidden')).toBe(true);
        });
    });

    describe('sprite previews', () => {
        const META = {
            cols: 10,
            rows: 1,
            frames: 10,
            tile_w: 160,
            tile_h: 90,
            interval_sec: 10,
            duration_sec: 100,
        };

        async function openWithSprites(routes) {
            stubFetch({
                '/api/config': jsonRes({ advanced: { seekbar: { enabled: true } } }),
                ...routes,
            });
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            await flush();
            return mod;
        }

        it('goes to pending while the sidecar is still working', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes({}, 404) });
            expect($('video-sprite-preview').dataset.state).toBe('pending');
        });

        it('flips to ready once the sprite image loads', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes(META) });
            expect(images.length).toBeGreaterThan(0);
            images.at(-1).onload();
            expect($('video-sprite-preview').dataset.state).toBe('ready');
            expect($('video-sprite-frame').style.backgroundImage).toContain('/api/seekbar/sprite/');
        });

        it('re-polls when the sprite image 404s behind a 200 meta', async () => {
            vi.useFakeTimers();
            await openWithSprites({ '/api/seekbar/meta/': jsonRes(META) });
            globalThis.fetch.mockClear();
            images.at(-1).onerror();
            await vi.advanceTimersByTimeAsync(4001);
            const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.includes('/api/seekbar/meta/'))).toBe(true);
        });

        it('paints the sprite tile for the hovered position', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes(META) });
            images.at(-1).onload();
            const video = $('modal-video');
            video.duration = 100;
            $('video-progress-container').getBoundingClientRect = () => ({
                left: 0,
                width: 200,
                top: 0,
                height: 4,
                right: 200,
                bottom: 4,
            });
            // Halfway → frame 5 of a single-row strip.
            $('video-progress-container').onpointermove({ clientX: 100 });
            expect($('video-sprite-frame').style.backgroundPosition).toBe('-800px 0px');
            expect($('video-sprite-time').textContent).toBe('00:50');
            expect($('video-hover-time').classList.contains('hidden')).toBe(true);
        });

        it('stays disabled when the feature flag is off', async () => {
            stubFetch({
                '/api/config': jsonRes({ advanced: { seekbar: { enabled: false } } }),
                '/api/seekbar/meta/': jsonRes(META),
            });
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            await flush();
            expect($('video-sprite-preview').dataset.state).toBe('disabled');
            const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.includes('/api/seekbar/meta/'))).toBe(false);
        });

        it('stays disabled for a federated peer row', async () => {
            stubFetch({ '/api/config': jsonRes({ advanced: { seekbar: { enabled: true } } }) });
            const mod = await load();
            await openWith([VIDEO({ peer_id: 'node-2' })], 0, mod);
            await flush();
            expect($('video-sprite-preview').dataset.state).toBe('disabled');
        });

        it('gives up after an unexpected server error', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes({}, 500) });
            expect($('video-sprite-preview').dataset.state).toBe('disabled');
        });

        it('re-polls after a network blip', async () => {
            vi.useFakeTimers();
            stubFetch({ '/api/config': jsonRes({ advanced: { seekbar: { enabled: true } } }) });
            const mod = await load();
            const calls = [];
            const realFetch = globalThis.fetch;
            globalThis.fetch = vi.fn(async (url) => {
                calls.push(String(url));
                if (String(url).includes('/api/seekbar/meta/')) throw new Error('offline');
                return realFetch(url);
            });
            await openWith([VIDEO()], 0, mod);
            await flush();
            const before = calls.filter((u) => u.includes('/meta/')).length;
            await vi.advanceTimersByTimeAsync(4001);
            expect(calls.filter((u) => u.includes('/meta/')).length).toBeGreaterThan(before);
        });

        it('is re-poked by a matching seekbar_done event', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes({}, 404) });
            globalThis.fetch.mockClear();
            fireWs('seekbar_done', { download_id: 7 });
            await flush();
            const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.includes('/api/seekbar/meta/'))).toBe(true);
        });

        it('ignores a seekbar_done for a different clip', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes({}, 404) });
            globalThis.fetch.mockClear();
            fireWs('seekbar_done', { download_id: 999 });
            fireWs('seekbar_done', {});
            fireWs('seekbar_done', null);
            await flush();
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('re-reads the feature flag after a config change', async () => {
            await openWithSprites({ '/api/seekbar/meta/': jsonRes({}, 404) });
            globalThis.fetch.mockClear();
            fireWs('config_updated', {});
            const mod2 = await import('../src/web/public/js/viewer.js');
            await openWith([VIDEO({ id: 8 })], 0, mod2);
            await flush();
            const urls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.includes('/api/config'))).toBe(true);
        });
    });

    describe('controls visibility', () => {
        it('hides the controls after the configured delay while playing', async () => {
            vi.useFakeTimers();
            localStorage.setItem('viewer-hide-delay', '3');
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.play();
            video.onplay();
            await vi.advanceTimersByTimeAsync(3001);
            expect($('video-controls').style.opacity).toBe('0');
            expect($('video-container').style.cursor).toBe('none');
        });

        it('keeps the controls up while the clip is paused', async () => {
            vi.useFakeTimers();
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            $('video-container').onpointermove({ pointerType: 'mouse' });
            await vi.advanceTimersByTimeAsync(10_000);
            expect($('video-controls').style.opacity).toBe('1');
        });

        it('keeps the controls up while the speed menu is open', async () => {
            vi.useFakeTimers();
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.play();
            $('video-speed-menu').classList.remove('hidden');
            $('video-container').onpointermove({ pointerType: 'mouse' });
            await vi.advanceTimersByTimeAsync(10_000);
            expect($('video-controls').style.opacity).toBe('1');
        });

        it('ignores touch pointer moves', async () => {
            vi.useFakeTimers();
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            $('video-controls').style.opacity = '0';
            $('video-container').onpointermove({ pointerType: 'touch' });
            expect($('video-controls').style.opacity).toBe('0');
        });

        it('schedules a fast hide when the cursor leaves a playing clip', async () => {
            vi.useFakeTimers();
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.play();
            $('video-container').onpointerleave();
            await vi.advanceTimersByTimeAsync(801);
            expect($('video-controls').style.opacity).toBe('0');
        });

        it('toggles play on a tap and reveals hidden controls first', async () => {
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            const tap = $('video-tap-layer');
            $('video-controls').style.opacity = '0';
            tap.onpointerdown({ clientX: 10 });
            tap.onclick({ stopPropagation() {} });
            // First tap only brings the chrome back.
            expect(video.paused).toBe(true);
            expect($('video-controls').style.opacity).toBe('1');

            tap.onpointerdown({ clientX: 10 });
            tap.onclick({ stopPropagation() {} });
            expect(video.paused).toBe(false);
        });

        it('double-tap toggles fullscreen unless the user disabled it', async () => {
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const tap = $('video-tap-layer');
            tap.ondblclick({ stopPropagation() {} });
            await flush();
            expect($('video-container').requestFullscreen).toHaveBeenCalledTimes(1);

            localStorage.setItem('viewer-dbl-tap-fs', '0');
            tap.ondblclick({ stopPropagation() {} });
            await flush();
            expect($('video-container').requestFullscreen).toHaveBeenCalledTimes(1);
        });

        it('swaps the fullscreen icon when the browser reports a change', async () => {
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            setFullscreenElement($('video-container'));
            document.dispatchEvent(new window.Event('fullscreenchange'));
            expect($('video-fullscreen-btn').innerHTML).toContain('ri-fullscreen-exit-line');
            setFullscreenElement(null);
            document.dispatchEvent(new window.Event('fullscreenchange'));
            expect($('video-fullscreen-btn').innerHTML).toContain('ri-fullscreen-line');
        });
    });

    describe('touch devices', () => {
        const touchMatchMedia = () => () => ({ matches: false, addEventListener() {} });

        it('double-taps one side of the frame to seek', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(500_000);
            const mod = await load({ matchMedia: touchMatchMedia() });
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.duration = 100;
            video.currentTime = 50;
            const tap = $('video-tap-layer');
            tap.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 100 });

            tap.onpointerdown({ clientX: 150 });
            vi.setSystemTime(500_100);
            tap.onpointerdown({ clientX: 150 });
            expect(video.currentTime).toBe(55);
            expect($('video-seek-fwd-label').textContent).toBe('5s');
            expect($('video-seek-fwd-overlay').style.opacity).toBe('1');

            await vi.advanceTimersByTimeAsync(601);
            expect($('video-seek-fwd-overlay').style.opacity).toBe('0');
        });

        it('rewinds on a double-tap of the left half', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(500_000);
            const mod = await load({ matchMedia: touchMatchMedia() });
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.duration = 100;
            video.currentTime = 50;
            const tap = $('video-tap-layer');
            tap.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 100 });
            tap.onpointerdown({ clientX: 20 });
            vi.setSystemTime(500_100);
            tap.onpointerdown({ clientX: 20 });
            expect(video.currentTime).toBe(45);
            expect($('video-seek-back-label').textContent).toBe('5s');
        });

        it('treats two slow taps as separate taps', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(500_000);
            const mod = await load({ matchMedia: touchMatchMedia() });
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.duration = 100;
            video.currentTime = 50;
            const tap = $('video-tap-layer');
            tap.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 100 });
            tap.onpointerdown({ clientX: 150 });
            vi.setSystemTime(500_800);
            tap.onpointerdown({ clientX: 150 });
            expect(video.currentTime).toBe(50);
        });

        it('never auto-hides the controls', async () => {
            vi.useFakeTimers();
            const mod = await load({ matchMedia: touchMatchMedia() });
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.play();
            video.onplay();
            await vi.advanceTimersByTimeAsync(30_000);
            expect($('video-controls').style.opacity).toBe('1');
        });
    });

    describe('unload', () => {
        it('stops the clip and clears the transport state', async () => {
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            video.play();
            mod.closeMediaViewer();
            expect(video.paused).toBe(true);
            expect(video.getAttribute('src')).toBeNull();
            expect($('video-speed-menu').classList.contains('hidden')).toBe(true);
            expect($('video-spinner').classList.contains('hidden')).toBe(true);
        });

        it('leaves picture-in-picture behind', async () => {
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            setPipElement($('modal-video'));
            document.exitPictureInPicture = vi.fn(() => Promise.resolve());
            mod.closeMediaViewer();
            expect(document.exitPictureInPicture).toHaveBeenCalled();
        });

        it('cancels a pending sprite poll', async () => {
            vi.useFakeTimers();
            stubFetch({
                '/api/config': jsonRes({ advanced: { seekbar: { enabled: true } } }),
                '/api/seekbar/meta/': jsonRes({}, 404),
            });
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            await vi.advanceTimersByTimeAsync(1);
            mod.closeMediaViewer();
            globalThis.fetch.mockClear();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect($('video-sprite-preview').dataset.state).toBe('disabled');
        });

        it('re-arms the error handler for the next clip', async () => {
            const mod = await load();
            await openWith([VIDEO()], 0, mod);
            const video = $('modal-video');
            mod.closeMediaViewer();
            expect(typeof video.onerror).toBe('function');
        });
    });
});
