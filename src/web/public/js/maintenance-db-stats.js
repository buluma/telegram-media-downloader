/**
 * Maintenance — Database stats (admin page).
 *
 * Fetches /api/db/stats and renders a dashboard of table sizes, group
 * breakdown, file type distribution, recent activity, and AI indexing.
 * Includes SVG bar charts and a donut chart. Auto-refreshes every 15 seconds.
 */

import { api } from './api.js';
import { escapeHtml } from './utils.js';

const $ = (id) => document.getElementById(id);
let _interval = null;

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmt(n) {
    return Number(n || 0).toLocaleString();
}

// ── SVG helpers ──────────────────────────────────────────────────────────────

/** Horizontal bar chart — each bar is a labelled row. */
function hbarChart(
    bars,
    {
        maxLabel = '',
        barColor = 'var(--tg-theme-accent, #2ea6ff)',
        height = 20,
        showValues = true,
    } = {},
) {
    const max = bars.reduce((m, b) => Math.max(m, b.value), 0) || 1;
    const pct = (v) => ((v / max) * 100).toFixed(1);
    let html = '<div class="space-y-1">';
    for (const b of bars) {
        if (b.value === 0) continue;
        const w = pct(b.value);
        const label = escapeHtml((b.label || '').slice(0, 22));
        html += `<div class="flex items-center gap-1.5 text-xs">
            <span class="text-tg-textSecondary truncate flex-shrink-0 max-w-[100px] sm:max-w-none" style="${maxLabel ? 'width:' + maxLabel : 'width:100px'}">${label}</span>
            <div class="flex-1 bg-tg-bg rounded-full overflow-hidden min-w-0" style="height:${height}px">
                <div class="h-full rounded-full transition-all duration-500" style="width:${w}%;background:${barColor}"></div>
            </div>
            ${showValues ? `<span class="text-tg-text tabular-nums flex-shrink-0 w-10 sm:w-[60px] text-right">${fmt(b.value)}</span>` : ''}
        </div>`;
    }
    html += '</div>';
    return html;
}

/**
 * Simple SVG donut chart.
 * segments: [{ label, value, color }]
 * Returns an SVG string with a centred total.
 */
function donutChart(segments, total, { size = 120, stroke = 18 } = {}) {
    const r = (size - stroke) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const sorted = segments.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    const slices = sorted.map((s) => {
        const pct = s.value / total;
        const len = pct * circ;
        const o = offset;
        offset += len;
        return { ...s, pct, len, offset: o };
    });

    let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" class="max-w-full h-auto">
        <style>
            .donut-segment{transition:stroke-dashoffset 0.6s ease}
            .donut-hole{fill:transparent}
        </style>`;
    // Background ring
    svg += `<circle class="donut-hole" cx="${cx}" cy="${cy}" r="${r}" stroke="var(--tg-theme-bg-color,#17212b)" stroke-width="${stroke}"/>`;
    // Slices
    for (const s of slices) {
        const dash = s.len;
        const gap = circ - dash;
        svg += `<circle class="donut-segment" cx="${cx}" cy="${cy}" r="${r}"
            fill="transparent" stroke="${s.color}" stroke-width="${stroke}"
            stroke-dasharray="${dash} ${gap}"
            stroke-dashoffset="${-s.offset}"
            transform="rotate(-90 ${cx} ${cy})"/>`;
    }
    // Centre text
    svg += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" dominant-baseline="central"
        fill="var(--tg-theme-text-color,#fff)" font-size="20" font-weight="700">${Math.round((sorted.reduce((s, v) => s + v.value, 0) / total) * 100)}%</text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" dominant-baseline="central"
        fill="var(--tg-theme-text-secondary,#7f8c8d)" font-size="8">of ${fmt(total)}</text>`;
    svg += '</svg>';

    // Legend
    let legend = '<div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">';
    const COLORS = ['#2ea6ff', '#a8d8ff', '#c084fc', '#fbbf24', '#f87171', '#34d399'];
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const c = s.color || COLORS[i % COLORS.length];
        legend += `<span class="flex items-center gap-1 text-tg-textSecondary">
            <span class="inline-block rounded-full" style="width:8px;height:8px;background:${c}"></span>
            ${escapeHtml(s.label)} <strong class="text-tg-text">${fmt(s.value)}</strong>
        </span>`;
    }
    legend += '</div>';
    return `<div class="flex flex-col items-center">${svg}${legend}</div>`;
}

/** Simple vertical bar chart (SVG). Supports optional `subLabel` per bar. */
function vbarChart(
    bars,
    { height = 120, barColor = 'var(--tg-theme-accent, #2ea6ff)', barWidth = 24 } = {},
) {
    const max = bars.reduce((m, b) => Math.max(m, b.value), 0) || 1;
    const hasSubLabels = bars.some((b) => b.subLabel);
    const pad = { top: 6, bottom: hasSubLabels ? 30 : 20, left: 4, right: 4 };
    const count = bars.length;
    const totalW = count * (barWidth + 4) + pad.left + pad.right;
    const h = height;
    const scale = (v) => (v / max) * (h - pad.top - pad.bottom);

    let svg = `<svg width="${totalW}" height="${h}" viewBox="0 0 ${totalW} ${h}" xmlns="http://www.w3.org/2000/svg">
        <style>.vbar{transition:height 0.5s ease}</style>`;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const barH = Math.max(0, scale(b.value));
        const x = pad.left + i * (barWidth + 4);
        const y = h - pad.bottom - barH;
        // Always render axis labels — keeps zero-value days visible on the time axis
        const labelY = h - pad.bottom + (hasSubLabels ? 11 : 14);
        svg += `<text x="${x + barWidth / 2}" y="${labelY}" text-anchor="middle" fill="var(--tg-theme-text-secondary,#7f8c8d)" font-size="9">${escapeHtml((b.label || '').slice(0, 6))}</text>`;
        if (b.subLabel) {
            svg += `<text x="${x + barWidth / 2}" y="${labelY + 11}" text-anchor="middle" fill="var(--tg-theme-text-secondary,#7f8c8d)" font-size="8">${escapeHtml((b.subLabel || '').slice(0, 5))}</text>`;
        }
        if (b.value === 0) continue;
        svg += `<rect class="vbar" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="2" fill="${barColor}" opacity="0.85"/>`;
        if (barH > 14) {
            svg += `<text x="${x + barWidth / 2}" y="${y - 2}" text-anchor="middle" fill="var(--tg-theme-text-color,#fff)" font-size="9" font-weight="600">${fmt(b.value)}</text>`;
        }
    }
    svg += '</svg>';
    return svg;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderTable(headers, rows) {
    let html =
        '<div class="overflow-x-auto -mx-3 px-3"><table class="w-full text-xs whitespace-nowrap sm:whitespace-normal"><thead><tr class="text-tg-textSecondary">';
    for (const h of headers) {
        html += `<th class="text-left py-1.5 px-2 font-medium${h.right ? ' text-right' : ''}">${escapeHtml(h.label)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const row of rows) {
        html += '<tr class="border-t border-tg-border">';
        for (let i = 0; i < row.length; i++) {
            const cls = headers[i]?.right ? ' text-right' : '';
            html += `<td class="py-1 px-2 text-tg-text${cls}">${row[i]}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
}

function renderCard(title, content) {
    return `<div class="bg-tg-panel rounded-xl p-3 mb-3">
        <h3 class="text-tg-text text-sm font-semibold mb-2">${escapeHtml(title)}</h3>
        ${content}
    </div>`;
}

function ago(iso) {
    if (!iso) return '—';
    // SQLite datetime() emits 'YYYY-MM-DD HH:MM:SS' without timezone marker.
    // Normalise to ISO 8601 and append Z only when no zone is already present.
    const s = String(iso).trim().replace(' ', 'T');
    const hasZone = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s);
    const ms = Date.now() - new Date(hasZone ? s : `${s}Z`).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ${min % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
}

const COLORS = [
    '#2ea6ff',
    '#a8d8ff',
    '#c084fc',
    '#fbbf24',
    '#f87171',
    '#34d399',
    '#fb923c',
    '#a78bfa',
];

const DAY_ABBREVS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Main load ────────────────────────────────────────────────────────────────

async function load() {
    // Don't fetch if the page isn't visible (teardown guard)
    const pageEl = document.getElementById('page-maintenance-db-stats');
    if (!pageEl || pageEl.classList.contains('hidden')) return;
    try {
        const res = await api.get('/api/db/stats');
        if (!res?.success) throw new Error('API error');
        const { tableCounts, groups, totals, dailyTrend, dbFileSizeBytes, ai } = res;
        const loadedAt = new Date().toLocaleTimeString();
        let html = '';

        // ── Toolbar: last-updated timestamp + refresh button ──
        html += `<div class="flex items-center justify-between mb-2">
            <span class="text-[10px] text-tg-textSecondary">Updated ${escapeHtml(loadedAt)}</span>
            <button id="db-stats-refresh-btn" class="tg-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
                <i class="ri-refresh-line"></i><span>Refresh</span>
            </button>
        </div>`;

        // ── Summary cards ──
        html += '<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">';
        const summaryItems = [
            { label: 'Downloads', value: fmt(totals?.total || 0), color: 'text-tg-accent' },
            { label: 'Faces', value: fmt(ai?.faces || 0), color: 'text-tg-accent' },
            { label: 'People', value: fmt(ai?.people || 0), color: 'text-tg-accent' },
            { label: 'Tags', value: fmt(ai?.tags || 0), color: 'text-tg-accent' },
            { label: 'Total size', value: formatBytes(totals?.bytes || 0), color: '' },
            { label: 'DB on disk', value: formatBytes(dbFileSizeBytes || 0), color: '' },
            {
                label: 'AI indexed',
                value: `${ai?.pct || 0}%`,
                sub: `${fmt(ai?.indexed || 0)} / ${fmt(ai?.total || 0)}`,
                color: '',
            },
            { label: 'Videos', value: fmt(totals?.videos || 0), color: '' },
        ];
        for (const item of summaryItems) {
            html += `<div class="bg-tg-panel rounded-xl p-2 sm:p-3 text-center truncate">
                <div class="text-sm sm:text-lg font-bold ${item.color} truncate">${item.value}</div>
                ${item.sub ? `<div class="text-[9px] text-tg-textSecondary tabular-nums leading-tight truncate">${item.sub}</div>` : ''}
                <div class="text-[9px] sm:text-[10px] text-tg-textSecondary mt-0.5 truncate">${escapeHtml(item.label)}</div>
            </div>`;
        }
        html += '</div>';

        // ── Queue backlog callout ──
        const queueCount = Number(tableCounts?.queue) || 0;
        if (queueCount > 0) {
            html += `<div class="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-3 py-2 mb-3 text-xs">
                <i class="ri-time-line text-yellow-400 shrink-0"></i>
                <span class="text-yellow-300 font-medium">${fmt(queueCount)} item${queueCount !== 1 ? 's' : ''} pending in download queue</span>
            </div>`;
        }

        // ── Table sizes ──
        if (tableCounts) {
            const rows = Object.entries(tableCounts).map(([name, count]) => [name, fmt(count)]);
            html += renderCard(
                'Table sizes',
                renderTable([{ label: 'Table' }, { label: 'Rows', right: true }], rows),
            );
        }

        // ── Groups chart + table ──
        if (groups?.length) {
            const topGroups = groups
                .slice()
                .sort((a, b) => b.n - a.n)
                .slice(0, 15);
            const bars = topGroups.map((g, i) => ({
                label: (g.group_name || g.group_id || '?').slice(0, 28),
                value: g.n,
                color: COLORS[i % COLORS.length],
            }));
            const maxLabel = Math.min(
                Math.max(...topGroups.map((g) => (g.group_name || g.group_id || '?').length)) *
                    6.5 +
                    8,
                160,
            );
            html += renderCard(
                'Files per group (top 15)',
                hbarChart(bars, { maxLabel: `${Math.min(maxLabel, 200)}px`, height: 18 }),
            );

            // Name cell: group_name as primary + group_id as mono subtitle for config correlation
            const rows = groups.map((g) => {
                const name = escapeHtml((g.group_name || '').slice(0, 28));
                const id = escapeHtml(String(g.group_id || ''));
                const nameCell = g.group_name
                    ? `${name}<br><span class="text-[10px] text-tg-textSecondary font-mono">${id}</span>`
                    : `<span class="font-mono text-tg-textSecondary">${id}</span>`;
                return [
                    nameCell,
                    fmt(g.n),
                    fmt(g.photos),
                    fmt(g.videos),
                    formatBytes(g.bytes),
                    `<span title="${escapeHtml(g.last_activity || '')}">${ago(g.last_activity)}</span>`,
                ];
            });
            html += renderCard(
                'Groups by activity',
                renderTable(
                    [
                        { label: 'Group' },
                        { label: 'Files', right: true },
                        { label: 'Photos', right: true },
                        { label: 'Videos', right: true },
                        { label: 'Size', right: true },
                        { label: 'Last activity' },
                    ],
                    rows,
                ),
            );
        }

        // ── File type donut + table (includes stickers) ──
        if (totals) {
            const totalFiles = Number(totals.total) || 1;
            const segs = [
                { label: 'Photos', value: Number(totals.photos || 0), color: '#2ea6ff' },
                { label: 'Videos', value: Number(totals.videos || 0), color: '#c084fc' },
                { label: 'Audio', value: Number(totals.audio || 0), color: '#34d399' },
                { label: 'Documents', value: Number(totals.documents || 0), color: '#fbbf24' },
                { label: 'Voice', value: Number(totals.voice || 0), color: '#f87171' },
                { label: 'Stickers', value: Number(totals.stickers || 0), color: '#fb923c' },
            ];
            html += renderCard(
                'File type distribution',
                `<div class="flex flex-col sm:flex-row items-center gap-4">
                    <div class="flex-shrink-0">${donutChart(segs, totalFiles)}</div>
                    <div class="flex-1 w-full">${renderTable(
                        [
                            { label: 'Type' },
                            { label: 'Count', right: true },
                            { label: '%', right: true },
                        ],
                        segs.map((s) => [
                            s.label,
                            fmt(s.value),
                            `${Math.round((s.value / totalFiles) * 100)}%`,
                        ]),
                    )}</div>
                </div>`,
            );
        }

        // ── 14-day download trend (day-of-week + MM-DD sub-labels) ──
        if (dailyTrend?.length) {
            const total14 = dailyTrend.reduce((s, d) => s + d.n, 0);
            const bars = dailyTrend.map((d) => {
                const dow = DAY_ABBREVS[new Date(`${d.day}T00:00:00`).getDay()];
                return { label: dow, subLabel: d.day.slice(5), value: d.n };
            });
            html += renderCard(
                `14-day download trend  ·  ${fmt(total14)} total`,
                `<div class="overflow-x-auto">${vbarChart(bars, { height: 140, barWidth: 30 })}</div>`,
            );
        }

        // ── AI coverage ──
        if (ai) {
            const indexed = Number(ai.indexed) || 0;
            const totalAi = Number(ai.total) || 1;
            const notIndexed = Math.max(0, totalAi - indexed);
            // Photo-specific features only process photos — use photo count as denominator
            // so coverage % reflects actual photo library coverage, not all file types.
            const photoBase = Math.max(1, Number(totals?.photos) || 0);
            const pctPhoto = (n) => `${Math.round((Number(n || 0) / photoBase) * 100)}%`;
            html += renderCard(
                'AI coverage',
                `<div class="flex flex-col sm:flex-row items-center gap-4 mb-2">
                    <div class="flex-shrink-0">${donutChart(
                        [
                            { label: 'Indexed', value: indexed, color: '#34d399' },
                            { label: 'Not indexed', value: notIndexed, color: '#4b5563' },
                        ],
                        totalAi,
                        { size: 100, stroke: 14 },
                    )}</div>
                    <div class="flex-1 w-full">${renderTable(
                        [
                            { label: 'Metric' },
                            { label: 'Count', right: true },
                            { label: '% of photos', right: true },
                        ],
                        [
                            ['Face-indexed', `${fmt(indexed)} / ${fmt(totalAi)}`, `${ai.pct}%`],
                            ['Faces detected', fmt(ai.faces), ''],
                            ['People clusters', fmt(ai.people), ''],
                            ['CLIP tags', fmt(ai.tags), pctPhoto(ai.tags)],
                            ['OCR scanned', fmt(ai.ocrFiles || 0), pctPhoto(ai.ocrFiles)],
                            ['WD14 tagged', fmt(ai.wd14Files || 0), pctPhoto(ai.wd14Files)],
                            ['Embeddings', fmt(ai.embeddings || 0), pctPhoto(ai.embeddings)],
                        ],
                    )}</div>
                </div>`,
            );
        }

        const root = $('db-stats-root');
        if (root) {
            root.innerHTML = html;
            const btn = root.querySelector('#db-stats-refresh-btn');
            if (btn) btn.addEventListener('click', () => load());
        }
    } catch (e) {
        const root = $('db-stats-root');
        if (root)
            root.innerHTML = `<div class="text-center py-8 text-xs text-tg-textSecondary">Failed to load: ${escapeHtml(e.message || e)}</div>`;
    }
}

export function showDbStatsPage() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
    load();
    _interval = setInterval(load, 15000);
}

export function stopDbStatsPage() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}
