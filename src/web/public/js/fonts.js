// Font registry — every option supports Thai. The list mirrors the
// inline boot-time loader in index.html (kept in two places so the
// boot script can run before the module graph evaluates and avoid
// FOUC). When you add a font here, ALSO add it to the REG object in
// the inline <script> at the top of index.html.
//
// `query` is the GoogleFonts CSS API path fragment ("css2?family=" + q
// + "&display=swap"). `family` is the CSS font-family stack — it
// always falls back to IBM Plex + system stack so missing glyphs
// (e.g. emoji, special icons) still render.
//
// `system` is the no-webfont escape hatch: every OS picks a
// reasonable Thai-capable system font. Useful in air-gapped /
// no-internet deployments.

export const FALLBACK_STACK = "'IBM Plex Sans', 'IBM Plex Sans Thai', 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const FONTS = [
    {
        id: 'ibm-plex-sans',
        name: 'IBM Plex Sans (default)',
        query: 'IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600;700',
        family: "'IBM Plex Sans', 'IBM Plex Sans Thai'",
    },
    {
        id: 'noto-sans-thai',
        name: 'Noto Sans Thai',
        query: 'Noto+Sans:wght@400;500;600;700&family=Noto+Sans+Thai:wght@400;500;600;700',
        family: "'Noto Sans', 'Noto Sans Thai'",
    },
    {
        id: 'sarabun',
        name: 'Sarabun',
        query: 'Sarabun:wght@400;500;600;700',
        family: "'Sarabun'",
    },
    {
        id: 'prompt',
        name: 'Prompt',
        query: 'Prompt:wght@400;500;600;700',
        family: "'Prompt'",
    },
    {
        id: 'kanit',
        name: 'Kanit',
        query: 'Kanit:wght@400;500;600;700',
        family: "'Kanit'",
    },
    {
        id: 'mitr',
        name: 'Mitr',
        query: 'Mitr:wght@400;500;600;700',
        family: "'Mitr'",
    },
    {
        id: 'k2d',
        name: 'K2D',
        query: 'K2D:wght@400;500;600;700',
        family: "'K2D'",
    },
    {
        id: 'bai-jamjuree',
        name: 'Bai Jamjuree',
        query: 'Bai+Jamjuree:wght@400;500;600;700',
        family: "'Bai Jamjuree'",
    },
    {
        id: 'athiti',
        name: 'Athiti',
        query: 'Athiti:wght@400;500;600;700',
        family: "'Athiti'",
    },
    {
        id: 'niramit',
        name: 'Niramit',
        query: 'Niramit:wght@400;500;600;700',
        family: "'Niramit'",
    },
    {
        id: 'system',
        name: 'System default',
        query: null,
        family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
];

const LS_KEY = 'tgdl-font';
const LINK_ID = 'tgdl-fonts-user';

export function getActiveFontId() {
    const id = localStorage.getItem(LS_KEY);
    return FONTS.some(f => f.id === id) ? id : 'ibm-plex-sans';
}

/**
 * Apply a font by id — injects the matching Google Fonts <link> if not
 * already present, sets the `--tgdl-font-family` CSS var, and persists
 * the choice. Triggering it with the current id is a no-op besides the
 * persist (so callers don't have to dedupe).
 */
export function applyFont(id) {
    const font = FONTS.find(f => f.id === id) || FONTS[0];
    try { localStorage.setItem(LS_KEY, font.id); } catch { /* private mode */ }

    // Strip a previous user-selected font link so we don't pile them up
    // when the user toggles back and forth (each variant is a separate
    // network request — keep one at a time).
    document.getElementById(LINK_ID)?.remove();
    if (font.query) {
        const link = document.createElement('link');
        link.id = LINK_ID;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${font.query}&display=swap`;
        document.head.appendChild(link);
    }
    document.documentElement.style.setProperty(
        '--tgdl-font-family',
        `${font.family}, ${FALLBACK_STACK}`,
    );
}

/** Populate a `<select id="setting-font">` with the registry. */
export function populateSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = FONTS
        .map(f => `<option value="${f.id}" style="font-family: ${f.family.replace(/"/g, '&quot;')}, ${FALLBACK_STACK}">${f.name}</option>`)
        .join('');
    selectEl.value = getActiveFontId();
}
