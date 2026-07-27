// @vitest-environment jsdom
//
// Covers src/web/public/js/changelog-viewer.js — the in-app CHANGELOG
// sheet: the tiny inline Markdown subset, latest-version-section
// extraction, cache-busted fetch (in-memory cache, once per session),
// and the trigger wiring on the status-bar version chip.
//
// sheet.js is mocked; global fetch is mocked per test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const openSheet = vi.fn();
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet }));

function sheetImpl(opts) {
    const root = document.createElement('div');
    root.appendChild(opts.content);
    document.body.appendChild(root);
    return { body: root, opts, close: vi.fn() };
}

function mockFetch(handlers) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        for (const [match, respond] of handlers) {
            if (typeof match === 'string' ? url === match : match.test(url)) return respond();
        }
        return Promise.resolve({ ok: false, status: 404 });
    });
}

async function loadModule() {
    vi.resetModules();
    document.body.innerHTML = '';
    openSheet.mockImplementation(sheetImpl);
    return import('../src/web/public/js/changelog-viewer.js');
}

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

// resetAllMocks (not restoreAllMocks): the latter only undoes vi.spyOn
// wrappers (the per-test fetch mocks) — it leaves openSheet's call
// history from previous tests in place, which is what made
// `openSheet.mock.results[0]` silently resolve to the FIRST test's sheet
// in every later test. Using .at(-1) fixes the indexing either way, but
// resetting here keeps the mock state actually scoped to one test.
beforeEach(() => vi.resetAllMocks());

describe('openChangelogViewer', () => {
    it('shows a loading placeholder immediately, before the fetch resolves', async () => {
        const { openChangelogViewer } = await loadModule();
        mockFetch([
            [/\/api\/version/, () => new Promise(() => {})],
            [/\/CHANGELOG\.md/, () => new Promise(() => {})],
        ]);
        openChangelogViewer();
        expect(openSheet).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Release notes', size: 'lg' }),
        );
        const body = openSheet.mock.results.at(-1).value.body;
        expect(body.textContent).toContain('Loading…');
    });

    it('renders the latest version section and a link to the full history', async () => {
        const { openChangelogViewer } = await loadModule();
        mockFetch([
            [
                /\/api\/version/,
                () => Promise.resolve({ ok: true, json: async () => ({ commit: 'abc123' }) }),
            ],
            [
                /\/CHANGELOG\.md/,
                () =>
                    Promise.resolve({
                        ok: true,
                        text: async () =>
                            '## [Unreleased]\n\n## [1.2.0]\n- Added thing\n\n## [1.1.0]\n- Old thing',
                    }),
            ],
        ]);
        await openChangelogViewer();
        await flush();
        const body = openSheet.mock.results.at(-1).value.body;
        expect(body.innerHTML).toContain('<h3 class="cl-version">[1.2.0]</h3>');
        expect(body.innerHTML).toContain('<li>Added thing</li>');
        expect(body.innerHTML).not.toContain('Old thing');
        expect(body.querySelector('a[href$="CHANGELOG.md"]')).not.toBeNull();
        expect(body.textContent).toContain('View full changelog');
    });

    it('busts the cache with the running commit', async () => {
        const { openChangelogViewer } = await loadModule();
        const fetchSpy = mockFetch([
            [
                /\/api\/version/,
                () => Promise.resolve({ ok: true, json: async () => ({ commit: 'deadbeef' }) }),
            ],
            [
                /\/CHANGELOG\.md/,
                () => Promise.resolve({ ok: true, text: async () => '## [1.0.0]\n- x' }),
            ],
        ]);
        await openChangelogViewer();
        await flush();
        expect(fetchSpy).toHaveBeenCalledWith(
            '/CHANGELOG.md?v=deadbeef',
            expect.objectContaining({ credentials: 'same-origin' }),
        );
    });

    it('skips the cache-bust query when the commit is "dev"', async () => {
        const { openChangelogViewer } = await loadModule();
        const fetchSpy = mockFetch([
            [
                /\/api\/version/,
                () => Promise.resolve({ ok: true, json: async () => ({ commit: 'dev' }) }),
            ],
            [
                /\/CHANGELOG\.md/,
                () => Promise.resolve({ ok: true, text: async () => '## [1.0.0]\n- x' }),
            ],
        ]);
        await openChangelogViewer();
        await flush();
        expect(fetchSpy).toHaveBeenCalledWith(
            '/CHANGELOG.md',
            expect.objectContaining({ credentials: 'same-origin' }),
        );
    });

    it('still fetches the changelog when the version probe fails', async () => {
        const { openChangelogViewer } = await loadModule();
        const fetchSpy = mockFetch([
            [/\/api\/version/, () => Promise.reject(new Error('down'))],
            [
                /\/CHANGELOG\.md/,
                () => Promise.resolve({ ok: true, text: async () => '## [1.0.0]\n- x' }),
            ],
        ]);
        await openChangelogViewer();
        await flush();
        expect(fetchSpy).toHaveBeenCalledWith('/CHANGELOG.md', expect.anything());
    });

    it('shows an error message instead of throwing on a failed fetch', async () => {
        const { openChangelogViewer } = await loadModule();
        mockFetch([
            [/\/api\/version/, () => Promise.resolve({ ok: false })],
            [/\/CHANGELOG\.md/, () => Promise.resolve({ ok: false, status: 500 })],
        ]);
        await openChangelogViewer();
        await flush();
        const body = openSheet.mock.results.at(-1).value.body;
        expect(body.textContent).toContain('HTTP 500');
    });

    it('caches the fetched changelog across repeated opens within a session', async () => {
        const { openChangelogViewer } = await loadModule();
        const fetchSpy = mockFetch([
            [
                /\/api\/version/,
                () => Promise.resolve({ ok: true, json: async () => ({ commit: 'aaa' }) }),
            ],
            [
                /\/CHANGELOG\.md/,
                () => Promise.resolve({ ok: true, text: async () => '## [1.0.0]\n- x' }),
            ],
        ]);
        await openChangelogViewer();
        await flush();
        const callsAfterFirst = fetchSpy.mock.calls.length;
        await openChangelogViewer();
        await flush();
        expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst); // no new network calls
    });
});

describe('markdown subset (via the rendered sheet)', () => {
    async function render(md) {
        const { openChangelogViewer } = await loadModule();
        mockFetch([
            [
                /\/api\/version/,
                () => Promise.resolve({ ok: true, json: async () => ({ commit: 'dev' }) }),
            ],
            [/\/CHANGELOG\.md/, () => Promise.resolve({ ok: true, text: async () => md })],
        ]);
        await openChangelogViewer();
        await flush();
        return openSheet.mock.results.at(-1).value.body;
    }

    it('renders ## / ### as h3/h4 inside a version section', async () => {
        const body = await render('## [1.0.0]\n### Fixed');
        expect(body.innerHTML).toContain('<h3 class="cl-version">[1.0.0]</h3>');
        expect(body.innerHTML).toContain('<h4>Fixed</h4>');
    });

    it('renders a top-level # as h2 (only reachable via the no-version-heading fallback)', async () => {
        // `_latestVersionSection` drops everything before the first
        // `## [` it finds, so a `# Title` ahead of a real version section
        // never survives to mdToHtml — it isn't a bug, it's the "just show
        // me what's new" behaviour the fallback comment describes. Only
        // exercise h2 in text that has no `## [` heading at all, so the
        // whole document passes through unmodified.
        const body = await render('# Title\n### Fixed');
        expect(body.innerHTML).toContain('<h2>Title</h2>');
        expect(body.innerHTML).toContain('<h4>Fixed</h4>');
    });

    it('groups consecutive bullets into one <ul>, closing it before other content', async () => {
        const body = await render('## [1.0.0]\n- one\n- two\n\nplain text\n- three');
        const html = body.innerHTML;
        expect((html.match(/<ul>/g) || []).length).toBe(2);
        expect(html).toContain('<li>one</li>');
        expect(html).toContain('<li>two</li>');
        expect(html).toContain('<p>plain text</p>');
        expect(html).toContain('<li>three</li>');
    });

    it('accepts both - and * as bullet markers', async () => {
        const body = await render('## [1.0.0]\n- dash\n* star');
        expect(body.innerHTML).toContain('<li>dash</li>');
        expect(body.innerHTML).toContain('<li>star</li>');
    });

    it('renders inline code, bold and emphasis', async () => {
        const body = await render('## [1.0.0]\n- Uses `npm test` for **CI** and *style*.');
        const html = body.innerHTML;
        expect(html).toContain('<code>npm test</code>');
        expect(html).toContain('<strong>CI</strong>');
        expect(html).toContain('<em>style</em>');
    });

    it('does not mistake bold markers for emphasis', async () => {
        const body = await render('## [1.0.0]\n- **only bold**');
        expect(body.innerHTML).toContain('<strong>only bold</strong>');
        expect(body.innerHTML).not.toContain('<em>');
    });

    it('links to an http(s) URL, but neutralises anything else', async () => {
        const body = await render(
            '## [1.0.0]\n- See [docs](https://example.com/x) and [bad](javascript:alert(1))',
        );
        const links = body.querySelectorAll('a');
        expect(links[0].getAttribute('href')).toBe('https://example.com/x');
        expect(links[0].target).toBe('_blank');
        expect(links[0].rel).toContain('noopener');
        expect(links[1].getAttribute('href')).toBe('#');
    });

    it('escapes raw HTML in the source instead of rendering it', async () => {
        const body = await render('## [1.0.0]\n- <img src=x onerror=alert(1)>');
        expect(body.querySelectorAll('img')).toHaveLength(0);
        expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('falls back to the whole document when no ## [version] heading exists', async () => {
        const body = await render('Just a plain paragraph with no headings.');
        expect(body.textContent).toContain('Just a plain paragraph with no headings.');
    });

    it('skips [Unreleased] in favour of the first real version section', async () => {
        const body = await render('## [Unreleased]\n- wip\n\n## [2.0.0]\n- shipped');
        expect(body.textContent).not.toContain('wip');
        expect(body.textContent).toContain('shipped');
    });

    it('is case-insensitive when detecting the Unreleased heading', async () => {
        const body = await render('## [unreleased]\n- wip\n\n## [2.0.0]\n- shipped');
        expect(body.textContent).not.toContain('wip');
    });
});

describe('wireChangelogTrigger', () => {
    it('does nothing when the version chip is absent', async () => {
        const { wireChangelogTrigger } = await loadModule();
        expect(() => wireChangelogTrigger()).not.toThrow();
    });

    it('opens the changelog sheet on a plain click and prevents navigation', async () => {
        const { wireChangelogTrigger } = await loadModule();
        document.body.innerHTML = '<a id="status-version" href="#"></a>';
        mockFetch([
            [
                /\/api\/version/,
                () => Promise.resolve({ ok: true, json: async () => ({ commit: 'dev' }) }),
            ],
            [
                /\/CHANGELOG\.md/,
                () => Promise.resolve({ ok: true, text: async () => '## [1.0.0]\n- x' }),
            ],
        ]);
        wireChangelogTrigger();
        const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        document.getElementById('status-version').dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        await flush();
        expect(openSheet).toHaveBeenCalled();
    });

    it('lets a modified click (Ctrl/Cmd/Shift/Alt) fall through to the default navigation', async () => {
        const { wireChangelogTrigger } = await loadModule();
        document.body.innerHTML = '<a id="status-version" href="#"></a>';
        wireChangelogTrigger();
        for (const mod of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
            const ev = new window.MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                [mod]: true,
            });
            document.getElementById('status-version').dispatchEvent(ev);
            expect(ev.defaultPrevented, mod).toBe(false);
        }
        expect(openSheet).not.toHaveBeenCalled();
    });
});
