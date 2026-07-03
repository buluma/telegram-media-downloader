/**
 * In-app CHANGELOG viewer — overlay sheet that fetches `/CHANGELOG.md`,
 * parses it with a tiny inline Markdown subset (~50 lines), and renders
 * a versioned timeline. Triggered by clicking the version chip in the
 * status bar.
 *
 * Cross-platform: pure DOM, no third-party deps.
 */

import { openSheet } from './sheet.js';
import { t as i18nT } from './i18n.js';

let _cache = null;

function escapeHtml(s) {
    return String(s).replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;',
            })[c],
    );
}

/**
 * Subset Markdown → HTML. Only the constructs that show up in our
 * CHANGELOG: headings (#, ##, ###), bullet lists (- ...), inline
 * code (`...`), bold (**...**), emphasis (*...*), links ([text](url)).
 * Anything else flows through as escaped text.
 */
function mdToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    const out = [];
    let inList = false;

    function inline(s) {
        return escapeHtml(s)
            .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
            .replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`)
            .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, e) => `<em>${e}</em>`)
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
                const safe = href.startsWith('http') ? href : '#';
                return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
            });
    }

    function flushList() {
        if (inList) {
            out.push('</ul>');
            inList = false;
        }
    }

    for (const raw of lines) {
        const line = raw.trimEnd();
        let m;
        if ((m = line.match(/^### (.+)$/))) {
            flushList();
            out.push(`<h4>${inline(m[1])}</h4>`);
            continue;
        }
        if ((m = line.match(/^## (.+)$/))) {
            flushList();
            out.push(`<h3 class="cl-version">${inline(m[1])}</h3>`);
            continue;
        }
        if ((m = line.match(/^# (.+)$/))) {
            flushList();
            out.push(`<h2>${inline(m[1])}</h2>`);
            continue;
        }
        if ((m = line.match(/^[-*] (.+)$/))) {
            if (!inList) {
                out.push('<ul>');
                inList = true;
            }
            out.push(`<li>${inline(m[1])}</li>`);
            continue;
        }
        if (line.trim() === '') {
            flushList();
            out.push('');
            continue;
        }
        flushList();
        out.push(`<p>${inline(line)}</p>`);
    }
    flushList();
    return out.join('\n');
}

async function _load() {
    if (_cache) return _cache;
    // The server sends `Cache-Control: max-age=3600` on this route (its own
    // comment says the SPA "invalidates it via the ?v= token" — it never
    // actually did, so a stale CHANGELOG.md could sit in the browser cache
    // for up to an hour after a deploy, surviving even a manual reload on
    // browsers that don't force-revalidate fetch() on hard-refresh). Bust
    // it with the running build's commit so each deploy gets a new URL.
    let v = '';
    try {
        const ver = await fetch('/api/version', { credentials: 'same-origin' }).then((r) =>
            r.ok ? r.json() : null,
        );
        if (ver?.commit && ver.commit !== 'dev') v = `?v=${encodeURIComponent(ver.commit)}`;
    } catch {
        /* best-effort cache-bust; fall through without it */
    }
    const res = await fetch(`/CHANGELOG.md${v}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _cache = await res.text();
    return _cache;
}

/**
 * The full CHANGELOG.md accumulates every release ever shipped; the
 * release-notes sheet only wants "what did we just get", i.e. the most
 * recent `## [x.y.z]` section. `[Unreleased]` is a standing placeholder
 * (usually empty) and is skipped in favour of the first real version.
 * Falls back to the whole doc if the heading shape isn't found, so a
 * format change degrades to the old full-dump behaviour instead of
 * showing nothing.
 */
function _latestVersionSection(md) {
    const lines = String(md || '').split(/\r?\n/);
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (!/^## \[/.test(lines[i])) continue;
        if (start === -1) {
            if (/^## \[Unreleased\]/i.test(lines[i])) continue;
            start = i;
            continue;
        }
        end = i;
        break;
    }
    return start === -1 ? md : lines.slice(start, end).join('\n').trim();
}

export async function openChangelogViewer() {
    const wrap = document.createElement('div');
    wrap.className = 'changelog-body text-tg-text text-sm leading-relaxed';
    wrap.innerHTML = `<div class="text-tg-textSecondary">${i18nT('changelog.viewer.loading', 'Loading…')}</div>`;
    const handle = openSheet({
        title: i18nT('changelog.viewer.title', 'Release notes'),
        content: wrap,
        size: 'lg',
    });
    try {
        const md = await _load();
        // NOT `#status-version`'s href — statusbar.js rewrites that to a
        // commit-specific `.../commit/<sha>` URL once the version loads,
        // which turned "view full changelog" into
        // `.../commit/<sha>/blob/main/CHANGELOG.md` (404). This link needs
        // the bare repo URL, not wherever the version chip happens to point.
        const repoUrl = 'https://github.com/buluma/telegram-media-downloader';
        wrap.innerHTML = `${mdToHtml(_latestVersionSection(md))}
<p class="pt-2 border-t border-tg-border mt-3">
  <a href="${escapeHtml(repoUrl)}/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">${i18nT('changelog.viewer.full_history', 'View full changelog →')}</a>
</p>`;
    } catch (e) {
        wrap.innerHTML = `<div class="text-red-400">${escapeHtml(e?.message || 'Failed to load CHANGELOG.md')}</div>`;
    }
    return handle;
}

export function wireChangelogTrigger() {
    const versionEl = document.getElementById('status-version');
    if (!versionEl) return;
    // Replace the link's default github navigation with the in-app sheet
    // so users discover the release notes without leaving the dashboard.
    // The link's existing href stays as a fallback (right-click → open
    // in new tab still works).
    versionEl.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        openChangelogViewer().catch(() => {});
    });
}
