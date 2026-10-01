import { BACKFILL_MAX_LIMIT } from './constants.js';

/**
 * Message cap for the backfill spawned after a restart when a group fell
 * behind (`advanced.history.autoCatchUp`).
 *
 * `autoCatchUpLimit > 0` is used as-is. Otherwise it follows the first-add
 * limit at 10x (the original behaviour); both at 0 means unbounded. Always
 * clamped to the global backfill ceiling.
 *
 * @param {object} [histCfg]  `advanced.history` config block
 * @returns {number|null}  null = no cap
 */
export function resolveCatchUpLimit(histCfg) {
    const explicit = Number(histCfg?.autoCatchUpLimit);
    if (Number.isFinite(explicit) && explicit > 0) {
        return Math.min(explicit, BACKFILL_MAX_LIMIT);
    }
    const ceiling = Number(histCfg?.autoFirstLimit ?? 50);
    return ceiling > 0 ? Math.min(ceiling * 10, BACKFILL_MAX_LIMIT) : null;
}
