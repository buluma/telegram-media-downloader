// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAIWorkspace, revealAISection } from '../src/web/public/js/ai-workspace.js';

const partial = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/web/public/partials/maintenance-ai.html'),
    'utf8',
);

beforeEach(() => {
    document.body.innerHTML = partial;
});

describe('AI workspace task navigation', () => {
    it('preserves bound controls while keeping active job feedback outside panels', () => {
        const scan = document.getElementById('ai-scan-btn');
        const action = vi.fn();
        scan.addEventListener('click', action);
        initAIWorkspace();
        expect(document.getElementById('ai-scan-btn')).toBe(scan);
        scan.click();
        expect(action).toHaveBeenCalledOnce();
        expect(scan.closest('[data-ai-panel]').dataset.aiPanel).toBe('configuration');
        expect(document.getElementById('ai-progress').closest('[data-ai-panel]')).toBeNull();
        expect(document.getElementById('ai-install-card').closest('[data-ai-panel]')).toBeNull();
        expect(document.getElementById('ai-workspace-search').hidden).toBe(false);
    });

    it('switches tasks with click and arrow keys, including focus and selection state', () => {
        initAIWorkspace();
        const people = document.getElementById('ai-tab-people');
        people.click();
        people.focus();
        people.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const tags = document.getElementById('ai-tab-tags');
        expect(document.activeElement).toBe(tags);
        expect(tags.getAttribute('aria-selected')).toBe('true');
        expect(people.tabIndex).toBe(-1);
        expect(document.getElementById('ai-workspace-tags').hidden).toBe(false);
        expect(document.getElementById('ai-workspace-people').hidden).toBe(true);
        expect(document.getElementById('ai-workspace-search').hidden).toBe(true);
    });

    it('reveals configuration for scanner settings links without replacing settings', () => {
        initAIWorkspace();
        const model = document.getElementById('ai-faces-model');
        revealAISection(model);
        expect(document.getElementById('ai-workspace-configuration').hidden).toBe(false);
        expect(document.getElementById('ai-tab-configuration').getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(model.closest('details').open).toBe(false);
    });
});
