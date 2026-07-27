// @vitest-environment jsdom
//
// Covers src/web/public/js/maintenance-db-stats.js — the DB stats
// dashboard: summary cards, table-size list, group chart+table, file-type
// donut, the 14-day trend chart (flat and per-group stacked variants), AI
// coverage, and the 15s auto-refresh lifecycle.
//
// Only showDbStatsPage/stopDbStatsPage are exported; everything else
// (formatBytes, ago, the chart builders) is exercised indirectly through
// the rendered #db-stats-root markup. api.js is mocked.

import { describe, it, expect, afterEach, vi } from 'vitest';

const api = { get: vi.fn() };
vi.mock('../src/web/public/js/api.js', () => ({ api }));

const $ = (id) => document.getElementById(id);

function baseStats(over = {}) {
    return {
        success: true,
        tableCounts: { downloads: 100, queue: 0 },
        groups: [],
        totals: {
            total: 100,
            bytes: 0,
            photos: 0,
            videos: 0,
            audio: 0,
            documents: 0,
            voice: 0,
            stickers: 0,
        },
        dailyTrend: [],
        trendByGroup: null,
        dbFileSizeBytes: 0,
        ai: { faces: 0, people: 0, tags: 0, indexed: 0, total: 0, pct: 0 },
        ...over,
    };
}

async function loadModule({ stats = baseStats(), hidden = false } = {}) {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `
        <div id="page-maintenance-db-stats" class="${hidden ? 'hidden' : ''}">
            <div id="db-stats-root"></div>
        </div>
    `;
    api.get.mockResolvedValue(stats);
    return import('../src/web/public/js/maintenance-db-stats.js');
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('showDbStatsPage / page visibility guard', () => {
    afterEach(() => vi.useRealTimers());

    it('fetches and renders when the page is visible', async () => {
        const { showDbStatsPage } = await loadModule();
        showDbStatsPage();
        await flush();
        expect(api.get).toHaveBeenCalledWith('/api/db/stats');
        expect($('db-stats-root').innerHTML).not.toBe('');
    });

    it('does not fetch when the page container is hidden', async () => {
        const { showDbStatsPage } = await loadModule({ hidden: true });
        showDbStatsPage();
        await flush();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('does not fetch when the page container is absent entirely', async () => {
        const { showDbStatsPage } = await loadModule();
        document.getElementById('page-maintenance-db-stats').remove();
        showDbStatsPage();
        await flush();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('shows an error message instead of throwing on a failed fetch', async () => {
        const { showDbStatsPage } = await loadModule();
        api.get.mockRejectedValue(new Error('network down'));
        expect(() => showDbStatsPage()).not.toThrow();
        await flush();
        expect($('db-stats-root').textContent).toContain('Failed to load');
        expect($('db-stats-root').textContent).toContain('network down');
    });

    it('treats a success:false response as a failure', async () => {
        const { showDbStatsPage } = await loadModule({ stats: { success: false } });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).toContain('Failed to load');
    });
});

describe('auto-refresh lifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('polls every 15 seconds', async () => {
        vi.useFakeTimers();
        const { showDbStatsPage } = await loadModule();
        showDbStatsPage();
        await vi.advanceTimersByTimeAsync(15000);
        await vi.advanceTimersByTimeAsync(15000);
        expect(api.get).toHaveBeenCalledTimes(3); // boot + 2 ticks
    });

    it('stopDbStatsPage cancels the interval', async () => {
        vi.useFakeTimers();
        const { showDbStatsPage, stopDbStatsPage } = await loadModule();
        showDbStatsPage();
        await vi.advanceTimersByTimeAsync(0);
        api.get.mockClear();
        stopDbStatsPage();
        await vi.advanceTimersByTimeAsync(30000);
        expect(api.get).not.toHaveBeenCalled();
    });

    it('calling showDbStatsPage again replaces the previous interval instead of stacking', async () => {
        vi.useFakeTimers();
        const { showDbStatsPage } = await loadModule();
        showDbStatsPage();
        showDbStatsPage();
        await vi.advanceTimersByTimeAsync(0);
        api.get.mockClear();
        await vi.advanceTimersByTimeAsync(15000);
        // If the first interval leaked, this would be 2.
        expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('stopDbStatsPage without a running page is a no-op', async () => {
        const { stopDbStatsPage } = await loadModule();
        expect(() => stopDbStatsPage()).not.toThrow();
    });

    it('the refresh button reloads on click', async () => {
        const { showDbStatsPage } = await loadModule();
        showDbStatsPage();
        await flush();
        api.get.mockClear();
        $('db-stats-root').querySelector('#db-stats-refresh-btn').click();
        await flush();
        expect(api.get).toHaveBeenCalledTimes(1);
    });
});

describe('summary cards', () => {
    it('renders totals, AI counts, and formatted sizes', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                totals: { total: 1234, bytes: 5 * 1024 * 1024, videos: 12 },
                dbFileSizeBytes: 2048,
                ai: { faces: 7, people: 3, tags: 40, indexed: 5, total: 10, pct: 50 },
            }),
        });
        showDbStatsPage();
        await flush();
        const text = $('db-stats-root').textContent;
        expect(text).toContain('1,234');
        expect(text).toContain('7'); // faces
        expect(text).toContain('50%'); // ai.pct
        expect(text).toContain('5.0 MB'); // formatBytes: <10 units keeps one decimal
        expect(text).toContain('2.0 KB');
    });

    it('shows the queue backlog callout only when the queue is non-empty', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({ tableCounts: { queue: 3 } }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).toContain('3 items pending');
    });

    it('uses singular phrasing for exactly one queued item', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({ tableCounts: { queue: 1 } }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).toContain('1 item pending');
    });

    it('omits the callout when the queue is empty', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({ tableCounts: { queue: 0 } }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).not.toContain('pending in download queue');
    });
});

describe('table sizes', () => {
    it('renders one row per table with formatted counts', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({ tableCounts: { downloads: 12345, groups: 7 } }),
        });
        showDbStatsPage();
        await flush();
        const root = $('db-stats-root');
        expect(root.textContent).toContain('downloads');
        expect(root.textContent).toContain('12,345');
        expect(root.textContent).toContain('groups');
    });
});

describe('groups chart + table', () => {
    it('lists every group and escapes hostile names', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                groups: [
                    {
                        group_id: '-100123',
                        group_name: '<img src=x onerror=alert(1)>',
                        n: 10,
                        photos: 5,
                        videos: 5,
                        bytes: 1024,
                        last_activity: null,
                    },
                ],
            }),
        });
        showDbStatsPage();
        await flush();
        const root = $('db-stats-root');
        expect(root.querySelector('img')).toBeNull();
        expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(root.textContent).toContain('-100123');
    });

    it('falls back to the raw group id when there is no name', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                groups: [{ group_id: '-100999', n: 1, photos: 0, videos: 1, bytes: 0 }],
            }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).toContain('-100999');
    });

    it('caps the bar chart at the top 15 groups by file count', async () => {
        const groups = Array.from({ length: 20 }, (_, i) => ({
            group_id: `g${i}`,
            group_name: `Group ${i}`,
            n: i, // group 19 has the most files, group 0 the fewest
            photos: 0,
            videos: 0,
            bytes: 0,
        }));
        const { showDbStatsPage } = await loadModule({ stats: baseStats({ groups }) });
        showDbStatsPage();
        await flush();
        // The bar chart renders each label as a truncated <span>; count how
        // many distinct group names show up in the "Files per group" card.
        // All 20 still appear in the full table below, so count via the
        // chart's bar rows specifically (bg-tg-bg progress-track divs).
        const barRows = $('db-stats-root').querySelectorAll('.bg-tg-bg.rounded-full');
        expect(barRows.length).toBe(15);
    });

    it('omits the groups section entirely with no groups', async () => {
        const { showDbStatsPage } = await loadModule({ stats: baseStats({ groups: [] }) });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).not.toContain('Files per group');
    });

    it('shows a relative "ago" time and the raw timestamp as a tooltip', async () => {
        const tenMinAgo = new Date(Date.now() - 10 * 60000)
            .toISOString()
            .replace('T', ' ')
            .slice(0, 19);
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                groups: [
                    {
                        group_id: 'g1',
                        group_name: 'A',
                        n: 1,
                        photos: 1,
                        videos: 0,
                        bytes: 0,
                        last_activity: tenMinAgo,
                    },
                ],
            }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).toContain('10m ago');
    });

    it('shows an em dash when a group has never been active', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                groups: [
                    {
                        group_id: 'g1',
                        group_name: 'A',
                        n: 1,
                        photos: 1,
                        videos: 0,
                        bytes: 0,
                        last_activity: null,
                    },
                ],
            }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).toContain('—');
    });
});

describe('file type distribution', () => {
    it('renders every category with its percentage of the total', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                totals: {
                    total: 100,
                    photos: 50,
                    videos: 25,
                    audio: 10,
                    documents: 10,
                    voice: 5,
                    stickers: 0,
                    bytes: 0,
                },
            }),
        });
        showDbStatsPage();
        await flush();
        const text = $('db-stats-root').textContent;
        expect(text).toContain('Photos');
        expect(text).toContain('50%');
        expect(text).toContain('Videos');
        expect(text).toContain('25%');
    });

    it('does not divide by zero when totals.total is 0', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                totals: {
                    total: 0,
                    photos: 0,
                    videos: 0,
                    audio: 0,
                    documents: 0,
                    voice: 0,
                    stickers: 0,
                    bytes: 0,
                },
            }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).not.toContain('NaN');
        expect($('db-stats-root').textContent).not.toContain('Infinity');
    });
});

describe('14-day trend chart', () => {
    it('renders the flat single-series chart when there is no per-group breakdown', async () => {
        const dailyTrend = [
            { day: '2026-07-20', n: 5 },
            { day: '2026-07-21', n: 3 },
        ];
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({ dailyTrend, trendByGroup: null }),
        });
        showDbStatsPage();
        await flush();
        const root = $('db-stats-root');
        expect(root.textContent).toContain('14-day download trend');
        expect(root.textContent).toContain('8 total'); // 5 + 3
        expect(root.querySelectorAll('rect.vbar').length).toBe(2);
    });

    it('renders the stacked per-group chart when the breakdown is present', async () => {
        const dailyTrend = [{ day: '2026-07-20', n: 8 }];
        const trendByGroup = {
            groups: [{ name: 'A' }, { name: 'B' }],
            days: [{ day: '2026-07-20', values: [5, 3] }],
        };
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({ dailyTrend, trendByGroup }),
        });
        showDbStatsPage();
        await flush();
        const root = $('db-stats-root');
        expect(root.textContent).toContain('8 total');
        // Both '8 total' and the bare letters 'A'/'B' show up regardless of
        // which chart variant renders (they appear elsewhere on the page,
        // e.g. inside "AI coverage" / "Table"), so they don't actually prove
        // the stacked branch ran. stackedBarChart's <rect> has no `vbar`
        // class — only the flat vbarChart's does — and it draws one rect
        // per non-zero series-segment (2 here), where the flat chart would
        // draw exactly one rect for the day's single combined total.
        const rects = root.querySelectorAll('svg rect');
        expect(rects.length).toBe(2);
        expect(root.querySelectorAll('svg rect.vbar').length).toBe(0);
    });

    it('omits the trend section with no daily data', async () => {
        const { showDbStatsPage } = await loadModule({ stats: baseStats({ dailyTrend: [] }) });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).not.toContain('14-day download trend');
    });
});

describe('AI coverage', () => {
    it('computes photo-relative percentages, not all-file percentages', async () => {
        // photos=50 also happens to be exactly 50% of total=100 — the file
        // type donut renders that same "50%" from an unrelated computation,
        // so a plain `text.toContain('50%')` passes whether or not this
        // code uses the right denominator. Read the CLIP tags table row
        // specifically instead of the whole panel's text.
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                totals: {
                    total: 100,
                    photos: 40,
                    videos: 0,
                    audio: 0,
                    documents: 0,
                    voice: 0,
                    stickers: 0,
                    bytes: 0,
                },
                ai: {
                    faces: 1,
                    people: 1,
                    tags: 20,
                    indexed: 40,
                    total: 100,
                    pct: 40,
                    ocrFiles: 10,
                },
            }),
        });
        showDbStatsPage();
        await flush();
        const row = [...$('db-stats-root').querySelectorAll('tr')].find((tr) =>
            tr.textContent.includes('CLIP tags'),
        );
        // tags=20 of photoBase=40 -> 50%, not 20% (of all 100 files).
        expect(row.textContent).toContain('50%');
        expect(row.textContent).not.toContain('20%');
    });

    it('avoids a divide-by-zero when there are no photos yet', async () => {
        const { showDbStatsPage } = await loadModule({
            stats: baseStats({
                totals: {
                    total: 0,
                    photos: 0,
                    videos: 0,
                    audio: 0,
                    documents: 0,
                    voice: 0,
                    stickers: 0,
                    bytes: 0,
                },
                ai: { faces: 0, people: 0, tags: 0, indexed: 0, total: 0, pct: 0 },
            }),
        });
        showDbStatsPage();
        await flush();
        expect($('db-stats-root').textContent).not.toContain('Infinity');
        expect($('db-stats-root').textContent).not.toContain('NaN');
    });
});
