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
    'TGDL_ML_ENABLED',
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
    it('returns localhost default when no env set', () => {
        clearMlEnv();
        expect(client.getTgdlMlUrl()).toBe('http://localhost:3800');
    });

    it('returns TGDL_ML_URL when set, stripping trailing slash', () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800/';
        expect(client.getTgdlMlUrl()).toBe('http://tgdl-ml:3800');
    });

    it('returns empty string when TGDL_ML_ENABLED=false', () => {
        process.env.TGDL_ML_ENABLED = 'false';
        expect(client.getTgdlMlUrl()).toBe('');
    });

    it('returns empty string when TGDL_ML_ENABLED=0', () => {
        process.env.TGDL_ML_ENABLED = '0';
        expect(client.getTgdlMlUrl()).toBe('');
    });

    it('TGDL_ML_ENABLED=false overrides explicit URL', () => {
        process.env.TGDL_ML_ENABLED = 'false';
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        expect(client.getTgdlMlUrl()).toBe('');
    });
});

describe('isTgdlMlEnabled', () => {
    it('true when no env set (default on)', () => {
        clearMlEnv();
        expect(client.isTgdlMlEnabled()).toBe(true);
    });

    it('false when TGDL_ML_ENABLED=false', () => {
        process.env.TGDL_ML_ENABLED = 'false';
        expect(client.isTgdlMlEnabled()).toBe(false);
    });

    it('true when URL explicitly configured', () => {
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

    it('falls back to cfg fields when tgdl-ml disabled', () => {
        process.env.TGDL_ML_ENABLED = 'false';
        expect(client.resolveClipModelId({ searchModel: 'MyModel' })).toBe('MyModel');
        expect(client.resolveClipModelId({ model: 'Alt' })).toBe('Alt');
        expect(client.resolveClipModelId({ clipModel: 'ClipAlt' })).toBe('ClipAlt');
    });

    it('falls back to Xenova default when cfg empty and tgdl-ml disabled', () => {
        process.env.TGDL_ML_ENABLED = 'false';
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

    it('throws when tgdl-ml disabled', async () => {
        process.env.TGDL_ML_ENABLED = 'false';
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

// ---------------------------------------------------------------------------
// mlDetect
// ---------------------------------------------------------------------------

describe('mlDetect', () => {
    it('POSTs to /detect with image_b64 body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        const faces = [
            { x: 10, y: 20, w: 80, h: 90, score: 0.95, embedding: new Array(512).fill(0.1) },
        ];

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ faces, image_w: 640, image_h: 480 }),
        });

        const result = await client.mlDetect('/tmp/face.jpg');

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://tgdl-ml:3800/detect');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(typeof body.image_b64).toBe('string');

        expect(result.faces).toHaveLength(1);
        expect(result.faces[0].score).toBeCloseTo(0.95);
        expect(result.image_w).toBe(640);
    });

    it('passes optional thresholds to body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ faces: [], image_w: 320, image_h: 240 }),
        });

        await client.mlDetect('/tmp/face.jpg', {
            minScore: 0.8,
            minBoxPx: 64,
            arRange: [0.5, 2.0],
        });

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.min_score).toBe(0.8);
        expect(body.min_box_px).toBe(64);
        expect(body.ar_range).toEqual([0.5, 2.0]);
    });

    it('omits optional fields when not provided', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ faces: [], image_w: 0, image_h: 0 }),
        });

        await client.mlDetect('/tmp/face.jpg');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('min_score');
        expect(body).not.toHaveProperty('min_box_px');
        expect(body).not.toHaveProperty('ar_range');
    });

    it('throws on HTTP error', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ error: 'detect failed', code: 'detect_failed' }),
        });

        await expect(client.mlDetect('/tmp/face.jpg')).rejects.toThrow(
            'tgdl-ml HTTP 500: detect failed',
        );
    });
});

// ---------------------------------------------------------------------------
// mlDetectBatch
// ---------------------------------------------------------------------------

describe('mlDetectBatch', () => {
    it('POSTs to /detect/batch with files array', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        const results = [
            {
                file: '/tmp/a.jpg',
                faces: [
                    { x: 0, y: 0, w: 50, h: 60, score: 0.9, embedding: new Array(512).fill(0.2) },
                ],
            },
            { file: '/tmp/b.jpg', faces: [] },
        ];

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results }),
        });

        const result = await client.mlDetectBatch(['/tmp/a.jpg', '/tmp/b.jpg']);

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://tgdl-ml:3800/detect/batch');
        const body = JSON.parse(init.body);
        expect(body.files).toEqual(['/tmp/a.jpg', '/tmp/b.jpg']);

        expect(result.results).toHaveLength(2);
        expect(result.results[0].faces).toHaveLength(1);
        expect(result.results[1].faces).toHaveLength(0);
    });

    it('passes optional thresholds to body', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
        });

        await client.mlDetectBatch(['/tmp/a.jpg'], { minScore: 0.7, minBoxPx: 48 });

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.min_score).toBe(0.7);
        expect(body.min_box_px).toBe(48);
    });

    it('throws on HTTP error', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ error: 'batch detect failed' }),
        });

        await expect(client.mlDetectBatch(['/tmp/a.jpg'])).rejects.toThrow('tgdl-ml HTTP 500');
    });
});

// ---------------------------------------------------------------------------
// mlTag
// ---------------------------------------------------------------------------

describe('mlTag', () => {
    it('POSTs to /tag with image_b64 and vocabulary', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';
        process.env.TGDL_ML_CLIP_MODEL = 'ViT-B-32__openai';
        const tags = [
            { tag: 'sunset', score: 0.82 },
            { tag: 'mountain', score: 0.61 },
        ];

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ tags, model: 'ViT-B-32__openai' }),
        });

        const result = await client.mlTag('/tmp/photo.jpg', {
            vocabulary: ['sunset', 'mountain', 'city'],
            minScore: 0.5,
            topK: 10,
        });

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://tgdl-ml:3800/tag');
        const body = JSON.parse(init.body);
        expect(typeof body.image_b64).toBe('string');
        expect(body.vocabulary).toEqual(['sunset', 'mountain', 'city']);
        expect(body.min_score).toBe(0.5);
        expect(body.top_k).toBe(10);

        expect(result.tags).toHaveLength(2);
        expect(result.tags[0].tag).toBe('sunset');
        expect(result.tags[0].score).toBeCloseTo(0.82);
        expect(result.model).toBe('ViT-B-32__openai');
    });

    it('omits optional fields when not provided', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ tags: [], model: 'ViT-B-32__openai' }),
        });

        await client.mlTag('/tmp/photo.jpg');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('vocabulary');
        expect(body).not.toHaveProperty('min_score');
        expect(body).not.toHaveProperty('top_k');
    });

    it('returns empty tags array when response tags is missing', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ model: 'ViT-B-32__openai' }),
        });

        const result = await client.mlTag('/tmp/photo.jpg');
        expect(result.tags).toEqual([]);
    });

    it('throws on HTTP 501 not implemented', async () => {
        process.env.TGDL_ML_URL = 'http://tgdl-ml:3800';

        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 501,
            text: async () =>
                JSON.stringify({
                    error: '/tag is not implemented in tgdl-ml yet',
                    code: 'not_implemented',
                }),
        });

        await expect(client.mlTag('/tmp/photo.jpg')).rejects.toThrow('tgdl-ml HTTP 501');
    });
});
