/**
 * Read-only SQLite worker pool.
 *
 * Runs heavy analytics queries (GROUP BY aggregations, large joins) on a
 * dedicated worker_thread so a cache miss on GET /api/ai/wd14/tags (or any
 * similar analytics endpoint) can never stall the main event loop.
 *
 * Design mirrors src/core/hash-worker.js:
 *   - Same-file dual-mode: worker entrypoint when isMainThread===false,
 *     parent pool when isMainThread===true.
 *   - Lazy pool — no workers until the first runQuery() call.
 *   - Env-tunable size: DB_READ_POOL_SIZE (default 1 — reads are infrequent
 *     but heavy; one worker avoids contention without wasting memory).
 *   - Hard kill-switch: DB_READ_WORKER_DISABLE=1 falls back to synchronous
 *     main-thread queries (same code path, byte-identical results).
 *
 * Key improvement over hash-worker.js: per-job TIMEOUT.
 *   hash-worker.js has no timeout, so a stalled FS read pins a pool slot
 *   and the in-flight promise never settles (root cause of the dedup hang).
 *   Here: DB_READ_TIMEOUT_MS (default 15 s) fires a worker terminate+replace
 *   on expiry, so a stuck SQLite read can never wedge the pool forever.
 *
 * Allowlist: jobs are { name, params } pairs, not raw SQL.  Only the names
 * registered in QUERIES (both sides) are accepted.  Adding a new heavy
 * query: register it in QUERIES on the worker side, and add a helper here
 * (or just call runQuery directly).
 *
 * Usage:
 *   import { runQuery, listWd14TagsAsync } from './read-worker.js';
 *   const tags = await listWd14TagsAsync({ minScore: 0.2, minCount: 1, limit: 500 });
 *
 * Configuration:
 *   DB_READ_POOL_SIZE=N       — worker count (1-8, default 1)
 *   DB_READ_WORKER_DISABLE=1  — skip pool, run inline on main thread
 *   DB_READ_TIMEOUT_MS=N      — ms before a stalled job is killed (default 15000)
 *   TGDL_READ_WORKER_DB=path  — DB path override (tests only; production uses DB_PATH)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(__dirname, 'read-worker.js');

// ============================================================================
// Shared query definitions — used on BOTH sides of the thread boundary.
// The worker side runs these; the parent side validates names against this set.
// ============================================================================

/**
 * Named query registry.  Each entry receives a prepared-statement cache
 * and returns rows synchronously (better-sqlite3 is always synchronous).
 *
 * @type {Record<string, (stmts: Map<string,object>, params: object) => object[]>}
 */
const QUERY_RUNNERS = {
    /**
     * Aggregate tag frequency across image_tags_wd14.
     * Mirrors listWd14Tags in src/core/db/faces.js exactly.
     */
    wd14Tags(stmts, { minScore = 0.2, minCount = 1, limit = 500 } = {}) {
        const ms = Math.max(0, Math.min(1, Number(minScore) || 0.2));
        const mc = Math.max(1, Number(minCount) || 1);
        const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
        const key = 'wd14Tags';
        if (!stmts.has(key)) {
            // stmts.db is the Database instance, set before first use.
            stmts.set(
                key,
                stmts.get('__db__').prepare(
                    `SELECT tag, COUNT(*) AS count, ROUND(AVG(score), 4) AS avg_score
                           FROM image_tags_wd14
                          WHERE tag != '_wd14_scanned_' AND score >= ?
                          GROUP BY tag HAVING COUNT(*) >= ?
                          ORDER BY COUNT(*) DESC, tag ASC LIMIT ?`,
                ),
            );
        }
        return stmts.get(key).all(ms, mc, lim);
    },
};

// ============================================================================
// Worker entrypoint (isMainThread === false)
// ============================================================================
if (!isMainThread) {
    const dbPath = (workerData && workerData.dbPath) || '';
    let _db = null;
    // Statement cache: Map<name, PreparedStatement> + '__db__' → Database
    const _stmts = new Map();

    function _ensureDb() {
        if (_db) return;
        _db = new Database(dbPath, { readonly: true });
        _db.pragma('journal_mode = WAL');
        _stmts.set('__db__', _db);
    }

    parentPort.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        const { jobId, name, params } = msg;

        try {
            _ensureDb();
        } catch (err) {
            parentPort.postMessage({
                jobId,
                ok: false,
                error: `DB open failed: ${err?.message || err}`,
            });
            return;
        }

        const runner = QUERY_RUNNERS[name];
        if (!runner) {
            parentPort.postMessage({ jobId, ok: false, error: `unknown query: ${name}` });
            return;
        }

        try {
            const rows = runner(_stmts, params || {});
            parentPort.postMessage({ jobId, ok: true, rows });
        } catch (err) {
            parentPort.postMessage({ jobId, ok: false, error: err?.message || String(err) });
        }
    });
}

// ============================================================================
// Parent-side pool (isMainThread === true)
// ============================================================================

function _resolveDbPath() {
    // Test override takes priority; production path comes from DB_PATH export.
    if (process.env.TGDL_READ_WORKER_DB) return process.env.TGDL_READ_WORKER_DB;
    // Lazy import of DB_PATH to avoid circular deps at module-load time.
    // We store it after first resolution.
    return null; // resolved lazily in _ensureDbPath()
}

let _dbPathResolved = null;
async function _ensureDbPath() {
    if (_dbPathResolved) return _dbPathResolved;
    if (process.env.TGDL_READ_WORKER_DB) {
        _dbPathResolved = process.env.TGDL_READ_WORKER_DB;
        return _dbPathResolved;
    }
    const { DB_PATH } = await import('../db.js');
    _dbPathResolved = DB_PATH;
    return _dbPathResolved;
}

const DISABLED = process.env.DB_READ_WORKER_DISABLE === '1';

function _resolvePoolSize() {
    const env = parseInt(process.env.DB_READ_POOL_SIZE, 10);
    if (Number.isFinite(env) && env >= 1) return Math.min(env, 8);
    return 1;
}

function _resolveTimeoutMs() {
    const env = parseInt(process.env.DB_READ_TIMEOUT_MS, 10);
    if (Number.isFinite(env) && env > 0) return env;
    return 15_000;
}

/** @type {{ worker: Worker, busy: boolean }[] | null} */
let _pool = null;
let _nextJobId = 1;
const _waiters = []; // { resolve, reject, name, params }
const _inFlight = new Map(); // jobId → { resolve, reject, slotIdx, timer }

function _slotForWorker(worker) {
    if (!_pool) return -1;
    return _pool.findIndex((s) => s.worker === worker);
}

function _makeSlot(dbPath) {
    const worker = new Worker(WORKER_FILE, {
        workerData: { dbPath },
    });
    const slot = { worker, busy: false };

    worker.on('message', (msg) => {
        const { jobId, ok, rows, error } = msg || {};
        const pending = _inFlight.get(jobId);
        if (!pending) return; // late delivery after timeout / worker reset
        clearTimeout(pending.timer);
        _inFlight.delete(jobId);
        slot.busy = false;
        if (ok) pending.resolve(rows);
        else pending.reject(new Error(error || 'read worker error'));
        _drainWaiters();
    });

    worker.on('error', (err) => {
        // Reject all in-flight jobs assigned to this slot.
        const idx = _slotForWorker(slot.worker);
        for (const [jid, p] of _inFlight) {
            if (p.slotIdx === idx) {
                clearTimeout(p.timer);
                _inFlight.delete(jid);
                p.reject(err);
            }
        }
        // Replace dead worker.
        if (idx >= 0 && _pool) _pool[idx] = _makeSlot(dbPath);
        _drainWaiters();
    });

    worker.on('exit', () => {
        const idx = _slotForWorker(slot.worker);
        if (idx >= 0 && _pool) _pool[idx] = _makeSlot(dbPath);
        _drainWaiters();
    });

    return slot;
}

function _drainWaiters() {
    if (!_pool || !_waiters.length) return;
    const timeoutMs = _resolveTimeoutMs();
    for (const slot of _pool) {
        if (!_waiters.length) break;
        if (slot.busy) continue;
        const job = _waiters.shift();
        const jobId = _nextJobId++;
        const slotIdx = _slotForWorker(slot.worker);
        slot.busy = true;

        // Per-job timeout: if the worker never responds, terminate + replace it.
        const timer = setTimeout(() => {
            const pending = _inFlight.get(jobId);
            if (!pending) return;
            _inFlight.delete(jobId);
            slot.busy = false;
            pending.reject(
                new Error(`read worker job '${job.name}' timed out after ${timeoutMs} ms`),
            );
            // Terminate the stuck worker and replace the slot so later jobs are not blocked.
            const idx = _slotForWorker(slot.worker);
            if (idx >= 0 && _pool) {
                slot.worker.terminate().catch(() => {});
                _pool[idx] = _makeSlot(slot.worker._dbPath || '');
            }
            _drainWaiters();
        }, timeoutMs);

        // Stash the dbPath so the replacement slot can reuse it.
        slot.worker._dbPath = job._dbPath;

        _inFlight.set(jobId, {
            resolve: job.resolve,
            reject: job.reject,
            slotIdx,
            timer,
        });

        try {
            slot.worker.postMessage({ jobId, name: job.name, params: job.params });
        } catch (err) {
            clearTimeout(timer);
            slot.busy = false;
            _inFlight.delete(jobId);
            job.reject(err);
        }
    }
}

async function _ensurePool() {
    if (_pool) return;
    if (DISABLED || !isMainThread) return;
    const dbPath = await _ensureDbPath();
    if (_pool) return; // concurrent _ensurePool() calls
    const size = _resolvePoolSize();
    _pool = [];
    for (let i = 0; i < size; i++) {
        const slot = _makeSlot(dbPath);
        slot.worker._dbPath = dbPath;
        _pool.push(slot);
    }
}

// ============================================================================
// Main-thread fallback (DISABLED=1 or non-main-thread context)
// ============================================================================

async function _runOnMainThread(name, params) {
    const dbPath = await _ensureDbPath();
    // Use a fresh read-only connection per call so we don't interfere with the
    // main connection's write transactions.
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    // Build a temporary statement cache and the '__db__' ref the runner expects.
    const stmts = new Map([['__db__', db]]);
    try {
        const runner = QUERY_RUNNERS[name];
        if (!runner) throw new Error(`unknown query: ${name}`);
        return runner(stmts, params || {});
    } finally {
        db.close();
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run a named analytics query off the main event loop (or inline when
 * the pool is disabled).  `name` must be a key of QUERY_RUNNERS; `params`
 * is passed through to the runner.
 *
 * @param {string} name
 * @param {object} [params]
 * @returns {Promise<object[]>}
 */
export async function runQuery(name, params = {}) {
    if (!(name in QUERY_RUNNERS)) {
        return Promise.reject(new Error(`unknown query: ${name}`));
    }
    if (DISABLED || !isMainThread) {
        return _runOnMainThread(name, params);
    }
    await _ensurePool();
    if (!_pool) return _runOnMainThread(name, params);
    return new Promise((resolve, reject) => {
        _waiters.push({ resolve, reject, name, params });
        _drainWaiters();
    });
}

/**
 * Convenience wrapper for the wd14Tags query.
 * Mirrors the sync `listWd14Tags` signature in src/core/db/faces.js.
 *
 * @param {{ minScore?: number, minCount?: number, limit?: number }} [opts]
 * @returns {Promise<Array<{ tag: string, count: number, avg_score: number }>>}
 */
export async function listWd14TagsAsync(opts = {}) {
    return runQuery('wd14Tags', opts);
}

/**
 * Tear the pool down — for tests and graceful-shutdown paths.
 * Idempotent.  Pending waiters are rejected; in-flight jobs get their
 * timers cleared (workers terminate naturally or via exit handler).
 */
export async function shutdownReadPool() {
    if (!_pool) return;
    const pool = _pool;
    _pool = null;
    _dbPathResolved = null;
    while (_waiters.length) {
        const w = _waiters.shift();
        w.reject(new Error('read worker pool shut down'));
    }
    for (const [jid, p] of _inFlight) {
        clearTimeout(p.timer);
        _inFlight.delete(jid);
        p.reject(new Error('read worker pool shut down'));
    }
    await Promise.all(pool.map((s) => s.worker.terminate().catch(() => {})));
}

/** Internal — exported for tests / diagnostics. */
export function _poolSize() {
    return _pool ? _pool.length : 0;
}
