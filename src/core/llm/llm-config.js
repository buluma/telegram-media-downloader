/**
 * LLM config resolver — merges three sources, in this precedence:
 *
 *   1. `TGDL_LLM_<UPPER_SNAKE>` env vars (deployment-time override).
 *   2. `config.advanced.ai.llm.*` (operator-set runtime config).
 *   3. The hardcoded defaults in `manager.js` `DEFAULT_CONFIG.advanced.ai.llm`.
 *
 * Mirrors the same pattern as `faces-config.js` — every knob is reachable
 * here with a single import. Consumers MUST go through this module so env
 * overrides are honoured everywhere.
 *
 * Config shape (nested under `advanced.ai.llm`):
 *   provider: "disabled" | "ollama" | "openai"
 *   ollama.baseUrl, ollama.model
 *   openai.apiKey, openai.model, openai.baseUrl
 *   defaults.temperature, defaults.maxTokens
 *
 * Env vars use UPPER_SNAKE_CASE derived from the leaf key:
 *   TGDL_LLM_PROVIDER
 *   TGDL_LLM_OLLAMA_BASE_URL
 *   TGDL_LLM_OLLAMA_MODEL
 *   TGDL_LLM_OPENAI_API_KEY
 *   TGDL_LLM_OPENAI_MODEL
 *   TGDL_LLM_OPENAI_BASE_URL
 *   TGDL_LLM_TEMPERATURE
 *   TGDL_LLM_MAX_TOKENS
 */

// Keys that map to a nested sub-object.
const NESTED_KEYS = new Set(['ollama', 'openai']);

// Keys under `defaults`.
const DEFAULTS_KEYS = new Set(['temperature', 'maxTokens']);

// Map each env var to a `[section, key]` pair so we can write generic
// resolver code instead of per-key branches.
const ENV_MAP = Object.freeze({
    TGDL_LLM_PROVIDER: ['', 'provider'],
    TGDL_LLM_OLLAMA_BASE_URL: ['ollama', 'baseUrl'],
    TGDL_LLM_OLLAMA_MODEL: ['ollama', 'model'],
    TGDL_LLM_OLLAMA_EMBED_MODEL: ['ollama', 'embedModel'],
    TGDL_LLM_OLLAMA_SUPPORTS_VISION: ['ollama', 'supportsVision'],
    TGDL_LLM_OPENAI_API_KEY: ['openai', 'apiKey'],
    TGDL_LLM_OPENAI_MODEL: ['openai', 'model'],
    TGDL_LLM_OPENAI_BASE_URL: ['openai', 'baseUrl'],
    TGDL_LLM_OPENAI_EMBED_MODEL: ['openai', 'embedModel'],
    TGDL_LLM_TEMPERATURE: ['defaults', 'temperature'],
    TGDL_LLM_MAX_TOKENS: ['defaults', 'maxTokens'],
});

// Fallback values when nothing is configured.
export const LLM_DEFAULTS = Object.freeze({
    provider: 'disabled',
    ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'qwen3-vl:235b-cloud',
        embedModel: 'nomic-embed-text',
    },
    openai: {
        apiKey: '',
        model: 'gpt-4o-mini',
        baseUrl: '',
        embedModel: 'text-embedding-3-small',
    },
    defaults: {
        temperature: 0.7,
        maxTokens: 512,
    },
});

/**
 * Return the resolved value for a single leaf key, applying env-var
 * overrides on top of the supplied `llmCfg` slice.
 *
 * @param {string} section  e.g. `'ollama'`, `'openai'`, `'defaults'`, or `''` for top-level
 * @param {string} key      e.g. `'baseUrl'`, `'model'`, `'provider'`
 * @param {object} llmCfg   the `config.advanced.ai.llm` block
 * @returns {any}
 */
export function resolveLlmKey(section, key, llmCfg = {}) {
    // Walk nested path: llmCfg.ollama.baseUrl
    let fromCfg;
    if (section) {
        fromCfg = llmCfg[section] ? llmCfg[section][key] : undefined;
    } else {
        fromCfg = llmCfg[key];
    }

    // Find matching env var
    const keyInMap = key.endsWith('Url') ? key : key;
    for (const [envName, [envSection, envKey]] of Object.entries(ENV_MAP)) {
        if (envSection === section && envKey === key) {
            const raw = process.env[envName];
            if (raw !== undefined && raw !== null && raw !== '') {
                return _parseEnv(key, raw, fromCfg);
            }
            break;
        }
    }
    return fromCfg;
}

/**
 * Resolve every llm.* key in one pass — used at module boot. The returned
 * object is a frozen snapshot with the full nested shape.
 */
export function resolveAllLlm(llmCfg = {}) {
    // Start with hardcoded defaults, overlay any user-supplied values.
    const out = _deepClone(LLM_DEFAULTS);
    _deepMerge(out, llmCfg);

    // Apply env-var overrides on top.
    for (const [envName, [section, key]] of Object.entries(ENV_MAP)) {
        const raw = process.env[envName];
        if (raw === undefined || raw === null || raw === '') continue;
        const parsed = _parseEnv(key, raw, undefined);
        if (parsed === undefined) continue;
        if (section) {
            if (!out[section]) out[section] = {};
            out[section][key] = parsed;
        } else {
            out[key] = parsed;
        }
    }

    return Object.freeze(out);
}

function _parseEnv(key, raw, fallback) {
    const trimmed = String(raw).trim();
    if (!trimmed) return fallback;

    // Numeric keys
    if (['temperature', 'maxTokens'].includes(key)) {
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : fallback;
    }

    // Boolean keys
    if (key === 'enabled' || key === 'supportsVision') {
        const v = trimmed.toLowerCase();
        if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
        if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
        return fallback;
    }

    // String keys
    return trimmed;
}

function _deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function _deepMerge(target, source) {
    if (!source || typeof source !== 'object') return;
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            _deepMerge(target[key], source[key]);
        } else if (source[key] !== undefined) {
            target[key] = source[key];
        }
    }
}

/**
 * Return a safe copy of an llm config block with sensitive values masked.
 * Replaces any non-empty `openai.apiKey` with `'***'` so the value can be
 * included in API responses or logs without leaking credentials.
 */
export function maskLlmConfig(config) {
    if (!config || typeof config !== 'object') return config;
    const out = _deepClone(config);
    if (out.openai?.apiKey) {
        out.openai.apiKey = '***';
    }
    return out;
}

/** Test-only: dump the env-name map. */
export function _envMap() {
    return { ...ENV_MAP };
}

/** Test-only: return the defaults. */
export function _defaults() {
    return _deepClone(LLM_DEFAULTS);
}
