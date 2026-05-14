// Tests for automatic face re-clustering:
//   - periodic interval timer (startAutoCluster / stopAutoCluster)
//   - guard conditions (autoCluster off, scan already running, ai disabled)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- module-level mocks set up before the subject is imported ---------------

let _isScanRunningResult = false;
let _startFacesScanCalled = 0;
let _loadConfigResult = {
    advanced: {
        ai: {
            enabled: true,
            faceClustering: true,
            autoCluster: true,
            autoClusterIntervalMin: 1,
            autoClusterDebounceMs: 50,
        },
    },
};

vi.mock('../../src/core/ai/scan-runner.js', () => ({
    isScanRunning: vi.fn(() => _isScanRunningResult),
    startFacesScan: vi.fn(() => {
        _startFacesScanCalled++;
        return Promise.resolve();
    }),
    cancelScan: vi.fn(),
    getScanState: vi.fn(),
}));

vi.mock('../../src/config/manager.js', () => ({
    loadConfig: vi.fn(() => _loadConfigResult),
}));

// Minimal DB / face stubs — _drainBg touches these
vi.mock('../../src/core/db.js', () => ({
    getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({ get: vi.fn(() => null), run: vi.fn() })),
    })),
    insertFace: vi.fn(),
    deleteFacesForDownload: vi.fn(),
    setAiIndexedAt: vi.fn(),
}));
vi.mock('../../src/core/db/faces.js', () => ({
    buildMetadataText: vi.fn(() => ''),
    setImageEmbedding: vi.fn(),
    setTextEmbedding: vi.fn(),
}));
vi.mock('../../src/core/ai/faces.js', () => ({
    detectFaces: vi.fn(async () => []),
    computeFaceQualityScore: vi.fn(() => 1),
    FACE_DEFAULTS: {},
    clusterFaces: vi.fn(() => ({ clusters: [] })),
    dbscan: vi.fn(),
    euclidean: vi.fn(),
    centroid: vi.fn(),
}));
vi.mock('../../src/core/ai/faces-client.js', () => ({
    embedImage: vi.fn(async () => null),
}));

// Import subject AFTER mocks are registered
const { startAutoCluster, stopAutoCluster, _resetForTests, _bgQueueDepths, pregenerateAi } =
    await import('../../src/core/ai/index.js');

const { startFacesScan, isScanRunning } = await import('../../src/core/ai/scan-runner.js');

beforeEach(() => {
    vi.useFakeTimers();
    _isScanRunningResult = false;
    _startFacesScanCalled = 0;
    _resetForTests();
    vi.clearAllMocks();
    _loadConfigResult = {
        advanced: {
            ai: {
                enabled: true,
                faceClustering: true,
                autoCluster: true,
                autoClusterIntervalMin: 1,
                autoClusterDebounceMs: 50,
            },
        },
    };
    isScanRunning.mockImplementation(() => _isScanRunningResult);
    startFacesScan.mockImplementation(() => {
        _startFacesScanCalled++;
        return Promise.resolve();
    });
});

afterEach(() => {
    stopAutoCluster();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('startAutoCluster / stopAutoCluster — periodic timer', () => {
    it('fires startFacesScan on each interval tick', async () => {
        startAutoCluster({ intervalMin: 1 / 60 }); // ~1 second for test
        await vi.advanceTimersByTimeAsync(1100);
        expect(_startFacesScanCalled).toBeGreaterThanOrEqual(1);
    });

    it('does not fire when autoCluster is false in live config', async () => {
        _loadConfigResult.advanced.ai.autoCluster = false;
        startAutoCluster({ intervalMin: 1 / 60 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(_startFacesScanCalled).toBe(0);
    });

    it('does not fire when ai.enabled is false in live config', async () => {
        _loadConfigResult.advanced.ai.enabled = false;
        startAutoCluster({ intervalMin: 1 / 60 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(_startFacesScanCalled).toBe(0);
    });

    it('stopAutoCluster prevents further ticks', async () => {
        startAutoCluster({ intervalMin: 1 / 60 });
        await vi.advanceTimersByTimeAsync(1100);
        const countAfterFirst = _startFacesScanCalled;
        stopAutoCluster();
        await vi.advanceTimersByTimeAsync(2000);
        expect(_startFacesScanCalled).toBe(countAfterFirst);
    });

    it('does not fire when scan already running', async () => {
        _isScanRunningResult = true;
        startAutoCluster({ intervalMin: 1 / 60 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(_startFacesScanCalled).toBe(0);
    });

    it('re-arming replaces the old timer', async () => {
        startAutoCluster({ intervalMin: 1 / 60 });
        await vi.advanceTimersByTimeAsync(1100);
        const firstCount = _startFacesScanCalled;
        // Re-arm with a much longer interval
        startAutoCluster({ intervalMin: 60 });
        await vi.advanceTimersByTimeAsync(2000);
        // Should not have fired again on the long interval within 2 s
        expect(_startFacesScanCalled).toBe(firstCount);
    });
});
