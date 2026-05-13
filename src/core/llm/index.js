/**
 * LLM subsystem — public surface.
 *
 * Provides a unified interface for text generation, chat, and embeddings
 * across multiple providers (Ollama, OpenAI). The active provider is
 * resolved from `config.advanced.ai.llm` at first use and cached until
 * `resetLlmProvider()` is called.
 *
 * Usage:
 *   import { generate, chat, embed, probeProviders, listProviders }
 *     from './core/llm/index.js';
 *
 *   const response = await generate({
 *     prompt: 'Summarise this',
 *     systemPrompt: 'Be concise',
 *   });
 *   console.log(response.text);
 *
 * The AI maintenance page calls `probeProviders()` to show availability.
 * When a provider is unavailable or disabled, all functions return
 * `{ unavailable: true }`-shaped results so callers can degrade gracefully.
 */

import { resolveAllLlm } from './llm-config.js';
import {
    listProviders as _listProviders,
    probeAll as _probeAll,
    resolveProvider as _resolveProvider,
    resetProvider as _resetProvider,
    getActiveProviderId,
} from './_registry.js';

// Lazily-loaded config-manager reference. Set on first call so this module
// can be imported before the config system is ready (same pattern as the
// NSFW classifier's `_loadClassifier` lazy import).
let _loadConfigFn = null;

async function _getLlmCfg() {
    if (!_loadConfigFn) {
        try {
            const mod = await import('../../config/manager.js');
            _loadConfigFn = mod.loadConfig;
        } catch {
            _loadConfigFn = () => ({});
        }
    }
    try {
        const live = _loadConfigFn();
        return resolveAllLlm(live?.advanced?.ai?.llm || {});
    } catch {
        return resolveAllLlm({});
    }
}

/**
 * List all known provider classes.
 * @returns {Array<{ id: string, label: string }>}
 */
export function listProviders() {
    return _listProviders().map((P) => ({ id: P.id, label: P.label }));
}

/**
 * Probe every provider and return availability. Cached for 60 s.
 * @returns {Promise<Array<{ id: string, label: string, available: boolean, version?: string, error?: string }>>}
 */
export async function probeProviders() {
    const cfg = await _getLlmCfg();
    const results = await _probeAll(cfg);
    const providers = _listProviders();
    return providers.map((P) => {
        const r = results.get(P.id) || { available: false, error: 'not probed' };
        return { id: P.id, label: P.label, ...r };
    });
}

/**
 * Get the currently active provider info.
 * @returns {Promise<{ id: string, label: string, available: boolean, supportsVision: boolean } | { id: 'disabled', label: string, available: false }>}
 */
export async function getActiveProvider() {
    const cfg = await _getLlmCfg();
    const provider = await _resolveProvider(cfg);
    if (!provider) {
        const id = getActiveProviderId() || 'disabled';
        const P = _listProviders().find((p) => p.id === id);
        return {
            id,
            label: P?.label || 'Disabled',
            available: false,
            supportsVision: false,
        };
    }
    return {
        id: provider.constructor.id,
        label: provider.constructor.label,
        available: true,
        supportsVision: provider.supportsVision,
    };
}

/**
 * Generate text (completion-style).
 *
 * @param {object} opts
 * @param {string}  opts.prompt
 * @param {string}  [opts.systemPrompt]
 * @param {string}  [opts.model]
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ text: string, finishReason?: string } | { unavailable: true, reason: string }>}
 */
export async function generate(opts) {
    const cfg = await _getLlmCfg();
    const provider = await _resolveProvider(cfg);
    if (!provider) {
        return { unavailable: true, reason: _unavailableReason(cfg) };
    }
    return provider.generate(opts);
}

/**
 * Chat-style interaction.
 *
 * @param {object} opts
 * @param {Array<{ role: string, content: string }>} opts.messages
 * @param {string}  [opts.model]
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ text: string, finishReason?: string } | { unavailable: true, reason: string }>}
 */
export async function chat(opts) {
    const cfg = await _getLlmCfg();
    const provider = await _resolveProvider(cfg);
    if (!provider) {
        return { unavailable: true, reason: _unavailableReason(cfg) };
    }
    return provider.chat(opts);
}

/**
 * Embed text into vectors.
 *
 * @param {object} opts
 * @param {string|string[]} opts.texts
 * @returns {Promise<number[][] | null | { unavailable: true, reason: string }>}
 */
export async function embed(opts) {
    const cfg = await _getLlmCfg();
    const provider = await _resolveProvider(cfg);
    if (!provider) {
        return { unavailable: true, reason: _unavailableReason(cfg) };
    }
    return provider.embed(opts);
}

/**
 * Call this after `saveConfig()` so the next LLM call picks up the new
 * provider / model settings without a server restart. Mirrors the
 * `watchConfig()` pattern used elsewhere in the app.
 */
export function resetLlmProvider() {
    _resetProvider();
    _loadConfigFn = null; // force re-resolve on next call
}

function _unavailableReason(cfg) {
    const id = cfg?.provider || 'disabled';
    if (id === 'disabled') return 'LLM provider is disabled in config';
    return `LLM provider "${id}" is not available — check the AI maintenance page for details`;
}

// Auto-register a config-change watcher so the provider singleton stays in
// sync with live edits. Best-effort — if the config manager isn't loaded
// yet, the watcher is a no-op until the next call.
(async () => {
    try {
        const mod = await import('../../config/manager.js');
        if (typeof mod.watchConfig === 'function') {
            mod.watchConfig(() => {
                _resetProvider();
                _loadConfigFn = null;
            });
        }
    } catch {
        /* config manager not ready — provider resets on next call */
    }
})();
