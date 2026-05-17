// Tests for tgdl-ml-client.js — pins the wire format, env var resolution,
// and response parsing so a future refactor can't silently break them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
    readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
}));

const ML_ENV_KEYS = [
    'TGDL_ML_URL',
    'TGDL_ML_PROVIDER',
    'TGDL_ML_CLIP_MODEL',
    'TGDL_ML_OCR_MODEL',
    'TGDL_ML_TIMEOUT_MS',
];

const ORIGINAL_ENV = { ...process.env };

function clearMlEnv() {
    for (const k of ML_ENV_KEYS) delete process.env[k];
}

const client = await import('../../src/core/ai/tgdl-ml-client.js');

beforeEach(() => {
    clearMlEnv();
    vi.restoreAllMocks();
});

afterEach(() => {
    clearMlEnv();
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('getTgdlMlUrl', () => {
    it('returns empty string when no env set', () => {
        clearMlEnv();
        expect(client.getTgdlMlUrl()).toBe('');
    });

    it('returns TGDL_ML_URL when set, stripping trailing slash', () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800/';
        expect(client.getTgdlMlUrl()).toBe('http://tgdl-ml:3800');
    });

    it('returns localhost default when TGDL_ML_PROVIDER=tgdl-ml and no URL', () => {
        process.env.TGDL_ML_PROVIDER = 'tgdl-ml';
        expect(client.getTgdlMlUrl()).toBe('http://localhost:3800');
    });

    it('returns empty string for unrecognised TGDL_ML_PROVIDER value', () => {
        process.env.TGDL_ML_PROVIDER = 'ollama';
        expect(client.getTgdlMlUrl()).toBe('');
    });
});

describe('isTgdlMlEnabled', () => {
    it('false when no env set', () => {
        expect(client.isTgdlMlEnabled()).toBe(false);
    });

    it('true when URL configured', () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        expect(client.isTgdlMlEnabled()).toBe(true);
    });
});

describe('resolveClipModelId', () => {
    it('returns tgdl-ml-prefixed model when sidecar enabled', () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        process.env.TGDL_ML_CLIP_MODEL = 'ViT-L-14__openai';
        expect(client.resolveClipModelId({})).toBe('tgdl-ml:ViT-L-14__openai');
    });

    it('falls back to cfg fields when sidecar disabled', () => {
        clearMlEnv();
        expect(client.resolveClipModelId({ searchModel: 'MyModel' })).toBe('MyModel');
        expect(client.resolveClipModelId({ model: 'Alt' })).toBe('Alt');
        expect(client.resolveClipModelId({ clipModel: 'ClipAlt' })).toBe('ClipAlt');
    });

    it('falls back to Xenova default when cfg empty and sidecar disabled', () => {
        clearMlEnv();
        expect(client.resolveClipModelId({})).toBe('Xenova/clip-vit-base-patch32');
    });
});

// ---------------------------------------------------------------------------
// mlEmbedImage
// ---------------------------------------------------------------------------

describe('mlEmbedImage', () => {
    it('POSTs to /embed-image with base64 body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        const embedding = Array.from({ length: 512 }, (_, i) => i / 512);

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ embedding, dim: 512, model: 'ViT-B-32__openai' }),
        });

        const result = await client.mlEmbedImage('/tmp/test.jpg');

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://tgdl-ml:3800/embed-image');
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(init.body);
        expect(typeof body.image_b64).toBe('string');
        expect(body.image_b64.length).toBeGreaterThan(0);

        expect(result.embedding).toHaveLength(512);
        expect(result.dim).toBe(512);
        expect(result.model).toBe('tgdl-ml:ViT-B-32__openai');
        expect(result.provider).toBe('tgdl-ml');
    });

    it('uses env model name when response omits model field', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        process.env.TGDL_ML_CLIP_MODEL = 'ViT-L-14__openai';
        const embedding = new Array(512).fill(0.1);

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ embedding, dim: 512 }),
        });

        const result = await client.mlEmbedImage('/tmp/test.jpg');
        expect(result.model).toBe('tgdl-ml:ViT-L-14__openai');
    });

    it('throws on HTTP error', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            text: async () =>
                JSON.stringify({ error: 'inference failed', code: 'embedding_failed' }),
        });

        await expect(client.mlEmbedImage('/tmp/test.jpg')).rejects.toThrow(
            'tgdl-ml HTTP 500: inference failed',
        );
    });

    it('throws when response embedding is missing', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ dim: 512 }),
        });

        await expect(client.mlEmbedImage('/tmp/test.jpg')).rejects.toThrow(
            '/embed-image response missing embedding',
        );
    });

    it('throws when URL not configured', async () => {
        clearMlEnv();
        await expect(client.mlEmbedImage('/tmp/test.jpg')).rejects.toThrow(
            'tgdl-ml URL is not configured',
        );
    });
});

// ---------------------------------------------------------------------------
// mlEmbedText
// ---------------------------------------------------------------------------

describe('mlEmbedText', () => {
    it('POSTs to /embed-text with text body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        const embedding = new Array(512).fill(0.5);

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ embedding, dim: 512, model: 'ViT-B-32__openai' }),
        });

        const result = await client.mlEmbedText('sunset over mountains');

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://tgdl-ml:3800/embed-text');
        expect(JSON.parse(init.body)).toEqual({ text: 'sunset over mountains' });

        expect(result.embedding).toHaveLength(512);
        expect(result.model).toBe('tgdl-ml:ViT-B-32__openai');
        expect(result.provider).toBe('tgdl-ml');
    });

    it('includes language when provided', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        const embedding = new Array(512).fill(0.1);

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ embedding, dim: 512, model: 'ViT-B-32__openai' }),
        });

        await client.mlEmbedText('hola mundo', { language: 'es' });

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.language).toBe('es');
    });

    it('omits language key when not provided', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        const embedding = new Array(512).fill(0.1);

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ embedding, dim: 512, model: 'ViT-B-32__openai' }),
        });

        await client.mlEmbedText('hello');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('language');
    });

    it('throws on missing embedding in response', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({}),
        });

        await expect(client.mlEmbedText('test')).rejects.toThrow(
            '/embed-text response missing embedding',
        );
    });
});

// ---------------------------------------------------------------------------
// mlOcr
// ---------------------------------------------------------------------------

describe('mlOcr', () => {
    it('POSTs to /ocr with image_b64 body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        process.env.TGDL_ML_OCR_MODEL = 'PP-OCRv5_mobile';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    result: { text: 'Hello world', language: null, confidence: 0.92 },
                    raw: {},
                }),
        });

        const result = await client.mlOcr('/tmp/test.jpg');

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://tgdl-ml:3800/ocr');
        const body = JSON.parse(init.body);
        expect(typeof body.image_b64).toBe('string');

        expect(result.text).toBe('Hello world');
        expect(result.language).toBeNull();
        expect(result.confidence).toBeCloseTo(0.92);
        expect(result.model).toBe('tgdl-ml-ocr:PP-OCRv5_mobile');
        expect(result.provider).toBe('tgdl-ml');
    });

    it('passes optional score and resolution opts to body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({ result: { text: '', language: null, confidence: null }, raw: {} }),
        });

        await client.mlOcr('/tmp/test.jpg', {
            minDetectionScore: 0.6,
            minRecognitionScore: 0.7,
            maxResolution: 1024,
        });

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.min_detection_score).toBe(0.6);
        expect(body.min_recognition_score).toBe(0.7);
        expect(body.max_resolution).toBe(1024);
    });

    it('omits optional fields when opts not provided', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({ result: { text: '', language: null, confidence: null }, raw: {} }),
        });

        await client.mlOcr('/tmp/test.jpg');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('min_detection_score');
        expect(body).not.toHaveProperty('min_recognition_score');
        expect(body).not.toHaveProperty('max_resolution');
    });

    it('returns empty text when result.text is missing', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ result: {}, raw: {} }),
        });

        const result = await client.mlOcr('/tmp/test.jpg');
        expect(result.text).toBe('');
        expect(result.confidence).toBeNull();
    });

    it('throws on HTTP 403 path_not_allowed', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 403,
            text: async () =>
                JSON.stringify({
                    error: 'path is outside TGDL_ML_ALLOW_ROOTS',
                    code: 'path_not_allowed',
                }),
        });

        await expect(client.mlOcr('/etc/shadow')).rejects.toThrow(
            'tgdl-ml HTTP 403: path is outside TGDL_ML_ALLOW_ROOTS',
        );
    });
});
