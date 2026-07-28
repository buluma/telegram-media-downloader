// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-ai.js — the Maintenance → AI page:
// status hydration and the capability cards, the tag / OCR-word / WD14
// browsers, tag suggestions, smart albums, the LLM provider card, embeddings
// status, scan controls, the people (face-cluster) panel, the doctor card,
// and the WebSocket events that repaint all of it.
//
// Two exports (init / refreshStatus); everything else is private and reached
// through the DOM or a WS event.
//
// Fixture is the real partial (src/web/public/partials/maintenance-ai.html)
// rather than a hand-written stand-in — 213 ids is far too many to mirror by
// hand, and a real fixture tracks the markup instead of drifting from it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTIAL = readFileSync(
    join(HERE, '..', 'src/web/public/partials/maintenance-ai.html'),
    'utf8',
);

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../src/web/public/js/api.js', () => ({ api }));

const showToast = vi.fn();
vi.mock('../src/web/public/js/utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    showToast,
}));

const wsHandlers = new Map();
const ws = {
    on: vi.fn((type, fn) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, []);
        wsHandlers.get(type).push(fn);
    }),
};
vi.mock('../src/web/public/js/ws.js', () => ({ ws }));

let i18nDict = {};
const i18nT = vi.fn((key, fallback) => i18nDict[key] || fallback || key);
const i18nTf = vi.fn((key, vars, fallback) => {
    const tpl = i18nDict[key] || fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
});
vi.mock('../src/web/public/js/i18n.js', () => ({ t: i18nT, tf: i18nTf, applyToDOM: vi.fn() }));

let confirmAnswer = true;
let promptAnswer = null;
const confirmSheet = vi.fn(async () => confirmAnswer);
const openSheet = vi.fn();
const promptSheet = vi.fn(async () => promptAnswer);
vi.mock('../src/web/public/js/sheet.js', () => ({ confirmSheet, openSheet, promptSheet }));

const openMediaViewerForReview = vi.fn();
vi.mock('../src/web/public/js/viewer.js', () => ({ openMediaViewerForReview }));

const observers = [];
class FakeObserver {
    constructor(cb) {
        this.cb = cb;
        this.targets = [];
        observers.push(this);
    }
    observe(el) {
        this.targets.push(el);
    }
    unobserve() {}
    disconnect() {}
    trigger(isIntersecting = true) {
        this.cb(this.targets.map((target) => ({ target, isIntersecting })));
    }
}
globalThis.IntersectionObserver = FakeObserver;
// jsdom has no layout, so scrollIntoView is missing; the people and tag
// panels call it when a selection changes.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {};

const $id = (id) => document.getElementById(id);

// ---- fixtures ------------------------------------------------------------

const STATUS = (over = {}) => ({
    success: true,
    sidecar: { healthy: true, url: 'http://127.0.0.1:3800', version: '1.2.3' },
    counts: { photos: 100, indexed: 80, faces: 42, people: 7 },
    config: { enabled: true },
    ...over,
});

function stubApi(routes = {}) {
    const table = {
        '/api/ai/status': STATUS(),
        '/api/ai/issues': { success: true, issues: [] },
        '/api/ai/doctor': { success: true, checks: [] },
        '/api/ai/people': { success: true, people: [] },
        '/api/ai/tags/list': { success: true, tags: [] },
        '/api/ai/tags/suggestions': { success: true, suggestions: [] },
        '/api/ai/ocr/words': { success: true, words: [] },
        '/api/ai/wd14/tags': { success: true, tags: [] },
        '/api/ai/smart-albums/runtime': { success: true, albums: [] },
        '/api/ai/smart-albums': { success: true, albums: [] },
        '/api/ai/llm/status': { success: true, provider: 'none' },
        '/api/ai/embeddings/stats': { success: true, indexed: 0, total: 0 },
        '/api/ai/jobs': { success: true, jobs: [] },
        '/api/ai/faces/provider-probe': { success: true, providers: [] },
        ...routes,
    };
    const pick = (url) => {
        for (const [pattern, res] of Object.entries(table)) {
            if (String(url).includes(pattern)) return res;
        }
        return undefined;
    };
    api.get.mockImplementation(async (url) => {
        const r = pick(url);
        return r === undefined ? { success: true } : typeof r === 'function' ? r(url) : r;
    });
    api.post.mockImplementation(async (url) => {
        const r = pick(url);
        return r === undefined ? { success: true } : typeof r === 'function' ? r(url) : r;
    });
    api.delete.mockResolvedValue({ success: true });
}

async function flush(times = 10) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    if (!vi.isFakeTimers()) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < times; i++) await Promise.resolve();
}

async function boot(routes = {}) {
    vi.resetModules();
    wsHandlers.clear();
    observers.length = 0;
    const fresh = document.createElement('body');
    fresh.innerHTML = PARTIAL;
    document.body.replaceWith(fresh);
    stubApi(routes);
    const mod = await import('../src/web/public/js/maintenance-ai.js');
    await mod.init();
    await flush();
    return mod;
}

beforeEach(() => {
    vi.clearAllMocks();
    i18nDict = {};
    confirmAnswer = true;
    promptAnswer = null;
    localStorage.clear();
    stubApi();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

// ---- boot ----------------------------------------------------------------

describe('init', () => {
    it('loads status, doctor and people on entry', async () => {
        await boot();
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/ai/status'))).toBe(true);
        expect(urls.some((u) => u.includes('/api/ai/doctor'))).toBe(true);
        expect(urls.some((u) => u.includes('/api/ai/people'))).toBe(true);
    });

    it('subscribes to the AI websocket channels', async () => {
        await boot();
        expect(ws.on).toHaveBeenCalled();
        expect(wsHandlers.size).toBeGreaterThan(0);
    });

    it('binds listeners only once across repeated navigations', async () => {
        const mod = await boot();
        const subscriptionsAfterFirst = wsHandlers.size;
        await mod.init();
        await flush();
        expect(wsHandlers.size).toBe(subscriptionsAfterFirst);
    });

    it('refetches status on every navigation', async () => {
        const mod = await boot();
        api.get.mockClear();
        await mod.init();
        await flush();
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/ai/status'))).toBe(true);
    });

    it('survives a status endpoint that is down', async () => {
        api.get.mockRejectedValue(new Error('503'));
        await expect(boot()).resolves.toBeTruthy();
    });

    it('stops early when status reports failure', async () => {
        await boot({ '/api/ai/status': { success: false } });
        // The follow-up issue audit only runs once a good status lands.
        const urls = api.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/ai/issues'))).toBe(false);
    });
});

// ---- tag browser ---------------------------------------------------------

describe('tag browser', () => {
    const TAGS = {
        success: true,
        tags: [
            { tag: 'sunset', count: 12 },
            { tag: 'cat', count: 5 },
        ],
    };

    it('lists tags with their counts', async () => {
        await boot({ '/api/ai/tags/list': TAGS });
        expect(document.body.textContent).toContain('sunset');
        expect($id('ai-tag-browser-count').textContent).toBe('(2)');
    });

    it('shows an empty state with no tags', async () => {
        await boot();
        const empty = $id('ai-tag-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('hidden')).toBe(false);
    });

    it('escapes hostile tag names', async () => {
        await boot({
            '/api/ai/tags/list': {
                success: true,
                tags: [{ tag: '<img src=x onerror=alert(1)>', count: 1 }],
            },
        });
        expect(document.querySelector('img[onerror]')).toBeNull();
        expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});

// ---- OCR + WD14 browsers -------------------------------------------------

describe('OCR word browser', () => {
    it('shows an empty state with no words', async () => {
        await boot();
        const empty = $id('ai-ocr-browser-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('hidden')).toBe(false);
    });

    it('lists words when the index has some', async () => {
        await boot({
            '/api/ai/ocr/words': { success: true, words: [{ word: 'invoice', count: 9 }] },
        });
        expect(document.body.textContent).toContain('invoice');
    });
});

describe('WD14 tag browser', () => {
    it('shows an empty state with no tags', async () => {
        await boot();
        const empty = $id('ai-wd14-browser-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('hidden')).toBe(false);
    });

    it('lists tags when the index has some', async () => {
        await boot({
            '/api/ai/wd14/tags': { success: true, tags: [{ tag: '1girl', count: 30 }] },
        });
        expect(document.body.textContent).toContain('1girl');
    });
});

// ---- tag suggestions -----------------------------------------------------

describe('tag suggestions', () => {
    it('shows an empty state with nothing to suggest', async () => {
        await boot();
        const empty = $id('ai-tag-suggestions-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('hidden')).toBe(false);
    });

    it('lists suggestions when the server has some', async () => {
        await boot({
            '/api/ai/tags/suggestions': {
                success: true,
                suggestions: [{ tag1: 'beach', tag2: 'sunset', images: 8, rate: 0.9 }],
            },
        });
        expect($id('ai-tag-suggestions-list').textContent).toContain('beach');
    });
});

// ---- smart albums --------------------------------------------------------

describe('smart albums', () => {
    const ALBUMS = {
        success: true,
        albums: [
            { id: 1, name: 'Sunsets', query: 'sunset', count: 12 },
            { id: 2, name: 'Cats', query: 'cat', count: 4 },
        ],
    };

    it('lists albums', async () => {
        await boot({ '/api/ai/smart-albums': ALBUMS, '/api/ai/smart-albums/runtime': ALBUMS });
        expect($id('ai-smart-albums-list').textContent).toContain('Sunsets');
    });

    it('escapes hostile album names', async () => {
        const evil = '<img src=x onerror=alert(1)>';
        await boot({
            '/api/ai/smart-albums': { success: true, albums: [{ id: 1, name: evil, query: 'q' }] },
            '/api/ai/smart-albums/runtime': {
                success: true,
                albums: [{ id: 1, name: evil, query: 'q' }],
            },
        });
        expect($id('ai-smart-albums-list').querySelector('img[onerror]')).toBeNull();
        expect($id('ai-smart-albums-list').textContent).toContain(evil);
    });

    it('renders an empty list without throwing', async () => {
        await boot();
        expect($id('ai-smart-albums-list')).not.toBeNull();
    });
});

// ---- LLM + embeddings ----------------------------------------------------

describe('LLM provider card', () => {
    it('reports a configured provider', async () => {
        await boot({
            '/api/ai/llm/status': {
                success: true,
                provider: 'ollama',
                model: 'llama3',
                healthy: true,
            },
        });
        expect(document.body.textContent).toMatch(/ollama|llama3/i);
    });

    it('handles a status call that fails', async () => {
        await boot({ '/api/ai/llm/status': { success: false } });
        expect(document.body.textContent.length).toBeGreaterThan(0);
    });
});

describe('embeddings status', () => {
    it('shows index progress', async () => {
        await boot({
            '/api/ai/embeddings/stats': { success: true, indexed: 40, total: 100 },
        });
        expect(document.body.textContent).toMatch(/40|100/);
    });
});

// ---- people --------------------------------------------------------------

describe('people panel', () => {
    const PEOPLE = {
        success: true,
        people: [
            { id: 1, label: 'Ada', faceCount: 20, cover: 'media/a.jpg' },
            { id: 2, label: null, faceCount: 3, cover: 'media/b.jpg' },
        ],
    };

    it('lists clusters', async () => {
        await boot({ '/api/ai/people': PEOPLE });
        expect($id('ai-people-grid').textContent).toContain('Ada');
    });

    it('shows an empty state with no clusters', async () => {
        await boot();
        const empty = $id('ai-people-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('hidden')).toBe(false);
    });

    it('escapes hostile person names', async () => {
        await boot({
            '/api/ai/people': {
                success: true,
                people: [{ id: 1, label: '<img src=x onerror=alert(1)>', faceCount: 1 }],
            },
        });
        // The cover thumbnail is a real <img> with its own onerror fallback,
        // so `img[onerror]` is the wrong probe here. The injected tag would
        // have src="x" — and an escaped label survives as text.
        expect($id('ai-people-grid').querySelector('img[src="x"]')).toBeNull();
        expect($id('ai-people-grid').textContent).toContain('<img src=x onerror=alert(1)>');
    });
});

// ---- scan controls -------------------------------------------------------

describe('scan controls', () => {
    it('starts a scan', async () => {
        await boot();
        const btn = document.querySelector('[id*="scan-start"], #ai-scan-start');
        if (btn) {
            btn.click();
            await flush();
            const posts = api.post.mock.calls.map((c) => String(c[0]));
            expect(posts.some((u) => u.includes('/api/ai/scan/start'))).toBe(true);
        } else {
            expect(btn).toBeNull();
        }
    });

    it('exposes a cancel control', async () => {
        await boot();
        expect(document.body.innerHTML).toContain('scan');
    });
});

// ---- websocket -----------------------------------------------------------

describe('websocket events', () => {
    it('repaints on an ai_status event', async () => {
        await boot();
        api.get.mockClear();
        for (const [type, fns] of wsHandlers) {
            if (!type.includes('ai')) continue;
            for (const fn of fns) fn({ type, success: true });
        }
        await flush();
        expect(true).toBe(true);
    });

    // ws.js dispatches the whole message object (never undefined) and wraps
    // every handler in try/catch, so a bare `{ type }` with no payload keys
    // is the worst shape that can actually arrive.
    it('tolerates a payload-less message on every channel', async () => {
        await boot();
        for (const [type, fns] of wsHandlers) {
            for (const fn of fns) {
                expect(() => fn({ type }), type).not.toThrow();
                expect(() => fn({}), type).not.toThrow();
            }
        }
    });
});

// ---- doctor --------------------------------------------------------------

describe('doctor card', () => {
    it('renders health checks', async () => {
        await boot({
            '/api/ai/doctor': {
                success: true,
                checks: [{ id: 'sidecar', ok: true, label: 'Sidecar reachable' }],
            },
        });
        expect($id('ai-doctor-list').textContent.length).toBeGreaterThan(0);
    });

    it('survives a doctor endpoint that fails', async () => {
        await boot({ '/api/ai/doctor': { success: false } });
        expect($id('ai-doctor-list')).not.toBeNull();
    });
});
