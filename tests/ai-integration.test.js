import { describe, it, expect, vi } from 'vitest';
import { detectFaces } from '../src/core/ai/faces.js';

// Mock the faces-client
vi.mock('../src/core/ai/faces-client.js', () => ({
    getSidecarUrl: vi.fn().mockReturnValue('http://localhost:8011'),
    detectFaces: vi
        .fn()
        .mockResolvedValue([
            { x: 10, y: 10, w: 100, h: 100, score: 0.9, embedding: new Float32Array(512) },
        ]),
}));

vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(true),
    };
});

describe('AI Subsystem Integration', () => {
    it('should process a face detection pipeline', async () => {
        const mockAbsPath = '/fake/path/test.jpg';
        const cfg = { faceClustering: true };

        const detected = await detectFaces(mockAbsPath, cfg);

        expect(detected).toHaveLength(1);
        expect(detected[0]).toHaveProperty('embedding');
    });
});
