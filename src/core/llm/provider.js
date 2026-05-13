/**
 * LLM provider base class.
 *
 * Every provider extends this class and implements the static + instance
 * contract below. The registry probes each provider at boot and selects
 * the one matching `config.advanced.ai.llm.provider`.
 *
 * @interface
 */
export class LLMProvider {
    /**
     * Unique provider identifier (e.g. `'ollama'`, `'openai'`, `'anthropic'`).
     * Used as the value for `config.advanced.ai.llm.provider`.
     * @type {string}
     */
    static id = '__abstract__';

    /**
     * Human-readable label for the UI provider selector.
     * @type {string}
     */
    static label = 'Abstract';

    /**
     * Probe whether this provider is available on the current host.
     * Called once at boot. Should not throw — return `{ available, version?, error? }`.
     *
     * @param {object} llmCfg  resolved llm config snapshot
     * @returns {Promise<{ available: boolean, version?: string, error?: string }>}
     */
    static async probe(llmCfg) {
        throw new Error('not implemented');
    }

    /**
     * Generate text (completion-style).
     *
     * @param {object} opts
     * @param {string} opts.prompt         the user prompt
     * @param {string} [opts.systemPrompt] optional system prompt
     * @param {string} [opts.model]        model override (provider default otherwise)
     * @param {number} [opts.temperature]  temperature override
     * @param {number} [opts.maxTokens]    max tokens override
     * @param {AbortSignal} [opts.signal]  abort signal
     * @returns {Promise<{ text: string, finishReason?: string }>}
     */
    async generate(opts) {
        throw new Error('not implemented');
    }

    /**
     * Chat-style interaction (array of messages).
     *
     * @param {object} opts
     * @param {Array<{ role: string, content: string }>} opts.messages
     * @param {string} [opts.model]
     * @param {number} [opts.temperature]
     * @param {number} [opts.maxTokens]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{ text: string, finishReason?: string }>}
     */
    async chat(opts) {
        throw new Error('not implemented');
    }

    /**
     * Embed text into a vector. Optional — providers that don't support
     * embeddings (e.g. pure chat models) should return `null`.
     *
     * @param {object} opts
     * @param {string|string[]} opts.texts  single string or array of strings
     * @returns {Promise<number[][]|null>}  array of embeddings, or null if unsupported
     */
    async embed(opts) {
        return null;
    }

    /**
     * Provider is vision-capable (can accept images in chat messages).
     * Override to return `true` in vision-capable providers.
     * @returns {boolean}
     */
    get supportsVision() {
        return false;
    }
}
