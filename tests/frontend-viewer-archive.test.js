// @vitest-environment jsdom
//
// Covers src/web/public/js/viewer-archive.js — the in-viewer archive
// listing: fetch + tree render, sorting (dirs first), the 1000-row
// render cap with a truncated indicator, per-extension icons, and the
// fallback panel's per-reason messaging.
//
// Global fetch is mocked per test.

import { describe, it, expect, afterEach, vi } from 'vitest';

function mockFetch(impl) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

function makeEls() {
    const targetEl = document.createElement('div');
    const statusEl = document.createElement('div');
    document.body.appendChild(targetEl);
    document.body.appendChild(statusEl);
    return { targetEl, statusEl };
}

function entry(name, size = 100, isDir = false) {
    return { name, size, isDir };
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('renderArchiveInto', () => {
    it('does nothing without a target element', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const spy = mockFetch(() => Promise.resolve({ ok: true, json: async () => ({}) }));
        await expect(renderArchiveInto({ filePath: 'a.zip' })).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });

    it('requests the archive-list endpoint with the encoded path', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        const spy = mockFetch(() =>
            Promise.resolve({ ok: true, json: async () => ({ supported: true, entries: [] }) }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a/b c.zip' });
        expect(spy).toHaveBeenCalledWith(
            '/api/files/archive-list?path=a%2Fb%20c.zip',
            expect.objectContaining({ credentials: 'same-origin' }),
        );
    });

    it('clears the status placeholder once the fetch settles', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl, statusEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({ ok: true, json: async () => ({ supported: true, entries: [] }) }),
        );
        await renderArchiveInto({ targetEl, statusEl, filePath: 'a.zip' });
        expect(statusEl.innerHTML).toBe('');
    });

    it('renders the file tree sorted with directories first, then by name', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({
                    supported: true,
                    name: 'photos.zip',
                    entries: [
                        entry('zeta.txt'),
                        entry('alpha_dir', 0, true),
                        entry('alpha.txt'),
                        entry('beta_dir', 0, true),
                    ],
                }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'photos.zip', fileName: 'photos.zip' });
        const names = [...targetEl.querySelectorAll('.archive-row span:first-of-type')].map(
            (el) => el.textContent,
        );
        expect(names).toEqual(['alpha_dir', 'beta_dir', 'alpha.txt', 'zeta.txt']);
    });

    it('shows the entry count and total size in the header', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({
                    supported: true,
                    entries: [entry('a.txt', 512), entry('b.txt', 512)],
                }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip' });
        expect(targetEl.textContent).toContain('2 entries');
        expect(targetEl.textContent).toContain('1.0 KB');
    });

    it('directories show no size cell', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ supported: true, entries: [entry('dir', 999, true)] }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip' });
        const sizeCell = targetEl.querySelector('.archive-row span:last-of-type');
        expect(sizeCell.textContent).toBe('');
    });

    it('caps rendered rows at 1000 and flags the list as truncated', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        const entries = Array.from({ length: 1200 }, (_, i) => entry(`f${i}.txt`));
        mockFetch(() =>
            Promise.resolve({ ok: true, json: async () => ({ supported: true, entries }) }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip' });
        expect(targetEl.querySelectorAll('.archive-row')).toHaveLength(1000);
        expect(targetEl.textContent).toContain('(truncated)');
    });

    it('does not show the truncated flag when everything fits', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ supported: true, entries: [entry('a.txt')] }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip' });
        expect(targetEl.textContent).not.toContain('truncated');
    });

    it('includes a download link when downloadUrl is given', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ supported: true, entries: [entry('a.txt')] }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip', downloadUrl: '/files/a.zip' });
        const link = targetEl.querySelector('a[download]');
        expect(link.getAttribute('href')).toBe('/files/a.zip');
    });

    it('escapes a hostile archive/entry name', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({
                    supported: true,
                    name: '<img src=x onerror=alert(1)>',
                    entries: [entry('<script>evil</script>.txt')],
                }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip' });
        expect(targetEl.querySelector('img')).toBeNull();
        expect(targetEl.querySelector('script')).toBeNull();
        expect(targetEl.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(targetEl.textContent).toContain('<script>evil</script>.txt');
    });

    it('picks an icon class by extension', async () => {
        const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
        const { targetEl } = makeEls();
        mockFetch(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({
                    supported: true,
                    entries: [entry('photo.jpg'), entry('clip.mp4'), entry('README')],
                }),
            }),
        );
        await renderArchiveInto({ targetEl, filePath: 'a.zip' });
        // Rows render sorted by name, not insertion order — look each up
        // by its filename rather than assuming a fixed index.
        const iconFor = (name) =>
            [...targetEl.querySelectorAll('.archive-row')]
                .find((row) => row.textContent.includes(name))
                .querySelector('i').className;
        expect(iconFor('photo.jpg')).toContain('ri-image-line');
        expect(iconFor('clip.mp4')).toContain('ri-video-line');
        expect(iconFor('README')).toContain('ri-file-line'); // no extension at all
    });

    describe('fallback panel', () => {
        it('shows the tool_missing explanation with the tool name', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() =>
                Promise.resolve({
                    ok: true,
                    json: async () => ({ supported: false, reason: 'tool_missing', tool: '7z' }),
                }),
            );
            await renderArchiveInto({ targetEl, filePath: 'a.7z', fileName: 'a.7z' });
            expect(targetEl.textContent).toContain('7z');
            expect(targetEl.textContent).toContain('not installed');
        });

        it('shows the single_stream explanation', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() =>
                Promise.resolve({
                    ok: true,
                    json: async () => ({ supported: false, reason: 'single_stream' }),
                }),
            );
            await renderArchiveInto({ targetEl, filePath: 'a.gz' });
            expect(targetEl.textContent).toContain('Single-stream compression');
        });

        it('shows the unknown_format explanation', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() =>
                Promise.resolve({
                    ok: true,
                    json: async () => ({ supported: false, reason: 'unknown_format' }),
                }),
            );
            await renderArchiveInto({ targetEl, filePath: 'a.xyz' });
            expect(targetEl.textContent).toContain("isn't supported for inline preview");
        });

        it('falls back to no_entries when the entry list is empty', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() =>
                Promise.resolve({ ok: true, json: async () => ({ supported: true, entries: [] }) }),
            );
            await renderArchiveInto({ targetEl, filePath: 'a.zip' });
            expect(targetEl.textContent).toContain('appears empty or unreadable');
        });

        it('shows the raw fetch-failure message when the request itself fails', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl, statusEl } = makeEls();
            mockFetch(() => Promise.reject(new Error('offline')));
            await renderArchiveInto({ targetEl, statusEl, filePath: 'a.zip' });
            expect(targetEl.textContent).toContain('offline');
            expect(statusEl.innerHTML).toBe('');
        });

        it('shows an HTTP-status message on a non-ok response', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() => Promise.resolve({ ok: false, status: 500 }));
            await renderArchiveInto({ targetEl, filePath: 'a.zip' });
            expect(targetEl.textContent).toContain('HTTP 500');
        });

        it('includes the download link in the fallback panel too', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() => Promise.resolve({ ok: false, status: 404 }));
            await renderArchiveInto({ targetEl, filePath: 'a.zip', downloadUrl: '/files/a.zip' });
            expect(targetEl.querySelector('a[download]').getAttribute('href')).toBe('/files/a.zip');
        });

        it('defaults the displayed name to "Archive" with none given', async () => {
            const { renderArchiveInto } = await import('../src/web/public/js/viewer-archive.js');
            const { targetEl } = makeEls();
            mockFetch(() => Promise.resolve({ ok: false, status: 404 }));
            await renderArchiveInto({ targetEl, filePath: 'a.zip' });
            expect(targetEl.textContent).toContain('Archive');
        });
    });
});
