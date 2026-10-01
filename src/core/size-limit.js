const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i;

/**
 * Validate a user-supplied size limit.
 *
 * @param {unknown} value
 * @returns {string|null|false}  a tidied size ("500MB"), `"none"` (explicit
 *   no limit), `null` for empty/unset, or `false` when it can't be parsed.
 */
export function normalizeSizeLimit(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (!s) return null;
    if (s.toLowerCase() === 'none') return 'none';
    const m = SIZE_RE.exec(s);
    if (!m || !(parseFloat(m[1]) > 0)) return false;
    return `${m[1]}${m[2].toUpperCase()}`;
}

/**
 * Size-limit string that applies to a download, e.g. "1GB".
 *
 * A group's `maxVideoSize` overrides the system `diskManagement.maxVideoSize`
 * for videos; `"none"` removes the limit for that group, and an unset value
 * falls back to the system default. Comment groups (`comment:<id>`) inherit
 * their parent group's override when they have no entry of their own. Other
 * media types always use the system default.
 *
 * @param {object} [config]
 * @param {string|number} [groupId]
 * @param {string} typeName  'Video' | 'Image' | ...
 * @returns {string|null|undefined}  null = explicitly unlimited, undefined = none configured
 */
export function resolveSizeLimit(config, groupId, typeName) {
    if (typeName === 'Video' && groupId != null) {
        const groups = config?.groups || [];
        const id = String(groupId);
        const group =
            groups.find((g) => String(g.id) === id) ??
            (id.startsWith('comment:')
                ? groups.find((g) => String(g.id) === id.slice('comment:'.length))
                : undefined);
        const own = group?.maxVideoSize;
        if (own === 'none') return null;
        if (own) return own;
    }
    return config?.diskManagement?.[`max${typeName}Size`];
}
