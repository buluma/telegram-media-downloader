// @vitest-environment jsdom
//
// Covers src/web/public/js/viewer-text.js — the text/code/markdown
// preview helpers, the byte-capped fetch that protects the tab from a
// multi-GB log, and the lazy CDN loaders.
//
// Two things are simulated here:
//   - jsdom never actually fetches <script>/<link> resources, so
//     document.head.appendChild is stubbed to fire onload (or onerror)
//     on the injected element. That is exactly what _loadScript and
//     _loadStylesheet wait on.
//   - fetch responses are hand-built with the streaming shape
//     fetchTextCapped consumes (headers.get + body.getReader), so the
//     mid-stream abort path is exercised for real rather than mocked out.
//
// The CDN-load promises are memoised at module scope, so every test
// re-imports through vi.resetModules().

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function loadModule() {
    vi.resetModules();
    return import('../src/web/public/js/viewer-text.js');
}

/** Make script/stylesheet injection resolve (or fail) without a network. */
function stubResourceLoading({ fail = false } = {}) {
    return vi.spyOn(document.head, 'appendChild').mockImplementation((el) => {
        queueMicrotask(() =>
            fail ? el.onerror?.(new Event('error')) : el.onload?.(new Event('load')),
        );
        return el;
    });
}

const enc = (s) => new TextEncoder().encode(s);

/**
 * Build a Response-alike. `chunks` drives the streaming reader; pass
 * `body: null` to exercise the no-stream fallback.
 */
function makeResponse({
    ok = true,
    status = 200,
    contentLength = null,
    chunks = [enc('hello')],
    body = undefined,
    text = 'hello',
} = {}) {
    let i = 0;
    const reader = {
        read: async () =>
            i < chunks.length
                ? { value: chunks[i++], done: false }
                : { value: undefined, done: true },
    };
    return {
        ok,
        status,
        headers: { get: (h) => (h === 'content-length' ? contentLength : null) },
        body: body === null ? null : { getReader: () => reader },
        text: async () => text,
    };
}

function mockFetch(response) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

describe('langFromExt', () => {
    it('maps known extensions to highlight.js language ids', async () => {
        const { langFromExt } = await loadModule();
        expect(langFromExt('js')).toBe('javascript');
        expect(langFromExt('mjs')).toBe('javascript');
        expect(langFromExt('ts')).toBe('typescript');
        expect(langFromExt('py')).toBe('python');
        expect(langFromExt('yml')).toBe('yaml');
        expect(langFromExt('svg')).toBe('xml');
        expect(langFromExt('env')).toBe('ini');
    });

    it('is case-insensitive', async () => {
        const { langFromExt } = await loadModule();
        expect(langFromExt('JS')).toBe('javascript');
        expect(langFromExt('Py')).toBe('python');
    });

    it('returns null for anything unmapped so hljs auto-detects', async () => {
        const { langFromExt } = await loadModule();
        expect(langFromExt('zzz')).toBeNull();
        expect(langFromExt('')).toBeNull();
        expect(langFromExt(null)).toBeNull();
        expect(langFromExt(undefined)).toBeNull();
    });
});

describe('lazy CDN loaders', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete window.hljs;
        delete window.marked;
        delete window.DOMPurify;
    });

    it('returns the global immediately when the library is already present', async () => {
        const spy = stubResourceLoading();
        window.hljs = { tag: 'already-here' };
        const { ensureHljs } = await loadModule();
        await expect(ensureHljs()).resolves.toEqual({ tag: 'already-here' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('injects the script and stylesheet for highlight.js', async () => {
        const spy = stubResourceLoading();
        const { ensureHljs } = await loadModule();
        const p = ensureHljs();
        window.hljs = { ready: true };
        await expect(p).resolves.toEqual({ ready: true });

        const injected = spy.mock.calls.map(([el]) => el);
        expect(injected.some((el) => el.tagName === 'SCRIPT' && el.src.includes('highlight'))).toBe(
            true,
        );
        expect(injected.some((el) => el.tagName === 'LINK' && el.rel === 'stylesheet')).toBe(true);
    });

    it('memoises the in-flight load instead of injecting twice', async () => {
        const spy = stubResourceLoading();
        const { ensureMarked } = await loadModule();
        const a = ensureMarked();
        const b = ensureMarked();
        window.marked = { parse: () => '' };
        await Promise.all([a, b]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('clears the memo on failure so a later call can retry', async () => {
        const failing = stubResourceLoading({ fail: true });
        const { ensureDomPurify } = await loadModule();
        await expect(ensureDomPurify()).rejects.toThrow(/Failed to load/);
        failing.mockRestore();

        const ok = stubResourceLoading();
        const p = ensureDomPurify();
        window.DOMPurify = { sanitize: (s) => s };
        await expect(p).resolves.toEqual({ sanitize: expect.any(Function) });
        expect(ok).toHaveBeenCalled();
    });

    it('rejects when the marked CDN is unreachable', async () => {
        stubResourceLoading({ fail: true });
        const { ensureMarked } = await loadModule();
        await expect(ensureMarked()).rejects.toThrow(/Failed to load/);
    });
});

describe('fetchTextCapped', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns the decoded body under the cap', async () => {
        const { fetchTextCapped } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('hello '), enc('world')] }));
        const out = await fetchTextCapped('/files/a.txt', 1024);
        expect(out).toEqual({ text: 'hello world', truncated: false, size: 11 });
    });

    it('sends same-origin credentials', async () => {
        const { fetchTextCapped } = await loadModule();
        const spy = mockFetch(makeResponse());
        await fetchTextCapped('/files/a.txt', 1024);
        expect(spy.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
    });

    it('throws on a non-ok response', async () => {
        const { fetchTextCapped } = await loadModule();
        mockFetch(makeResponse({ ok: false, status: 404 }));
        await expect(fetchTextCapped('/files/a.txt', 1024)).rejects.toThrow('HTTP 404');
    });

    it('short-circuits on an oversized content-length without reading the body', async () => {
        const { fetchTextCapped } = await loadModule();
        const res = makeResponse({ contentLength: '99999' });
        const readerSpy = vi.spyOn(res.body, 'getReader');
        mockFetch(res);

        const out = await fetchTextCapped('/files/big.log', 1024);
        expect(out).toEqual({ text: '', truncated: true, size: 99999 });
        expect(readerSpy).not.toHaveBeenCalled();
    });

    it('still streams when content-length is absent or unparseable', async () => {
        const { fetchTextCapped } = await loadModule();
        mockFetch(makeResponse({ contentLength: 'unknown', chunks: [enc('abc')] }));
        const out = await fetchTextCapped('/files/a.txt', 1024);
        expect(out.truncated).toBe(false);
        expect(out.text).toBe('abc');
    });

    it('aborts mid-stream once the running total passes the cap', async () => {
        const { fetchTextCapped } = await loadModule();
        // 3 x 10 bytes against an 18-byte cap: trips on the second chunk.
        const chunks = [enc('0123456789'), enc('0123456789'), enc('0123456789')];
        const res = makeResponse({ chunks });
        const readSpy = vi.spyOn(res.body.getReader(), 'read');
        mockFetch(res);

        const out = await fetchTextCapped('/files/big.log', 18);
        expect(out).toEqual({ text: '', truncated: true, size: 20 });
        // The third chunk is never requested.
        expect(readSpy.mock.calls.length).toBeLessThan(3);
    });

    it('accepts a payload exactly at the cap', async () => {
        const { fetchTextCapped } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('0123456789')] }));
        const out = await fetchTextCapped('/files/a.txt', 10);
        expect(out.truncated).toBe(false);
        expect(out.size).toBe(10);
    });

    it('falls back to res.text() when the response exposes no stream', async () => {
        const { fetchTextCapped } = await loadModule();
        mockFetch(makeResponse({ body: null, text: 'plain body' }));
        const out = await fetchTextCapped('/files/a.txt', 1024);
        expect(out).toEqual({ text: 'plain body', truncated: false, size: 10 });
    });

    it('decodes multi-byte UTF-8 split across chunk boundaries', async () => {
        const { fetchTextCapped } = await loadModule();
        const full = enc('héllo wörld');
        const chunks = [full.slice(0, 3), full.slice(3)];
        mockFetch(makeResponse({ chunks }));
        const out = await fetchTextCapped('/files/a.txt', 1024);
        expect(out.text).toBe('héllo wörld');
    });

    it('propagates a network failure', async () => {
        const { fetchTextCapped } = await loadModule();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        await expect(fetchTextCapped('/files/a.txt', 1024)).rejects.toThrow('offline');
    });
});

describe('renderTextInto', () => {
    let preEl;
    let statusEl;

    beforeEach(() => {
        document.body.innerHTML = '<pre id="pre"></pre><div id="status"></div>';
        preEl = document.getElementById('pre');
        statusEl = document.getElementById('status');
    });
    afterEach(() => vi.restoreAllMocks());

    it('drops the text in as textContent, never as markup', async () => {
        const { renderTextInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('<b>not bold</b>')] }));
        await renderTextInto({ preEl, statusEl, url: '/f' });
        expect(preEl.querySelector('b')).toBeNull();
        expect(preEl.textContent).toBe('<b>not bold</b>');
    });

    it('reports the loaded size through onLoaded', async () => {
        const { renderTextInto } = await loadModule();
        const onLoaded = vi.fn();
        mockFetch(makeResponse({ chunks: [enc('hello')] }));
        await renderTextInto({ preEl, statusEl, url: '/f', onLoaded });
        expect(onLoaded).toHaveBeenCalledWith({ text: 'hello', size: 5 });
    });

    it('paints the too-large placeholder with both sizes and a download link', async () => {
        const { renderTextInto } = await loadModule();
        mockFetch(makeResponse({ contentLength: String(8 * 1024 * 1024) }));
        await renderTextInto({
            preEl,
            statusEl,
            url: '/f',
            downloadUrl: '/files/big.log',
            fileName: 'big.log',
            maxBytes: 5 * 1024 * 1024,
        });
        expect(preEl.textContent).toBe('');
        expect(statusEl.textContent).toContain('8.0 MB');
        expect(statusEl.textContent).toContain('cap 5.0 MB');
        expect(statusEl.querySelector('a').getAttribute('href')).toBe('/files/big.log');
    });

    it('omits the download link when no downloadUrl is given', async () => {
        const { renderTextInto } = await loadModule();
        mockFetch(makeResponse({ contentLength: '99999999' }));
        await renderTextInto({ preEl, statusEl, url: '/f', fileName: 'big.log' });
        expect(statusEl.querySelector('a')).toBeNull();
    });

    it('escapes the file name in the placeholder', async () => {
        const { renderTextInto } = await loadModule();
        mockFetch(makeResponse({ contentLength: '99999999' }));
        await renderTextInto({ preEl, statusEl, url: '/f', fileName: '<img src=x>' });
        expect(statusEl.querySelector('img')).toBeNull();
        expect(statusEl.textContent).toContain('<img src=x>');
    });

    it('shows the error placeholder on a failed fetch', async () => {
        const { renderTextInto } = await loadModule();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        await renderTextInto({ preEl, statusEl, url: '/f', fileName: 'a.txt' });
        expect(preEl.textContent).toBe('');
        expect(statusEl.textContent).toContain('offline');
        expect(statusEl.textContent).toContain('a.txt');
    });

    it('clears any previous content before loading', async () => {
        const { renderTextInto } = await loadModule();
        preEl.textContent = 'stale output';
        statusEl.textContent = 'stale status';
        mockFetch(makeResponse({ chunks: [enc('fresh')] }));
        await renderTextInto({ preEl, statusEl, url: '/f' });
        expect(preEl.textContent).toBe('fresh');
    });

    it('does nothing without a target element', async () => {
        const { renderTextInto } = await loadModule();
        const spy = mockFetch(makeResponse());
        await expect(renderTextInto({ url: '/f' })).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });

    it('tolerates a missing statusEl on the error path', async () => {
        const { renderTextInto } = await loadModule();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        await expect(renderTextInto({ preEl, url: '/f' })).resolves.toBeUndefined();
    });
});

describe('renderCodeInto', () => {
    let codeEl;
    let statusEl;

    beforeEach(() => {
        document.body.innerHTML = '<code id="code"></code><div id="status"></div>';
        codeEl = document.getElementById('code');
        statusEl = document.getElementById('status');
        window.hljs = { highlightElement: vi.fn() };
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete window.hljs;
    });

    it('sets the language class from the extension and highlights', async () => {
        const { renderCodeInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('const a = 1;')] }));
        await renderCodeInto({ codeEl, statusEl, url: '/f', ext: 'js' });
        expect(codeEl.className).toBe('language-javascript');
        expect(window.hljs.highlightElement).toHaveBeenCalledWith(codeEl);
        expect(codeEl.textContent).toBe('const a = 1;');
    });

    it('leaves the class empty for an unmapped extension so hljs auto-detects', async () => {
        const { renderCodeInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('x')] }));
        await renderCodeInto({ codeEl, statusEl, url: '/f', ext: 'zzz' });
        expect(codeEl.className).toBe('');
        expect(window.hljs.highlightElement).toHaveBeenCalled();
    });

    it('clears the highlighted marker so re-renders do not compound', async () => {
        const { renderCodeInto } = await loadModule();
        codeEl.setAttribute('data-highlighted', 'yes');
        mockFetch(makeResponse({ chunks: [enc('x')] }));
        await renderCodeInto({ codeEl, statusEl, url: '/f', ext: 'js' });
        expect(codeEl.hasAttribute('data-highlighted')).toBe(false);
    });

    it('still shows readable plain text when the highlighter is unavailable', async () => {
        delete window.hljs;
        stubResourceLoading({ fail: true });
        const { renderCodeInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('const a = 1;')] }));
        await renderCodeInto({ codeEl, statusEl, url: '/f', ext: 'js' });
        expect(codeEl.textContent).toBe('const a = 1;');
    });

    it('passes the resolved language to onLoaded', async () => {
        const { renderCodeInto } = await loadModule();
        const onLoaded = vi.fn();
        mockFetch(makeResponse({ chunks: [enc('x')] }));
        await renderCodeInto({ codeEl, statusEl, url: '/f', ext: 'py', onLoaded });
        expect(onLoaded).toHaveBeenCalledWith({ text: 'x', size: 1, lang: 'python' });
    });

    it('paints the too-large placeholder past the 2 MB code cap', async () => {
        const { renderCodeInto } = await loadModule();
        mockFetch(makeResponse({ contentLength: String(3 * 1024 * 1024) }));
        await renderCodeInto({ codeEl, statusEl, url: '/f', fileName: 'big.js', ext: 'js' });
        expect(codeEl.textContent).toBe('');
        expect(statusEl.textContent).toContain('cap 2.0 MB');
    });

    it('shows the error placeholder on a failed fetch', async () => {
        const { renderCodeInto } = await loadModule();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
        await renderCodeInto({ codeEl, statusEl, url: '/f', fileName: 'a.js' });
        expect(codeEl.textContent).toBe('');
        expect(statusEl.textContent).toContain('boom');
    });

    it('does nothing without a target element', async () => {
        const { renderCodeInto } = await loadModule();
        const spy = mockFetch(makeResponse());
        await expect(renderCodeInto({ url: '/f' })).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('renderMarkdownInto', () => {
    let targetEl;
    let statusEl;

    beforeEach(() => {
        document.body.innerHTML = '<div id="target"></div><div id="status"></div>';
        targetEl = document.getElementById('target');
        statusEl = document.getElementById('status');
        window.marked = { parse: vi.fn((src) => `<h1>${src}</h1>`) };
        window.DOMPurify = { sanitize: vi.fn((html) => html) };
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete window.marked;
        delete window.DOMPurify;
    });

    it('renders parsed markdown through the sanitiser', async () => {
        const { renderMarkdownInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('# Title')] }));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f' });
        expect(window.marked.parse).toHaveBeenCalledWith('# Title', { breaks: true, gfm: true });
        expect(window.DOMPurify.sanitize).toHaveBeenCalled();
        expect(targetEl.querySelector('h1').textContent).toBe('# Title');
    });

    it('asks DOMPurify to strip inline event handlers', async () => {
        const { renderMarkdownInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('x')] }));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f' });
        expect(window.DOMPurify.sanitize.mock.calls[0][1]).toMatchObject({
            USE_PROFILES: { html: true },
            FORBID_ATTR: ['onerror', 'onload', 'onclick'],
        });
    });

    it('injects the sanitiser output, not the raw parse output', async () => {
        const { renderMarkdownInto } = await loadModule();
        window.DOMPurify.sanitize = vi.fn(() => '<p>scrubbed</p>');
        mockFetch(makeResponse({ chunks: [enc('<script>alert(1)</script>')] }));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f' });
        expect(targetEl.innerHTML).toBe('<p>scrubbed</p>');
    });

    it('falls back to escaped plain text when the CDN is blocked', async () => {
        delete window.marked;
        delete window.DOMPurify;
        stubResourceLoading({ fail: true });
        const { renderMarkdownInto } = await loadModule();
        mockFetch(makeResponse({ chunks: [enc('# Title <img src=x>')] }));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f' });
        expect(targetEl.querySelector('img')).toBeNull();
        expect(targetEl.querySelector('pre').textContent).toBe('# Title <img src=x>');
    });

    it('paints the too-large placeholder past the cap', async () => {
        const { renderMarkdownInto } = await loadModule();
        mockFetch(makeResponse({ contentLength: String(9 * 1024 * 1024) }));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f', fileName: 'big.md' });
        expect(targetEl.innerHTML).toBe('');
        expect(statusEl.textContent).toContain('big.md');
    });

    it('shows the error placeholder on a failed fetch', async () => {
        const { renderMarkdownInto } = await loadModule();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('gone'));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f', fileName: 'a.md' });
        expect(targetEl.innerHTML).toBe('');
        expect(statusEl.textContent).toContain('gone');
    });

    it('reports the loaded size through onLoaded', async () => {
        const { renderMarkdownInto } = await loadModule();
        const onLoaded = vi.fn();
        mockFetch(makeResponse({ chunks: [enc('# T')] }));
        await renderMarkdownInto({ targetEl, statusEl, url: '/f', onLoaded });
        expect(onLoaded).toHaveBeenCalledWith({ text: '# T', size: 3 });
    });

    it('does nothing without a target element', async () => {
        const { renderMarkdownInto } = await loadModule();
        const spy = mockFetch(makeResponse());
        await expect(renderMarkdownInto({ url: '/f' })).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });
});
