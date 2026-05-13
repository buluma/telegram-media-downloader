/**
 * LLM provider registry.
 *
 * Auto-discovers available providers at boot by probing each one. The
 * registry exposes:
 *   - `listProviders()` — every known provider class
 *   - `probeAll(llmCfg)` — runs `.probe()` on each, returns availability map
 *   - `resolveProvider(llmCfg)` — returns the active provider singleton
 *
 * Mirrors the boot-time probe pattern used in `faces-spawn.js` for sidecar
 * health checks — lightweight HTTP probes that the AI maintenance page can
 * surface as green/red indicators.
 */

import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';

// Ordered list — first matching provider wins when resolving.
const PROVIDERS = [OllamaProvider, OpenAIProvider];

// Cached probe results keyed by provider id.
let _probeCache = null;
let _probeTimestamp = 0;
const PROBE_CACHE_TTL_MS = 60_000;

// Active provider singleton (set by resolveProvider / boot).
let _activeProvider = null;
let _activeProviderId = null;

/**
 * Return the list of all known provider classes.
 * @returns {Array<typeof import('./provider.js').LLMProvider>}
 */
export function listProviders() {
    return PROVIDERS.slice();
}

/**
 * Run `.probe()` on every provider. Results are cached for 60 s so the
 * AI maintenance page can poll without hammering the network.
 *
 * Returns a `Map<string, { available, version?, error? }>` keyed by
 * provider id.
 *
 * @param {object} llmCfg  resolved llm config snapshot
 * @returns {Promise<Map<string, object>>}
 */
export async function probeAll(llmCfg) {
    const now = Date.now();
    if (_probeCache && now - _probeTimestamp < PROBE_CACHE_TTL_MS) {
        return _probeCache;
    }
    const results = new Map();
    await Promise.all(
        PROVIDERS.map(async (Provider) => {
            try {
                const result = await Provider.probe(llmCfg);
                results.set(Provider.id, result);
            } catch (e) {
                results.set(Provider.id, {
                    available: false,
                    error: e?.message || String(e),
                });
            }
        }),
    );
    _probeCache = results;
    _probeTimestamp = now;
    return results;
}

/**
 * Resolve the active provider based on config. Returns null when the
 * provider is `disabled` or the configured provider is unavailable.
 *
 * The provider instance is created once and cached. If the config changes
 * (e.g. operator switches from ollama to openai), call `resetProvider()`
 * first, then re-call `resolveProvider()`.
 *
 * @param {object} llmCfg  resolved llm config snapshot
 * @returns {Promise<import('./provider.js').LLMProvider | null>}
 */
export async function resolveProvider(llmCfg) {
    const providerId = llmCfg?.provider || 'disabled';
    if (providerId === 'disabled') {
        _activeProvider = null;
        _activeProviderId = 'disabled';
        return null;
    }

    // Return cached singleton if provider hasn't changed.
    if (_activeProvider && _activeProviderId === providerId) {
        return _activeProvider;
    }

    const Provider = PROVIDERS.find((P) => P.id === providerId);
    if (!Provider) {
        _activeProvider = null;
        _activeProviderId = providerId;
        return null;
    }

    // Probe first — don't construct a provider that's unreachable.
    const probeResult = await Provider.probe(llmCfg);
    if (!probeResult.available) {
        _activeProvider = null;
        _activeProviderId = providerId;
        return null;
    }

    _activeProvider = new Provider(llmCfg);
    _activeProviderId = providerId;
    return _activeProvider;
}

/**
 * Clear the cached provider singleton + probe results. Call this after
 * `saveConfig()` so the next `resolveProvider()` picks up the new config.
 */
export function resetProvider() {
    _activeProvider = null;
    _activeProviderId = null;
    _probeCache = null;
    _probeTimestamp = 0;
}

/**
 * Return the currently-active provider id (or 'disabled' / null).
 * Useful for the AI maintenance page to show which provider is active.
 */
export function getActiveProviderId() {
    return _activeProviderId;
}

/** Test-only: inject a provider mock. */
export function _resetForTests() {
    _activeProvider = null;
    _activeProviderId = null;
    _probeCache = null;
    _probeTimestamp = 0;
}
