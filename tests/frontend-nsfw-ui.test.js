// @vitest-environment jsdom
//
// Covers src/web/public/js/nsfw-ui.js — the Maintenance hub card for the
// NSFW review tool: status line, unseen-candidates badge, review/scan
// buttons, and the scan/cancel toggle.
//
// api.js and utils.js are mocked. localStorage comes from
// tests/setup.js's in-memory polyfill.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn() };
const showToast = vi.fn();

vi.mock('../src/web/public/js/api.js', () => ({ api }));
vi.mock('../src/web/public/js/utils.js', () => ({ showToast }));

const $ = (id) => document.getElementById(id);

const DOM = `
    <span id="maint-nsfw-status"></span>
    <button id="maint-nsfw-review-btn" class="hidden"></button>
    <button id="maint-nsfw-scan-btn"></button>
    <span id="maint-nsfw-badge" class="hidden"></span>
    <div id="maint-nsfw-progress" class="hidden">
        <div id="maint-nsfw-progress-bar"></div>
    </div>
`;

async function loadModule() {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = DOM;
    localStorage.clear();
    api.get.mockResolvedValue({ enabled: true });
    api.post.mockResolvedValue({});
    return import('../src/web/public/js/nsfw-ui.js');
}

describe('refreshNsfwStatus', () => {
    afterEach(() => vi.restoreAllMocks());

    it('does nothing when the status element is absent from the page', async () => {
        const { refreshNsfwStatus } = await loadModule();
        document.body.innerHTML = '';
        await expect(refreshNsfwStatus()).resolves.toBeUndefined();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('shows the disabled message and hides review/badge/progress, disables scan', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: false });
        await refreshNsfwStatus();
        expect($('maint-nsfw-status').textContent).toContain('Disabled');
        expect($('maint-nsfw-review-btn').classList.contains('hidden')).toBe(true);
        expect($('maint-nsfw-badge').classList.contains('hidden')).toBe(true);
        expect($('maint-nsfw-progress').classList.contains('hidden')).toBe(true);
        expect($('maint-nsfw-scan-btn').disabled).toBe(true);
        expect($('maint-nsfw-scan-btn').classList.contains('opacity-50')).toBe(true);
    });

    it('re-enables the scan button when enabled again', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, scanned: 0, totalEligible: 0, candidates: 0 });
        $('maint-nsfw-scan-btn').disabled = true;
        $('maint-nsfw-scan-btn').classList.add('opacity-50');
        await refreshNsfwStatus();
        expect($('maint-nsfw-scan-btn').disabled).toBe(false);
        expect($('maint-nsfw-scan-btn').classList.contains('opacity-50')).toBe(false);
    });

    it('renders the scan/eligible/candidate summary line', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({
            enabled: true,
            scanned: 40,
            totalEligible: 100,
            candidates: 3,
            lastCheckedAt: Date.now() - 5 * 60_000,
        });
        await refreshNsfwStatus();
        const text = $('maint-nsfw-status').textContent;
        expect(text).toContain('40 / 100 scanned');
        expect(text).toContain('3 possibly not 18+');
        expect(text).toContain('5m ago');
    });

    it('shows "never scanned" with no lastCheckedAt', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, scanned: 0, totalEligible: 10, candidates: 0 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-status').textContent).toContain('never scanned');
    });

    it('shows the badge when there are unseen candidates', async () => {
        const { refreshNsfwStatus } = await loadModule();
        localStorage.setItem('tgdl.nsfw.lastSeen', '2');
        api.get.mockResolvedValue({ enabled: true, candidates: 5 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-badge').classList.contains('hidden')).toBe(false);
        expect($('maint-nsfw-badge').textContent).toBe('5');
    });

    it('hides the badge once the candidate count has already been seen', async () => {
        const { refreshNsfwStatus } = await loadModule();
        localStorage.setItem('tgdl.nsfw.lastSeen', '5');
        api.get.mockResolvedValue({ enabled: true, candidates: 5 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-badge').classList.contains('hidden')).toBe(true);
    });

    it('hides the badge when there are zero candidates, even with lastSeen at 0', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, candidates: 0 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-badge').classList.contains('hidden')).toBe(true);
    });

    it('caps the badge display at 99+', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, candidates: 150 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-badge').textContent).toBe('99+');
    });

    it('shows the review button only when there are candidates', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, candidates: 0 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-review-btn').classList.contains('hidden')).toBe(true);

        api.get.mockResolvedValue({ enabled: true, candidates: 7 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-review-btn').classList.contains('hidden')).toBe(false);
        expect($('maint-nsfw-review-btn').textContent).toBe('Review 7');
    });

    it('shows the progress bar and switches the button to Cancel while running', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({
            enabled: true,
            running: true,
            scanned: 3,
            total: 10,
            candidates: 0,
        });
        await refreshNsfwStatus();
        expect($('maint-nsfw-progress').classList.contains('hidden')).toBe(false);
        expect($('maint-nsfw-progress-bar').style.width).toBe('30%');
        expect($('maint-nsfw-scan-btn').textContent).toBe('Cancel');
        expect($('maint-nsfw-scan-btn').dataset.mode).toBe('cancel');
    });

    it('clamps the progress bar at 100%', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, running: true, scanned: 20, total: 10 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-progress-bar').style.width).toBe('100%');
    });

    it('hides the progress bar and resets the button label when not running', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, running: false, candidates: 0 });
        await refreshNsfwStatus();
        expect($('maint-nsfw-progress').classList.contains('hidden')).toBe(true);
        expect($('maint-nsfw-scan-btn').textContent).toBe('Scan');
        expect($('maint-nsfw-scan-btn').dataset.mode).toBe('scan');
    });

    it('shows a status-unavailable message on a failed fetch', async () => {
        const { refreshNsfwStatus } = await loadModule();
        api.get.mockRejectedValue(new Error('down'));
        await refreshNsfwStatus();
        expect($('maint-nsfw-status').textContent).toContain('status unavailable');
    });
});

describe('maintNsfwScan', () => {
    afterEach(() => vi.restoreAllMocks());

    it('does nothing when the button is absent', async () => {
        const { maintNsfwScan } = await loadModule();
        document.body.innerHTML = '';
        await expect(maintNsfwScan()).resolves.toBeUndefined();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('starts a scan, toasts, and refreshes status', async () => {
        api.post.mockResolvedValue({});
        const { maintNsfwScan } = await loadModule();
        api.get.mockResolvedValue({ enabled: true, candidates: 0 });
        $('maint-nsfw-scan-btn').dataset.mode = 'scan';
        await maintNsfwScan();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/nsfw/scan', {});
        expect(showToast).toHaveBeenCalledWith('Scan started — will notify when done', 'info');
        expect(api.get).toHaveBeenCalledWith('/api/maintenance/nsfw/status');
        expect($('maint-nsfw-scan-btn').disabled).toBe(false);
    });

    it('shows a distinct toast when the server reports it is already running', async () => {
        const { maintNsfwScan } = await loadModule();
        api.post.mockResolvedValue({ alreadyRunning: true });
        $('maint-nsfw-scan-btn').dataset.mode = 'scan';
        await maintNsfwScan();
        expect(showToast).toHaveBeenCalledWith('A scan is already running', 'info');
    });

    it('disables the button while the scan request is in flight', async () => {
        let resolvePost;
        const { maintNsfwScan } = await loadModule();
        api.post.mockReturnValue(new Promise((r) => (resolvePost = r)));
        $('maint-nsfw-scan-btn').dataset.mode = 'scan';
        const p = maintNsfwScan();
        expect($('maint-nsfw-scan-btn').disabled).toBe(true);
        resolvePost({});
        await p;
        expect($('maint-nsfw-scan-btn').disabled).toBe(false);
    });

    it('toasts an error and re-enables the button on failure', async () => {
        const { maintNsfwScan } = await loadModule();
        api.post.mockRejectedValue({ data: { error: 'model missing' } });
        $('maint-nsfw-scan-btn').dataset.mode = 'scan';
        await maintNsfwScan();
        expect(showToast).toHaveBeenCalledWith('model missing', 'error');
        expect($('maint-nsfw-scan-btn').disabled).toBe(false);
    });

    it('posts to the cancel endpoint when the button is in cancel mode', async () => {
        const { maintNsfwScan } = await loadModule();
        $('maint-nsfw-scan-btn').dataset.mode = 'cancel';
        await maintNsfwScan();
        expect(api.post).toHaveBeenCalledWith('/api/maintenance/nsfw/scan/cancel', {});
        // Cancel path never touches `disabled` or calls the "started" toast.
        expect(showToast).not.toHaveBeenCalled();
    });

    it('toasts an error when the cancel request fails', async () => {
        const { maintNsfwScan } = await loadModule();
        api.post.mockRejectedValue(new Error('cancel boom'));
        $('maint-nsfw-scan-btn').dataset.mode = 'cancel';
        await maintNsfwScan();
        expect(showToast).toHaveBeenCalledWith('cancel boom', 'error');
    });
});
