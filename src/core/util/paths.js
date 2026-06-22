// Path normalization helpers shared across providers, downloaders, and
// middleware. Replaces the 49+ scattered `replace(/\\/g,'/')` calls.

/**
 * Normalize a file path to forward slashes (POSIX style).
 * Safe on strings that are already forward-slash — a no-op in that case.
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosixPath(p) {
    return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}
