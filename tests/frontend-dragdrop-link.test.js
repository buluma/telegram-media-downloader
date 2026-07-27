// @vitest-environment jsdom
//
// Covers src/web/public/js/dragdrop-link.js — drag-drop a t.me link onto
// the dashboard: overlay show/hide with nested-depth tracking, URL
// extraction across the four possible dataTransfer formats, and the
// submit-to-queue call.
//
// api.js and utils.js are mocked. setupDragDropLink() attaches four
// listeners straight to `document` with no way to remove them, and
// jsdom keeps the same `document` across every test in a file — so, as
// with shortcuts.js, each handler is captured via a spy on
// addEventListener and invoked directly instead of dispatched through
// the (accumulating) real listener chain.

import { describe, it, expect, vi } from 'vitest';

const api = { post: vi.fn() };
const showToast = vi.fn();

vi.mock('../src/web/public/js/api.js', () => ({ api }));
vi.mock('../src/web/public/js/utils.js', () => ({ showToast }));

const $ = (id) => document.getElementById(id);

async function loadModule() {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="dragdrop-overlay"></div>';
    api.post.mockResolvedValue({});
    return import('../src/web/public/js/dragdrop-link.js');
}

/** Boot the module and capture its four document-level handlers. */
async function boot() {
    const mod = await loadModule();
    const spy = vi.spyOn(document, 'addEventListener');
    mod.setupDragDropLink();
    const handlers = {};
    for (const [type, fn] of spy.mock.calls) handlers[type] = fn;
    spy.mockRestore();
    return handlers;
}

/** Minimal DataTransfer stand-in — jsdom has no real implementation. */
function dt({ types = ['text/uri-list', 'text/plain'], data = {} } = {}) {
    return {
        types,
        dropEffect: '',
        getData: (fmt) => data[fmt] ?? '',
    };
}

function fireEvent(handler, dataTransfer) {
    const ev = { dataTransfer, preventDefault: vi.fn() };
    handler(ev);
    return ev;
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('setupDragDropLink — idempotency', () => {
    it('wires listeners exactly once across repeated calls', async () => {
        const mod = await loadModule();
        const spy = vi.spyOn(document, 'addEventListener');
        mod.setupDragDropLink();
        mod.setupDragDropLink();
        expect(spy.mock.calls.filter(([t]) => t === 'drop')).toHaveLength(1);
    });
});

describe('dragenter', () => {
    it('shows the overlay and prevents default when the drag carries a URL', async () => {
        const { dragenter } = await boot();
        const ev = fireEvent(dragenter, dt());
        expect(ev.preventDefault).toHaveBeenCalled();
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(true);
    });

    it('ignores a drag with no URL-shaped data (e.g. dragging a file)', async () => {
        const { dragenter } = await boot();
        const ev = fireEvent(dragenter, dt({ types: ['Files'] }));
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(false);
    });

    it('ignores an event with no dataTransfer at all', async () => {
        const { dragenter } = await boot();
        expect(() => fireEvent(dragenter, null)).not.toThrow();
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(false);
    });
});

describe('dragover', () => {
    it('sets the copy drop effect and prevents default', async () => {
        const { dragover } = await boot();
        const transfer = dt();
        const ev = fireEvent(dragover, transfer);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(transfer.dropEffect).toBe('copy');
    });

    it('ignores a drag with no URL data', async () => {
        const { dragover } = await boot();
        const transfer = dt({ types: ['Files'] });
        fireEvent(dragover, transfer);
        expect(transfer.dropEffect).toBe('');
    });
});

describe('dragleave — nested depth tracking', () => {
    it('keeps the overlay visible until every nested dragleave has fired', async () => {
        const { dragenter, dragleave } = await boot();
        fireEvent(dragenter, dt()); // depth 1
        fireEvent(dragenter, dt()); // depth 2 (entering a child element)
        fireEvent(dragleave, dt()); // depth 1 — still inside
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(true);
        fireEvent(dragleave, dt()); // depth 0 — actually left
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(false);
    });

    it('does not go negative on an extra dragleave', async () => {
        const { dragenter, dragleave } = await boot();
        fireEvent(dragenter, dt());
        fireEvent(dragleave, dt());
        fireEvent(dragleave, dt()); // extra — depth already at 0
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(false);
    });

    it('an extra dragleave does not leave depth permanently offset', async () => {
        // Without the `Math.max(0, ...)` floor, the extra dragleave above
        // drives depth to -1 instead of clamping at 0. The overlay looks
        // fine right after (it was already hidden), but a LATER, perfectly
        // ordinary enter/leave pair would then land depth on 0 -> -1 --
        // wait, on 1 -> 0? No: starting from -1, one dragenter takes it to
        // 0 and one dragleave takes it to -1 again, so the `=== 0` hide
        // check never fires again. Confirmed by driving one more full
        // cycle here and checking the overlay actually hides.
        const { dragenter, dragleave } = await boot();
        fireEvent(dragenter, dt());
        fireEvent(dragleave, dt());
        fireEvent(dragleave, dt()); // extra, would desync depth without the floor
        fireEvent(dragenter, dt());
        fireEvent(dragleave, dt());
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(false);
    });

    it('ignores a dragleave with no URL data', async () => {
        const { dragenter, dragleave } = await boot();
        fireEvent(dragenter, dt());
        fireEvent(dragleave, dt({ types: ['Files'] }));
        // Depth untouched, overlay still showing from the real dragenter.
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(true);
    });
});

describe('drop — URL extraction', () => {
    it('extracts from text/uri-list first', async () => {
        const { drop } = await boot();
        await fireEvent(drop, dt({ data: { 'text/uri-list': 'https://t.me/somechannel/123' } }));
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/download/url', {
            url: 'https://t.me/somechannel/123',
        });
    });

    it('falls back to text/plain when uri-list has no t.me link', async () => {
        const { drop } = await boot();
        await fireEvent(
            drop,
            dt({
                data: {
                    'text/uri-list': 'https://example.com/not-telegram',
                    'text/plain': 'check this out: https://t.me/chan/5',
                },
            }),
        );
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/download/url', {
            url: 'https://t.me/chan/5',
        });
    });

    it('falls back to text/x-moz-url and URL formats', async () => {
        const { drop } = await boot();
        await fireEvent(drop, dt({ data: { URL: 'https://t.me/x/1' } }));
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/download/url', { url: 'https://t.me/x/1' });
    });

    it('matches http as well as https', async () => {
        const { drop } = await boot();
        await fireEvent(drop, dt({ data: { 'text/plain': 'http://t.me/x/1' } }));
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/download/url', { url: 'http://t.me/x/1' });
    });

    it('shows an error toast when no t.me link is found anywhere', async () => {
        const { drop } = await boot();
        await fireEvent(
            drop,
            dt({ data: { 'text/plain': 'just some random text, no link here' } }),
        );
        await flush();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('No t.me link found in the dropped data', 'error');
    });

    it('resets depth and hides the overlay on drop', async () => {
        const { dragenter, drop } = await boot();
        fireEvent(dragenter, dt());
        fireEvent(dragenter, dt());
        await fireEvent(drop, dt({ data: { 'text/plain': 'https://t.me/x/1' } }));
        await flush();
        expect($('dragdrop-overlay').classList.contains('is-active')).toBe(false);
    });

    it('ignores a drop with no URL-shaped data', async () => {
        const { drop } = await boot();
        const ev = fireEvent(drop, dt({ types: ['Files'] }));
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('toasts success on a successful queue', async () => {
        const { drop } = await boot();
        await fireEvent(drop, dt({ data: { 'text/plain': 'https://t.me/x/1' } }));
        await flush();
        expect(showToast).toHaveBeenCalledWith('Queued for download', 'success');
    });

    it('toasts an error when the queue POST fails', async () => {
        const { drop } = await boot();
        api.post.mockRejectedValue(new Error('server down'));
        await fireEvent(drop, dt({ data: { 'text/plain': 'https://t.me/x/1' } }));
        await flush();
        expect(showToast).toHaveBeenCalledWith('server down', 'error');
    });

    it('falls back to a generic failure message with no error text', async () => {
        const { drop } = await boot();
        api.post.mockRejectedValue({});
        await fireEvent(drop, dt({ data: { 'text/plain': 'https://t.me/x/1' } }));
        await flush();
        expect(showToast).toHaveBeenCalledWith('Could not queue', 'error');
    });
});
