// @vitest-environment jsdom
//
// Covers src/web/public/js/i18n.js — lazy locale loading, `t`/`tf` lookup
// and the data-i18n DOM sweep.
//
// The module keeps its dictionary, active language and listener set at
// module scope, so every test re-imports through vi.resetModules() to get
// a clean instance. `tests/setup.js` supplies localStorage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function loadI18n() {
    vi.resetModules();
    return import('../src/web/public/js/i18n.js');
}

function mockFetch(payload, { ok = true } = {}) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok,
        json: async () => payload,
    });
}

describe('i18n', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
        document.documentElement.lang = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('t', () => {
        it('falls back to the supplied string, then to the key itself', async () => {
            const i18n = await loadI18n();
            expect(i18n.t('missing.key', 'Fallback')).toBe('Fallback');
            expect(i18n.t('missing.key')).toBe('missing.key');
        });

        it('returns the translation once a dictionary is loaded', async () => {
            const i18n = await loadI18n();
            mockFetch({ 'nav.queue': 'คิว' });
            await i18n.setLang('th');
            expect(i18n.t('nav.queue', 'Queue')).toBe('คิว');
        });
    });

    describe('tf', () => {
        it('interpolates named placeholders', async () => {
            const i18n = await loadI18n();
            expect(i18n.tf('k', { count: 3 }, 'Delete {count} file(s)?')).toBe('Delete 3 file(s)?');
        });

        it('returns the template untouched when no vars are given', async () => {
            const i18n = await loadI18n();
            expect(i18n.tf('k', null, 'Delete {count}')).toBe('Delete {count}');
        });

        it('leaves a placeholder in place when its var is missing or null', async () => {
            const i18n = await loadI18n();
            expect(i18n.tf('k', { other: 1 }, '{count} files')).toBe('{count} files');
            expect(i18n.tf('k', { count: null }, '{count} files')).toBe('{count} files');
        });

        it('interpolates zero rather than treating it as absent', async () => {
            const i18n = await loadI18n();
            expect(i18n.tf('k', { count: 0 }, '{count} files')).toBe('0 files');
        });

        it('prefers the loaded translation over the fallback template', async () => {
            const i18n = await loadI18n();
            mockFetch({ 'bulk.confirm': 'ลบ {count} ไฟล์?' });
            await i18n.setLang('th');
            expect(i18n.tf('bulk.confirm', { count: 2 }, 'Delete {count}?')).toBe('ลบ 2 ไฟล์?');
        });
    });

    describe('getLang / setLang', () => {
        it('defaults to auto', async () => {
            const i18n = await loadI18n();
            expect(i18n.getLang()).toBe('auto');
        });

        it('persists a supported language and reflects it on <html lang>', async () => {
            const i18n = await loadI18n();
            mockFetch({});
            await i18n.setLang('th');
            expect(i18n.getLang()).toBe('th');
            expect(document.documentElement.lang).toBe('th');
        });

        it('ignores an unsupported language entirely', async () => {
            const i18n = await loadI18n();
            const fetchSpy = mockFetch({});
            await i18n.setLang('klingon');
            expect(i18n.getLang()).toBe('auto');
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('resolves auto against the browser language', async () => {
            vi.spyOn(navigator, 'language', 'get').mockReturnValue('th-TH');
            const i18n = await loadI18n();
            mockFetch({});
            await i18n.setLang('auto');
            // Stored value stays 'auto'; the resolved one lands on <html>.
            expect(i18n.getLang()).toBe('auto');
            expect(document.documentElement.lang).toBe('th');
        });

        it('falls back to English for an unsupported browser language', async () => {
            vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
            const i18n = await loadI18n();
            await i18n.setLang('auto');
            expect(document.documentElement.lang).toBe('en');
        });
    });

    describe('locale loading', () => {
        it('ships English inline — no network round-trip', async () => {
            const i18n = await loadI18n();
            const fetchSpy = mockFetch({ a: 'b' });
            await i18n.setLang('en');
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(i18n.t('a', 'A')).toBe('A');
        });

        it('requests the locale file for other languages', async () => {
            const i18n = await loadI18n();
            const fetchSpy = mockFetch({});
            await i18n.setLang('th');
            expect(fetchSpy).toHaveBeenCalledWith('/locales/th.json');
        });

        it('degrades to the fallback strings on a non-ok response', async () => {
            const i18n = await loadI18n();
            mockFetch({ 'nav.queue': 'คิว' }, { ok: false });
            await i18n.setLang('th');
            expect(i18n.t('nav.queue', 'Queue')).toBe('Queue');
        });

        it('degrades to the fallback strings when the request throws', async () => {
            const i18n = await loadI18n();
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
            await i18n.setLang('th');
            expect(i18n.t('nav.queue', 'Queue')).toBe('Queue');
        });

        it('clears a previously loaded dictionary when switching back to English', async () => {
            const i18n = await loadI18n();
            mockFetch({ 'nav.queue': 'คิว' });
            await i18n.setLang('th');
            expect(i18n.t('nav.queue', 'Queue')).toBe('คิว');
            await i18n.setLang('en');
            expect(i18n.t('nav.queue', 'Queue')).toBe('Queue');
        });
    });

    describe('onLanguageChange', () => {
        it('notifies subscribers with the resolved language', async () => {
            const i18n = await loadI18n();
            mockFetch({});
            const seen = vi.fn();
            i18n.onLanguageChange(seen);
            await i18n.setLang('th');
            expect(seen).toHaveBeenCalledWith('th');
        });

        it('returns an unsubscribe handle', async () => {
            const i18n = await loadI18n();
            mockFetch({});
            const seen = vi.fn();
            const off = i18n.onLanguageChange(seen);
            off();
            await i18n.setLang('th');
            expect(seen).not.toHaveBeenCalled();
        });

        it('keeps notifying the rest when one subscriber throws', async () => {
            const i18n = await loadI18n();
            mockFetch({});
            const bad = vi.fn(() => {
                throw new Error('boom');
            });
            const good = vi.fn();
            i18n.onLanguageChange(bad);
            i18n.onLanguageChange(good);
            await expect(i18n.setLang('th')).resolves.toBeUndefined();
            expect(good).toHaveBeenCalled();
        });
    });

    describe('applyToDOM', () => {
        it('replaces textContent for a data-i18n element', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `<span data-i18n="nav.queue">Queue</span>`;
            mockFetch({ 'nav.queue': 'คิว' });
            await i18n.setLang('th');
            expect(document.querySelector('span').textContent).toBe('คิว');
        });

        it('uses the existing text as the fallback when the key is missing', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `<span data-i18n="nav.unknown">  Queue  </span>`;
            i18n.applyToDOM();
            expect(document.querySelector('span').textContent).toBe('Queue');
        });

        it('prefers an explicit data-i18n-fallback', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `<span data-i18n="x" data-i18n-fallback="Explicit">Inline</span>`;
            i18n.applyToDOM();
            expect(document.querySelector('span').textContent).toBe('Explicit');
        });

        it('renders _html keys as markup so embedded tags format', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `<p data-i18n="tip_html">old</p>`;
            mockFetch({ tip_html: 'Run <code>npm test</code>' });
            await i18n.setLang('th');
            const p = document.querySelector('p');
            expect(p.querySelector('code')).not.toBeNull();
            expect(p.textContent).toBe('Run npm test');
        });

        it('keeps _html fallbacks as markup too', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `<p data-i18n="missing_html">Run <code>x</code></p>`;
            i18n.applyToDOM();
            expect(document.querySelector('code')).not.toBeNull();
        });

        it('translates aria-label, placeholder and title attributes', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `
                <button data-i18n-aria-label="a.close" aria-label="Close"></button>
                <input data-i18n-placeholder="a.search" placeholder="Search">
                <span data-i18n-title="a.info" title="Info"></span>
            `;
            mockFetch({ 'a.close': 'ปิด', 'a.search': 'ค้นหา', 'a.info': 'ข้อมูล' });
            await i18n.setLang('th');
            expect(document.querySelector('button').getAttribute('aria-label')).toBe('ปิด');
            expect(document.querySelector('input').getAttribute('placeholder')).toBe('ค้นหา');
            expect(document.querySelector('span').getAttribute('title')).toBe('ข้อมูล');
        });

        it('leaves attribute values alone when the key is missing', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `<button data-i18n-aria-label="nope" aria-label="Close"></button>`;
            i18n.applyToDOM();
            expect(document.querySelector('button').getAttribute('aria-label')).toBe('Close');
        });

        it('scopes the sweep to the given root', async () => {
            const i18n = await loadI18n();
            document.body.innerHTML = `
                <div id="inside"><span data-i18n="k">before</span></div>
                <span id="outside" data-i18n="k">before</span>
            `;
            mockFetch({ k: 'after' });
            await i18n.setLang('th');
            document.querySelector('#outside').textContent = 'before';
            i18n.applyToDOM(document.getElementById('inside'));
            expect(document.querySelector('#inside span').textContent).toBe('after');
            expect(document.querySelector('#outside').textContent).toBe('before');
        });
    });

    describe('initI18n', () => {
        it('applies the stored language and resolves `ready`', async () => {
            localStorage.setItem('tgdl-lang', 'th');
            const i18n = await loadI18n();
            document.body.innerHTML = `<span data-i18n="k">before</span>`;
            mockFetch({ k: 'after' });
            await i18n.initI18n();
            expect(document.documentElement.lang).toBe('th');
            expect(document.querySelector('span').textContent).toBe('after');
            await expect(i18n.ready).resolves.toBe('th');
        });

        it('resolves auto against the browser language', async () => {
            vi.spyOn(navigator, 'language', 'get').mockReturnValue('th');
            const i18n = await loadI18n();
            mockFetch({});
            await i18n.initI18n();
            expect(document.documentElement.lang).toBe('th');
            await expect(i18n.ready).resolves.toBe('th');
        });
    });
});
