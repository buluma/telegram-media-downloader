// Structured error swallowing — logs at debug/warn instead of silently
// discarding. Drop-in replacement for `catch {}` and `.catch(() => {})`
// at sites where failure is tolerable but should still be observable.
//
// Usage:
//   import { swallow, swallowAsync } from './util/swallow.js';
//
//   try { riskyOp(); } catch (e) { swallow(e, 'backup retention prune'); }
//   await riskyPromise().catch((e) => swallow(e, 'drain unlink'));
//   await riskyPromise().catch(swallowAsync('drain unlink'));

import { logger } from '../logger.js';

/**
 * Log a swallowed error at debug level (warn for non-ENOENT / non-abort).
 * Returns undefined so it can be used as an expression.
 *
 * @param {unknown} err
 * @param {string}  ctx  short label for the call site, e.g. 'backup upload'
 */
export function swallow(err, ctx) {
    if (!err) return;
    const msg = err?.message || String(err);
    const code = err?.code;
    // ENOENT and abort are genuinely expected in many paths — keep them quiet.
    if (code === 'ENOENT' || code === 'ABORT_ERR' || /\baborted?\b/i.test(msg)) {
        logger.debug({ ctx, code, err: msg }, `[swallow] ${ctx}`);
        return;
    }
    logger.warn({ ctx, code, err: msg }, `[swallow] ${ctx}`);
}

/**
 * Returns a `.catch()` handler that swallows with the given context.
 * Convenience for promise chains:
 *   `somePromise.catch(swallowAsync('label'))`
 *
 * @param {string} ctx
 * @returns {(err: unknown) => void}
 */
export function swallowAsync(ctx) {
    return (err) => swallow(err, ctx);
}
