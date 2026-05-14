/**
 * Ollama provider — OpenAI-compatible REST API running locally.
 *
 * Ollama exposes an OpenAI-compatible endpoint at `/v1/chat/completions`
 * and `/v1/embeddings`, so this module reuses the same code paths as the
 * OpenAI provider with a different base URL.
 *
 * https://github.com/ollama/ollama/blob/main/docs/openai.md
 *
 * Config expected shape (from `config.advanced.ai.llm.ollama`):
 *   baseUrl: string  (default 'http://localhost:11434')
 *   model:   string  (default 'qwen3-vl:235b-cloud')
 */

import { LLMProvider } from './provider.js';
import { resolveLlmKey } from './llm-config.js';

export class OllamaProvider extends LLMProvider {
    static id = 'ollama';
    static label = 'Ollama (local)';

    /**
     * Probe Ollama by hitting `/api/tags` (native endpoint, faster than
     * the OpenAI-compatible one). Returns `{ available, version?, error? }`.
     */
    static async probe(llmCfg) {
        const baseUrl = _baseUrl(llmCfg);
        if (!baseUrl)
            return { available: false, error: 'no base URL configured', code: 'LLM_PROBE_FAILED' };
        try {
            const res = await fetch(`${baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                return { available: false, error: `http_${res.status}`, code: 'LLM_PROBE_FAILED' };
            }
            const body = await res.json();
            const version = body?.models?.length > 0 ? `${body.models.length} models` : 'unknown';
            return { available: true, version };
        } catch (e) {
            return { available: false, error: e?.message || String(e), code: 'LLM_NETWORK_ERROR' };
        }
    }

    constructor(llmCfg) {
        super();
        this._baseUrl = _baseUrl(llmCfg);
        this._model = resolveLlmKey('ollama', 'model', llmCfg) || 'qwen3-vl:235b-cloud';
        this._embedModel = resolveLlmKey('ollama', 'embedModel', llmCfg) || 'nomic-embed-text';
        const visionOverride = resolveLlmKey('ollama', 'supportsVision', llmCfg);
        this._supportsVisionOverride =
            visionOverride === true ? true : visionOverride === false ? false : null;
        const defaults = llmCfg?.defaults || {};
        this._temperature = Number.isFinite(defaults.temperature) ? defaults.temperature : 0.7;
        this._maxTokens = Number.isFinite(defaults.maxTokens) ? defaults.maxTokens : 512;
    }

    get supportsVision() {
        if (this._supportsVisionOverride !== null) return this._supportsVisionOverride;
        // Regex matches known vision-model naming patterns:
        //   -vl      → qwen-vl, deepseek-vl, internvl
        //   vision   → llava-vision, bakllava
        //   llava    → llava, bakllava
        //   moondream, cogvlm, minicpm-v
        return /vision|llava|moondream|cogvlm|minicpm-v|-vl(?:[:._-]|$)/i.test(this._model);
    }

    async generate(opts) {
        const { prompt, systemPrompt, model, temperature, maxTokens, signal } = opts;
        const url = `${this._baseUrl}/v1/chat/completions`;
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const body = {
            model: model || this._model,
            messages,
            temperature: temperature ?? this._temperature,
            max_tokens: maxTokens ?? this._maxTokens,
            stream: false,
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: signal || AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`Ollama generate failed (${res.status}): ${errBody.slice(0, 500)}`);
        }

        const data = await res.json();
        const choice = data?.choices?.[0];
        return {
            text: choice?.message?.content || '',
            finishReason: choice?.finish_reason || 'stop',
        };
    }

    async chat(opts) {
        const { messages, model, temperature, maxTokens, signal } = opts;
        const url = `${this._baseUrl}/v1/chat/completions`;

        const body = {
            model: model || this._model,
            messages,
            temperature: temperature ?? this._temperature,
            max_tokens: maxTokens ?? this._maxTokens,
            stream: false,
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: signal || AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`Ollama chat failed (${res.status}): ${errBody.slice(0, 500)}`);
        }

        const data = await res.json();
        const choice = data?.choices?.[0];
        return {
            text: choice?.message?.content || '',
            finishReason: choice?.finish_reason || 'stop',
        };
    }

    async embed(opts) {
        const texts = Array.isArray(opts.texts) ? opts.texts : [opts.texts];
        if (!texts.length) return [];

        const url = `${this._baseUrl}/v1/embeddings`;
        const body = {
            model: this._embedModel,
            input: texts,
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
            return null;
        }

        const data = await res.json();
        if (!Array.isArray(data?.data)) return null;
        return data.data.map((d) => d.embedding);
    }
}

function _baseUrl(llmCfg) {
    const raw = resolveLlmKey('ollama', 'baseUrl', llmCfg) || 'http://localhost:11434';
    return raw.replace(/\/+$/, '');
}
