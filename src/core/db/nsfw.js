import { getDb } from '../db.js';

// ---- NSFW hash blocklist --------------------------------------------------
//
// Stores SHA-256 fingerprints of files deleted via the NSFW review UI.
// Re-downloaded copies are matched by hash and auto-deleted without a
// full rescan, preventing the same content from accumulating indefinitely.

/**
 * Check whether any of the supplied hashes appear in the blocklist.
 * Returns a Set containing only the matching hashes.
 *
 * @param {string[]} hashes  SHA-256 hex strings to test
 * @returns {Set<string>}
 */
export function checkNsfwBlocklistHashes(hashes) {
    const result = new Set();
    if (!Array.isArray(hashes) || !hashes.length) return result;
    const valid = hashes.filter((h) => typeof h === 'string' && h.length === 64);
    if (!valid.length) return result;
    const placeholders = valid.map(() => '?').join(',');
    const rows = getDb()
        .prepare(`SELECT file_hash FROM nsfw_hash_blocklist WHERE file_hash IN (${placeholders})`)
        .all(...valid);
    for (const row of rows) result.add(row.file_hash);
    return result;
}

/**
 * Add a file hash to the blocklist.
 *
 * @param {string} fileHash  SHA-256 hex string
 * @param {string} [fileName]
 * @param {string} [source]  'manual' | 'review' | ...
 */
export function addNsfwBlocklistHash(fileHash, fileName = null, source = 'manual') {
    if (!fileHash || typeof fileHash !== 'string') return;
    getDb()
        .prepare(
            `INSERT INTO nsfw_hash_blocklist (file_hash, file_name, deleted_at, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(file_hash) DO NOTHING`,
        )
        .run(fileHash, fileName ?? null, Date.now(), source);
}

/**
 * Remove all entries from the blocklist.
 * @returns {number} rows deleted
 */
export function clearNsfwBlocklist() {
    return getDb().prepare('DELETE FROM nsfw_hash_blocklist').run().changes;
}

/**
 * Count entries currently in the blocklist.
 * @returns {number}
 */
export function getNsfwBlocklistCount() {
    return getDb().prepare('SELECT COUNT(*) AS n FROM nsfw_hash_blocklist').get().n;
}
