// @vitest-environment jsdom
//
// Covers src/web/public/js/fonts.js — the font registry: persisted
// active-font lookup with a fallback to the default, applyFont's
// <link> injection/replacement + CSS var, and populateSelect's
// grouped <optgroup> markup.
//
// localStorage is the real jsdom-polyfilled global (tests/setup.js).

import { describe, it, expect, beforeEach } from 'vitest';
import {
    FONTS,
    FALLBACK_STACK,
    getActiveFontId,
    applyFont,
    populateSelect,
} from '../src/web/public/js/fonts.js';

beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '';
    document.documentElement.style.cssText = '';
});

describe('getActiveFontId', () => {
    it('defaults to ibm-plex-sans when nothing is stored', () => {
        expect(getActiveFontId()).toBe('ibm-plex-sans');
    });

    it('returns the stored id when it is a known font', () => {
        localStorage.setItem('tgdl-font', 'roboto');
        expect(getActiveFontId()).toBe('roboto');
    });

    it('falls back to the default for an unknown/stale stored id', () => {
        localStorage.setItem('tgdl-font', 'some-removed-font');
        expect(getActiveFontId()).toBe('ibm-plex-sans');
    });
});

describe('applyFont', () => {
    it('persists the chosen font id', () => {
        applyFont('roboto');
        expect(localStorage.getItem('tgdl-font')).toBe('roboto');
    });

    it('falls back to the first registry entry for an unknown id', () => {
        applyFont('not-a-real-font');
        expect(localStorage.getItem('tgdl-font')).toBe(FONTS[0].id);
    });

    it('injects a Google Fonts <link> for a font with a query', () => {
        applyFont('roboto');
        const link = document.getElementById('tgdl-fonts-user');
        expect(link).not.toBeNull();
        expect(link.rel).toBe('stylesheet');
        expect(link.href).toContain('fonts.googleapis.com/css2?family=Roboto');
    });

    it('does not inject a link for the system font (query: null)', () => {
        applyFont('system');
        expect(document.getElementById('tgdl-fonts-user')).toBeNull();
    });

    it('removes the previous link before adding a new one (no pile-up)', () => {
        applyFont('roboto');
        applyFont('inter');
        expect(document.querySelectorAll('#tgdl-fonts-user')).toHaveLength(1);
        expect(document.getElementById('tgdl-fonts-user').href).toContain('Inter');
    });

    it('removes a stale link when switching to the system font', () => {
        applyFont('roboto');
        applyFont('system');
        expect(document.getElementById('tgdl-fonts-user')).toBeNull();
    });

    it('sets the --tgdl-font-family CSS var including the fallback stack', () => {
        applyFont('sarabun');
        const value = document.documentElement.style.getPropertyValue('--tgdl-font-family');
        expect(value).toBe(`'Sarabun', ${FALLBACK_STACK}`);
    });

    it('re-applying the current id is a no-op besides persisting again', () => {
        applyFont('roboto');
        applyFont('roboto');
        expect(document.querySelectorAll('#tgdl-fonts-user')).toHaveLength(1);
    });

    it('degrades silently when localStorage.setItem throws (private mode)', () => {
        const orig = localStorage.setItem;
        localStorage.setItem = () => {
            throw new Error('quota');
        };
        expect(() => applyFont('roboto')).not.toThrow();
        localStorage.setItem = orig;
    });
});

describe('populateSelect', () => {
    it('does nothing (no throw) with a null select element', () => {
        expect(() => populateSelect(null)).not.toThrow();
    });

    it('groups options under Thai-capable / Latin / No webfont optgroups', () => {
        const select = document.createElement('select');
        populateSelect(select);
        const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label);
        expect(groups).toEqual(['Thai-capable', 'Latin (Thai falls back)', 'No webfont']);
    });

    it('renders one option per registry entry', () => {
        const select = document.createElement('select');
        populateSelect(select);
        expect(select.querySelectorAll('option')).toHaveLength(FONTS.length);
    });

    it('sets each option value to the font id and label to its name', () => {
        const select = document.createElement('select');
        populateSelect(select);
        const option = select.querySelector('option[value="roboto"]');
        expect(option.textContent).toBe('Roboto');
    });

    it('previews the family in the option style', () => {
        const select = document.createElement('select');
        populateSelect(select);
        const option = select.querySelector('option[value="roboto"]');
        expect(option.getAttribute('style')).toContain("font-family: 'Roboto'");
    });

    it('escapes double quotes in the system family so the style attribute is not truncated', () => {
        // getAttribute() decodes entities back to raw quotes, so the escaped
        // markup isn't observable as literal "&quot;" text here — what's
        // observable is that the attribute survives intact through to
        // 'sans-serif' instead of getting cut off at the embedded `"`.
        const select = document.createElement('select');
        populateSelect(select);
        const option = select.querySelector('option[value="system"]');
        expect(option.getAttribute('style')).toContain('Roboto, sans-serif');
    });

    it('selects the currently active font on populate', () => {
        localStorage.setItem('tgdl-font', 'kanit');
        const select = document.createElement('select');
        populateSelect(select);
        expect(select.value).toBe('kanit');
    });

    it('re-populating clears any previously rendered options', () => {
        const select = document.createElement('select');
        populateSelect(select);
        populateSelect(select);
        expect(select.querySelectorAll('option')).toHaveLength(FONTS.length);
    });
});

describe('FONTS registry integrity', () => {
    it('every entry has a unique id', () => {
        const ids = FONTS.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every entry is one of the three known categories', () => {
        for (const f of FONTS) {
            expect(['thai', 'latin', 'system']).toContain(f.category);
        }
    });

    it('only the system entry has a null query', () => {
        const nullQueryIds = FONTS.filter((f) => f.query === null).map((f) => f.id);
        expect(nullQueryIds).toEqual(['system']);
    });
});
