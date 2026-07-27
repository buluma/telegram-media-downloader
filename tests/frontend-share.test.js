// @vitest-environment jsdom
//
// Covers src/web/public/js/share.js — the per-file Share sheet and the
// library-wide Active-links sheet.
//
// api.js, sheet.js and the toast helper are mocked so the assertions are
// about share.js's own behaviour: which endpoint it calls, what it puts
// in the DOM, and how it treats the expiry sentinel. i18n stays real, so
// the English fallback strings are what gets rendered.
//
// The sheet mock mirrors the real contract closely enough to matter: it
// parses the content string into a live element and hands it back as
// `.body`, which is what share.js queries for its controls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
const showToast = vi.fn();
const openSheet = vi.fn();
const confirmSheet = vi.fn();

vi.mock('../src/web/public/js/api.js', () => ({ api }));
vi.mock('../src/web/public/js/utils.js', () => ({ showToast }));
vi.mock('../src/web/public/js/sheet.js', () => ({ openSheet, confirmSheet }));

/** Build the sheet handle share.js expects: a live `.body` element. */
function sheetImpl(opts) {
    const root = document.createElement('div');
    if (typeof opts.content === 'string') root.innerHTML = opts.content;
    else if (opts.content) root.appendChild(opts.content);
    document.body.appendChild(root);
    return { body: root, close: vi.fn(), opts };
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/** A link that is active for another week. */
function link(over = {}) {
    return {
        id: 'lnk1',
        url: 'https://tgdl.example/share/lnk1',
        expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY,
        revokedAt: null,
        accessCount: 0,
        lastAccessedAt: null,
        label: null,
        ...over,
    };
}

const body = () => openSheet.mock.results[0].value.body;

describe('openShareSheet', () => {
    let share;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        openSheet.mockImplementation(sheetImpl);
        api.get.mockResolvedValue({ links: [] });
        api.post.mockResolvedValue({ link: link({ id: 'new1' }) });
        api.delete.mockResolvedValue({});
        confirmSheet.mockResolvedValue(true);
        navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        share = await import('../src/web/public/js/share.js');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('guards', () => {
        it('refuses to open without a download id', async () => {
            await share.openShareSheet({ downloadId: null, fileName: 'a.mp4' });
            expect(api.get).not.toHaveBeenCalled();
            expect(openSheet).not.toHaveBeenCalled();
            expect(showToast).toHaveBeenCalledWith('No file selected', 'error');
        });

        it('surfaces a listing failure instead of opening an empty sheet', async () => {
            api.get.mockRejectedValue({ data: { error: 'forbidden' } });
            await share.openShareSheet({ downloadId: 7, fileName: 'a.mp4' });
            expect(openSheet).not.toHaveBeenCalled();
            expect(showToast).toHaveBeenCalledWith('forbidden', 'error');
        });

        it('falls back to the error message when the API sends no body', async () => {
            api.get.mockRejectedValue(new Error('network down'));
            await share.openShareSheet({ downloadId: 7 });
            expect(showToast).toHaveBeenCalledWith('network down', 'error');
        });
    });

    describe('listing', () => {
        it('requests links scoped to the file', async () => {
            await share.openShareSheet({ downloadId: 42, fileName: 'a.mp4' });
            expect(api.get).toHaveBeenCalledWith('/api/share/links?downloadId=42');
        });

        it('percent-encodes the download id', async () => {
            await share.openShareSheet({ downloadId: 'a/b', fileName: 'a.mp4' });
            expect(api.get).toHaveBeenCalledWith('/api/share/links?downloadId=a%2Fb');
        });

        it('shows an empty state when the file has no links', async () => {
            await share.openShareSheet({ downloadId: 1, fileName: 'a.mp4' });
            expect(body().querySelector('#share-list').textContent).toContain('No share links yet');
        });

        it('renders an active link with a revoke control', async () => {
            api.get.mockResolvedValue({ links: [link()] });
            await share.openShareSheet({ downloadId: 1 });
            const row = body().querySelector('[data-share-row="lnk1"]');
            expect(row.textContent).toContain('Active');
            expect(row.querySelector('[data-revoke="lnk1"]')).not.toBeNull();
            expect(row.querySelector('input[data-url="lnk1"]').value).toBe(
                'https://tgdl.example/share/lnk1',
            );
        });

        it('treats expiresAt 0 as never-expires, not as long-expired', async () => {
            api.get.mockResolvedValue({ links: [link({ expiresAt: 0 })] });
            await share.openShareSheet({ downloadId: 1 });
            const row = body().querySelector('[data-share-row="lnk1"]');
            expect(row.textContent).toContain('Active');
            expect(row.textContent).toContain('Never expires');
            expect(row.textContent).not.toContain('Expired');
        });

        it('marks a past expiry as expired and disables revoke', async () => {
            api.get.mockResolvedValue({
                links: [link({ expiresAt: Math.floor(Date.now() / 1000) - 60 })],
            });
            await share.openShareSheet({ downloadId: 1 });
            const row = body().querySelector('[data-share-row="lnk1"]');
            expect(row.textContent).toContain('Expired');
            expect(row.querySelector('[data-revoke]')).toBeNull();
            expect(row.querySelector('button[disabled]')).not.toBeNull();
        });

        it('marks a revoked link regardless of its expiry', async () => {
            api.get.mockResolvedValue({ links: [link({ revokedAt: Date.now() })] });
            await share.openShareSheet({ downloadId: 1 });
            const row = body().querySelector('[data-share-row="lnk1"]');
            expect(row.textContent).toContain('Revoked');
            expect(row.querySelector('[data-revoke]')).toBeNull();
        });

        it('reports access counts and never-opened links', async () => {
            api.get.mockResolvedValue({
                links: [link({ id: 'a', accessCount: 3 }), link({ id: 'b', accessCount: 0 })],
            });
            await share.openShareSheet({ downloadId: 1 });
            expect(body().querySelector('[data-share-row="a"]').textContent).toContain('3 opens');
            expect(body().querySelector('[data-share-row="b"]').textContent).toContain(
                'Never opened',
            );
        });

        it('escapes the link label rather than rendering it', async () => {
            api.get.mockResolvedValue({ links: [link({ label: '<img src=x onerror=alert(1)>' })] });
            await share.openShareSheet({ downloadId: 1 });
            expect(body().querySelector('img')).toBeNull();
            expect(body().textContent).toContain('<img src=x onerror=alert(1)>');
        });

        it('escapes the link URL so it cannot break out of the value attribute', async () => {
            // The URL is interpolated into value="…" and href="…". An
            // unescaped quote closes the attribute and everything after it
            // becomes markup.
            const hostile = '"><img src=x onerror=alert(1)>';
            api.get.mockResolvedValue({ links: [link({ url: hostile })] });
            await share.openShareSheet({ downloadId: 1 });
            expect(body().querySelector('img')).toBeNull();
            expect(body().querySelector('input[data-url="lnk1"]').value).toBe(hostile);
            expect(body().querySelector('a[href]').getAttribute('href')).toBe(hostile);
        });

        it('escapes the file name in the header', async () => {
            await share.openShareSheet({ downloadId: 1, fileName: '<script>alert(1)</script>' });
            expect(body().querySelector('script')).toBeNull();
            expect(body().textContent).toContain('<script>alert(1)</script>');
        });
    });

    describe('minting', () => {
        it('defaults the TTL to 7 days', async () => {
            await share.openShareSheet({ downloadId: 1 });
            const checked = body().querySelector('input[name="share-ttl"]:checked');
            expect(Number(checked.value)).toBe(7 * DAY);
        });

        it('offers a never-expires option', async () => {
            await share.openShareSheet({ downloadId: 1 });
            const values = [...body().querySelectorAll('input[name="share-ttl"]')].map((i) =>
                Number(i.value),
            );
            expect(values).toContain(0);
            expect(values).toContain(HOUR);
        });

        it('posts the selected TTL and trimmed label', async () => {
            await share.openShareSheet({ downloadId: 42 });
            const root = body();
            root.querySelector(`input[name="share-ttl"][value="${HOUR}"]`).checked = true;
            root.querySelector('#share-label-input').value = '  for John  ';
            root.querySelector('#share-mint-btn').click();
            await vi.waitFor(() => expect(api.post).toHaveBeenCalled());

            expect(api.post).toHaveBeenCalledWith('/api/share/links', {
                downloadId: 42,
                ttlSeconds: HOUR,
                label: 'for John',
            });
        });

        it('sends a null label when the field is blank', async () => {
            await share.openShareSheet({ downloadId: 42 });
            body().querySelector('#share-mint-btn').click();
            await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
            expect(api.post.mock.calls[0][1].label).toBeNull();
        });

        it('prepends the new link, copies it, and clears the label field', async () => {
            api.get.mockResolvedValue({ links: [link({ id: 'old' })] });
            api.post.mockResolvedValue({
                link: link({ id: 'fresh', url: 'https://x/share/fresh' }),
            });
            await share.openShareSheet({ downloadId: 1 });
            const root = body();
            root.querySelector('#share-label-input').value = 'note';
            root.querySelector('#share-mint-btn').click();

            await vi.waitFor(() =>
                expect(root.querySelector('[data-share-row="fresh"]')).not.toBeNull(),
            );
            const rows = [...root.querySelectorAll('[data-share-row]')].map(
                (r) => r.dataset.shareRow,
            );
            expect(rows).toEqual(['fresh', 'old']);
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://x/share/fresh');
            expect(showToast).toHaveBeenCalledWith('Link created and copied', 'success');
            expect(root.querySelector('#share-label-input').value).toBe('');
        });

        it('still reports success when the clipboard is unavailable', async () => {
            navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
            document.execCommand = vi.fn(() => false);
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('#share-mint-btn').click();
            await vi.waitFor(() =>
                expect(showToast).toHaveBeenCalledWith('Link created', 'success'),
            );
        });

        it('surfaces a mint failure and re-enables the button', async () => {
            api.post.mockRejectedValue({ data: { error: 'quota exceeded' } });
            await share.openShareSheet({ downloadId: 1 });
            const btn = body().querySelector('#share-mint-btn');
            btn.click();
            await vi.waitFor(() =>
                expect(showToast).toHaveBeenCalledWith('quota exceeded', 'error'),
            );
            expect(btn.disabled) /* re-enabled in finally */
                .toBe(false);
        });

        it('leaves the list alone when the API returns no link', async () => {
            api.post.mockResolvedValue({});
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('#share-mint-btn').click();
            await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
            expect(body().querySelectorAll('[data-share-row]')).toHaveLength(0);
        });
    });

    describe('revoking', () => {
        beforeEach(() => {
            api.get.mockResolvedValue({ links: [link()] });
        });

        it('asks for confirmation first', async () => {
            confirmSheet.mockResolvedValue(false);
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-revoke="lnk1"]').click();
            await vi.waitFor(() => expect(confirmSheet).toHaveBeenCalled());
            expect(api.delete).not.toHaveBeenCalled();
        });

        it('flags the confirmation as destructive', async () => {
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-revoke="lnk1"]').click();
            await vi.waitFor(() => expect(confirmSheet).toHaveBeenCalled());
            expect(confirmSheet.mock.calls[0][0]).toMatchObject({ destructive: true });
        });

        it('deletes the link and repaints the row as revoked', async () => {
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-revoke="lnk1"]').click();

            await vi.waitFor(() =>
                expect(api.delete).toHaveBeenCalledWith('/api/share/links/lnk1'),
            );
            await vi.waitFor(() =>
                expect(body().querySelector('[data-share-row="lnk1"]').textContent).toContain(
                    'Revoked',
                ),
            );
            expect(showToast).toHaveBeenCalledWith('Link revoked', 'success');
        });

        it('percent-encodes the link id', async () => {
            api.get.mockResolvedValue({ links: [link({ id: 'a/b' })] });
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-revoke="a/b"]').click();
            await vi.waitFor(() =>
                expect(api.delete).toHaveBeenCalledWith('/api/share/links/a%2Fb'),
            );
        });

        it('surfaces a revoke failure and leaves the row active', async () => {
            api.delete.mockRejectedValue({ data: { error: 'gone' } });
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-revoke="lnk1"]').click();
            await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('gone', 'error'));
            expect(body().querySelector('[data-share-row="lnk1"]').textContent).toContain('Active');
        });
    });

    describe('copying', () => {
        beforeEach(() => {
            api.get.mockResolvedValue({ links: [link()] });
        });

        it('copies the row URL and confirms', async () => {
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-copy="lnk1"]').click();
            // Wait on the toast, not on writeText: the toast is the last
            // effect in the chain, so waiting on the earlier call would
            // return before the handler finished.
            await vi.waitFor(() =>
                expect(showToast).toHaveBeenCalledWith('Link copied', 'success'),
            );
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
                'https://tgdl.example/share/lnk1',
            );
        });

        it('falls back to execCommand outside a secure context', async () => {
            navigator.clipboard.writeText.mockRejectedValue(new Error('not allowed'));
            document.execCommand = vi.fn(() => true);
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-copy="lnk1"]').click();
            await vi.waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
            expect(showToast).toHaveBeenCalledWith('Link copied', 'success');
        });

        it('tells the user to copy manually when every path fails', async () => {
            navigator.clipboard.writeText.mockRejectedValue(new Error('not allowed'));
            document.execCommand = vi.fn(() => false);
            await share.openShareSheet({ downloadId: 1 });
            body().querySelector('[data-copy="lnk1"]').click();
            await vi.waitFor(() =>
                expect(showToast).toHaveBeenCalledWith(
                    'Could not copy — select the link manually',
                    'error',
                ),
            );
        });
    });
});

describe('openAllSharesSheet', () => {
    let share;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        openSheet.mockImplementation(sheetImpl);
        api.get.mockResolvedValue({ links: [], total: 0, hasMore: false });
        confirmSheet.mockResolvedValue(true);
        navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        share = await import('../src/web/public/js/share.js');
    });

    afterEach(() => vi.restoreAllMocks());

    it('requests the first page with the server-side cap', async () => {
        await share.openAllSharesSheet();
        expect(api.get).toHaveBeenCalledWith('/api/share/links?limit=500&offset=0');
    });

    it('surfaces a load failure instead of opening an empty sheet', async () => {
        api.get.mockRejectedValue({ data: { error: 'nope' } });
        await share.openAllSharesSheet();
        expect(openSheet).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('nope', 'error');
    });

    it('shows the originating file for each link', async () => {
        api.get.mockResolvedValue({
            links: [link({ fileName: 'clip.mp4', groupName: 'News' })],
            total: 1,
            hasMore: false,
        });
        await share.openAllSharesSheet();
        const row = body().querySelector('[data-share-row="lnk1"]');
        expect(row.textContent).toContain('clip.mp4');
        expect(row.textContent).toContain('News');
    });

    it('escapes the file name and group name', async () => {
        api.get.mockResolvedValue({
            links: [link({ fileName: '<img src=x>', groupName: '<b>g</b>' })],
            total: 1,
        });
        await share.openAllSharesSheet();
        expect(body().querySelector('img')).toBeNull();
        expect(body().querySelector('[data-share-row] b')).toBeNull();
    });

    it('labels a link with no file name', async () => {
        api.get.mockResolvedValue({ links: [link({ fileName: '' })], total: 1 });
        await share.openAllSharesSheet();
        expect(body().querySelector('[data-share-row="lnk1"]').textContent).toContain('(unnamed)');
    });
});
