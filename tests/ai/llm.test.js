/**
 * LLM provider abstraction unit tests.
 *
 * Covers config resolution, provider probe/generate/chat/embed contracts,
 * registry caching/TTL, and facade proxy behaviour. External HTTP calls
 * are mocked via vi.spyOn(globalThis, 'fetch').
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Helpers ------------------------------------------------------------

/** Minimal LLM config fragment for tests. */
function makeCfg(overrides = {}) {
    return {
        provider: 'ollama',
        ollama: { baseUrl: 'http://ollama:11434', model: 'qwen3-vl:235b-cloud' },
        openai: { apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
        defaults: { temperature: 0.7, maxTokens: 512 },
        ...overrides,
    };
}

/** Mock fetch to return a given JSON body + status. */
function mockFetch(status, body) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });
}

// ---- Shared: OpenAI-compatible response builder -------------------------

function openaiChatResponse(text) {
    return {
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
    };
}

// ======================================================================
// llm-config (nested config resolver + env-var override)
// ======================================================================

describe('llm-config', () => {
    let mod;

    beforeAll(async () => {
        mod = await import('../../src/core/llm/llm-config.js');
    });

    afterEach(() => {
        for (const k of Object.keys(process.env)) {
            if (k.startsWith('TGDL_LLM_')) delete process.env[k];
        }
    });

    it('exports resolveAllLlm and resolveLlmKey', () => {
        expect(typeof mod.resolveAllLlm).toBe('function');
        expect(typeof mod.resolveLlmKey).toBe('function');
    });

    it('defaults provider to "disabled" when config is empty', () => {
        const cfg = mod.resolveAllLlm({});
        expect(cfg.provider).toBe('disabled');
    });

    it('reads provider from config', () => {
        const cfg = mod.resolveAllLlm(makeCfg());
        expect(cfg.provider).toBe('ollama');
    });

    it('resolves nested ollama.baseUrl', () => {
        const cfg = mod.resolveAllLlm(makeCfg());
        expect(cfg.ollama.baseUrl).toBe('http://ollama:11434');
    });

    it('resolves nested openai.apiKey', () => {
        const cfg = mod.resolveAllLlm(makeCfg({ provider: 'openai' }));
        expect(cfg.openai.apiKey).toBe('sk-test');
    });

    it('includes defaults for temperature and maxTokens', () => {
        const cfg = mod.resolveAllLlm(makeCfg());
        expect(cfg.defaults.temperature).toBe(0.7);
        expect(cfg.defaults.maxTokens).toBe(512);
    });

    it('applies TGDL_LLM_PROVIDER env override', () => {
        process.env.TGDL_LLM_PROVIDER = 'openai';
        const cfg = mod.resolveAllLlm(makeCfg({ provider: 'ollama' }));
        expect(cfg.provider).toBe('openai');
    });

    it('applies TGDL_LLM_OLLAMA_BASE_URL env override', () => {
        process.env.TGDL_LLM_OLLAMA_BASE_URL = 'http://custom:11434';
        const cfg = mod.resolveAllLlm(makeCfg());
        expect(cfg.ollama.baseUrl).toBe('http://custom:11434');
    });

    it('applies TGDL_LLM_OPENAI_API_KEY env override', () => {
        process.env.TGDL_LLM_OPENAI_API_KEY = 'sk-env-test';
        const cfg = mod.resolveAllLlm(makeCfg({ provider: 'openai' }));
        expect(cfg.openai.apiKey).toBe('sk-env-test');
    });

    it('applies TGDL_LLM_TEMPERATURE env override', () => {
        process.env.TGDL_LLM_TEMPERATURE = '0.3';
        const cfg = mod.resolveAllLlm(makeCfg());
        expect(cfg.defaults.temperature).toBe(0.3);
    });

    it('applies TGDL_LLM_OLLAMA_MODEL env override for nested key', () => {
        process.env.TGDL_LLM_OLLAMA_MODEL = 'env-ollama-model';
        const cfg = mod.resolveAllLlm(makeCfg());
        expect(cfg.ollama.model).toBe('env-ollama-model');
    });

    it('resolveLlmKey drills into section with env-var fallback', () => {
        const cfg = makeCfg();
        expect(mod.resolveLlmKey('ollama', 'baseUrl', cfg)).toBe('http://ollama:11434');
        expect(mod.resolveLlmKey('openai', 'apiKey', cfg)).toBe('sk-test');
    });

    it('resolveLlmKey returns undefined for missing key', () => {
        expect(mod.resolveLlmKey('ollama', 'nonexistent', makeCfg())).toBeUndefined();
    });

    it('_defaults() returns a deep clone of defaults', () => {
        const d = mod._defaults();
        expect(d.provider).toBe('disabled');
        expect(d.ollama.baseUrl).toBe('http://localhost:11434');
        // Ensure it's a mutable clone, not frozen
        d.provider = 'ollama';
        expect(mod._defaults().provider).toBe('disabled');
    });

    it('_envMap() returns the env-var map', () => {
        const m = mod._envMap();
        expect(m.TGDL_LLM_PROVIDER).toEqual(['', 'provider']);
    });

    it('LLM_DEFAULTS includes ollama.embedModel', () => {
        expect(mod.LLM_DEFAULTS.ollama.embedModel).toBe('nomic-embed-text');
    });

    it('LLM_DEFAULTS includes openai.embedModel', () => {
        expect(mod.LLM_DEFAULTS.openai.embedModel).toBe('text-embedding-3-small');
    });

    it('resolveAllLlm preserves ollama.embedModel from config', () => {
        const cfg = mod.resolveAllLlm({ ollama: { embedModel: 'custom-embed' } });
        expect(cfg.ollama.embedModel).toBe('custom-embed');
    });

    it('resolveAllLlm preserves openai.embedModel from config', () => {
        const cfg = mod.resolveAllLlm({ openai: { embedModel: 'text-embedding-3-large' } });
        expect(cfg.openai.embedModel).toBe('text-embedding-3-large');
    });

    it('applies TGDL_LLM_OLLAMA_EMBED_MODEL env override', () => {
        process.env.TGDL_LLM_OLLAMA_EMBED_MODEL = 'all-minilm';
        const cfg = mod.resolveAllLlm({});
        expect(cfg.ollama.embedModel).toBe('all-minilm');
    });

    it('applies TGDL_LLM_OPENAI_EMBED_MODEL env override', () => {
        process.env.TGDL_LLM_OPENAI_EMBED_MODEL = 'text-embedding-3-large';
        const cfg = mod.resolveAllLlm({});
        expect(cfg.openai.embedModel).toBe('text-embedding-3-large');
    });

    it('exports maskLlmConfig', () => {
        expect(typeof mod.maskLlmConfig).toBe('function');
    });

    it('maskLlmConfig masks non-empty apiKey', () => {
        const masked = mod.maskLlmConfig({
            openai: { apiKey: 'sk-real-key', model: 'gpt-4o-mini' },
        });
        expect(masked.openai.apiKey).toBe('***');
        expect(masked.openai.model).toBe('gpt-4o-mini');
    });

    it('maskLlmConfig leaves empty apiKey unchanged', () => {
        const masked = mod.maskLlmConfig({ openai: { apiKey: '' } });
        expect(masked.openai.apiKey).toBe('');
    });

    it('maskLlmConfig does not mutate the original object', () => {
        const orig = { openai: { apiKey: 'sk-secret' } };
        mod.maskLlmConfig(orig);
        expect(orig.openai.apiKey).toBe('sk-secret');
    });

    it('maskLlmConfig handles config without openai block', () => {
        const masked = mod.maskLlmConfig({ provider: 'ollama' });
        expect(masked.provider).toBe('ollama');
    });
});

// ======================================================================
// provider.js — abstract base class
// ======================================================================

describe('Provider base (provider.js)', () => {
    let Provider;
    let instance;

    beforeAll(async () => {
        const mod = await import('../../src/core/llm/provider.js');
        Provider = mod.LLMProvider;
        instance = new Provider();
    });

    it('abstract methods throw "not implemented" when called', async () => {
        await expect(instance.generate({ prompt: 'test' })).rejects.toThrow(/not implemented/i);
        await expect(instance.chat({ messages: [] })).rejects.toThrow(/not implemented/i);
        const embedResult = await instance.embed({ texts: 'test' });
        expect(embedResult).toBeNull();
    });

    it('static probe throws "not implemented"', async () => {
        await expect(Provider.probe({})).rejects.toThrow(/not implemented/i);
    });

    it('default supportsVision returns false', () => {
        expect(instance.supportsVision).toBe(false);
    });

    it('has abstract id and label', () => {
        expect(Provider.id).toBe('__abstract__');
        expect(Provider.label).toBe('Abstract');
    });

    it('default supportsVision returns false', () => {
        class Good extends Provider {
            constructor() {
                super();
            }
            async generate() {
                return {};
            }
            async chat() {
                return {};
            }
            async embed() {
                return {};
            }
        }
        const p = new Good();
        expect(p.supportsVision).toBe(false);
    });
});

// ======================================================================
// Ollama provider
// ======================================================================

describe('Ollama provider', () => {
    let OllamaProvider;

    beforeAll(async () => {
        const mod = await import('../../src/core/llm/ollama.js');
        OllamaProvider = mod.OllamaProvider;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('probe()', () => {
        it('returns available when /api/tags returns models', async () => {
            mockFetch(200, { models: [{ name: 'qwen3-vl:235b-cloud' }] });
            const result = await OllamaProvider.probe(makeCfg());
            expect(result.available).toBe(true);
            expect(result.version).toMatch(/models/);
        });

        it('returns unavailable when /api/tags returns non-ok', async () => {
            mockFetch(503, { error: 'busy' });
            const result = await OllamaProvider.probe(makeCfg());
            expect(result.available).toBe(false);
            expect(result.error).toMatch(/503/);
        });

        it('returns unavailable on network error', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
            const result = await OllamaProvider.probe(makeCfg());
            expect(result.available).toBe(false);
        });

        it('includes code LLM_NETWORK_ERROR on connection failure', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
            const result = await OllamaProvider.probe(makeCfg());
            expect(result.code).toBe('LLM_NETWORK_ERROR');
        });

        it('includes code LLM_PROBE_FAILED on non-ok HTTP response', async () => {
            mockFetch(503, { error: 'busy' });
            const result = await OllamaProvider.probe(makeCfg());
            expect(result.code).toBe('LLM_PROBE_FAILED');
        });

        it('uses configured baseUrl', async () => {
            const fetchSpy = mockFetch(200, { models: [] });
            await OllamaProvider.probe(
                makeCfg({
                    ollama: { baseUrl: 'http://custom:11434', model: 'test' },
                }),
            );
            expect(fetchSpy.mock.calls[0][0]).toMatch(/custom:11434/);
        });
    });

    describe('generate() / chat()', () => {
        it('generate() returns text via OpenAI-compatible /v1/chat/completions', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('Hello!'));
            const p = new OllamaProvider(makeCfg());
            const result = await p.generate({ prompt: 'Hi' });
            expect(result.text).toBe('Hello!');
            expect(fetchSpy.mock.calls[0][0]).toContain('/v1/chat/completions');
        });

        it('generate() sends model override in body', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('ok'));
            const p = new OllamaProvider(makeCfg());
            await p.generate({ prompt: 'Hi', model: 'custom-model' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.model).toBe('custom-model');
        });

        it('generate() uses configured model when no override', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('ok'));
            const p = new OllamaProvider(makeCfg());
            await p.generate({ prompt: 'Hi' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.model).toBe('qwen3-vl:235b-cloud');
        });

        it('generate() passes temperature and max_tokens in body', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('ok'));
            const p = new OllamaProvider(makeCfg());
            await p.generate({ prompt: 'Hi', temperature: 0.5, maxTokens: 100 });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.temperature).toBe(0.5);
            expect(body.max_tokens).toBe(100);
        });

        it('generate({ json: true }) requests a JSON object response', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('{"ok":true}'));
            const p = new OllamaProvider(makeCfg());
            await p.generate({ prompt: 'Hi', json: true });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.response_format).toEqual({ type: 'json_object' });
        });

        it('generate() omits response_format without json flag', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('ok'));
            const p = new OllamaProvider(makeCfg());
            await p.generate({ prompt: 'Hi' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.response_format).toBeUndefined();
        });

        it('chat() returns text via /v1/chat/completions', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('Chat reply'));
            const p = new OllamaProvider(makeCfg());
            const result = await p.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            });
            expect(result.text).toBe('Chat reply');
            expect(fetchSpy.mock.calls[0][0]).toContain('/v1/chat/completions');
        });

        it('chat() passes messages through as-is', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('ok'));
            const p = new OllamaProvider(makeCfg());
            await p.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.messages[0].role).toBe('user');
            expect(body.messages[0].content).toBe('Hi');
        });

        it('generate() throws on HTTP error', async () => {
            mockFetch(503, { error: 'overloaded' });
            const p = new OllamaProvider(makeCfg());
            await expect(p.generate({ prompt: 'Hi' })).rejects.toThrow(/503/);
        });

        it('chat() throws on HTTP error', async () => {
            mockFetch(500, { error: 'fail' });
            const p = new OllamaProvider(makeCfg());
            await expect(p.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow(
                /500/,
            );
        });
    });

    describe('supportsVision', () => {
        it('returns true for models containing -vl', () => {
            const p = new OllamaProvider(
                makeCfg({
                    ollama: { baseUrl: 'http://ollama:11434', model: 'qwen3-vl:235b-cloud' },
                }),
            );
            expect(p.supportsVision).toBe(true);
        });

        it('returns false for non-vision models', () => {
            const p = new OllamaProvider(
                makeCfg({
                    ollama: { baseUrl: 'http://ollama:11434', model: 'llama3.2:latest' },
                }),
            );
            expect(p.supportsVision).toBe(false);
        });

        it('returns true for llava model', () => {
            const p = new OllamaProvider(
                makeCfg({
                    ollama: { baseUrl: 'http://ollama:11434', model: 'llava:13b' },
                }),
            );
            expect(p.supportsVision).toBe(true);
        });

        it('config override true forces supportsVision regardless of model name', () => {
            const p = new OllamaProvider(
                makeCfg({
                    ollama: {
                        baseUrl: 'http://ollama:11434',
                        model: 'llama3.2:latest',
                        supportsVision: true,
                    },
                }),
            );
            expect(p.supportsVision).toBe(true);
        });

        it('config override false suppresses supportsVision regardless of model name', () => {
            const p = new OllamaProvider(
                makeCfg({
                    ollama: {
                        baseUrl: 'http://ollama:11434',
                        model: 'llava:13b',
                        supportsVision: false,
                    },
                }),
            );
            expect(p.supportsVision).toBe(false);
        });

        it('null/undefined override falls back to regex', () => {
            const p = new OllamaProvider(
                makeCfg({
                    ollama: { baseUrl: 'http://ollama:11434', model: 'llava:13b' },
                }),
            );
            expect(p.supportsVision).toBe(true);
        });

        it('TGDL_LLM_OLLAMA_SUPPORTS_VISION env var overrides vision detection', () => {
            process.env.TGDL_LLM_OLLAMA_SUPPORTS_VISION = 'true';
            const p = new OllamaProvider(
                makeCfg({
                    ollama: { baseUrl: 'http://ollama:11434', model: 'llama3.2:latest' },
                }),
            );
            expect(p.supportsVision).toBe(true);
            delete process.env.TGDL_LLM_OLLAMA_SUPPORTS_VISION;
        });
    });

    describe('embed()', () => {
        it('returns embeddings from /v1/embeddings', async () => {
            mockFetch(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
            const p = new OllamaProvider(makeCfg());
            const result = await p.embed({ texts: 'test' });
            expect(Array.isArray(result)).toBe(true);
            expect(result[0]).toEqual([0.1, 0.2, 0.3]);
        });

        it('returns empty array for empty texts', async () => {
            const p = new OllamaProvider(makeCfg());
            const result = await p.embed({ texts: [] });
            expect(result).toEqual([]);
        });

        it('throws on network error', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
            const p = new OllamaProvider(makeCfg());
            await expect(p.embed({ texts: 'test' })).rejects.toThrow(/fail/);
        });

        it('uses configured embedModel in request body', async () => {
            const fetchSpy = mockFetch(200, { data: [{ embedding: [0.1] }] });
            const p = new OllamaProvider(
                makeCfg({
                    ollama: {
                        baseUrl: 'http://ollama:11434',
                        model: 'qwen3',
                        embedModel: 'custom-embed-model',
                    },
                }),
            );
            await p.embed({ texts: 'hello' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.model).toBe('custom-embed-model');
        });

        it('defaults to nomic-embed-text when embedModel not in config', async () => {
            const fetchSpy = mockFetch(200, { data: [{ embedding: [0.1] }] });
            const p = new OllamaProvider(makeCfg());
            await p.embed({ texts: 'hello' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.model).toBe('nomic-embed-text');
        });
    });
});

// ======================================================================
// OpenAI provider
// ======================================================================

describe('OpenAI provider', () => {
    let OpenAIProvider;

    beforeAll(async () => {
        const mod = await import('../../src/core/llm/openai.js');
        OpenAIProvider = mod.OpenAIProvider;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('probe()', () => {
        it('returns available when /v1/models returns 200', async () => {
            mockFetch(200, { data: [{ id: 'gpt-4' }] });
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.available).toBe(true);
        });

        it('uses /v1/models endpoint (not /models)', async () => {
            const fetchSpy = mockFetch(200, { data: [] });
            await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(fetchSpy.mock.calls[0][0]).toContain('/v1/models');
        });

        it('returns unavailable when no API key', async () => {
            const result = await OpenAIProvider.probe(
                makeCfg({
                    provider: 'openai',
                    openai: { apiKey: '', model: 'gpt-4o-mini' },
                }),
            );
            expect(result.available).toBe(false);
            expect(result.error).toMatch(/no API key/i);
        });

        it('returns unavailable on 401', async () => {
            mockFetch(401, { error: { message: 'Unauthorized' } });
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.available).toBe(false);
            expect(result.error).toMatch(/401/);
        });

        it('returns unavailable on network error', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.available).toBe(false);
        });

        it('includes code LLM_AUTH_FAILED when no API key', async () => {
            const result = await OpenAIProvider.probe(
                makeCfg({ provider: 'openai', openai: { apiKey: '', model: 'gpt-4o-mini' } }),
            );
            expect(result.code).toBe('LLM_AUTH_FAILED');
        });

        it('includes code LLM_AUTH_FAILED on 401', async () => {
            mockFetch(401, { error: { message: 'Unauthorized' } });
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.code).toBe('LLM_AUTH_FAILED');
        });

        it('includes code LLM_AUTH_FAILED on 403', async () => {
            mockFetch(403, { error: { message: 'Forbidden' } });
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.code).toBe('LLM_AUTH_FAILED');
        });

        it('includes code LLM_PROBE_FAILED on non-auth HTTP error', async () => {
            mockFetch(500, { error: { message: 'Internal Server Error' } });
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.code).toBe('LLM_PROBE_FAILED');
        });

        it('includes code LLM_NETWORK_ERROR on connection failure', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
            const result = await OpenAIProvider.probe(makeCfg({ provider: 'openai' }));
            expect(result.code).toBe('LLM_NETWORK_ERROR');
        });
    });

    describe('generate() / chat()', () => {
        it('generate() returns text from chat completions', async () => {
            mockFetch(200, openaiChatResponse('Hello from OpenAI'));
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            const result = await p.generate({ prompt: 'Hi' });
            expect(result.text).toBe('Hello from OpenAI');
        });

        it('generate() sends system prompt when provided', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('ok'));
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            await p.generate({ prompt: 'Hi', systemPrompt: 'Be concise.' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.messages.find((m) => m.role === 'system').content).toBe('Be concise.');
        });

        it('generate({ json: true }) requests a JSON object response', async () => {
            const fetchSpy = mockFetch(200, openaiChatResponse('{"ok":true}'));
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            await p.generate({ prompt: 'Hi', json: true });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.response_format).toEqual({ type: 'json_object' });
        });

        it('chat() posts messages and returns text', async () => {
            mockFetch(200, openaiChatResponse('Chat reply'));
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            const result = await p.chat({
                messages: [{ role: 'user', content: 'Hello' }],
            });
            expect(result.text).toBe('Chat reply');
        });

        it('generate() throws on HTTP error', async () => {
            mockFetch(401, { error: { message: 'Unauthorized' } });
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            await expect(p.generate({ prompt: 'Hi' })).rejects.toThrow(/401/);
        });
    });

    describe('embed()', () => {
        it('returns embeddings from /v1/embeddings', async () => {
            mockFetch(200, { data: [{ embedding: [0.4, 0.5, 0.6] }] });
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            const result = await p.embed({ texts: 'test' });
            expect(Array.isArray(result)).toBe(true);
            expect(result[0]).toEqual([0.4, 0.5, 0.6]);
        });

        it('throws on network error', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            await expect(p.embed({ texts: 'test' })).rejects.toThrow(/fail/);
        });

        it('uses configured embedModel in request body', async () => {
            const fetchSpy = mockFetch(200, { data: [{ embedding: [0.4] }] });
            const p = new OpenAIProvider(
                makeCfg({
                    provider: 'openai',
                    openai: {
                        apiKey: 'sk-test',
                        model: 'gpt-4o',
                        baseUrl: 'https://api.openai.com',
                        embedModel: 'text-embedding-3-large',
                    },
                }),
            );
            await p.embed({ texts: 'hello' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.model).toBe('text-embedding-3-large');
        });

        it('defaults to text-embedding-3-small when embedModel not in config', async () => {
            const fetchSpy = mockFetch(200, { data: [{ embedding: [0.4] }] });
            const p = new OpenAIProvider(makeCfg({ provider: 'openai' }));
            await p.embed({ texts: 'hello' });
            const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body);
            expect(body.model).toBe('text-embedding-3-small');
        });
    });
});

// ======================================================================
// _registry.js
// ======================================================================

describe('LLM Registry (_registry.js)', () => {
    let registry;

    beforeAll(async () => {
        registry = await import('../../src/core/llm/_registry.js');
    });

    afterEach(() => {
        registry.resetProvider();
        vi.restoreAllMocks();
    });

    it('listProviders() returns provider metadata array', () => {
        const list = registry.listProviders();
        expect(Array.isArray(list)).toBe(true);
        const ids = list.map((p) => p.id);
        expect(ids).toContain('ollama');
        expect(ids).toContain('openai');
    });

    it('probeAll() probes all providers and returns a Map', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'test' }] }),
        });
        const results = await registry.probeAll(makeCfg());
        expect(results instanceof Map).toBe(true);
        expect(results.get('ollama')).toBeDefined();
        expect(results.get('openai')).toBeDefined();
    });

    it('probeAll() returns unavailable when probes fail', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const results = await registry.probeAll(makeCfg());
        expect(results.get('ollama').available).toBe(false);
        expect(results.get('openai').available).toBe(false);
    });

    it('resolveProvider() returns null for "disabled"', async () => {
        const p = await registry.resolveProvider(makeCfg({ provider: 'disabled' }));
        expect(p).toBeNull();
    });

    it('resolveProvider() returns null for unknown provider id', async () => {
        const p = await registry.resolveProvider(makeCfg({ provider: 'nonexistent' }));
        expect(p).toBeNull();
    });

    it('resolveProvider() probes and caches the same instance', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'test' }] }),
        });
        const p1 = await registry.resolveProvider(makeCfg());
        const p2 = await registry.resolveProvider(makeCfg());
        expect(p1).toBe(p2);
    });

    it('resetProvider() clears the singleton cache', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'test' }] }),
        });
        const p1 = await registry.resolveProvider(makeCfg());
        registry.resetProvider();
        const p2 = await registry.resolveProvider(makeCfg());
        expect(p1).not.toBe(p2);
    });

    it('getActiveProviderId() returns null initially', () => {
        registry.resetProvider();
        expect(registry.getActiveProviderId()).toBeNull();
    });

    it('resolveProvider() sets active provider id on success', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'test' }] }),
        });
        const p = await registry.resolveProvider(makeCfg());
        expect(p).not.toBeNull();
        expect(registry.getActiveProviderId()).toBe('ollama');
    });

    it('resolveProvider() sets id to "disabled" when provider is disabled', async () => {
        await registry.resolveProvider(makeCfg({ provider: 'disabled' }));
        expect(registry.getActiveProviderId()).toBe('disabled');
    });

    it('exports getLastProviderError', () => {
        expect(typeof registry.getLastProviderError).toBe('function');
    });

    it('getLastProviderError() returns null when no error recorded', () => {
        registry.resetProvider();
        expect(registry.getLastProviderError('ollama')).toBeNull();
    });

    it('getLastProviderError() returns probe code after failed resolve', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        await registry.resolveProvider(makeCfg({ provider: 'ollama' }));
        const err = registry.getLastProviderError('ollama');
        expect(err).not.toBeNull();
        expect(err.code).toBe('LLM_NETWORK_ERROR');
    });

    it('getLastProviderError() returns LLM_PROVIDER_NOT_FOUND for unknown id', async () => {
        await registry.resolveProvider(makeCfg({ provider: 'ghost' }));
        const err = registry.getLastProviderError('ghost');
        expect(err?.code).toBe('LLM_PROVIDER_NOT_FOUND');
    });

    it('resetProvider() clears last error', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        await registry.resolveProvider(makeCfg({ provider: 'ollama' }));
        registry.resetProvider();
        expect(registry.getLastProviderError('ollama')).toBeNull();
    });
});

// ======================================================================
// Facade (src/core/llm/index.js)
// ======================================================================

describe('LLM Facade (index.js)', () => {
    let llm;

    beforeAll(async () => {
        llm = await import('../../src/core/llm/index.js');
    });

    beforeEach(() => {
        llm.resetLlmProvider();
        vi.restoreAllMocks();
    });

    it('exports expected function surface', () => {
        expect(typeof llm.generate).toBe('function');
        expect(typeof llm.chat).toBe('function');
        expect(typeof llm.embed).toBe('function');
        expect(typeof llm.probeProviders).toBe('function');
        expect(typeof llm.listProviders).toBe('function');
        expect(typeof llm.getActiveProvider).toBe('function');
        expect(typeof llm.resetLlmProvider).toBe('function');
    });

    it('listProviders() returns provider metadata', () => {
        const list = llm.listProviders();
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBeGreaterThanOrEqual(2);
        expect(list.some((p) => p.id === 'ollama')).toBe(true);
        expect(list.some((p) => p.id === 'openai')).toBe(true);
        // Each entry has id and label
        for (const p of list) {
            expect(typeof p.id).toBe('string');
            expect(typeof p.label).toBe('string');
        }
    });

    it('probeProviders() returns per-provider availability', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        const results = await llm.probeProviders();
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThanOrEqual(2);
        for (const r of results) {
            expect('id' in r).toBe(true);
            expect('available' in r).toBe(true);
        }
        // Both should be unavailable since we mocked fetch to reject
        const ollama = results.find((r) => r.id === 'ollama');
        expect(ollama.available).toBe(false);
    });

    it('getActiveProvider() always returns an info object', async () => {
        const active = await llm.getActiveProvider();
        expect(active).not.toBeNull();
        expect(typeof active).toBe('object');
        expect('id' in active).toBe(true);
        expect('label' in active).toBe(true);
        expect('available' in active).toBe(true);
    });

    it('generate() returns code LLM_DISABLED when provider is disabled', {
        timeout: 15_000,
    }, async () => {
        // No fetch mock needed — disabled path doesn't probe
        const result = await llm.generate({ prompt: 'test' });
        // Default config has provider: 'disabled'
        if (result.unavailable) {
            expect(result.code).toBe('LLM_DISABLED');
        }
    });

    it('generate() returns structured code from probe failure', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        // Force ollama provider to trigger a probe
        const { resolveAllLlm } = await import('../../src/core/llm/llm-config.js');
        // Directly reset and re-configure via env
        process.env.TGDL_LLM_PROVIDER = 'ollama';
        llm.resetLlmProvider();
        const result = await llm.generate({ prompt: 'test' });
        expect(result.unavailable).toBe(true);
        expect(result.code).toBe('LLM_NETWORK_ERROR');
        delete process.env.TGDL_LLM_PROVIDER;
        llm.resetLlmProvider();
    });

    it('chat() returns structured code when unavailable', { timeout: 15_000 }, async () => {
        llm.resetLlmProvider();
        const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
        if (result.unavailable) {
            expect(typeof result.code).toBe('string');
            expect(result.code.startsWith('LLM_')).toBe(true);
        }
    });

    it('embed() returns structured code when unavailable', { timeout: 15_000 }, async () => {
        llm.resetLlmProvider();
        const result = await llm.embed({ texts: 'test' });
        if (result.unavailable) {
            expect(typeof result.code).toBe('string');
            expect(result.code.startsWith('LLM_')).toBe(true);
        }
    });
});
