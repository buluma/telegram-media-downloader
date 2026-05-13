/**
 * Cross-modal search engine.
 *
 * Combines six signal sources into one ranked result set:
 *   1. **Semantic** — CLIP image embedding cosine similarity (sidecar)
 *   2. **Tags** — CLIP zero-shot tag matches (image_tags table)
 *   3. **Objects** — YOLO detected object matches (image_objects table)
 *   4. **People** — labelled person matches (faces → people table)
 *   5. **Text / OCR** — OCR text substring match (image_text table)
 *   6. **Filename** — keyword match on file_name / group_name (downloads)
 *
 * Each matcher produces scored download-ID sets; the combiner normalises
 * and merges them via a weighted sum. Empty/unavailable matchers are
 * skipped silently.
 */

import { getDb } from '../db.js';
import { searchTextEmbeddings } from '../db/faces.js';

// ---- Default weights (tunable via opts) ----------------------------------

const DEFAULT_WEIGHTS = {
    semantic: 1.0,
    tags: 0.6,
    objects: 0.4,
    people: 0.5,
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
 * @param {Function} [opts.llmEmbed] - Optional async (texts: string[]) => number[][] | null.
 *   Used as fallback text embedding source when the CLIP sidecar is unavailable. Results are
 *   matched against LLM text embeddings stored in text_embeddings (see buildMetadataText).
 * @returns {Promise<{ query, results: object[], modalities: string[], excludedTokens?: string[] }>}
 */
export async function crossModalSearch(query, opts = {}) {
    const topK = Math.max(1, Math.min(500, Number(opts.topK) || 50));
    const minScore = Number(opts.minScore) || 0;
    const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    const skipSemantic = opts.skipSemantic === true;
    const llmEmbed = typeof opts.llmEmbed === 'function' ? opts.llmEmbed : null;

    // Tokenise the query into include / exclude lists
    const { include: tokens, exclude: excludedTokens } = _tokenise(query);
    if (!tokens.length) return { query, results: [], modalities: [] };

    const db = getDb();
    const resultsByModality = {};
    let semanticEmbedding = null;

    // Run matchers in parallel where possible
    const tasks = [];

    // 1. Semantic (async — try CLIP sidecar first, fall back to LLM text embeddings)
    if (!skipSemantic) {
        tasks.push(
            (async () => {
                // Primary path: CLIP sidecar embeds the query into CLIP space,
                // then we cosine-sim against stored image embeddings.
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
                        return; // sidecar succeeded — skip LLM fallback
                    }
                } catch {
                    // sidecar unavailable — try LLM fallback below
                }

                // Fallback: LLM text embedding (nomic-embed-text / text-embedding-3-small).
                // Matches against per-download metadata summaries stored in text_embeddings.
                // Only fires if llmEmbed was supplied by the caller.
                if (!llmEmbed) return;
                try {
                    const vecs = await llmEmbed([query]);
                    if (Array.isArray(vecs) && vecs[0]?.length) {
                        semanticEmbedding = Float32Array.from(vecs[0]);
                        resultsByModality.semantic = _matchTextSemantic(
                            semanticEmbedding,
                            opts.fileTypes,
                        );
                    }
                } catch {
                    // LLM also unavailable — skip semantic modality entirely
                }
            })(),
        );
    }

    // 2-6. Local DB matchers (fast, run in parallel)
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
            resultsByModality.people = _matchPeople(db, tokens, opts.fileTypes);
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

    // Exclusion pass — collect IDs matching any exclude token across all
    // non-semantic modalities, then remove them from every modality result.
    if (excludedTokens.length) {
        const excluded = new Set();
        const exResults = await Promise.allSettled([
            Promise.resolve(_matchTags(db, excludedTokens, opts.fileTypes)),
            Promise.resolve(_matchObjects(db, excludedTokens, opts.fileTypes)),
            Promise.resolve(_matchPeople(db, excludedTokens, opts.fileTypes)),
            Promise.resolve(_matchText(db, excludedTokens, opts.fileTypes)),
            Promise.resolve(_matchFilename(db, excludedTokens, opts.fileTypes)),
        ]);
        for (const r of exResults) {
            if (r.status === 'fulfilled' && r.value) {
                for (const id of r.value.keys()) excluded.add(id);
            }
        }
        for (const map of Object.values(resultsByModality)) {
            if (map) for (const id of excluded) map.delete(id);
        }
    }

    // Count how many modalities were active
    const activeModalities = Object.keys(resultsByModality).filter(
        (k) => resultsByModality[k] && resultsByModality[k].size > 0,
    );

    if (!activeModalities.length) {
        return {
            query,
            results: [],
            modalities: [],
            ...(excludedTokens.length ? { excludedTokens } : {}),
        };
    }

    // Combine scores across all active modalities
    const combined = _combineScores(resultsByModality, weights, activeModalities);

    // Normalise so the highest-scoring result = 1.0. Preserves relative
    // ranking while preventing scores from feeling arbitrarily low when
    // only one modality fires or IDs match only a subset of modalities.
    if (combined.size > 0) {
        const max = Math.max(...combined.values());
        if (max > 0 && max < 1) {
            for (const [id, score] of combined) {
                combined.set(id, score / max);
            }
        }
    }

    // Build final result list sorted by combined score
    const entries = [...combined.entries()]
        .filter(([, score]) => score >= minScore)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK);

    if (!entries.length) {
        return {
            query,
            results: [],
            modalities: activeModalities,
            ...(excludedTokens.length ? { excludedTokens } : {}),
        };
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
        ...(excludedTokens.length ? { excludedTokens } : {}),
    };
}

// ---- Tokeniser ----------------------------------------------------------

/**
 * Split a query string into include and exclude token lists.
 * Tokens prefixed with `-` are exclusions (e.g. `beach -vacation`).
 * Returns `{ include: string[], exclude: string[] }`.
 */
function _tokenise(text) {
    const include = [];
    const exclude = [];
    String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((tok) => {
            if (tok.startsWith('-') && tok.length > 1) {
                exclude.push(tok.slice(1));
            } else {
                include.push(tok);
            }
        });
    return { include, exclude };
}

// ---- Individual matchers ------------------------------------------------

/**
 * Semantic matcher — cosine similarity against stored image embeddings
 * for a single active model. If multiple models exist, uses the most
 * common one. Returns Map<downloadId, score>.
 */
function _matchSemantic(db, embedding, fileTypes) {
    const q = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    const qNorm = Math.sqrt(q.reduce((a, b) => a + b * b, 0)) || 1;
    const qn = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) qn[i] = q[i] / qNorm;
    const dim = q.length;

    // Detect the active embedding model — use the most common one
    const modelCounts = db
        .prepare(
            `SELECT model, COUNT(*) AS cnt FROM image_embeddings GROUP BY model ORDER BY cnt DESC`,
        )
        .all();
    const activeModel = modelCounts.length ? modelCounts[0].model : null;

    let sql = `SELECT e.download_id, e.embedding
                 FROM image_embeddings e`;
    const params = [];
    const wheres = [];
    if (activeModel) {
        wheres.push(`e.model = ?`);
        params.push(activeModel);
    }
    if (Array.isArray(fileTypes) && fileTypes.length) {
        sql += ` JOIN downloads d ON d.id = e.download_id`;
        wheres.push(`d.file_type IN (${fileTypes.map(() => '?').join(',')})`);
        params.push(...fileTypes);
    }
    if (wheres.length) {
        sql += ` WHERE ${wheres.join(' AND ')}`;
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
 * LLM text-embedding semantic matcher — cosine similarity against stored
 * LLM text embeddings (text_embeddings table). Used when the CLIP sidecar
 * is unavailable. Returns Map<downloadId, score>.
 */
function _matchTextSemantic(embedding, fileTypes) {
    const results = searchTextEmbeddings(embedding, {
        topK: 500,
        minScore: 0,
        fileTypes: fileTypes || null,
    });
    const map = new Map();
    for (const { id, score } of results) {
        if (score > 0) map.set(id, score);
    }
    return map;
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
 * People matcher — find images whose detected faces belong to a person
 * whose label matches any query token.
 * Returns Map<downloadId, score> where score = 1.0 for any match.
 */
function _matchPeople(db, tokens, fileTypes) {
    const likeClauses = tokens.map(() => `p.label LIKE ?`);
    let sql = `SELECT DISTINCT f.download_id
                 FROM faces f
                 JOIN people p ON p.id = f.person_id
                 JOIN downloads d ON d.id = f.download_id
                WHERE (${likeClauses.join(' OR ')})
                  AND p.label IS NOT NULL
                  AND p.label != ''`;
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
        results.set(Number(row.download_id), 1.0);
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
