import { describe, it, expect, vi, beforeEach } from 'vitest';

// Intercept fetch before importing the module under test
const _fetchMock = vi.fn();
vi.stubGlobal('fetch', _fetchMock);

// Mock getSidecarUrl and tgdl-ml helpers
vi.mock('../../src/core/ai/faces-client.js', () => ({
    getSidecarUrl: vi.fn(() => 'http://127.0.0.1:8011'),
}));
vi.mock('../../src/core/ai/tgdl-ml-client.js', () => ({
    isTgdlMlEnabled: vi.fn(() => false),
    getTgdlMlUrl: vi.fn(() => null),
}));

const { checkSidecarCapability } = await import('../../src/core/ai/preflight.js');

function makeInfoResponse(overrides = {}) {
    return {
        endpoints: {
            detect: true,
            tag: true,
            wd14: true,
            ocr: true,
            embed_image: true,
            embed_text: true,
            ...overrides.endpoints,
        },
        models: {
            faces: { ready: true },
            clip: { ready: true },
            wd14: { ready: true },
            ocr: { ready: true },
            ...overrides.models,
        },
    };
}

function mockFetch(body, status = 200) {
    _fetchMock.mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level cache between tests by making urls differ via timestamp
});

describe('checkSidecarCapability', () => {
    it('returns ok when endpoint and model are ready', async () => {
        mockFetch(makeInfoResponse());
        const result = await checkSidecarCapability('ocr', 'http://sidecar:8011');
        expect(result.ok).toBe(true);
    });

    it('accepts Python sidecar tag_wd14 endpoint spelling', async () => {
        mockFetch(
            makeInfoResponse({
                endpoints: { wd14: false, tag_wd14: true },
            }),
        );
        const result = await checkSidecarCapability('wd14', 'http://sidecar:8017');
        expect(result.ok).toBe(true);
    });

    it('returns CAPABILITY_MISSING when endpoint is absent', async () => {
        mockFetch(makeInfoResponse({ endpoints: { ocr: false } }));
        const result = await checkSidecarCapability('ocr', 'http://sidecar:8016');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('CAPABILITY_MISSING');
    });

    it('returns MODEL_NOT_READY when model.ready is false', async () => {
        mockFetch(makeInfoResponse({ models: { wd14: { ready: false } } }));
        const result = await checkSidecarCapability('wd14', 'http://sidecar:8012');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('MODEL_NOT_READY');
    });

    it('returns SIDECAR_UNREACHABLE when fetch throws', async () => {
        _fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await checkSidecarCapability('ocr', 'http://sidecar:8013');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('SIDECAR_UNREACHABLE');
    });

    it('returns SIDECAR_UNREACHABLE when /info returns non-200', async () => {
        mockFetch({}, 503);
        const result = await checkSidecarCapability('wd14', 'http://sidecar:8014');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('SIDECAR_UNREACHABLE');
    });

    it('returns SIDECAR_OFFLINE when no url is provided and getSidecarUrl returns null', async () => {
        const { getSidecarUrl } = await import('../../src/core/ai/faces-client.js');
        getSidecarUrl.mockReturnValueOnce(null);
        const result = await checkSidecarCapability('ocr');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('SIDECAR_OFFLINE');
    });

    it('returns UNKNOWN_SCANNER for unrecognised scanner name', async () => {
        const result = await checkSidecarCapability('banana', 'http://sidecar:8011');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('UNKNOWN_SCANNER');
    });

    it('passes check when model entry is missing (assume ready)', async () => {
        // Some sidecars omit models block entirely — should not block the scan
        mockFetch({ endpoints: { ocr: true } });
        const result = await checkSidecarCapability('ocr', 'http://sidecar:8015');
        expect(result.ok).toBe(true);
    });
});
