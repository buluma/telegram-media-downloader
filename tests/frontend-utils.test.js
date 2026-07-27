// Covers src/web/public/js/utils.js — the SPA's shared formatting,
// avatar-rendering, toast and LRU helpers. Every page imports this module,
// so a break here is visible on every surface at once.
//
// Everything except `showToast` is pure and imports cleanly into Node.
// For `showToast` we install a hand-rolled DOM stub rather than pulling in
// jsdom, matching the zero-browser-dep approach the rest of the suite uses
// (see tests/viewer-classifier.test.js, tests/shortcut-overrides.test.js).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatBytes,
    formatDate,
    formatRelativeTime,
    escapeHtml,
    getFileIcon,
    getGroupType,
    getAvatarClass,
    createAvatar,
    showToast,
    lruSet,
    lruCap,
} from '../src/web/public/js/utils.js';

describe('formatBytes', () => {
    it('renders the zero case with a unit', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    it('picks the largest unit that keeps the number >= 1', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(1024 * 1024)).toBe('1 MB');
        expect(formatBytes(1024 ** 3)).toBe('1 GB');
        expect(formatBytes(1024 ** 4)).toBe('1 TB');
    });

    it('keeps at most two decimals and trims trailing zeros', () => {
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(1234567)).toBe('1.18 MB');
    });
});

describe('formatDate', () => {
    it('returns an empty string for missing input rather than "Invalid Date"', () => {
        expect(formatDate(null)).toBe('');
        expect(formatDate(undefined)).toBe('');
        expect(formatDate('')).toBe('');
    });

    it('renders a parseable date via the host locale', () => {
        const out = formatDate('2026-01-02T03:04:05Z');
        expect(out).not.toBe('');
        expect(out).not.toBe('Invalid Date');
    });
});

describe('formatRelativeTime', () => {
    const NOW = Date.parse('2026-07-27T12:00:00Z');

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const ago = (sec) => NOW - sec * 1000;

    it('returns an empty string for missing or unparseable input', () => {
        expect(formatRelativeTime(null)).toBe('');
        expect(formatRelativeTime(undefined)).toBe('');
        expect(formatRelativeTime('')).toBe('');
        expect(formatRelativeTime('not a date')).toBe('');
    });

    it('collapses anything under 45s to "now"', () => {
        expect(formatRelativeTime(ago(0))).toBe('now');
        expect(formatRelativeTime(ago(44))).toBe('now');
    });

    it('uses minutes up to an hour', () => {
        expect(formatRelativeTime(ago(45))).toBe('1m');
        expect(formatRelativeTime(ago(300))).toBe('5m');
        expect(formatRelativeTime(ago(3599))).toBe('60m');
    });

    it('uses hours up to a day', () => {
        expect(formatRelativeTime(ago(3600))).toBe('1h');
        expect(formatRelativeTime(ago(7200))).toBe('2h');
    });

    it('says "yesterday" in the 24-48h window', () => {
        expect(formatRelativeTime(ago(24 * 3600))).toBe('yesterday');
        expect(formatRelativeTime(ago(47 * 3600))).toBe('yesterday');
    });

    it('uses days in the 2-7 day window', () => {
        expect(formatRelativeTime(ago(48 * 3600))).toBe('2d');
        expect(formatRelativeTime(ago(6 * 24 * 3600))).toBe('6d');
    });

    it('falls back to dd.mm past a week', () => {
        expect(formatRelativeTime(Date.parse('2026-07-01T12:00:00Z'))).toBe('01.07');
    });

    it('accepts both epoch millis and date strings', () => {
        expect(formatRelativeTime('2026-07-27T11:00:00Z')).toBe('1h');
        expect(formatRelativeTime(ago(3600))).toBe('1h');
    });

    it('reports future timestamps as "now" rather than a negative age', () => {
        // Note: the `Math.max(0, …)` clamp in the implementation is
        // belt-and-braces — a negative age already falls into the <45s
        // branch — so this pins the observable contract, not the clamp.
        expect(formatRelativeTime(NOW + 60_000)).toBe('now');
        expect(formatRelativeTime(NOW + 10 * 86400_000)).toBe('now');
    });
});

describe('escapeHtml', () => {
    it('escapes every character that can break out of an attribute or text node', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
            '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;',
        );
    });

    it('escapes the ampersand first so entities are not double-broken', () => {
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });

    it('returns an empty string for null and undefined', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('coerces non-string input instead of throwing on .replace', () => {
        // Regression guard: a WS payload whose `msg` was an object used to
        // crash the page with "text.replace is not a function".
        expect(() => escapeHtml({ a: 1 })).not.toThrow();
        expect(escapeHtml(42)).toBe('42');
        expect(escapeHtml(false)).toBe('false');
    });
});

describe('getFileIcon', () => {
    it('maps known extensions by family', () => {
        expect(getFileIcon('mp4')).toBe('ri-video-line');
        expect(getFileIcon('flac')).toBe('ri-music-line');
        expect(getFileIcon('png')).toBe('ri-image-line');
        expect(getFileIcon('pdf')).toBe('ri-file-pdf-line');
        expect(getFileIcon('7z')).toBe('ri-file-zip-line');
    });

    it('is case-insensitive and tolerates a leading dot', () => {
        expect(getFileIcon('.JPG')).toBe('ri-image-line');
        expect(getFileIcon('MP3')).toBe('ri-music-line');
    });

    it('falls back to the generic file icon', () => {
        expect(getFileIcon('xyz')).toBe('ri-file-line');
        expect(getFileIcon('')).toBe('ri-file-line');
        expect(getFileIcon(null)).toBe('ri-file-line');
        expect(getFileIcon(undefined)).toBe('ri-file-line');
    });
});

describe('getGroupType', () => {
    it('classifies by Telegram id prefix', () => {
        expect(getGroupType('-1001234567890')).toBe('Channel');
        expect(getGroupType('-987654321')).toBe('Group');
        expect(getGroupType('123456789')).toBe('Private Chat');
    });

    it('accepts numeric ids as well as strings', () => {
        expect(getGroupType(-1001234567890)).toBe('Channel');
        expect(getGroupType(123456789)).toBe('Private Chat');
    });
});

describe('getAvatarClass', () => {
    it('is deterministic for a given id', () => {
        expect(getAvatarClass('-1001234567890')).toBe(getAvatarClass('-1001234567890'));
    });

    it('always returns one of the palette gradients', () => {
        for (const id of ['-100123', '456', 'story:abc', '', null, undefined]) {
            expect(getAvatarClass(id)).toMatch(/^bg-gradient-to-br from-\S+ to-\S+$/);
        }
    });

    it('spreads non-numeric ids across the palette instead of collapsing them', () => {
        // parseInt on an alpha tail yields NaN; the char-code fallback exists
        // so story:/username: rows do not all render the same colour.
        const ids = ['story:alpha', 'story:bravo', 'story:charlie', 'story:delta', 'user:echo'];
        const classes = new Set(ids.map(getAvatarClass));
        expect(classes.size).toBeGreaterThan(1);
    });
});

describe('createAvatar', () => {
    it('accepts both the positional and the options call signature', () => {
        const positional = createAvatar('-100123', 'News', 'channel');
        const options = createAvatar({ id: '-100123', name: 'News', type: 'channel' });
        expect(positional).toBe(options);
    });

    it('renders the uppercased first initial', () => {
        expect(createAvatar({ id: '1', name: 'heimdal' })).toContain('>H<');
        expect(createAvatar({ id: '1', name: '' })).toContain('>?<');
        expect(createAvatar({ id: '1' })).toContain('>?<');
    });

    it('picks the type icon from the explicit type', () => {
        expect(createAvatar({ id: '1', type: 'channel' })).toContain('ri-megaphone-fill');
        expect(createAvatar({ id: '1', type: 'group' })).toContain('ri-group-fill');
        expect(createAvatar({ id: '1', type: 'bot' })).toContain('ri-robot-2-fill');
        expect(createAvatar({ id: '1', type: 'user' })).toContain('ri-user-fill');
    });

    it('infers the type icon from the id prefix when type is absent', () => {
        expect(createAvatar({ id: '-1001234' })).toContain('ri-megaphone-fill');
        expect(createAvatar({ id: '-1234' })).toContain('ri-group-fill');
        expect(createAvatar({ id: '1234' })).toContain('ri-user-fill');
    });

    it('strips synthetic id prefixes before inferring the type', () => {
        expect(createAvatar({ id: 'comment:-1001234' })).toContain('ri-megaphone-fill');
        expect(createAvatar({ id: 'unknown:-1234' })).toContain('ri-group-fill');
    });

    it('skips the photo request entirely when the server said there is none', () => {
        const withPhoto = createAvatar({ id: '1', name: 'A' });
        const noPhoto = createAvatar({ id: '1', name: 'A', noPhotoKnown: true });
        expect(withPhoto).toContain('/api/groups/1/photo');
        expect(noPhoto).not.toContain('/api/groups/1/photo');
        expect(noPhoto).not.toContain('<img');
    });

    it('escapes the name in the img alt attribute', () => {
        const html = createAvatar({ id: '1', name: '"><script>alert(1)</script>' });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });

    it('renders the status dot with its aria-label and drops the type badge', () => {
        const html = createAvatar({ id: '1', name: 'A', dot: 'monitor' });
        expect(html).toContain('aria-label="monitoring"');
        expect(html).toContain('#4FAE4E');
        expect(html).not.toContain('ri-user-fill');
    });

    it('ignores an unknown dot value and keeps the type badge', () => {
        const html = createAvatar({ id: '1', name: 'A', dot: 'bogus' });
        expect(html).not.toContain('aria-label=');
        expect(html).toContain('ri-user-fill');
    });

    it('maps the size keyword to pixels and falls back to lg', () => {
        expect(createAvatar({ id: '1', size: 'sm' })).toContain('width:32px;height:32px');
        expect(createAvatar({ id: '1', size: 'xl' })).toContain('width:64px;height:64px');
        expect(createAvatar({ id: '1' })).toContain('width:48px;height:48px');
        expect(createAvatar({ id: '1', size: 'nonsense' })).toContain('width:48px;height:48px');
    });

    it('adds the animated ring class only for the ring states', () => {
        expect(createAvatar({ id: '1', ring: 'downloading' })).toContain('avatar-ring-active');
        const active = createAvatar({ id: '1', ring: 'active' });
        expect(active).toContain('avatar-ring');
        expect(active).not.toContain('avatar-ring-active');
        expect(createAvatar({ id: '1' })).not.toContain('avatar-ring');
    });

    it('percent-encodes the id in the photo URL', () => {
        expect(createAvatar({ id: 'comment:-100/1', name: 'A' })).toContain(
            '/api/groups/comment%3A-100%2F1/photo',
        );
    });
});

// ---- showToast -----------------------------------------------------------
//
// Minimal DOM stub: only the surface showToast actually touches.

class FakeEl {
    constructor(tag) {
        this.tagName = tag;
        this.id = '';
        this.className = '';
        this.textContent = '';
        this.style = {};
        this.attrs = {};
        this.children = [];
        this.parent = null;
    }
    get firstChild() {
        return this.children[0] ?? null;
    }
    appendChild(el) {
        el.parent = this;
        this.children.push(el);
        return el;
    }
    setAttribute(k, v) {
        this.attrs[k] = v;
    }
    remove() {
        const p = this.parent;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parent = null;
    }
}

function installDom() {
    const body = new FakeEl('body');
    globalThis.document = {
        body,
        createElement: (tag) => new FakeEl(tag),
        getElementById: (id) => {
            const walk = (el) => {
                if (el.id === id) return el;
                for (const c of el.children) {
                    const hit = walk(c);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(body);
        },
    };
    return body;
}

describe('showToast', () => {
    let body;

    beforeEach(() => {
        vi.useFakeTimers();
        body = installDom();
    });
    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.document;
    });

    const stack = () => document.getElementById('toast-stack');

    it('lazily creates a single shared toast stack', () => {
        showToast('one');
        showToast('two');
        expect(body.children.filter((c) => c.id === 'toast-stack')).toHaveLength(1);
        expect(stack().children).toHaveLength(2);
    });

    it('sets the message as textContent, never as HTML', () => {
        showToast('<b>hi</b>');
        expect(stack().children[0].textContent).toBe('<b>hi</b>');
    });

    it('uses role=alert for errors and role=status otherwise', () => {
        showToast('boom', 'error');
        showToast('fine', 'success');
        expect(stack().children[0].attrs.role).toBe('alert');
        expect(stack().children[1].attrs.role).toBe('status');
    });

    it('colours by type and falls back to info for an unknown type', () => {
        showToast('a', 'error');
        showToast('b', 'bogus');
        expect(stack().children[0].className).toContain('bg-tg-red');
        expect(stack().children[1].className).toContain('bg-tg-blue');
    });

    it('caps the stack at 6 visible toasts, dropping the oldest', () => {
        for (let i = 0; i < 10; i++) showToast(`t${i}`);
        expect(stack().children).toHaveLength(6);
        expect(stack().children[0].textContent).toBe('t4');
        expect(stack().children[5].textContent).toBe('t9');
    });

    it('fades out then removes itself after the duration', () => {
        showToast('bye', 'info', 1000);
        const toast = stack().children[0];
        expect(stack().children).toHaveLength(1);

        vi.advanceTimersByTime(1000);
        expect(toast.style.opacity).toBe('0');
        expect(stack().children).toHaveLength(1); // still fading

        vi.advanceTimersByTime(300);
        expect(stack().children).toHaveLength(0);
    });

    it('defaults to a 3s duration', () => {
        showToast('default');
        vi.advanceTimersByTime(2999 + 300);
        expect(stack().children).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(stack().children).toHaveLength(0);
    });
});

describe('lruSet', () => {
    it('inserts and evicts the oldest entry past the cap', () => {
        const m = new Map();
        for (const k of ['a', 'b', 'c']) lruSet(m, k, k.toUpperCase(), 2);
        expect([...m.keys()]).toEqual(['b', 'c']);
    });

    it('bumps a re-set key to the back of the queue (true LRU)', () => {
        const m = new Map([
            ['a', 1],
            ['b', 2],
        ]);
        lruSet(m, 'a', 99, 2);
        expect([...m.keys()]).toEqual(['b', 'a']);
        expect(m.get('a')).toBe(99);

        lruSet(m, 'c', 3, 2);
        expect([...m.keys()]).toEqual(['a', 'c']); // 'b' was least-recent
    });

    it('is a no-op for a non-Map argument', () => {
        expect(() => lruSet(null, 'a', 1, 5)).not.toThrow();
        expect(() => lruSet({}, 'a', 1, 5)).not.toThrow();
    });

    it('handles an undefined value without breaking eviction', () => {
        const m = new Map();
        lruSet(m, 'a', undefined, 1);
        lruSet(m, 'b', undefined, 1);
        expect([...m.keys()]).toEqual(['b']);
    });
});

describe('lruCap', () => {
    it('trims to the cap and reports how many it evicted', () => {
        const m = new Map([
            ['a', 1],
            ['b', 2],
            ['c', 3],
            ['d', 4],
        ]);
        expect(lruCap(m, 2)).toBe(2);
        expect([...m.keys()]).toEqual(['c', 'd']);
    });

    it('is a no-op when already at or under the cap', () => {
        const m = new Map([['a', 1]]);
        expect(lruCap(m, 1)).toBe(0);
        expect(lruCap(m, 5)).toBe(0);
        expect(m.size).toBe(1);
    });

    it('empties the map for a cap of zero', () => {
        const m = new Map([
            ['a', 1],
            ['b', 2],
        ]);
        expect(lruCap(m, 0)).toBe(2);
        expect(m.size).toBe(0);
    });

    it('is a no-op for a non-Map argument', () => {
        expect(lruCap(null, 2)).toBe(0);
        expect(lruCap([1, 2, 3], 2)).toBe(0);
    });
});
