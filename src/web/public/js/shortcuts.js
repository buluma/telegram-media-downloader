// Global keyboard shortcuts. Press `?` to open the cheatsheet, `Esc` to
// close. We deliberately don't grab printable keys when the user is typing
// in an input or textarea so search / form fields stay usable.

const SHORTCUTS = [
    { keys: '?',          description: 'Open this shortcuts cheatsheet' },
    { keys: 'Esc',        description: 'Close any modal / drawer' },
    { keys: 'g v',        description: 'Go to Viewer' },
    { keys: 'g g',        description: 'Go to Groups' },
    { keys: 'g s',        description: 'Go to Settings' },
    { keys: '/',          description: 'Focus the gallery search box' },
    { keys: 'l',          description: 'Open the "paste t.me link" drawer' },
    { keys: 's',          description: 'Toggle gallery selection mode' },
    { keys: 'Enter',      description: '(in viewer) play / pause video' },
    { keys: '← / →',      description: '(in viewer) previous / next item' },
    { keys: 'f',          description: '(in viewer) toggle fullscreen' },
];

let modalEl = null;
let lastG = 0; // timestamp of the last "g" press for two-key chords

function buildModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'shortcuts-modal';
    modalEl.className = 'hidden fixed inset-0 z-[120] flex items-center justify-center p-4 modal-backdrop';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-label', 'Keyboard shortcuts');
    modalEl.innerHTML = `
        <div class="bg-tg-panel border border-tg-border rounded-xl w-full max-w-md p-5 shadow-xl">
            <div class="flex items-center justify-between mb-3">
                <h3 class="font-semibold text-tg-text">Keyboard shortcuts</h3>
                <button id="shortcuts-close" class="text-tg-textSecondary hover:text-tg-text" aria-label="Close">
                    <i class="ri-close-line text-xl"></i>
                </button>
            </div>
            <ul class="space-y-1.5 text-sm">
                ${SHORTCUTS.map(s => `
                    <li class="flex items-center justify-between">
                        <span class="text-tg-textSecondary">${s.description}</span>
                        <kbd class="px-1.5 py-0.5 text-xs rounded bg-tg-bg/60 border border-tg-border font-mono">${s.keys}</kbd>
                    </li>
                `).join('')}
            </ul>
            <p class="text-[11px] text-tg-textSecondary mt-3">Pro tip — none of these fire while you're typing in a text field.</p>
        </div>`;
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) hide(); });
    modalEl.querySelector('#shortcuts-close').addEventListener('click', hide);
    return modalEl;
}

function show() { buildModal().classList.remove('hidden'); }
function hide() { if (modalEl) modalEl.classList.add('hidden'); }

function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function dispatchG(letter) {
    if (typeof window.navigateTo !== 'function') return;
    if (letter === 'v') window.navigateTo('viewer');
    else if (letter === 'g') window.navigateTo('groups');
    else if (letter === 's') window.navigateTo('settings');
}

export function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // ESC also closes the shortcuts modal itself; other modal handlers
            // run after this and close their own state.
            if (modalEl && !modalEl.classList.contains('hidden')) { hide(); return; }
        }
        if (isTyping(e)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
            e.preventDefault();
            show();
            return;
        }
        if (e.key === '/') {
            const search = document.getElementById('media-search');
            if (search) { e.preventDefault(); search.focus(); }
            return;
        }
        if (e.key === 'l' || e.key === 'L') {
            document.getElementById('paste-url-btn')?.click();
            return;
        }
        if (e.key === 's' || e.key === 'S') {
            document.getElementById('select-mode-btn')?.click();
            return;
        }
        if (e.key === 'g' || e.key === 'G') {
            lastG = Date.now();
            return;
        }
        if (Date.now() - lastG < 800 && /^[a-z]$/i.test(e.key)) {
            lastG = 0;
            dispatchG(e.key.toLowerCase());
        }
    });
}
