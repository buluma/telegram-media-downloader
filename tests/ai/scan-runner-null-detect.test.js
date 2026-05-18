// Face scan phase A: stamping behaviour when detection service is unavailable.
//
// The bug: scan-runner.js:648 (_safeSetIndexed) was called unconditionally
// for every image, including those where detection returned null (service
// error). That permanently excluded them from future scans even though the
// file still exists and no faces were ever extracted.
//
// After the fix, null-result + file-present means "service error" — do NOT
// stamp. Only stamp when:
//   (a) the file no longer exists (can't scan anyway), OR
//   (b) detection ran and returned a real result ([] or [{...}]).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mutable state shared between top-level vi.mock factories and tests ----
let _batchCall = 0;
const _setAiIndexedAt = vi.fn();

const _photos = [
    {
        id: 101,
        group_id: 'g1',
        group_name: 'Test',
        file_name: 'a.jpg',
        file_path: 'a.jpg',
        file_type: 'photo',
        file_size: 1,
        created_at: 1,
    },
    {
        id: 102,
        group_id: 'g1',
        group_name: 'Test',
        file_name: 'b.jpg',
        file_path: 'b.jpg',
        file_type: 'photo',
        file_size: 1,
        created_at: 2,
    },
];

// ---- module mocks (hoisted by Vitest — must be declared before imports) ----

vi.mock('../../src/core/db.js', () => ({
    getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({ get: vi.fn(() => ({ n: 2 })) })),
    })),
    getUnindexedAiBatch: vi.fn(() => (_batchCall++ === 0 ? _photos : [])),
    setAiIndexedAt: _setAiIndexedAt,
    insertFace: vi.fn(),
    deleteFacesForDownload: vi.fn(),
    insertPerson: vi.fn(),
    iterateAllFaces: vi.fn(function* () {}),
    setFacePerson: vi.fn(),
    setImageTags: vi.fn(),
    clearImageTagsForDownload: vi.fn(),
}));

vi.mock('../../src/core/db/faces.js', () => ({
    countUnscannedWd14: vi.fn(() => 0),
    getUnscannedOcrBatch: vi.fn(() => []),
    getUnscannedWd14Batch: vi.fn(() => []),
    setWd14Tags: vi.fn(),
    setImageText: vi.fn(),
}));

// detection service unavailable — returns null for every path
let _detectFacesBatchImpl = async (paths) => paths.map(() => null);
vi.mock('../../src/core/ai/faces-client.js', () => ({
    detectFacesBatch: vi.fn(async (...a) => _detectFacesBatchImpl(...a)),
    getSidecarUrl: vi.fn(() => null),
    detectFaces: vi.fn(async () => null),
}));

vi.mock('../../src/core/ai/faces.js', () => ({
    detectFaces: vi.fn(async () => []),
    computeFaceQualityScore: vi.fn(() => 1),
    clusterFaces: vi.fn(() => ({ clusters: [] })),
    FACE_DEFAULTS: {},
    dbscan: vi.fn(),
    euclidean: vi.fn(),
    centroid: vi.fn(),
}));

vi.mock('../../src/core/ai/faces-config.js', () => ({
    resolveFacesValue: vi.fn(() => undefined),
}));

vi.mock('../../src/core/ai/tgdl-ml-client.js', () => ({
    mlOcr: vi.fn(),
    isTgdlMlEnabled: vi.fn(() => false),
    getTgdlMlUrl: vi.fn(() => ''),
    mlDetect: vi.fn(),
    mlDetectBatch: vi.fn(async () => ({ results: [] })),
    getTgdlClipModelName: vi.fn(() => ''),
    getTgdlOcrModelName: vi.fn(() => ''),
    getTgdlEmbeddingModelId: vi.fn(() => ''),
    resolveClipModelId: vi.fn(() => ''),
    mlEmbedImage: vi.fn(),
    mlEmbedText: vi.fn(),
}));

vi.mock('../../src/core/thumbs.js', () => ({
    hasFfmpeg: vi.fn(() => false),
    resolveFfmpegBin: vi.fn(() => null),
}));

// existsSync always true — files are "present on disk" in every test unless
// overridden. This drives the two branches: file-present + null detection
// (service error) vs file-missing + null detection (file deleted).
let _existsSyncResult = true;
vi.mock('fs', async (importActual) => {
    const real = await importActual();
    return { ...real, existsSync: vi.fn(() => _existsSyncResult) };
});

// Import after mocks so the subject picks up the stub dependencies.
const { startFacesScan, _resetForTests } = await import('../../src/core/ai/scan-runner.js');

function runScan(cfg = {}) {
    _resetForTests();
    return new Promise((resolve) => startFacesScan(cfg, null, resolve, null));
}

beforeEach(() => {
    _batchCall = 0;
    _existsSyncResult = true;
    _detectFacesBatchImpl = async (paths) => paths.map(() => null);
    _setAiIndexedAt.mockClear();
});

// ---------------------------------------------------------------------------

describe('face scan phase A — stamping', () => {
    it('does NOT stamp ai_indexed_at when detection returns null for existing files', async () => {
        // detection service unreachable → all nulls
        _detectFacesBatchImpl = async (paths) => paths.map(() => null);
        _existsSyncResult = true;

        await runScan();

        expect(_setAiIndexedAt).not.toHaveBeenCalled();
    });

    it('stamps ai_indexed_at when detection returns empty array (genuine no-faces)', async () => {
        // service reachable, photos contain no faces
        _detectFacesBatchImpl = async (paths) => paths.map(() => []);
        _existsSyncResult = true;

        await runScan();

        expect(_setAiIndexedAt).toHaveBeenCalledTimes(2);
        expect(_setAiIndexedAt).toHaveBeenCalledWith(101);
        expect(_setAiIndexedAt).toHaveBeenCalledWith(102);
    });

    it('stamps ai_indexed_at when file no longer exists (null detection, missing file)', async () => {
        _detectFacesBatchImpl = async (paths) => paths.map(() => null);
        _existsSyncResult = false; // files deleted

        await runScan();

        expect(_setAiIndexedAt).toHaveBeenCalledTimes(2);
    });
});
