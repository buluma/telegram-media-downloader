/**
 * Cross-modal search engine.
 *
 * Combines five signal sources into one ranked result set:
 *   1. **Semantic** — CLIP image embedding cosine similarity (sidecar)
 *   2. **Tags** — CLIP zero-shot tag matches (image_tags table)
 *   3. **Objects** — YOLO detected object matches (image_objects table)
 *   4. **Text / OCR** — OCR text substring match (image_text table)
 *   5. **Filename** — keyword match on file_name / group_name (downloads)
 *
 * Each matcher produces scored download-ID sets; the combiner normalises
 * and merges them via a weighted sum. Empty/unavailable matchers are
 * skipped silently.
 */

import { getDb } from '../db.js';

// ---- Default weights (tunable via opts) ----------------------------------

const DEFAULT_WEIGHTS = {
    semantic: 1.0,
    tags: 0.6,
    objects: 0.4,
    text: 0.3,
    filename: 0.3,
};

// ---- Public API ---------------------------------------------------------

/**
 * Run a cross-modal search and return ranked results.
 *
 * @param {string} query - Natural-language query (e.g. "dog on a beach")
 * @param {object} [opts]
 * @param {number} [opts.topK=50]  - Max results
 * @param {number} [opts.minScore=0] - Minimum combined score (0-1)
 * @param {object} [opts.weights] - Per-modality weight overrides
 * @param {string[]} [opts.fileTypes] - Filter by file type(s)
 * @param {boolean} [opts.skipSemantic=false] - Skip embedding search
 * @returns {Promise<{ query, results: object[], modalities: object }>}
 */
export async function crossModalSearch(query, opts = {}) {
    const topK = Math.max(1, Math.min(500, Number(opts.topK) || 50));
    const minScore = Number(opts.minScore) || 0;
    const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    const skipSemantic = opts.skipSemantic === true;

    // Tokenise the query into lower-cased keywords
    const tokens = _tokenise(query);
    if (!tokens.length) return { query, results: [], modalities: {} };

    const db = getDb();
    const resultsByModality = {};
    let semanticEmbedding = null;

    // Run matchers in parallel where possible
    const tasks = [];

    // 1. Semantic (async — needs sidecar call for text embedding)
    if (!skipSemantic) {
        tasks.push(
            (async () => {
                try {
                    const { embedText } = await import('./faces-client.js');
                    const r = await embedText(query);
                    if (r?.embedding?.length) {
                        semanticEmbedding = Float32Array.from(r.embedding);
                        resultsByModality.semantic = _matchSemantic(
                            db,
                            semanticEmbedding,
                            opts.fileTypes,
                        );
                    }
                } catch {
                    // sidecar unavailable — skip
                }
            })(),
        );
    }

    // 2-5. Local DB matchers (fast, run in parallel)
    tasks.push(
        Promise.resolve().then(() => {
            resultsByModality.tags = _matchTags(db, tokens, opts.fileTypes);
        }),
    );
    tasks.push(
        Promise.resolve().then(() => {
            resultsByModality.objects = _matchObjects(db, tokens, opts.fileTypes);
        }),
    );
    tasks.push(
        Promise.resolve().then(() => {
            resultsByModality.text = _matchText(db, tokens, opts.fileTypes);
        }),
    );
    tasks.push(
        Promise.resolve().then(() => {
            resultsByModality.filename = _matchFilename(db, tokens, opts.fileTypes);
        }),
    );

    await Promise.allSettled(tasks);

    // Count how many modalities were active
    const activeModalities = Object.keys(resultsByModality).filter(
        (k) => resultsByModality[k] && resultsByModality[k].size > 0,
    );

    if (!activeModalities.length) {
        return { query, results: [], modalities: [] };
    }

    // Combine scores across all active modalities
    const combined = _combineScores(resultsByModality, weights, activeModalities);

    // Build final result list sorted by combined score
    const entries = [...combined.entries()]
        .filter(([, score]) => score >= minScore)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK);

    if (!entries.length) {
        return { query, results: [], modalities: activeModalities };
    }

    // Fetch file metadata for the matched download IDs
    const ids = entries.map(([id]) => id);
    const placeholders = ids.map(() => '?').join(',');
    const fileRows = db
        .prepare(
            `SELECT id, group_id, group_name, file_name, file_path,
                    file_type, file_size, created_at
               FROM downloads
              WHERE id IN (${placeholders})`,
        )
        .all(...ids);

    const fileMap = new Map(fileRows.map((r) => [Number(r.id), r]));

    const results = entries.map(([id, score]) => {
        const f = fileMap.get(id) || {};
        return {
            id,
            groupId: f.group_id || null,
            groupName: f.group_name || '',
            fileName: f.file_name || '',
            filePath: f.file_path || '',
            fileType: f.file_type || '',
            fileSize: f.file_size || 0,
            createdAt: f.created_at || 0,
            score: Math.round(score * 1000) / 1000,
        };
    });

    return {
        query,
        results,
        modalities: activeModalities,
    };
}

// ---- Tokeniser ----------------------------------------------------------

function _tokenise(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/\s+/)
        .filter(Boolean);
}

// ---- Individual matchers ------------------------------------------------

/**
 * Semantic matcher — cosine similarity against stored image embeddings.
 * Returns Map<downloadId, score>.
 */
function _matchSemantic(db, embedding, fileTypes) {
    const q = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    const qNorm = Math.sqrt(q.reduce((a, b) => a + b * b, 0)) || 1;
    const qn = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) qn[i] = q[i] / qNorm;
    const dim = q.length;

    let sql = `SELECT e.download_id, e.embedding
                 FROM image_embeddings e`;
    const params = [];
    if (Array.isArray(fileTypes) && fileTypes.length) {
        sql += ` JOIN downloads d ON d.id = e.download_id
                  WHERE d.file_type IN (${fileTypes.map(() => '?').join(',')})`;
        params.push(...fileTypes);
    }

    const rows = db.prepare(sql).all(...params);
    const results = new Map();

    for (const row of rows) {
        if (!row.embedding || !row.embedding.byteLength) continue;
        const emb = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
        );
        if (emb.length !== dim) continue;
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += qn[i] * emb[i];
        const score = Math.max(0, Math.min(1, dot));
        if (score > 0) {
            results.set(Number(row.download_id), score);
        }
    }
    return results;
}

/**
 * Tag matcher — find images whose CLIP tags match any query token.
 * Returns Map<downloadId, score> where score = max matching tag score.
 */
function _matchTags(db, tokens, fileTypes) {
    const likeClauses = tokens.map(() => `t.tag LIKE ?`);
    let sql = `SELECT DISTINCT t.download_id, t.score
                 FROM image_tags t
                 JOIN downloads d ON d.id = t.download_id
                WHERE (${likeClauses.join(' OR ')})
                  AND t.score >= 0.1`;
    const params = [];
    for (const tok of tokens) params.push(`%${tok}%`);
    if (Array.isArray(fileTypes) && fileTypes.length) {
        const fps = fileTypes.map(() => '?').join(',');
        sql += ` AND d.file_type IN (${fps})`;
        params.push(...fileTypes);
    }

    const rows = db.prepare(sql).all(...params);
    const results = new Map();
    for (const row of rows) {
        const id = Number(row.download_id);
        const score = Math.max(0, Math.min(1, Number(row.score) || 0));
        if (!results.has(id) || score > results.get(id)) {
            results.set(id, score);
        }
    }
    return results;
}

/**
 * Object matcher — find images whose detected objects match any token.
 * Returns Map<downloadId, score> where score = max confidence.
 */
function _matchObjects(db, tokens, fileTypes) {
    const likeClauses = tokens.map(() => `o.object LIKE ?`);
    let sql = `SELECT DISTINCT o.download_id, o.confidence
                 FROM image_objects o
                 JOIN downloads d ON d.id = o.download_id
                WHERE (${likeClauses.join(' OR ')})
                  AND o.confidence >= 0.3`;
    const params = [];
    for (const tok of tokens) params.push(`%${tok}%`);
    if (Array.isArray(fileTypes) && fileTypes.length) {
        const fps = fileTypes.map(() => '?').join(',');
        sql += ` AND d.file_type IN (${fps})`;
        params.push(...fileTypes);
    }

    const rows = db.prepare(sql).all(...params);
    const results = new Map();
    for (const row of rows) {
        const id = Number(row.download_id);
        const score = Math.max(0, Math.min(1, Number(row.confidence) || 0));
        if (!results.has(id) || score > results.get(id)) {
            results.set(id, score);
        }
    }
    return results;
}

/**
 * Text/OCR matcher — find images whose OCR text contains any token.
 * Returns Map<downloadId, score> where score reflects match density.
 */
function _matchText(db, tokens, fileTypes) {
    const likeClauses = tokens.map(() => `t.text LIKE ?`);
    let sql = `SELECT t.download_id, t.text
                 FROM image_text t
                 JOIN downloads d ON d.id = t.download_id
                WHERE (${likeClauses.join(' OR ')})`;
    const params = [];
    for (const tok of tokens) params.push(`%${tok}%`);
    if (Array.isArray(fileTypes) && fileTypes.length) {
        const fps = fileTypes.map(() => '?').join(',');
        sql += ` AND d.file_type IN (${fps})`;
        params.push(...fileTypes);
    }

    const rows = db.prepare(sql).all(...params);
    const results = new Map();
    for (const row of rows) {
        const id = Number(row.download_id);
        let matchCount = 0;
        const text = String(row.text || '').toLowerCase();
        for (const tok of tokens) {
            if (text.includes(tok)) matchCount++;
        }
        const score = Math.min(1, matchCount / tokens.length);
        if (score > 0) {
            results.set(id, score);
        }
    }
    return results;
}

/**
 * Filename matcher — find images whose filename or group name contains
 * any query token. Returns Map<downloadId, score>.
 */
function _matchFilename(db, tokens, fileTypes) {
    const clauses = [];
    const params = [];
    for (const tok of tokens) {
        clauses.push(`(d.file_name LIKE ? OR d.group_name LIKE ?)`);
        params.push(`%${tok}%`, `%${tok}%`);
    }
    let sql = `SELECT DISTINCT d.id, d.file_name, d.group_name
                 FROM downloads d
                WHERE (${clauses.join(' OR ')})`;
    if (Array.isArray(fileTypes) && fileTypes.length) {
        params.push(...fileTypes);
        sql += ` AND d.file_type IN (${fileTypes.map(() => '?').join(',')})`;
    }

    const rows = db.prepare(sql).all(...params);
    const results = new Map();
    for (const row of rows) {
        const id = Number(row.id);
        let matchCount = 0;
        const name = String(row.file_name || '').toLowerCase();
        const group = String(row.group_name || '').toLowerCase();
        for (const tok of tokens) {
            if (name.includes(tok) || group.includes(tok)) matchCount++;
        }
        const score = Math.min(1, matchCount / tokens.length);
        if (score > 0) {
            results.set(id, score);
        }
    }
    return results;
}

// ---- Score combiner -----------------------------------------------------

/**
 * Combine multiple modality result sets into one weighted score per
 * download ID.
 *
 * Each modality produces scores in [0, 1]. The combined score is the
 * weighted average over all active modalities (not over all possible
 * modalities — missing ones don't penalise).
 *
 * @param {Object<string, Map<number, number>>} resultsByModality
 * @param {Object<string, number>} weights
 * @param {string[]} activeModalities
 * @returns {Map<number, number>}
 */
function _combineScores(resultsByModality, weights, activeModalities) {
    const combined = new Map();

    // Collect every download ID that appears in any modality
    const allIds = new Set();
    for (const mod of activeModalities) {
        const map = resultsByModality[mod];
        if (map) {
            for (const id of map.keys()) allIds.add(id);
        }
    }

    // Normalise weights so they sum to 1
    let totalWeight = 0;
    for (const mod of activeModalities) {
        totalWeight += Number(weights[mod]) || 0;
    }
    if (totalWeight <= 0) return combined;

    for (const id of allIds) {
        let score = 0;
        for (const mod of activeModalities) {
            const map = resultsByModality[mod];
            const w = (Number(weights[mod]) || 0) / totalWeight;
            if (map && map.has(id)) {
                score += w * map.get(id);
            }
        }
        if (score > 0) {
            combined.set(id, score);
        }
    }

    return combined;
}
