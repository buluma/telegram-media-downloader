// @vitest-environment jsdom
//
// Covers src/web/public/js/settings.js — the Settings page: config hydration
// into ~90 inputs, the localStorage-backed Video Player preferences, the
// disk-cap and max-speed dual inputs, self-saving cards (Force HTTPS, rate
// limit, ntfy alerts, guest password, federation), the debounced autosave
// pipeline with its per-page scoped payloads, and the exported save/proxy/
// credentials/accounts/password actions.
//
// Not covered here, and deliberately: the inline maintenance sheets that make
// up the back half of the file — the duplicate-review sheet, the log browser,
// the JSON config tree and the session exporter. Those are ~1300 lines of
// sheet-rendering that deserve their own file; wireMaintenance() is exercised
// only far enough to prove the buttons bind and route.
//
// Harness follows the other P4 pages. Two things are specific to this module:
//   - It reads document.body.dataset.role ('guest' short-circuits the whole
//     admin surface) and document.body.dataset.page (which picks the autosave
//     payload scope). Both are set per test.
//   - Two dynamic imports (nsfw-ui.js for the review status, header-mobile.js
//     for the notification bell) are mocked so the module stays stand-alone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../src/web/public/js/api.js', () => ({ api }));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

const Notifications = {
    isEnabled: vi.fn(() => false),
    disable: vi.fn(),
    requestEnable: vi.fn(async () => true),
};
vi.mock('../src/web/public/js/notifications.js', () => Notifications);

const Fonts = { populateSelect: vi.fn(), applyFont: vi.fn() };
vi.mock('../src/web/public/js/fonts.js', () => Fonts);

const wsHandlers = new Map();
const ws = {
    on: vi.fn((type, fn) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, []);
        wsHandlers.get(type).push(fn);
    }),
};
vi.mock('../src/web/public/js/ws.js', () => ({ ws }));

const wireJobButton = vi.fn();
vi.mock('../src/web/public/js/job-buttons.js', () => ({ wireJobButton }));

let i18nDict = {};
const i18nT = vi.fn((key, fallback) => i18nDict[key] || fallback || key);
const i18nTf = vi.fn((key, vars, fallback) => {
    const tpl = i18nDict[key] || fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
});
vi.mock('../src/web/public/js/i18n.js', () => ({ t: i18nT, tf: i18nTf, applyToDOM: vi.fn() }));

let confirmAnswer = true;
const confirmSheet = vi.fn(async () => confirmAnswer);
const openSheet = vi.fn();
const promptSheet = vi.fn(async () => null);
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet, openSheet, promptSheet }));

const refreshNsfwStatus = vi.fn();
vi.mock('../src/web/public/js/nsfw-ui.js', () => ({ refreshNsfwStatus }));

const pushLogToNotify = vi.fn();
vi.mock('../src/web/public/js/header-mobile.js', () => ({ pushLogToNotify }));

const $ = (id) => document.getElementById(id);

// ---- fixture -------------------------------------------------------------

const NUM_INPUTS = [
    'setting-concurrent',
    'setting-retries',
    'setting-rpm',
    'setting-polling',
    'setting-max-speed',
    'setting-max-speed-value',
    'setting-max-disk-value',
    'setting-max-video',
    'setting-max-image',
    'setting-rescue-default-hours',
    'setting-rescue-sweep-min',
    'setting-rate-limit-rpm',
    'setting-alerts-streak',
    'setting-alerts-silent-days',
    'setting-slideshow-interval',
    'setting-viewer-default-volume',
    'setting-viewer-skip-step',
    'setting-viewer-hide-delay',
    'federation-failover-grace',
];

const TEXT_INPUTS = [
    'setting-path',
    'setting-api-id',
    'setting-api-hash',
    'setting-alerts-ntfy-url',
    'setting-alerts-ntfy-topic',
    'setting-alerts-ntfy-token',
    'setting-guest-password',
    'proxy-type',
    'proxy-host',
    'proxy-port',
    'proxy-username',
    'proxy-password',
    'proxy-secret',
    'sec-current',
    'sec-new',
];

const ADV_INPUTS = [
    'setting-adv-min-concurrency',
    'setting-adv-max-concurrency',
    'setting-adv-scaler-sec',
    'setting-adv-idle-sleep-ms',
    'setting-adv-spillover',
    'setting-adv-backpressure',
    'setting-adv-backpressure-wait',
    'setting-adv-short-break',
    'setting-adv-long-break',
    'setting-adv-auto-first-limit',
    'setting-adv-batch-insert',
    'setting-adv-sweep-batch',
    'setting-adv-max-deletes',
    'setting-adv-low-water',
    'setting-adv-integrity-min',
    'setting-adv-integrity-batch',
    'setting-adv-session-days',
    'setting-adv-nsfw-model',
    'setting-adv-nsfw-dtype',
    'setting-adv-nsfw-threshold',
    'setting-adv-nsfw-concurrency',
    'setting-adv-ffmpeg-hwaccel',
    'setting-adv-seekbar-intervalSec',
    'setting-adv-seekbar-tileWidth',
    'setting-adv-seekbar-columns',
    'setting-adv-seekbar-maxTiles',
    'setting-adv-seekbar-quality',
    'setting-adv-seekbar-concurrency',
    'setting-adv-seekbar-format',
    'setting-adv-seekbar-hwaccel',
];

// Custom `.tg-toggle` widgets — a div whose `.active` class is the state.
const TOGGLES = [
    'setting-disk-rotate',
    'setting-rescue-default',
    'setting-allow-dm',
    'setting-force-https',
    'setting-rate-limit',
    'setting-alerts-enabled',
    'setting-guest-enabled',
    'setting-notifications',
    'setting-viewer-autoplay',
    'setting-viewer-start-muted',
    'setting-viewer-loop',
    'setting-viewer-auto-advance',
    'setting-viewer-dbl-tap-fs',
    'setting-viewer-resume',
    'setting-viewer-show-pip',
    'setting-viewer-show-speed',
    'setting-adv-auto-first-backfill',
    'setting-adv-auto-catchup',
    'setting-adv-nsfw-enabled',
    'setting-adv-nsfw-preload',
    'setting-adv-nsfw-blocklist',
    'setting-adv-thumbs-warn-misses',
    'setting-adv-seekbar-enabled',
    'setting-adv-seekbar-autoOnDownload',
];

const MAINT_BUTTONS = [
    'maint-resync-btn',
    'maint-restart-btn',
    'maint-db-check-btn',
    'maint-db-vacuum-btn',
    'maint-verify-btn',
    'maint-dedup-btn',
    'maint-shares-btn',
    'maint-thumbs-build-btn',
    'maint-thumbs-rebuild-btn',
    'maint-update-btn',
    'maint-nsfw-scan-btn',
    'maint-nsfw-review-btn',
    'maint-logs-btn',
    'maint-config-btn',
    'maint-export-btn',
    'maint-signout-all-btn',
];

const SELECTS = {
    'setting-max-speed-unit': ['KB', 'MB', 'GB'],
    'setting-max-disk-unit': ['', 'MB', 'GB', 'TB'],
    'setting-font': ['system', 'inter'],
    'setting-viewer-default-speed': ['0.5', '1', '1.5', '2'],
};

function buildDom() {
    const parts = [];
    for (const id of NUM_INPUTS) parts.push(`<input id="${id}" type="number" />`);
    for (const id of TEXT_INPUTS) parts.push(`<input id="${id}" type="text" />`);
    for (const id of ADV_INPUTS) parts.push(`<input id="${id}" type="text" />`);
    for (const id of TOGGLES) parts.push(`<div id="${id}" class="tg-toggle"></div>`);
    for (const id of MAINT_BUTTONS) parts.push(`<button id="${id}"></button>`);
    for (const [id, opts] of Object.entries(SELECTS)) {
        parts.push(
            `<select id="${id}">${opts.map((o) => `<option value="${o}">${o || '—'}</option>`).join('')}</select>`,
        );
    }
    parts.push(`
        <input id="setting-block-webp" type="checkbox" />
        <span id="concurrent-value"></span>
        <span id="retries-value"></span>
        <span id="rpm-value"></span>
        <span id="polling-value"></span>
        <span id="speed-value"></span>
        <span id="slideshow-interval-label"></span>
        <span id="setting-viewer-default-volume-val"></span>
        <span id="rescue-stats-line"></span>
        <span id="alerts-status-line"></span>
        <span id="guest-enable-status"></span>
        <button id="guest-set-btn"></button>
        <button id="guest-clear-btn"></button>
        <button id="alerts-save-btn"></button>
        <button id="alerts-test-btn"></button>
        <button id="video-pip-btn"></button>
        <button id="video-settings-btn"></button>
        <button id="setting-adv-ffmpeg-hwaccel-probe"><span>Probe</span></button>
        <div id="setting-adv-ffmpeg-hwaccel-probe-result"></div>
        <div id="accounts-list"></div>
        <div id="maint-thumbs-stats"></div>
        <div id="maint-update-status"></div>
        <div id="proxy-status"></div>
        <div id="settings-card-federation">
            <div id="federation-replicate-list"></div>
            <span id="federation-failover-grace-value"></span>
            <span id="federation-self-name"></span>
            <span id="federation-self-id"></span>
            <div id="federation-empty-hint" class="hidden"></div>
        </div>
        <div id="settings-autosave-status">
            <span id="settings-autosave-icon"></span>
            <span id="settings-autosave-text"></span>
        </div>
    `);
    return parts.join('\n');
}

const CONFIG = (over = {}) => ({
    download: { concurrent: 4, retries: 6, path: '/data/dl', maxSpeed: 0, blockWebp: false },
    rateLimits: { requestsPerMinute: 20 },
    pollingInterval: 15,
    diskManagement: {},
    telegram: {},
    ...over,
});

function stubApi(routes = {}) {
    const pick = (url) => {
        for (const [pattern, res] of Object.entries(routes)) {
            if (String(url).includes(pattern)) return res;
        }
        return undefined;
    };
    api.get.mockImplementation(async (url) => {
        const r = pick(url);
        if (r !== undefined) return typeof r === 'function' ? r(url) : r;
        if (String(url).includes('/api/accounts')) return [];
        return {};
    });
    api.post.mockImplementation(async (url) => {
        const r = pick(url);
        if (r !== undefined) return typeof r === 'function' ? r(url) : r;
        return {};
    });
}

async function flush(times = 8) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    if (!vi.isFakeTimers()) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < times; i++) await Promise.resolve();
}

async function load({ page = 'settings', role = 'admin' } = {}) {
    vi.resetModules();
    wsHandlers.clear();
    // Swap the whole <body> element, not just its innerHTML. setupAutoSave()
    // binds input/change/click/focusout to document.body, and the body node
    // itself survives an innerHTML wipe — so a previous module instance keeps
    // listening and fires a second save for every edit the next test makes.
    const fresh = document.createElement('body');
    fresh.innerHTML = buildDom();
    document.body.replaceWith(fresh);
    document.body.dataset.page = page;
    document.body.dataset.role = role;
    return import('../src/web/public/js/settings.js');
}

async function boot(config = CONFIG(), opts = {}) {
    stubApi({ '/api/config': config, ...(opts.routes || {}) });
    const mod = await load(opts);
    await mod.loadSettings();
    await flush();
    return mod;
}

beforeEach(() => {
    vi.clearAllMocks();
    i18nDict = {};
    confirmAnswer = true;
    localStorage.clear();
    stubApi();
    Notifications.isEnabled.mockReturnValue(false);
    Notifications.requestEnable.mockResolvedValue(true);
    delete window.navigateTo;
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    delete document.body.dataset.page;
    delete document.body.dataset.role;
});

// ---- hydration -----------------------------------------------------------

describe('loadSettings — hydration', () => {
    it('fills the download, rate-limit and polling fields with their labels', async () => {
        await boot();
        expect($('setting-concurrent').value).toBe('4');
        expect($('concurrent-value').textContent).toBe('4');
        expect($('setting-retries').value).toBe('6');
        expect($('retries-value').textContent).toBe('6');
        expect($('setting-path').value).toBe('/data/dl');
        expect($('setting-rpm').value).toBe('20');
        expect($('rpm-value').textContent).toBe('20');
        expect($('setting-polling').value).toBe('15');
        expect($('polling-value').textContent).toBe('15s');
    });

    it('falls back to the documented defaults for a bare config', async () => {
        await boot({});
        expect($('concurrent-value').textContent).toBe('3');
        expect($('retries-value').textContent).toBe('5');
        expect($('rpm-value').textContent).toBe('15');
        expect($('polling-value').textContent).toBe('10s');
        expect($('setting-path').value).toBe('./data/downloads');
    });

    it('never asks the server for config as a guest', async () => {
        await boot(CONFIG(), { role: 'guest' });
        expect(api.get).not.toHaveBeenCalledWith('/api/config');
        // …but the browser-side Video Player prefs still wire up.
        expect($('setting-viewer-autoplay')).not.toBeNull();
    });

    it('skips the admin-only sub-panels for a guest', async () => {
        await boot(CONFIG(), { role: 'guest' });
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/accounts'))).toBe(false);
        expect(urls.some((u) => u.includes('/api/cluster/'))).toBe(false);
    });

    it('swallows a config load failure rather than leaving the page half-built', async () => {
        api.get.mockRejectedValue(new Error('503'));
        const mod = await load();
        await expect(mod.loadSettings()).resolves.toBeUndefined();
    });

    it('populates the font picker once and applies a change', async () => {
        const mod = await boot();
        expect(Fonts.populateSelect).toHaveBeenCalledWith($('setting-font'));
        $('setting-font').value = 'inter';
        $('setting-font').dispatchEvent(new window.Event('change'));
        expect(Fonts.applyFont).toHaveBeenCalledWith('inter');

        // Re-opening the page must not stack a second change listener.
        Fonts.applyFont.mockClear();
        await mod.loadSettings();
        await flush();
        $('setting-font').dispatchEvent(new window.Event('change'));
        expect(Fonts.applyFont).toHaveBeenCalledTimes(1);
    });

    it('survives a font picker that throws', async () => {
        Fonts.populateSelect.mockImplementationOnce(() => {
            throw new Error('fonts module broken');
        });
        await boot();
        // The rest of the page still hydrated.
        expect($('setting-concurrent').value).toBe('4');
    });
});

// ---- max speed dual input ------------------------------------------------

describe('max download speed', () => {
    const bytes = (v) => boot(CONFIG({ download: { maxSpeed: v } }));

    it('picks the most natural unit for the stored byte count', async () => {
        await bytes(5 * 1024 * 1024);
        expect($('setting-max-speed-value').value).toBe('5');
        expect($('setting-max-speed-unit').value).toBe('MB');
        expect($('setting-max-speed').value).toBe('5242880');
        expect($('speed-value').textContent).toBe('5 MB/s');
    });

    it('uses GB for a large cap and KB for a small one', async () => {
        await bytes(2 * 1024 * 1024 * 1024);
        expect($('setting-max-speed-unit').value).toBe('GB');
        expect($('setting-max-speed-value').value).toBe('2');

        await bytes(512 * 1024);
        expect($('setting-max-speed-unit').value).toBe('KB');
        expect($('setting-max-speed-value').value).toBe('512');
    });

    it('reads unlimited when no cap is set', async () => {
        await bytes(0);
        expect($('setting-max-speed-value').value).toBe('');
        expect($('setting-max-speed').value).toBe('0');
        expect($('speed-value').textContent).toBe('Unlimited');
    });

    it('recomputes the hidden byte value when either half changes', async () => {
        await bytes(0);
        $('setting-max-speed-value').value = '3';
        $('setting-max-speed-value').dispatchEvent(new window.Event('input'));
        expect($('setting-max-speed').value).toBe('3145728');

        $('setting-max-speed-unit').value = 'KB';
        $('setting-max-speed-unit').dispatchEvent(new window.Event('change'));
        expect($('setting-max-speed').value).toBe('3072');
        expect($('speed-value').textContent).toBe('3 KB/s');
    });

    it('treats a zero or negative entry as unlimited', async () => {
        await bytes(1024 * 1024);
        $('setting-max-speed-value').value = '0';
        $('setting-max-speed-value').dispatchEvent(new window.Event('input'));
        expect($('setting-max-speed').value).toBe('0');
        expect($('speed-value').textContent).toBe('Unlimited');
    });
});

// ---- disk cap ------------------------------------------------------------

describe('total disk cap', () => {
    const cap = (v) => boot(CONFIG({ diskManagement: { maxTotalSize: v } }));

    it('splits a unit-suffixed string', async () => {
        await cap('500GB');
        expect($('setting-max-disk-value').value).toBe('500');
        expect($('setting-max-disk-unit').value).toBe('GB');
    });

    it('accepts whitespace, lower case and decimals', async () => {
        await cap('1.5 tb');
        expect($('setting-max-disk-value').value).toBe('1.5');
        expect($('setting-max-disk-unit').value).toBe('TB');
    });

    it('treats a bare number as megabytes', async () => {
        await cap(250);
        expect($('setting-max-disk-value').value).toBe('250');
        expect($('setting-max-disk-unit').value).toBe('MB');
    });

    it('rounds sub-megabyte units up to MB — the rotator works in MB', async () => {
        await cap('900KB');
        expect($('setting-max-disk-unit').value).toBe('MB');
    });

    it('shows no limit for empty, zero and garbage values', async () => {
        for (const v of ['', 0, '0', null, 'not-a-size', '-5GB']) {
            await cap(v);
            expect($('setting-max-disk-value').value, String(v)).toBe('');
            expect($('setting-max-disk-unit').value, String(v)).toBe('');
        }
    });

    it('recombines into the string form on save', async () => {
        const mod = await boot();
        $('setting-max-disk-value').value = '2';
        $('setting-max-disk-unit').value = 'TB';
        await mod.saveSettings();
        expect(api.post).toHaveBeenCalledWith(
            '/api/config',
            expect.objectContaining({
                diskManagement: expect.objectContaining({ maxTotalSize: '2TB' }),
            }),
        );
    });

    it('sends no limit when either half is blank', async () => {
        const mod = await boot();
        $('setting-max-disk-value').value = '2';
        $('setting-max-disk-unit').value = '';
        await mod.saveSettings();
        expect(api.post).toHaveBeenCalledWith(
            '/api/config',
            expect.objectContaining({
                diskManagement: expect.objectContaining({ maxTotalSize: null }),
            }),
        );
    });
});

// ---- toggles that only stage state --------------------------------------

describe('staged toggles', () => {
    it('flips auto-rotate and says a save is needed', async () => {
        await boot(CONFIG({ diskManagement: { enabled: true } }));
        expect($('setting-disk-rotate').classList.contains('active')).toBe(true);
        $('setting-disk-rotate').click();
        expect($('setting-disk-rotate').classList.contains('active')).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Auto-rotate disabled — save to apply', 'info');
    });

    it('flips the rescue default', async () => {
        await boot(CONFIG({ rescue: { enabled: false, retentionHours: 72 } }));
        expect($('setting-rescue-default-hours').value).toBe('72');
        $('setting-rescue-default').click();
        expect(showToast).toHaveBeenCalledWith(
            'File retention on by default — save to apply',
            'success',
        );
    });

    it('defaults the rescue fields when the block is absent', async () => {
        await boot();
        expect($('setting-rescue-default-hours').value).toBe('48');
        expect($('setting-rescue-sweep-min').value).toBe('10');
    });

    it('flips the DM download toggle silently', async () => {
        await boot(CONFIG({ allowDmDownloads: true }));
        expect($('setting-allow-dm').classList.contains('active')).toBe(true);
        $('setting-allow-dm').click();
        expect($('setting-allow-dm').classList.contains('active')).toBe(false);
    });

    it('mirrors the block-webp checkbox', async () => {
        await boot(CONFIG({ download: { blockWebp: true } }));
        expect($('setting-block-webp').checked).toBe(true);
    });
});

// ---- video player preferences -------------------------------------------

describe('video player preferences', () => {
    it('reflects and flips the plain boolean toggles', async () => {
        localStorage.setItem('viewer-autoplay', '1');
        await boot();
        expect($('setting-viewer-autoplay').classList.contains('active')).toBe(true);

        $('setting-viewer-autoplay').click();
        expect(localStorage.getItem('viewer-autoplay')).toBe('0');
        expect($('setting-viewer-autoplay').classList.contains('active')).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Autoplay disabled.', 'info');

        $('setting-viewer-autoplay').click();
        expect(localStorage.getItem('viewer-autoplay')).toBe('1');
        expect(showToast).toHaveBeenCalledWith('Autoplay enabled.', 'info');
    });

    it('wires loop, start-muted and auto-advance to their own keys', async () => {
        await boot();
        $('setting-viewer-loop').click();
        $('setting-viewer-start-muted').click();
        $('setting-viewer-auto-advance').click();
        expect(localStorage.getItem('viewer-loop')).toBe('1');
        expect(localStorage.getItem('video-muted')).toBe('1');
        expect(localStorage.getItem('viewer-auto-advance')).toBe('1');
    });

    it('seeds double-tap fullscreen on so the legacy behaviour survives', async () => {
        await boot();
        expect(localStorage.getItem('viewer-dbl-tap-fs')).toBe('1');
        expect($('setting-viewer-dbl-tap-fs').classList.contains('active')).toBe(true);
    });

    it('leaves an existing double-tap preference alone', async () => {
        localStorage.setItem('viewer-dbl-tap-fs', '0');
        await boot();
        expect(localStorage.getItem('viewer-dbl-tap-fs')).toBe('0');
    });

    it('stores resume as an inverted opt-out', async () => {
        await boot();
        // Nothing stored yet reads as ON.
        expect($('setting-viewer-resume').classList.contains('active')).toBe(true);
        $('setting-viewer-resume').click();
        expect(localStorage.getItem('viewer-no-resume')).toBe('1');
        expect($('setting-viewer-resume').classList.contains('active')).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Resume disabled', 'info');
    });

    it('hides the PiP and speed buttons through inverted-sense keys', async () => {
        await boot();
        expect($('setting-viewer-show-pip').classList.contains('active')).toBe(true);
        expect($('video-pip-btn').style.display).toBe('');

        $('setting-viewer-show-pip').click();
        expect(localStorage.getItem('viewer-hide-pip')).toBe('1');
        expect($('video-pip-btn').style.display).toBe('none');
        expect(showToast).toHaveBeenCalledWith('PiP button hidden.', 'info');

        $('setting-viewer-show-speed').click();
        expect($('video-settings-btn').style.display).toBe('none');
    });

    it('applies a stored hide preference on open', async () => {
        localStorage.setItem('viewer-hide-pip', '1');
        await boot();
        expect($('setting-viewer-show-pip').classList.contains('active')).toBe(false);
        expect($('video-pip-btn').style.display).toBe('none');
    });

    it('clamps the slideshow interval into 2..15 seconds', async () => {
        localStorage.setItem('viewer-slideshow-interval', '99');
        await boot();
        expect($('setting-slideshow-interval').value).toBe('15');
        expect($('slideshow-interval-label').textContent).toBe('15s');

        $('setting-slideshow-interval').value = '7';
        $('setting-slideshow-interval').dispatchEvent(new window.Event('input'));
        expect($('slideshow-interval-label').textContent).toBe('7s');
        expect(localStorage.getItem('viewer-slideshow-interval')).toBe('7');
    });

    it('binds the default speed straight to the player key', async () => {
        localStorage.setItem('video-speed', '1.5');
        await boot();
        expect($('setting-viewer-default-speed').value).toBe('1.5');
        $('setting-viewer-default-speed').value = '2';
        $('setting-viewer-default-speed').dispatchEvent(new window.Event('change'));
        expect(localStorage.getItem('video-speed')).toBe('2');
    });

    it('shows the default volume as a percentage and stores it as a fraction', async () => {
        localStorage.setItem('video-volume', '0.4');
        await boot();
        expect($('setting-viewer-default-volume').value).toBe('40');
        expect($('setting-viewer-default-volume-val').textContent).toBe('40');

        $('setting-viewer-default-volume').value = '80';
        $('setting-viewer-default-volume').dispatchEvent(new window.Event('input'));
        expect(localStorage.getItem('video-volume')).toBe('0.8');
        expect($('setting-viewer-default-volume-val').textContent).toBe('80');
    });

    it('clamps the skip step and hide delay to their ranges', async () => {
        localStorage.setItem('viewer-skip-step', '900');
        await boot();
        // Out-of-range stored value falls back to the default rather than clamping.
        expect($('setting-viewer-skip-step').value).toBe('5');

        $('setting-viewer-skip-step').value = '900';
        $('setting-viewer-skip-step').dispatchEvent(new window.Event('input'));
        expect(localStorage.getItem('viewer-skip-step')).toBe('60');

        $('setting-viewer-hide-delay').value = '0';
        $('setting-viewer-hide-delay').dispatchEvent(new window.Event('input'));
        expect(localStorage.getItem('viewer-hide-delay')).toBe('3');
    });
});

// ---- notifications -------------------------------------------------------

describe('notifications toggle', () => {
    it('asks for permission and reports the grant', async () => {
        await boot();
        await $('setting-notifications').onclick(new window.Event('click'));
        expect(Notifications.requestEnable).toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Notifications enabled', 'success');
    });

    it('reports a denied permission', async () => {
        Notifications.requestEnable.mockResolvedValue(false);
        await boot();
        await $('setting-notifications').onclick(new window.Event('click'));
        expect(showToast).toHaveBeenCalledWith('Permission denied', 'error');
    });

    it('disables without a permission round-trip when already on', async () => {
        Notifications.isEnabled.mockReturnValue(true);
        await boot();
        expect($('setting-notifications').classList.contains('active')).toBe(true);
        await $('setting-notifications').onclick(new window.Event('click'));
        expect(Notifications.disable).toHaveBeenCalled();
        expect(Notifications.requestEnable).not.toHaveBeenCalled();
    });
});

// ---- self-saving cards ---------------------------------------------------

describe('force HTTPS', () => {
    it('confirms before enabling, then saves', async () => {
        await boot();
        await $('setting-force-https').onclick(new window.Event('click'));
        await flush();
        expect(confirmSheet).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
        expect(api.post).toHaveBeenCalledWith('/api/config', { web: { forceHttps: true } });
        expect($('setting-force-https').classList.contains('active')).toBe(true);
    });

    it('backs out when the confirm is declined', async () => {
        confirmAnswer = false;
        await boot();
        await $('setting-force-https').onclick(new window.Event('click'));
        await flush();
        expect(api.post).not.toHaveBeenCalled();
        expect($('setting-force-https').classList.contains('active')).toBe(false);
    });

    it('disables without friction', async () => {
        await boot(CONFIG({ web: { forceHttps: true } }));
        expect($('setting-force-https').classList.contains('active')).toBe(true);
        await $('setting-force-https').onclick(new window.Event('click'));
        await flush();
        expect(confirmSheet).not.toHaveBeenCalled();
        expect(api.post).toHaveBeenCalledWith('/api/config', { web: { forceHttps: false } });
    });

    it('reports a failed save', async () => {
        await boot();
        api.post.mockRejectedValueOnce(new Error('read-only'));
        await $('setting-force-https').onclick(new window.Event('click'));
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('read-only'), 'error');
    });
});

describe('web rate limit', () => {
    it('hydrates from config', async () => {
        await boot(CONFIG({ web: { rateLimit: { enabled: true, perMinute: 250 } } }));
        expect($('setting-rate-limit').classList.contains('active')).toBe(true);
        expect($('setting-rate-limit-rpm').value).toBe('250');
    });

    it('saves on toggle and clamps the rate', async () => {
        await boot();
        $('setting-rate-limit-rpm').value = '2';
        $('setting-rate-limit').onclick(new window.Event('click'));
        await flush();
        expect($('setting-rate-limit-rpm').value).toBe('10');
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            web: { rateLimit: { enabled: true, perMinute: 10 } },
        });
        expect(showToast).toHaveBeenCalledWith('Rate limit: 10/min', 'success');
    });

    it('clamps the upper bound and saves on a direct edit', async () => {
        await boot();
        $('setting-rate-limit-rpm').value = '99999999';
        $('setting-rate-limit-rpm').onchange();
        await flush();
        expect($('setting-rate-limit-rpm').value).toBe('1000000');
        expect(showToast).toHaveBeenCalledWith('Rate limit disabled', 'info');
    });

    it('reports a failed save', async () => {
        await boot();
        api.post.mockRejectedValueOnce(new Error('nope'));
        $('setting-rate-limit').onclick(new window.Event('click'));
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('nope'), 'error');
    });
});

describe('ntfy alerts', () => {
    const ALERTS = {
        alerts: {
            enabled: true,
            ntfy: { url: 'https://n.example', topic: 'tgdl', authToken: 'tk' },
            failureStreak: 3,
            silentGroupDays: 7,
        },
    };

    it('hydrates the whole card', async () => {
        await boot(CONFIG(ALERTS));
        expect($('setting-alerts-enabled').classList.contains('active')).toBe(true);
        expect($('setting-alerts-ntfy-url').value).toBe('https://n.example');
        expect($('setting-alerts-ntfy-topic').value).toBe('tgdl');
        expect($('setting-alerts-streak').value).toBe('3');
        expect($('setting-alerts-silent-days').value).toBe('7');
    });

    it('defaults the ntfy url and the numeric fields', async () => {
        await boot(CONFIG({ alerts: {} }));
        expect($('setting-alerts-ntfy-url').value).toBe('https://ntfy.sh');
        expect($('setting-alerts-streak').value).toBe('5');
        expect($('setting-alerts-silent-days').value).toBe('0');
    });

    it('saves the gathered subtree, trimmed and clamped', async () => {
        await boot(CONFIG(ALERTS));
        $('setting-alerts-ntfy-topic').value = '  spaced  ';
        $('setting-alerts-streak').value = '9999';
        $('setting-alerts-silent-days').value = '-4';
        $('alerts-save-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            alerts: expect.objectContaining({
                enabled: true,
                failureStreak: 1000,
                silentGroupDays: 0,
                ntfy: expect.objectContaining({ topic: 'spaced' }),
            }),
        });
        expect(showToast).toHaveBeenCalledWith('Alert settings saved', 'success');
    });

    it('reports the outcome of a test delivery', async () => {
        stubApi({ '/api/config': CONFIG(ALERTS), '/api/alerts/test': { ok: true } });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        $('alerts-test-btn').click();
        await flush();
        expect($('alerts-status-line').textContent).toBe('Delivered ✓');
    });

    it('reports a rejected test delivery', async () => {
        stubApi({ '/api/config': CONFIG(ALERTS), '/api/alerts/test': { ok: false } });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        $('alerts-test-btn').click();
        await flush();
        expect($('alerts-status-line').textContent).toContain('Failed');
    });

    it('reports a test that never reached the server', async () => {
        await boot(CONFIG(ALERTS));
        api.post.mockRejectedValueOnce(new Error('DNS'));
        $('alerts-test-btn').click();
        await flush();
        expect($('alerts-status-line').textContent).toContain('DNS');
    });

    it('reports a failed save', async () => {
        await boot(CONFIG(ALERTS));
        api.post.mockRejectedValueOnce(new Error('nope'));
        $('alerts-save-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('nope'), 'error');
    });
});

// ---- proxy + credentials -------------------------------------------------

describe('proxy', () => {
    it('hydrates every field but never echoes the password', async () => {
        await boot(
            CONFIG({
                proxy: {
                    type: 'socks5',
                    host: '10.0.0.1',
                    port: 1080,
                    username: 'u',
                    secret: 's',
                    password: 'hunter2',
                },
            }),
        );
        expect($('proxy-type').value).toBe('socks5');
        expect($('proxy-host').value).toBe('10.0.0.1');
        expect($('proxy-port').value).toBe('1080');
        expect($('proxy-username').value).toBe('u');
        expect($('proxy-password').value).toBe('');
        expect($('proxy-password').placeholder).toContain('saved');
    });

    it('saves the full proxy record', async () => {
        const mod = await boot();
        $('proxy-type').value = 'socks5';
        $('proxy-host').value = 'h';
        $('proxy-port').value = '9050';
        $('proxy-username').value = 'u';
        $('proxy-password').value = 'p';
        $('proxy-secret').value = 's';
        await mod.saveProxy();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            proxy: {
                type: 'socks5',
                host: 'h',
                port: 9050,
                username: 'u',
                password: 'p',
                secret: 's',
            },
        });
    });

    it('omits the optional fields when they are blank', async () => {
        const mod = await boot();
        $('proxy-type').value = 'http';
        $('proxy-host').value = 'h';
        $('proxy-port').value = '3128';
        await mod.saveProxy();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            proxy: { type: 'http', host: 'h', port: 3128 },
        });
    });

    it('clears the proxy when no type is chosen', async () => {
        const mod = await boot();
        await mod.saveProxy();
        expect(api.post).toHaveBeenCalledWith('/api/config', { proxy: null });
        expect(showToast).toHaveBeenCalledWith('Proxy disabled', 'info');
    });

    it('refuses to save without host and port', async () => {
        const mod = await boot();
        $('proxy-type').value = 'socks5';
        await mod.saveProxy();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Host and port required', 'error');
    });

    it('reports a failed save', async () => {
        const mod = await boot();
        $('proxy-type').value = 'socks5';
        $('proxy-host').value = 'h';
        $('proxy-port').value = '1';
        api.post.mockRejectedValueOnce(new Error('bad gateway'));
        await mod.saveProxy();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('bad gateway'), 'error');
    });

    it('reports a reachable proxy with its latency', async () => {
        stubApi({ '/api/config': CONFIG(), '/api/proxy/test': { ok: true, ms: 42 } });
        const mod = await load();
        await mod.loadSettings();
        $('proxy-host').value = 'h';
        $('proxy-port').value = '1080';
        await mod.testProxy();
        expect($('proxy-status').textContent).toContain('42ms');
        expect($('proxy-status').className).toContain('tg-green');
    });

    it('reports an unreachable proxy', async () => {
        stubApi({ '/api/config': CONFIG(), '/api/proxy/test': { ok: false, error: 'refused' } });
        const mod = await load();
        await mod.loadSettings();
        $('proxy-host').value = 'h';
        $('proxy-port').value = '1080';
        await mod.testProxy();
        expect($('proxy-status').textContent).toContain('refused');
        expect($('proxy-status').className).toContain('red');
    });

    it('reports a test that threw', async () => {
        const mod = await boot();
        $('proxy-host').value = 'h';
        $('proxy-port').value = '1080';
        api.post.mockRejectedValueOnce(new Error('timeout'));
        await mod.testProxy();
        expect($('proxy-status').textContent).toContain('timeout');
    });

    it('refuses to test without host and port', async () => {
        const mod = await boot();
        await mod.testProxy();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Host and port required', 'error');
    });
});

describe('telegram credentials', () => {
    it('shows the api id and a placeholder that says the hash is stored', async () => {
        await boot(CONFIG({ telegram: { apiId: '12345', apiHashSet: true } }));
        expect($('setting-api-id').value).toBe('12345');
        expect($('setting-api-hash').placeholder).toContain('saved');
    });

    it('hints where to get credentials when none are stored', async () => {
        await boot();
        expect($('setting-api-hash').placeholder).toContain('my.telegram.org');
    });

    it('saves both fields and clears the hash input', async () => {
        const mod = await boot();
        $('setting-api-id').value = '999';
        $('setting-api-hash').value = 'abc';
        await mod.saveApiCredentials();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            telegram: { apiId: '999', apiHash: 'abc' },
        });
        expect($('setting-api-hash').value).toBe('');
    });

    it('sends only the id when the hash is left blank', async () => {
        const mod = await boot();
        $('setting-api-id').value = '999';
        await mod.saveApiCredentials();
        expect(api.post).toHaveBeenCalledWith('/api/config', { telegram: { apiId: '999' } });
    });

    it('refuses to save without an api id', async () => {
        const mod = await boot();
        await mod.saveApiCredentials();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('API ID required', 'error');
    });

    it('reports a failed save', async () => {
        const mod = await boot();
        $('setting-api-id').value = '1';
        api.post.mockRejectedValueOnce(new Error('invalid id'));
        await mod.saveApiCredentials();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('invalid id'), 'error');
    });
});

// ---- accounts ------------------------------------------------------------

describe('accounts', () => {
    const ACCOUNTS = [
        { id: 'main', name: 'Main', username: 'me', phone: '+100', isDefault: true },
        { id: 'alt', name: 'Alt' },
    ];

    async function bootAccounts(accounts = ACCOUNTS) {
        stubApi({ '/api/config': CONFIG(), '/api/accounts': accounts });
        const mod = await load();
        await mod.loadAccounts();
        await flush();
        return mod;
    }

    it('renders one row per account, marking the default', async () => {
        await bootAccounts();
        const rows = $('accounts-list').querySelectorAll('[data-account]');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('Main');
        expect(rows[0].textContent).toContain('default');
        expect(rows[0].textContent).toContain('@me • +100');
        // No username or phone → fall back to the id.
        expect(rows[1].textContent).toContain('alt');
    });

    it('shows an empty state', async () => {
        await bootAccounts([]);
        expect($('accounts-list').textContent).toContain('No Telegram accounts yet');
    });

    it('escapes hostile account fields', async () => {
        await bootAccounts([{ id: 'x', name: '<img src=x onerror=alert(1)>' }]);
        expect($('accounts-list').querySelector('img')).toBeNull();
        expect($('accounts-list').textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('confirms, deletes and reloads on remove', async () => {
        await bootAccounts();
        api.get.mockClear();
        $('accounts-list').querySelector('[data-action="remove-account"]').click();
        await flush();
        expect(confirmSheet).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
        expect(api.delete).toHaveBeenCalledWith('/api/accounts/main');
        expect(showToast).toHaveBeenCalledWith('Account removed', 'success');
        expect(api.get).toHaveBeenCalledWith('/api/accounts');
    });

    it('url-encodes the account id', async () => {
        await bootAccounts([{ id: 'a/b', name: 'Slashy' }]);
        $('accounts-list').querySelector('[data-action="remove-account"]').click();
        await flush();
        expect(api.delete).toHaveBeenCalledWith('/api/accounts/a%2Fb');
    });

    it('keeps the account when the confirm is declined', async () => {
        confirmAnswer = false;
        await bootAccounts();
        $('accounts-list').querySelector('[data-action="remove-account"]').click();
        await flush();
        expect(api.delete).not.toHaveBeenCalled();
    });

    it('reports a failed removal', async () => {
        await bootAccounts();
        api.delete.mockRejectedValueOnce(new Error('in use'));
        $('accounts-list').querySelector('[data-action="remove-account"]').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('in use'), 'error');
    });

    it('renders a load failure into the list', async () => {
        stubApi({ '/api/config': CONFIG() });
        api.get.mockImplementation(async (url) => {
            if (String(url).includes('/api/accounts')) throw new Error('503');
            return CONFIG();
        });
        const mod = await load();
        await mod.loadAccounts();
        await flush();
        expect($('accounts-list').textContent).toContain('503');
    });
});

// ---- dashboard security --------------------------------------------------

describe('change password', () => {
    it('posts both fields and clears them', async () => {
        const mod = await boot();
        $('sec-current').value = 'old-password';
        $('sec-new').value = 'new-password';
        await mod.changePassword();
        expect(api.post).toHaveBeenCalledWith('/api/auth/change-password', {
            currentPassword: 'old-password',
            newPassword: 'new-password',
        });
        expect($('sec-current').value).toBe('');
        expect($('sec-new').value).toBe('');
        expect(showToast).toHaveBeenCalledWith('Password changed', 'success');
    });

    it('requires both fields', async () => {
        const mod = await boot();
        $('sec-current').value = 'only-current';
        await mod.changePassword();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Both fields required', 'error');
    });

    it('enforces a minimum length on the new password', async () => {
        const mod = await boot();
        $('sec-current').value = 'old-password';
        $('sec-new').value = 'short';
        await mod.changePassword();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(
            'New password must be at least 8 characters',
            'error',
        );
    });

    it('reports a rejected change', async () => {
        const mod = await boot();
        $('sec-current').value = 'old-password';
        $('sec-new').value = 'new-password';
        api.post.mockRejectedValueOnce(new Error('wrong current password'));
        await mod.changePassword();
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('wrong current password'),
            'error',
        );
    });
});

describe('sign out', () => {
    it('posts logout then leaves for the login page', async () => {
        const mod = await boot();
        delete window.location;
        window.location = { href: '' };
        await mod.signOut();
        expect(api.post).toHaveBeenCalledWith('/api/logout');
        expect(window.location.href).toBe('/login.html');
    });

    it('leaves anyway when logout fails', async () => {
        const mod = await boot();
        delete window.location;
        window.location = { href: '' };
        api.post.mockRejectedValueOnce(new Error('already gone'));
        await mod.signOut();
        expect(window.location.href).toBe('/login.html');
    });
});

// ---- guest password ------------------------------------------------------

describe('guest password', () => {
    async function bootGuestCard(authCheck = { guestEnabled: false }) {
        stubApi({ '/api/config': CONFIG(), '/api/auth_check': authCheck });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        return mod;
    }

    it('reflects the server state', async () => {
        await bootGuestCard({ guestEnabled: true });
        expect($('setting-guest-enabled').classList.contains('active')).toBe(true);
        expect($('guest-enable-status').textContent).toContain('Enabled');
    });

    it('describes the disabled state', async () => {
        await bootGuestCard();
        expect($('guest-enable-status').textContent).toContain('Disabled');
    });

    it('enables guest access', async () => {
        stubApi({
            '/api/config': CONFIG(),
            '/api/auth_check': { guestEnabled: false },
            '/api/auth/guest-password': { enabled: true },
        });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        $('setting-guest-enabled').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/auth/guest-password', { enabled: true });
        expect(showToast).toHaveBeenCalledWith('Guest access enabled');
    });

    it('saves a password of sufficient length', async () => {
        await bootGuestCard();
        $('setting-guest-password').value = 'long-enough';
        $('guest-set-btn').click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/auth/guest-password', {
            password: 'long-enough',
        });
        expect($('setting-guest-password').value).toBe('');
        expect($('guest-set-btn').disabled).toBe(false);
    });

    it('rejects a short password without calling the server', async () => {
        await bootGuestCard();
        $('setting-guest-password').value = 'short';
        $('guest-set-btn').click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(
            'Guest password must be at least 8 characters',
            'error',
        );
    });

    it('explains the same-as-admin rejection specifically', async () => {
        await bootGuestCard();
        $('setting-guest-password').value = 'long-enough';
        api.post.mockRejectedValueOnce(
            Object.assign(new Error('conflict'), { data: { code: 'SAME_AS_ADMIN' } }),
        );
        $('guest-set-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('Guest password must differ from admin', 'error');
        // The button must come back even on the error path.
        expect($('guest-set-btn').disabled).toBe(false);
    });

    it('surfaces any other rejection', async () => {
        await bootGuestCard();
        $('setting-guest-password').value = 'long-enough';
        api.post.mockRejectedValueOnce(
            Object.assign(new Error('x'), { data: { error: 'server said no' } }),
        );
        $('guest-set-btn').click();
        await flush();
        expect(showToast).toHaveBeenCalledWith('server said no', 'error');
    });

    it('confirms before clearing', async () => {
        await bootGuestCard();
        $('guest-clear-btn').click();
        await flush();
        expect(confirmSheet).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
        expect(api.post).toHaveBeenCalledWith('/api/auth/guest-password', { clear: true });
        expect(showToast).toHaveBeenCalledWith('Guest access cleared');
    });

    it('does nothing when the clear confirm is declined', async () => {
        confirmAnswer = false;
        await bootGuestCard();
        $('guest-clear-btn').click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });
});

// ---- federation ----------------------------------------------------------

describe('federation card', () => {
    async function bootFederation(config = CONFIG(), routes = {}) {
        stubApi({
            '/api/config': config,
            '/api/cluster/identity': { name: 'heimdal', peerId: 'peer-1' },
            '/api/cluster/peers': { peers: [] },
            ...routes,
        });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        return mod;
    }

    it('renders one row per replication key with local as the default', async () => {
        await bootFederation();
        const rows = $('federation-replicate-list').querySelectorAll('.federation-segmented');
        expect(rows).toHaveLength(5);
        const first = rows[0].querySelectorAll('.federation-policy-btn');
        expect(first).toHaveLength(3);
        expect(first[0].dataset.active).toBe('1');
    });

    it('marks the configured policy active', async () => {
        await bootFederation(CONFIG({ cluster: { replicate: { groups: 'cluster' } } }));
        const groupBtns = $('federation-replicate-list').querySelectorAll('[data-key="groups"]');
        expect(groupBtns[1].dataset.active).toBe('1');
        expect(groupBtns[0].dataset.active).toBeUndefined();
    });

    it('saves a policy change and repaints the row', async () => {
        await bootFederation(CONFIG({ cluster: { replicate: {} } }));
        const clusterBtn = $('federation-replicate-list').querySelector(
            '[data-key="groups"][data-policy="cluster"]',
        );
        clusterBtn.click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            cluster: expect.objectContaining({ replicate: { groups: 'cluster' } }),
        });
        expect(clusterBtn.dataset.active).toBe('1');
    });

    it('drops the key entirely when set back to local', async () => {
        await bootFederation(CONFIG({ cluster: { replicate: { groups: 'cluster' } } }));
        $('federation-replicate-list')
            .querySelector('[data-key="groups"][data-policy="local"]')
            .click();
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            cluster: expect.objectContaining({ replicate: {} }),
        });
    });

    it('ignores a click that is not on a policy button', async () => {
        await bootFederation();
        $('federation-replicate-list').click();
        await flush();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('clamps and saves the failover grace on release', async () => {
        await bootFederation(CONFIG({ cluster: { failover_grace_minutes: 99 } }));
        expect($('federation-failover-grace').value).toBe('60');
        expect($('federation-failover-grace-value').textContent).toBe('60 min');

        $('federation-failover-grace').value = '12';
        $('federation-failover-grace').dispatchEvent(new window.Event('input'));
        expect($('federation-failover-grace-value').textContent).toBe('12 min');
        expect(api.post).not.toHaveBeenCalled();

        $('federation-failover-grace').dispatchEvent(new window.Event('change'));
        await flush();
        expect(api.post).toHaveBeenCalledWith('/api/config', {
            cluster: expect.objectContaining({ failover_grace_minutes: 12 }),
        });
    });

    it('shows this peer identity', async () => {
        await bootFederation();
        expect($('federation-self-name').textContent).toBe('heimdal');
        expect($('federation-self-id').textContent).toBe('peer-1');
    });

    it('hides the empty hint once a peer is paired', async () => {
        await bootFederation(CONFIG(), { '/api/cluster/peers': { peers: [{ id: 'p2' }] } });
        expect($('federation-empty-hint').classList.contains('hidden')).toBe(true);
    });

    it('shows the empty hint with no peers', async () => {
        await bootFederation();
        expect($('federation-empty-hint').classList.contains('hidden')).toBe(false);
    });

    it('falls back to dashes when the identity endpoint is unavailable', async () => {
        stubApi({ '/api/config': CONFIG() });
        api.get.mockImplementation(async (url) => {
            if (String(url).includes('/api/cluster/')) throw new Error('401');
            if (String(url).includes('/api/accounts')) return [];
            return CONFIG();
        });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        expect($('federation-self-name').textContent).toBe('');
    });
});

// ---- advanced ------------------------------------------------------------

describe('advanced tunables', () => {
    it('renders the documented defaults for a config with no advanced block', async () => {
        const mod = await load();
        mod.loadAdvanced({});
        expect($('setting-adv-min-concurrency').value).toBe('3');
        expect($('setting-adv-max-concurrency').value).toBe('20');
        expect($('setting-adv-scaler-sec').value).toBe('5');
        expect($('setting-adv-idle-sleep-ms').value).toBe('200');
        expect($('setting-adv-spillover').value).toBe('2000');
        expect($('setting-adv-backpressure').value).toBe('500');
        expect($('setting-adv-sweep-batch').value).toBe('50');
        expect($('setting-adv-integrity-min').value).toBe('60');
        expect($('setting-adv-session-days').value).toBe('7');
    });

    it('lets stored values win over the defaults', async () => {
        const mod = await load();
        mod.loadAdvanced({ advanced: { downloader: { minConcurrency: 9 }, web: {} } });
        expect($('setting-adv-min-concurrency').value).toBe('9');
        // Siblings inside the same block keep their defaults.
        expect($('setting-adv-max-concurrency').value).toBe('20');
    });

    it('defaults the history backfill toggles on', async () => {
        const mod = await load();
        mod.loadAdvanced({});
        expect($('setting-adv-auto-first-backfill').classList.contains('active')).toBe(true);
        expect($('setting-adv-auto-catchup').classList.contains('active')).toBe(true);
        expect($('setting-adv-auto-first-limit').value).toBe('50');
        expect($('setting-adv-batch-insert').value).toBe('50');
    });

    it('defaults the NSFW toggles off and seeds the model fields', async () => {
        const mod = await load();
        mod.loadAdvanced({});
        expect($('setting-adv-nsfw-enabled').classList.contains('active')).toBe(false);
        expect($('setting-adv-nsfw-model').value).toBe('AdamCodd/vit-base-nsfw-detector');
        expect($('setting-adv-nsfw-dtype').value).toBe('q8');
        expect($('setting-adv-nsfw-threshold').value).toBe('0.6');
        expect($('setting-adv-nsfw-concurrency').value).toBe('1');
    });

    it('rejects an unknown dtype and a blank model', async () => {
        const mod = await load();
        mod.loadAdvanced({ advanced: { nsfw: { dtype: 'int2', model: '   ' } } });
        expect($('setting-adv-nsfw-dtype').value).toBe('q8');
        expect($('setting-adv-nsfw-model').value).toBe('AdamCodd/vit-base-nsfw-detector');
    });

    it('defaults the seekbar block and its two toggles on', async () => {
        const mod = await load();
        mod.loadAdvanced({});
        expect($('setting-adv-seekbar-intervalSec').value).toBe('4');
        expect($('setting-adv-seekbar-tileWidth').value).toBe('160');
        expect($('setting-adv-seekbar-columns').value).toBe('10');
        expect($('setting-adv-seekbar-maxTiles').value).toBe('240');
        expect($('setting-adv-seekbar-quality').value).toBe('75');
        expect($('setting-adv-seekbar-format').value).toBe('webp');
        expect($('setting-adv-seekbar-enabled').classList.contains('active')).toBe(true);
        expect($('setting-adv-seekbar-autoOnDownload').classList.contains('active')).toBe(true);
    });

    it('falls back to the default for a non-numeric seekbar value', async () => {
        const mod = await load();
        mod.loadAdvanced({ advanced: { seekbar: { quality: 'high' } } });
        expect($('setting-adv-seekbar-quality').value).toBe('75');
    });

    it('defaults the thumb-miss warning on and reads hwaccel as a bare string', async () => {
        const mod = await load();
        mod.loadAdvanced({ advanced: { thumbs: { hwaccel: 'vaapi', warnMisses: false } } });
        expect($('setting-adv-ffmpeg-hwaccel').value).toBe('vaapi');
        expect($('setting-adv-thumbs-warn-misses').classList.contains('active')).toBe(false);
    });

    it('flips a toggle on click and wires it only once', async () => {
        const mod = await load();
        mod.loadAdvanced({});
        const el = $('setting-adv-nsfw-enabled');
        el.click();
        expect(el.classList.contains('active')).toBe(true);
        // A second hydrate must not stack another click handler.
        mod.loadAdvanced({ advanced: { nsfw: { enabled: true } } });
        el.click();
        expect(el.classList.contains('active')).toBe(false);
    });

    describe('hwaccel probe', () => {
        it('lists the available backends', async () => {
            stubApi({ '/hwaccel-probe': { available: ['vaapi', 'cuda'] } });
            const mod = await load();
            mod.loadAdvanced({});
            $('setting-adv-ffmpeg-hwaccel-probe').click();
            await flush();
            const out = $('setting-adv-ffmpeg-hwaccel-probe-result');
            expect(out.textContent).toContain('vaapi');
            expect(out.textContent).toContain('cuda');
            expect($('setting-adv-ffmpeg-hwaccel-probe').disabled).toBe(false);
        });

        it('says so when there are none', async () => {
            stubApi({ '/hwaccel-probe': { available: [] } });
            const mod = await load();
            mod.loadAdvanced({});
            $('setting-adv-ffmpeg-hwaccel-probe').click();
            await flush();
            expect($('setting-adv-ffmpeg-hwaccel-probe-result').textContent).toContain('CPU only');
        });

        it('renders a probe failure and restores the button', async () => {
            const mod = await load();
            mod.loadAdvanced({});
            api.get.mockRejectedValueOnce(new Error('ffmpeg missing'));
            const before = $('setting-adv-ffmpeg-hwaccel-probe').innerHTML;
            $('setting-adv-ffmpeg-hwaccel-probe').click();
            await flush();
            expect($('setting-adv-ffmpeg-hwaccel-probe-result').textContent).toContain(
                'ffmpeg missing',
            );
            expect($('setting-adv-ffmpeg-hwaccel-probe').innerHTML).toBe(before);
            expect($('setting-adv-ffmpeg-hwaccel-probe').disabled).toBe(false);
        });
    });
});

// ---- save ----------------------------------------------------------------

describe('saveSettings', () => {
    it('sends the whole config tree', async () => {
        const mod = await boot();
        await mod.saveSettings();
        const body = api.post.mock.calls.at(-1)[1];
        expect(body.download.concurrent).toBe(4);
        expect(body.rateLimits.requestsPerMinute).toBe(20);
        expect(body.pollingInterval).toBe(15);
        expect(body.advanced.downloader.minConcurrency).toBe(3);
        expect(body.advanced.nsfw.enabled).toBe(false);
        expect(showToast).toHaveBeenCalledWith('Settings saved!', 'success');
    });

    it('clamps the rescue window and sweep interval', async () => {
        const mod = await boot();
        $('setting-rescue-default-hours').value = '9999';
        $('setting-rescue-sweep-min').value = '0';
        await mod.saveSettings();
        const body = api.post.mock.calls.at(-1)[1];
        expect(body.rescue.retentionHours).toBe(720);
        expect(body.rescue.sweepIntervalMin).toBe(10);
    });

    it('falls back to the advanced defaults for unparseable fields', async () => {
        const mod = await boot();
        $('setting-adv-min-concurrency').value = 'lots';
        $('setting-adv-integrity-batch').value = '';
        await mod.saveSettings();
        const adv = api.post.mock.calls.at(-1)[1].advanced;
        expect(adv.downloader.minConcurrency).toBe(3);
        expect(adv.integrity.batchSize).toBe(64);
    });

    it('reads the advanced toggles with their asymmetric defaults', async () => {
        const mod = await boot();
        $('setting-adv-auto-catchup').classList.remove('active');
        $('setting-adv-nsfw-enabled').classList.add('active');
        await mod.saveSettings();
        const adv = api.post.mock.calls.at(-1)[1].advanced;
        // History toggles default ON (only an explicit off is off) …
        expect(adv.history.autoCatchUp).toBe(false);
        expect(adv.history.autoFirstBackfill).toBe(true);
        // … NSFW toggles default OFF.
        expect(adv.nsfw.enabled).toBe(true);
        expect(adv.nsfw.preload).toBe(false);
    });

    it('reports a failed save', async () => {
        const mod = await boot();
        api.post.mockRejectedValueOnce(new Error('disk full'));
        await mod.saveSettings();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('disk full'), 'error');
    });
});

describe('applyPreset', () => {
    it('applies each preset and fires input events so the labels follow', async () => {
        const mod = await boot();
        const seen = [];
        $('setting-concurrent').addEventListener('input', () => seen.push('c'));

        mod.applyPreset('safe');
        expect([
            $('setting-concurrent').value,
            $('setting-rpm').value,
            $('setting-polling').value,
        ]).toEqual(['1', '5', '30']);

        mod.applyPreset('balanced');
        expect([
            $('setting-concurrent').value,
            $('setting-rpm').value,
            $('setting-polling').value,
        ]).toEqual(['3', '15', '10']);

        mod.applyPreset('fast');
        expect([
            $('setting-concurrent').value,
            $('setting-rpm').value,
            $('setting-polling').value,
        ]).toEqual(['5', '30', '5']);

        expect(seen).toHaveLength(3);
    });

    it('leaves the fields alone for an unknown preset', async () => {
        const mod = await boot();
        mod.applyPreset('turbo');
        expect($('setting-concurrent').value).toBe('4');
    });
});

// ---- autosave ------------------------------------------------------------

describe('autosave', () => {
    it('debounces an edit into one save and reports the time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T09:05:03'));
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);

        $('setting-concurrent').value = '7';
        $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        expect($('settings-autosave-text').textContent).toBe('Editing…');
        expect($('settings-autosave-status').dataset.state).toBe('dirty');

        // Nothing has gone out yet — the debounce is still running.
        expect(api.post).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(801);
        expect(api.post).toHaveBeenCalledWith('/api/config', expect.any(Object));
        expect($('settings-autosave-text').textContent).toBe('Saved at 09:05:03');

        // The chip fades back to idle on its own.
        await vi.advanceTimersByTimeAsync(2501);
        expect($('settings-autosave-status').dataset.state).toBe('idle');
    });

    it('collapses a burst of edits into a single request', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        for (const v of ['5', '6', '7']) {
            $('setting-concurrent').value = v;
            $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        }
        await vi.advanceTimersByTimeAsync(801);
        expect(api.post).toHaveBeenCalledTimes(1);
        expect(api.post.mock.calls[0][1].download.concurrent).toBe(7);
    });

    it('skips the request when the payload is unchanged', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(801);
        expect(api.post).not.toHaveBeenCalled();
        expect($('settings-autosave-status').dataset.state).toBe('idle');
    });

    it('flushes early when the field loses focus', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-concurrent').value = '9';
        $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        $('setting-concurrent').dispatchEvent(new window.Event('focusout', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(1);
        expect(api.post).toHaveBeenCalled();
    });

    it('ignores a blur when nothing is pending', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-concurrent').dispatchEvent(new window.Event('focusout', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(1);
        expect(api.post).not.toHaveBeenCalled();
    });

    it('flushes when the tab is hidden', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-concurrent').value = '9';
        $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new window.Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(1);
        expect(api.post).toHaveBeenCalled();
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    });

    it('ignores edits to fields that did not opt in', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('proxy-host').value = 'h';
        $('proxy-host').dispatchEvent(new window.Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(801);
        expect(api.post).not.toHaveBeenCalled();
    });

    it('saves after a toggle click', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-allow-dm').click();
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(801);
        expect(api.post.mock.calls.at(-1)[1].allowDmDownloads).toBe(true);
    });

    it('sticks on an error and pings the notification bell', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        api.post.mockRejectedValueOnce(new Error('409 conflict'));
        $('setting-concurrent').value = '7';
        $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(801);
        await vi.advanceTimersByTimeAsync(1);
        expect($('settings-autosave-status').dataset.state).toBe('error');
        expect($('settings-autosave-text').textContent).toContain('409 conflict');
        // Unlike "saved", the error does not fade away.
        await vi.advanceTimersByTimeAsync(5000);
        expect($('settings-autosave-status').dataset.state).toBe('error');
        expect(pushLogToNotify).toHaveBeenCalledWith(
            expect.objectContaining({ level: 'error', source: 'settings' }),
        );
    });

    // saveSettings() and _gatherSettingsPayload() carry their own copies of
    // the rescue clamp. Covering only the button leaves the autosave copy
    // free to drift, so assert it separately rather than assuming they stay
    // in step.
    it('clamps the rescue window on the autosave path too', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-rescue-default-hours').value = '9999';
        $('setting-rescue-default-hours').dispatchEvent(
            new window.Event('input', { bubbles: true }),
        );
        $('setting-rescue-sweep-min').value = '99999';
        $('setting-rescue-sweep-min').dispatchEvent(new window.Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(801);
        await vi.advanceTimersByTimeAsync(1);
        const body = api.post.mock.calls.at(-1)[1];
        expect(body.rescue.retentionHours).toBe(720);
        expect(body.rescue.sweepIntervalMin).toBe(1440);
    });

    it('wires only once', async () => {
        vi.useFakeTimers();
        const mod = await boot(CONFIG(), { page: 'settings' });
        mod.setupAutoSave();
        mod.setupAutoSave();
        await vi.advanceTimersByTimeAsync(1);
        $('setting-concurrent').value = '7';
        $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(801);
        expect(api.post).toHaveBeenCalledTimes(1);
    });

    describe('scoped payloads', () => {
        async function editOn(page, id, value) {
            vi.useFakeTimers();
            const mod = await boot(CONFIG(), { page });
            mod.setupAutoSave();
            await vi.advanceTimersByTimeAsync(1);
            $(id).value = value;
            $(id).dispatchEvent(new window.Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(801);
            await vi.advanceTimersByTimeAsync(1);
            return api.post.mock.calls.at(-1)?.[1];
        }

        it('sends only the thumbs keys from the thumbs page', async () => {
            const body = await editOn('maintenance-thumbs', 'setting-adv-ffmpeg-hwaccel', 'qsv');
            expect(body).toEqual({ advanced: { thumbs: { hwaccel: 'qsv', warnMisses: true } } });
        });

        it('sends only the NSFW keys from the NSFW page', async () => {
            const body = await editOn('maintenance-nsfw', 'setting-adv-nsfw-model', 'my/model');
            expect(Object.keys(body.advanced)).toEqual(['nsfw']);
            expect(body.advanced.nsfw.model).toBe('my/model');
            expect(body.advanced.nsfw.threshold).toBe(0.6);
        });

        it('sends only the seekbar keys from the seekbar page', async () => {
            const body = await editOn('maintenance-seekbar', 'setting-adv-seekbar-quality', '90');
            expect(Object.keys(body.advanced)).toEqual(['seekbar']);
            expect(body.advanced.seekbar.quality).toBe(90);
            expect(body.advanced.seekbar.format).toBe('webp');
        });

        it('saves nothing at all from a page that owns no settings', async () => {
            vi.useFakeTimers();
            const mod = await boot(CONFIG(), { page: 'gallery' });
            mod.setupAutoSave();
            await vi.advanceTimersByTimeAsync(1);
            $('setting-concurrent').value = '7';
            $('setting-concurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(801);
            expect(api.post).not.toHaveBeenCalled();
            expect($('settings-autosave-status').dataset.state).toBe('idle');
        });

        it('toasts the page label instead of a clock away from Settings', async () => {
            await editOn('maintenance-thumbs', 'setting-adv-ffmpeg-hwaccel', 'qsv');
            expect(showToast).toHaveBeenCalledWith('Build thumbnails settings saved', 'success');
        });

        it('names each maintenance page in its toast', async () => {
            await editOn('maintenance-nsfw', 'setting-adv-nsfw-model', 'm');
            expect(showToast).toHaveBeenCalledWith('NSFW settings saved', 'success');
        });

        it('toasts a failure away from Settings', async () => {
            vi.useFakeTimers();
            const mod = await boot(CONFIG(), { page: 'maintenance-thumbs' });
            mod.setupAutoSave();
            await vi.advanceTimersByTimeAsync(1);
            api.post.mockRejectedValueOnce(new Error('offline'));
            $('setting-adv-ffmpeg-hwaccel').value = 'qsv';
            $('setting-adv-ffmpeg-hwaccel').dispatchEvent(
                new window.Event('input', { bubbles: true }),
            );
            await vi.advanceTimersByTimeAsync(801);
            await vi.advanceTimersByTimeAsync(1);
            expect(showToast).toHaveBeenCalledWith(expect.stringContaining('offline'), 'error');
        });
    });
});

// ---- rescue stats + maintenance wiring ----------------------------------

describe('rescue stats', () => {
    it('renders the counters', async () => {
        await boot(CONFIG(), {
            routes: { '/api/rescue/stats': { pending: 3, rescued: 2, lastSweepCleared: 9 } },
        });
        expect($('rescue-stats-line').textContent).toBe(
            '3 pending · 2 rescued · 9 cleared last sweep',
        );
    });

    it('says so when the endpoint is unavailable', async () => {
        stubApi({ '/api/config': CONFIG() });
        api.get.mockImplementation(async (url) => {
            if (String(url).includes('/api/rescue/stats')) throw new Error('404');
            if (String(url).includes('/api/accounts')) return [];
            return CONFIG();
        });
        const mod = await load();
        await mod.loadSettings();
        await flush();
        expect($('rescue-stats-line').textContent).toBe('Rescue stats unavailable.');
    });

    it('does not ask for stats as a guest', async () => {
        await boot(CONFIG(), { role: 'guest' });
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/rescue/stats'))).toBe(false);
    });
});

describe('maintenance wiring', () => {
    it('routes the standalone-page buttons through the SPA router', async () => {
        window.navigateTo = vi.fn();
        await boot();
        $('maint-dedup-btn').click();
        $('maint-thumbs-build-btn').click();
        $('maint-nsfw-review-btn').click();
        $('maint-logs-btn').click();
        expect(window.navigateTo.mock.calls.map((c) => c[0])).toEqual([
            'maintenance/duplicates',
            'maintenance/thumbs',
            'maintenance/nsfw',
            'maintenance/logs',
        ]);
    });

    it('survives a missing router', async () => {
        await boot();
        expect(() => $('maint-dedup-btn').click()).not.toThrow();
    });

    it('binds each button exactly once across repeated opens', async () => {
        window.navigateTo = vi.fn();
        const mod = await boot();
        await mod.loadSettings();
        await flush();
        $('maint-dedup-btn').click();
        expect(window.navigateTo).toHaveBeenCalledTimes(1);
    });

    it('refreshes the NSFW status card', async () => {
        await boot();
        expect(refreshNsfwStatus).toHaveBeenCalled();
    });
});
