/**
 * OpenAI provider — uses the OpenAI REST API (or any OpenAI-compatible
 * endpoint, e.g. Azure OpenAI, LiteLLM, or a local proxy).
 *
 * https://platform.openai.com/docs/api-reference/chat
 *
 * Config expected shape (from `config.advanced.ai.llm.openai`):
 *   apiKey:  string  (also reads OPENAI_API_KEY env var)
 *   model:   string  (default 'gpt-4o-mini')
 *   baseUrl: string  (also reads OPENAI_BASE_URL env var; default 'https://api.openai.com')
 */

import { LLMProvider } from './provider.js';
import { resolveLlmKey } from './llm-config.js';

export class OpenAIProvider extends LLMProvider {
    static id = 'openai';
    static label = 'OpenAI / Azure';

    static async probe(llmCfg) {
        const apiKey = _apiKey(llmCfg);
        if (!apiKey) {
            return { available: false, error: 'no API key configured', code: 'LLM_AUTH_FAILED' };
        }
        const baseUrl = _baseUrl(llmCfg);
        try {
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                const code =
                    res.status === 401 || res.status === 403
                        ? 'LLM_AUTH_FAILED'
                        : 'LLM_PROBE_FAILED';
                return { available: false, error: `http_${res.status}`, code };
            }
            return { available: true, version: 'api' };
        } catch (e) {
            return { available: false, error: e?.message || String(e), code: 'LLM_NETWORK_ERROR' };
        }
    }

    constructor(llmCfg) {
        super();
        this._apiKey = _apiKey(llmCfg);
        this._baseUrl = _baseUrl(llmCfg);
        this._model = resolveLlmKey('openai', 'model', llmCfg) || 'gpt-4o-mini';
        this._embedModel =
            resolveLlmKey('openai', 'embedModel', llmCfg) || 'text-embedding-3-small';
        const defaults = llmCfg?.defaults || {};
        this._temperature = Number.isFinite(defaults.temperature) ? defaults.temperature : 0.7;
        this._maxTokens = Number.isFinite(defaults.maxTokens) ? defaults.maxTokens : 512;
    }

    get supportsVision() {
        return /gpt-4o|gpt-4-vision|gpt-4-turbo/i.test(this._model);
    }

    async generate(opts) {
        const { prompt, systemPrompt, model, temperature, maxTokens, signal, json } = opts;
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        let content = prompt;
        if (opts.images && opts.images.length > 0) {
            content = [{ type: 'text', text: prompt }];
            for (const img of opts.images) {
                const url = img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`;
                content.push({ type: 'image_url', image_url: { url } });
            }
        }
        messages.push({ role: 'user', content });

        return this._chat(messages, {
            model: model || this._model,
            temperature,
            maxTokens,
            signal,
            json,
        });
    }

    async chat(opts) {
        const { messages, model, temperature, maxTokens, signal, json } = opts;
        return this._chat(messages, {
            model: model || this._model,
            temperature,
            maxTokens,
            signal,
            json,
        });
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
            headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${this._apiKey}`,
            },
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

    async _chat(messages, { model, temperature, maxTokens, signal, json }) {
        const url = `${this._baseUrl}/v1/chat/completions`;

        const body = {
            model,
            messages,
            temperature: temperature ?? this._temperature,
            max_tokens: maxTokens ?? this._maxTokens,
        };
        // Constrained decoding — the model can only emit valid JSON, so
        // callers that parse the reply skip the markdown-fence cleanup.
        if (json) body.response_format = { type: 'json_object' };

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${this._apiKey}`,
            },
            body: JSON.stringify(body),
            signal: signal || AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`OpenAI chat failed (${res.status}): ${errBody.slice(0, 500)}`);
        }

        const data = await res.json();
        const choice = data?.choices?.[0];
        return {
            text: choice?.message?.content || '',
            finishReason: choice?.finish_reason || 'stop',
        };
    }
}

function _apiKey(llmCfg) {
    return resolveLlmKey('openai', 'apiKey', llmCfg) || process.env.OPENAI_API_KEY || '';
}

function _baseUrl(llmCfg) {
    const raw =
        resolveLlmKey('openai', 'baseUrl', llmCfg) ||
        process.env.OPENAI_BASE_URL ||
        'https://api.openai.com';
    return raw.replace(/\/+$/, '');
}
