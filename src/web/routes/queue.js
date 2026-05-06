import express from 'express';
import fs from 'fs/promises';
import path from 'path';

const QUEUE_HISTORY_CAP = 100;

/**
 * Queue routes + runtime event wiring.
 *
 * Drives the #/queue page. The page boots from /api/queue/snapshot, then
 * patches its in-memory store from WS events. Per-row + global actions live
 * under /api/queue/*.
 *
 * Recent (last N finished/failed) is persisted to disk so a page reload
 * doesn't drop the tail. Cap = 100, writes are fire-and-forget.
 *
 * @param {object} ctx
 * @param {string}   ctx.dataDir       Path to data directory
 * @param {string}   ctx.downloadsDir  Absolute path to downloads dir (for relPath stripping)
 * @param {object}   ctx.runtime       Runtime instance
 * @param {Function} ctx.broadcast     WebSocket broadcast
 */
export function createQueueRouter({ dataDir, downloadsDir, runtime, broadcast }) {
    const router = express.Router();
    const queueHistoryPath = path.join(dataDir, 'queue-history.json');

    let _queueHistory = []; // newest first
    let _queueHistoryDirty = false;
    let _queueHistoryFlushTimer = null;
    // Map<key, jobMeta> — keeps original job objects so /retry can re-enqueue
    // without the client having to round-trip the message ref.
    const _failedJobMeta = new Map();

    // Load persisted recent history on startup (best-effort).
    (async function loadQueueHistory() {
        try {
            const raw = await fs.readFile(queueHistoryPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) _queueHistory = parsed.slice(0, QUEUE_HISTORY_CAP);
        } catch { /* first-run, no file yet */ }
    })();

    function flushQueueHistorySoon() {
        _queueHistoryDirty = true;
        if (_queueHistoryFlushTimer) return;
        _queueHistoryFlushTimer = setTimeout(async () => {
            _queueHistoryFlushTimer = null;
            if (!_queueHistoryDirty) return;
            _queueHistoryDirty = false;
            try {
                await fs.mkdir(dataDir, { recursive: true });
                await fs.writeFile(queueHistoryPath, JSON.stringify(_queueHistory.slice(0, QUEUE_HISTORY_CAP)), 'utf-8');
            } catch (e) {
                console.error('queue-history.json write failed:', e?.message || e);
            }
        }, 1500).unref?.();
    }

    function pushQueueHistory(entry) {
        if (!entry || !entry.key) return;
        // Dedup by key — last write wins so a retry → success replaces the
        // old failed row instead of stacking duplicates.
        _queueHistory = [entry, ..._queueHistory.filter(e => e.key !== entry.key)].slice(0, QUEUE_HISTORY_CAP);
        flushQueueHistorySoon();
    }

    // Subscribe directly to the downloader's `error` event whenever the
    // runtime spins one up so we can stash the raw job (incl. live `message`
    // reference) for the retry path. The serialized payload broadcast over WS
    // strips `message`, which gramJS needs to actually re-download.
    runtime.on('state', (s) => {
        if (s.state !== 'running' || !runtime._downloader) return;
        const dl = runtime._downloader;
        if (dl.__queueWired) return;
        dl.__queueWired = true;
        dl.on('error', ({ job }) => {
            if (job?.key) _failedJobMeta.set(job.key, job);
        });
        dl.on('complete', (job) => {
            if (job?.key) _failedJobMeta.delete(job.key);
        });
    });

    // Capture finishes/failures off the runtime event stream so the snapshot
    // always has a populated "recent" tail even after a server restart.
    runtime.on('event', (e) => {
        if (e.type === 'download_complete' && e.payload) {
            const p = e.payload;
            // Normalise `filePath` to a path relative to downloadsDir
            // — the form the SPA's `/files/<path>?inline=1` route expects.
            //
            // The downloader's `buildPath()` defaults to `'./data/downloads'`,
            // so the emitted filePath is usually a RELATIVE string like
            // `data/downloads/<group>/images/<file>`. Older code path (before
            // v2.3.19) only stripped an ABSOLUTE prefix, which made every
            // queue-history entry ship with a literal `data/downloads/`
            // segment — and `/files/data/downloads/...` then got joined to
            // downloadsDir a second time and 404'd. Walk three forms:
            //   1. absolute under downloadsDir
            //   2. relative starting with `./data/downloads/` or `data/downloads/`
            //   3. already canonical `<group>/<type>/<file>` — leave alone
            let relPath = null;
            if (p.filePath) {
                let s = String(p.filePath).replace(/\\/g, '/');
                const absRoot = path.resolve(downloadsDir).replace(/\\/g, '/');
                if (s.startsWith(absRoot + '/')) {
                    relPath = s.slice(absRoot.length + 1);
                } else if (s.startsWith('./data/downloads/')) {
                    relPath = s.slice('./data/downloads/'.length);
                } else if (s.startsWith('data/downloads/')) {
                    relPath = s.slice('data/downloads/'.length);
                } else {
                    relPath = s;
                }
            }
            pushQueueHistory({
                key: p.key,
                groupId: String(p.groupId || ''),
                groupName: p.groupName || null,
                mediaType: p.mediaType || null,
                messageId: p.messageId ?? null,
                fileName: p.fileName || (p.filePath ? p.filePath.split(/[\\/]/).pop() : null),
                filePath: relPath,
                fileSize: p.fileSize || 0,
                status: 'done',
                // Surfaces "file was already on disk under another (group, msg)
                // mapping" — `registerDownload()` set this on dedup. The queue UI
                // renders a small "Duplicate" tag when present.
                deduped: p.deduped === true,
                addedAt: p.addedAt || null,
                finishedAt: Date.now(),
                error: null,
            });
            _failedJobMeta.delete(p.key);
        } else if (e.type === 'download_error' && e.payload?.job) {
            const p = e.payload.job;
            const errMsg = e.payload.error || 'Download failed';
            pushQueueHistory({
                key: p.key,
                groupId: String(p.groupId || ''),
                groupName: p.groupName || null,
                mediaType: p.mediaType || null,
                messageId: p.messageId ?? null,
                fileName: p.fileName || null,
                fileSize: p.fileSize || 0,
                status: 'failed',
                addedAt: p.addedAt || null,
                finishedAt: Date.now(),
                error: errMsg,
            });
        }
    });

    function requireDownloader(res) {
        if (!runtime._downloader) {
            res.status(409).json({ error: 'Engine is not running. Start the monitor first.' });
            return null;
        }
        return runtime._downloader;
    }

    router.get('/api/queue/snapshot', (req, res) => {
        try {
            const dl = runtime._downloader;
            const snap = dl ? dl.snapshot() : { active: [], queued: [], globalPaused: false, pausedCount: 0, workers: 0, pending: 0 };
            res.json({
                ...snap,
                recent: _queueHistory.slice(0, QUEUE_HISTORY_CAP),
                engineRunning: runtime.state === 'running',
                maxSpeed: (runtime._downloader?.config?.download?.maxSpeed) || null,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/queue/pause-all', (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        dl.pauseAll();
        broadcast({ type: 'queue_changed', payload: { op: 'pause-all' } });
        res.json({ success: true });
    });

    router.post('/api/queue/resume-all', (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        dl.resumeAll();
        broadcast({ type: 'queue_changed', payload: { op: 'resume-all' } });
        res.json({ success: true });
    });

    router.post('/api/queue/cancel-all', (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        const removed = dl.cancelAllQueued();
        broadcast({ type: 'queue_changed', payload: { op: 'cancel-all', removed } });
        res.json({ success: true, removed });
    });

    router.post('/api/queue/clear-finished', (req, res) => {
        _queueHistory = [];
        flushQueueHistorySoon();
        _failedJobMeta.clear();
        broadcast({ type: 'queue_changed', payload: { op: 'clear-finished' } });
        res.json({ success: true });
    });

    // Per-row routes. Keys look like "<chatId>_<messageId>"; URL-encode them.
    router.post('/api/queue/:key/pause', (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        const ok = dl.pauseJob(key);
        broadcast({ type: 'queue_changed', payload: { op: 'pause', key } });
        res.json({ success: ok });
    });

    router.post('/api/queue/:key/resume', (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        const ok = dl.resumeJob(key);
        broadcast({ type: 'queue_changed', payload: { op: 'resume', key } });
        res.json({ success: ok });
    });

    router.post('/api/queue/:key/cancel', async (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        // Best-effort delete of any partial file the worker may have left
        // behind. We don't know the exact path until the download path is
        // built (config-dependent), so this is intentionally a no-op for the
        // cases the downloader hasn't reached yet.
        const removed = dl.cancelJob(key);
        _failedJobMeta.delete(key);
        broadcast({ type: 'queue_changed', payload: { op: 'cancel', key } });
        res.json({ success: removed });
    });

    router.post('/api/queue/:key/retry', async (req, res) => {
        const dl = requireDownloader(res); if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        const meta = _failedJobMeta.get(key);
        if (!meta) {
            // No cached job means we never saw the original message — surface
            // a friendly error instead of silently doing nothing. The caller
            // can fall back to re-pasting the link from the viewer.
            return res.status(404).json({ error: 'Cannot retry: original job no longer in memory. Re-trigger from the source (link / backfill / monitor).' });
        }
        dl.retryJob(meta);
        broadcast({ type: 'queue_changed', payload: { op: 'retry', key } });
        res.json({ success: true });
    });

    router.post('/api/queue/retry-all', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        let retried = 0;
        const skippedKeys = [];
        for (const [key, meta] of _failedJobMeta) {
            if (!meta) {
                skippedKeys.push(key);
                continue;
            }
            try {
                dl.retryJob(meta);
                retried++;
            } catch (e) {
                skippedKeys.push(key);
            }
        }
        broadcast({ type: 'queue_changed', payload: { op: 'retry-all', retried } });
        res.json({ success: true, retried, skipped: skippedKeys.length });
    });

    // Multi-row batch action. Single endpoint instead of per-action routes so
    // the client can fire one request per user gesture regardless of action.
    // Continues past per-row failures so a single missing key doesn't abort
    // the whole batch.
    router.post('/api/queue/batch', async (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const { keys, action } = req.body || {};
        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ error: 'keys must be a non-empty array' });
        }
        const ALLOWED = new Set(['pause', 'resume', 'cancel', 'retry', 'dismiss']);
        if (!ALLOWED.has(action)) {
            return res.status(400).json({ error: `action must be one of: ${Array.from(ALLOWED).join(', ')}` });
        }
        let ok = 0;
        const failed = [];
        for (const rawKey of keys) {
            const key = String(rawKey || '');
            if (!key) {
                failed.push({ key: rawKey, reason: 'empty key' });
                continue;
            }
            try {
                if (action === 'pause') {
                    if (dl.pauseJob(key)) ok++;
                    else failed.push({ key, reason: 'not pausable' });
                } else if (action === 'resume') {
                    if (dl.resumeJob(key)) ok++;
                    else failed.push({ key, reason: 'not paused' });
                } else if (action === 'cancel') {
                    dl.cancelJob(key);
                    _failedJobMeta.delete(key);
                    ok++;
                } else if (action === 'retry') {
                    const meta = _failedJobMeta.get(key);
                    if (!meta) {
                        failed.push({ key, reason: 'meta evicted' });
                        continue;
                    }
                    dl.retryJob(meta);
                    ok++;
                } else if (action === 'dismiss') {
                    _failedJobMeta.delete(key);
                    ok++;
                }
            } catch (e) {
                failed.push({ key, reason: e?.message || 'unknown' });
            }
        }
        broadcast({
            type: 'queue_changed',
            payload: { op: 'batch', action, ok, failed: failed.length },
        });
        res.json({ success: true, ok, failed });
    });

    return router;
}
