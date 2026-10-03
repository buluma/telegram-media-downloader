// Group the existing AI controls without replacing their nodes or listeners.
const SECTIONS = {
    search: ['ai-unified-query', 'ai-smart-albums'],
    people: ['ai-pane-people'],
    tags: ['ai-tag-browser', 'ai-wd14-browser', 'ai-tag-suggestions'],
    ocr: ['ai-ocr-browser'],
    configuration: [
        'ai-pane-faces',
        'ai-pane-tags',
        'ai-pane-ocr',
        'ai-pane-embeddings',
        'ai-pane-llm',
    ],
    diagnostics: ['ai-doctor-card'],
};

export function selectAISection(name) {
    const nav = document.getElementById('ai-workspace-tabs');
    if (!nav || !SECTIONS[name]) return;
    for (const button of nav.querySelectorAll('[data-ai-section]')) {
        const selected = button.dataset.aiSection === name;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
    }
    for (const key of Object.keys(SECTIONS)) {
        const panel = document.getElementById(`ai-workspace-${key}`);
        if (panel) panel.hidden = key !== name;
    }
}

export function revealAISection(element) {
    const panel = element?.closest('[data-ai-panel]');
    if (panel) selectAISection(panel.dataset.aiPanel);
}

export function initAIWorkspace() {
    const nav = document.getElementById('ai-workspace-tabs');
    if (!nav) return;
    for (const [name, ids] of Object.entries(SECTIONS)) {
        const panel = document.getElementById(`ai-workspace-${name}`);
        if (!panel) continue;
        for (const id of ids) {
            const element = document.getElementById(id);
            if (!element) continue;
            panel.append(element);
            if (name !== 'configuration' && element.tagName === 'DETAILS') element.open = true;
        }
    }
    const faceActions = document.getElementById('ai-face-scan-actions');
    const faces = document.getElementById('ai-pane-faces');
    if (faceActions && faces) faces.append(faceActions);
    nav.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ai-section]');
        if (button) selectAISection(button.dataset.aiSection);
    });
    nav.addEventListener('keydown', (event) => {
        const buttons = [...nav.querySelectorAll('[data-ai-section]')];
        const current = buttons.indexOf(document.activeElement);
        if (current < 0) return;
        let next;
        if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') next = (current + buttons.length - 1) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault();
        selectAISection(buttons[next].dataset.aiSection);
        buttons[next].focus();
    });
    selectAISection('search');
}
