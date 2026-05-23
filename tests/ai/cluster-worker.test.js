import { Worker } from 'worker_threads';
import { describe, expect, it } from 'vitest';

const F = (...arr) => new Float32Array(arr);

function runWorker(faces, opts) {
    return new Promise((resolve, reject) => {
        const embeddings = faces.map((face) => face.embedding.buffer);
        const worker = new Worker(new URL('../../src/core/ai/cluster-worker.js', import.meta.url), {
            workerData: {
                embeddings,
                qualityScores: faces.map((face) => face.qualityScore),
                opts,
            },
            transferList: embeddings,
        });
        worker.once('message', (msg) => {
            if (msg?.error) reject(new Error(msg.error));
            else resolve(msg);
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`worker exited with ${code}`));
        });
    });
}

describe('cluster worker', () => {
    it('clusters embeddings off the main thread', async () => {
        const faces = [
            { embedding: F(0, 0), qualityScore: 1 },
            { embedding: F(0.05, 0.05), qualityScore: 1 },
            { embedding: F(0.1, 0), qualityScore: 1 },
            { embedding: F(10, 10), qualityScore: 1 },
            { embedding: F(10.05, 10.05), qualityScore: 1 },
            { embedding: F(10, 10.1), qualityScore: 1 },
            { embedding: F(50, 50), qualityScore: 1 },
        ];

        const result = await runWorker(faces, { eps: 0.5, minPts: 3 });

        expect(result.clusters).toHaveLength(2);
        expect(result.clusters.map((c) => c.faceCount)).toEqual([3, 3]);
        expect(result.clusters[0].centroid).toBeInstanceOf(Float32Array);
        expect(result.noise).toEqual([6]);
    });
});
