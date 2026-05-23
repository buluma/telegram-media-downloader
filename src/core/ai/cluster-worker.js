import { parentPort, workerData } from 'worker_threads';

import { clusterFaces } from './faces.js';

try {
    const embeddings = Array.isArray(workerData?.embeddings) ? workerData.embeddings : [];
    const qualityScores = Array.isArray(workerData?.qualityScores) ? workerData.qualityScores : [];
    const faces = embeddings.map((buffer, idx) => ({
        embedding: new Float32Array(buffer),
        qualityScore: qualityScores[idx],
    }));
    const result = clusterFaces(faces, workerData?.opts || {});
    parentPort.postMessage({
        clusters: result.clusters.map((cluster) => ({
            memberIdxs: cluster.memberIdxs,
            centroid: cluster.centroid,
            faceCount: cluster.faceCount,
        })),
        noise: result.noise,
    });
} catch (error) {
    parentPort.postMessage({
        error: error?.stack || error?.message || String(error),
    });
}
