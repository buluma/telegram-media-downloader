/**
 * Download Manager - Multi-threaded downloads with deduplication
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Api } from 'telegram';
import { logger, DebugLogger } from './logger.js';
import {
    getDb,
    insertDownload,
    isDownloaded as dbIsDownloaded,
    kvSet,
    getTotalSizeBytes,
    pushQueueBacklog,
    popQueueBacklog,
    queueBacklogSize,
} from './db.js';
import { sha256OfFile, sha256OfFileViaPool } from './checksum.js';
import { pregenerateThumb } from './thumbs.js';
import { optimizeDownloadInBackground as faststartInBackground } from './faststart.js';
import { pregenerateNsfw } from './nsfw.js';
import { pregenerateAi } from './ai/index.js';
import { pregenerateSeekbar } from './seekbar/index.js';
import { fileTypeFromExtension, sniffMediaFile } from './media-sniff.js';
import { QueueManager } from './download-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Windows reserved device names — both bare and with any extension are
// rejected by the OS (`CON.jpg` is just as bad as `CON`). Match
// case-insensitively against the part BEFORE the first dot.
const _WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// Unicode invisible / zero-width / formatting chars that produce ghost
// folder names or confuse filesystem tools. Stripped before any other
// sanitisation. U+200D (ZWJ) included — emoji ZWJ sequences aren't
// useful in folder names and their components survive individually.
const _INVISIBLE_RE = new RegExp(
    '[' +
        '­' + // soft hyphen
        '͏' + // combining grapheme joiner
        '؜' + // Arabic letter mark
        'ᅟᅠ' + // Hangul fillers
        '឴឵' + // Khmer vowel inherent
        '᠎' + // Mongolian vowel separator
        '​-‏' + // ZW space, ZWNJ, ZWJ, LTR/RTL marks
        '‪-‮' + // bidi embedding/override
        '⁠-⁯' + // word joiner, invisible operators
        '⠀' + // Braille blank
        'ㅤ' + // Hangul filler ㅤ
        '︀-️' + // variation selectors
        '﻿' + // BOM / ZWNBS
        'ﾠ' + // halfwidth Hangul filler
        ']',
    'g',
);

/**
 * Shared folder + filename sanitizer.
 *
 * - Strips invisible / zero-width Unicode chars that produce ghost names.
 * - Strips path / control / NUL chars and collapses whitespace.
 * - Prefixes Windows reserved names with `_` so a chat literally named
 *   `CON` or a file like `PRN.jpg` doesn't ENOENT on Windows hosts.
 * - Truncates by **UTF-8 byte length** rather than UTF-16 char length
 *   (`.slice(80)` would silently corrupt multi-byte CJK / emoji at the
 *   boundary; we cut at a byte cap and back off to the last full
 *   codepoint).
 * - Falls back to `_unnamed` when stripping leaves nothing.
 */
export function sanitizeName(name) {
    const raw = String(name || '');
    let s = raw
        .replace(_INVISIBLE_RE, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    if (!s) {
        if (!raw || !_INVISIBLE_RE.test(raw)) return '_unnamed';
        let h = 0;
        for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
        return `_unnamed_${(h >>> 0).toString(36)}`;
    }
    if (_WIN_RESERVED.test(s)) s = '_' + s;
    return _truncUtf8(s, 80);
}

function _truncUtf8(s, maxBytes) {
    const enc = new TextEncoder();
    const dec = new TextDecoder('utf-8', { fatal: false });
    const bytes = enc.encode(s);
    if (bytes.length <= maxBytes) return s;
    // Walk back from maxBytes until we land on a UTF-8 codepoint boundary
    // (the high bits of a continuation byte are 10xxxxxx → 0x80..0xBF).
    let cut = maxBytes;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    return dec.decode(bytes.subarray(0, cut));
}

/**
 * Migrate old unsanitized folder names into sanitized ones (one-time startup)
 */
export async function migrateFolders(downloadPath) {
    const basePath = downloadPath || DOWNLOADS_DIR;
    try {
        if (!existsSync(basePath)) return;
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory());

        for (const dir of dirs) {
            const sanitized = sanitizeName(dir.name);
            if (sanitized === dir.name) continue; // Already clean

            const oldPath = path.join(basePath, dir.name);
            const newPath = path.join(basePath, sanitized);

            // Merge into sanitized folder
            await fs.mkdir(newPath, { recursive: true });
            const children = await fs.readdir(oldPath, { withFileTypes: true });

            for (const child of children) {
                const src = path.join(oldPath, child.name);
                const dst = path.join(newPath, child.name);

                if (child.isDirectory()) {
                    // Merge subdirectory
                    await fs.mkdir(dst, { recursive: true });
                    const subFiles = await fs.readdir(src);
                    for (const f of subFiles) {
                        const sf = path.join(src, f);
                        const df = path.join(dst, f);
                        if (!existsSync(df)) await fs.rename(sf, df);
                    }
                    // Remove old subdir if empty
                    const remaining = await fs.readdir(src);
                    if (remaining.length === 0) await fs.rmdir(src);
                } else {
                    // Merge file (append for .txt, skip-if-exists for others)
                    if (child.name.endsWith('.txt') && existsSync(dst)) {
                        const content = await fs.readFile(src, 'utf8');
                        await fs.appendFile(dst, content);
                        await fs.unlink(src);
                    } else if (!existsSync(dst)) {
                        await fs.rename(src, dst);
                    }
                }
            }

            // Remove old folder if empty
            try {
                const leftovers = await fs.readdir(oldPath);
                if (leftovers.length === 0) await fs.rmdir(oldPath);
            } catch (e) {}
        }
    } catch (e) {
        // Non-critical, silently skip
    }
}

// Inline defaults — kept here so every config.advanced?.downloader?.X read
// throughout this file shares the same fallback in case `advanced` is missing
// (e.g. an older config.json that pre-dates the Settings → Advanced panel).
const MIN_CONCURRENCY = 3;
const MAX_CONCURRENCY = 20;
const DEFAULT_SCALER_INTERVAL_MS = 5000;
const DEFAULT_IDLE_SLEEP_MS = 200;
const DEFAULT_SPILLOVER_THRESHOLD = 2000;

export class DownloadManager extends EventEmitter {
    constructor(client, config, rateLimiter) {
        super();
        this.client = client;
        this.config = config;
        this.rateLimiter = rateLimiter;
        // Two-lane queue logic extracted to QueueManager.
        this.queueManager = new QueueManager(config);

        Object.defineProperty(this, '_high', {
            get: () => this.queueManager.getHigh(),
            set: (v) => {
                this.queueManager._high = v;
            },
        });
        Object.defineProperty(this, 'queue', {
            get: () => this.queueManager.getQueue(),
            set: (v) => {
                this.queueManager.queue = v;
            },
        });
        Object.defineProperty(this, '_jobs', { get: () => this.queueManager.getJobs() });
        Object.defineProperty(this, '_paused', { get: () => this.queueManager.getPaused() });
        Object.defineProperty(this, '_globalPaused', {
            get: () => this.queueManager.getGlobalPaused(),
            set: (v) => {
                this.queueManager._globalPaused = v;
            },
        });
        Object.defineProperty(this, '_cancelling', {
            get: () => this.queueManager._cancelling,
            set: (v) => {
                this.queueManager._cancelling = v;
            },
        });

        this.queueManager.on('queue', (n) => this.emit('queue', n));
        this.queueManager.on('queue_changed', (evt) => this.emit('queue_changed', evt));

        this.enqueue = async (job, priority) => {
            if (job.fileSize == null) {
                try {
                    job.fileSize = this.getFileSize(job.message);
                } catch (e) {
                    logger.debug({ err: e.message }, 'Failed to get file size early hint');
                }
            }
            return this.queueManager.enqueue(
                job,
                priority,
                this.isDownloaded.bind(this),
                this.active,
            );
        };
        this.pauseJob = (key) => this.queueManager.pauseJob(key);
        this.resumeJob = (key) => this.queueManager.resumeJob(key);
        this.isPaused = (key) => this.queueManager.isPaused(key);
        this.cancelJob = (key) => this.queueManager.cancelJob(key, this.active);
        this.isCancelling = (key) => this.queueManager.isCancelling(key);
        this.pauseAll = () => this.queueManager.pauseAll();
        this.resumeAll = () => this.queueManager.resumeAll();
        this.cancelAllQueued = () => this.queueManager.cancelAllQueued();
        this.retryJob = (job) => this.queueManager.retryJob(job);
        this.rehydrateFromDisk = async () => this.queueManager.rehydrateFromDisk();

        this.active = new Map(); // Key -> Promise/Status
        // Absolute paths of files currently being written (.part + final
        // candidates). The disk-rotator consults this Set before unlinking
        // anything to avoid yanking a file out from under an active write.
        this._activeFilePaths = new Set();
        this.concurrency = config.download?.concurrent || 10;
        this.running = false;
        this.workers = [];
        this.workerCount = 0;
        this.LOG_DIR = LOGS_DIR;
        this._scalerInterval = null;
        this._consecutiveSuccess = 0; // Track success streak for scaling up

        // Ensure directories
        fs.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => {});
        fs.mkdir(LOGS_DIR, { recursive: true }).catch(() => {});
    }

    // Helper to constructing the exact InputLocation required by GramJS
    getInputLocation(message) {
        if (!message || typeof message !== 'object') return null;
        // 1. Check for Document
        let doc = message.document;
        if (!doc && message.media) {
            if (message.media.document) doc = message.media.document;
            else if (message.media.className === 'MessageMediaDocument')
                doc = message.media.document;
            else if (message.media.webpage && message.media.webpage.document)
                doc = message.media.webpage.document;
        }

        if (doc) {
            // Ensure fileReference is valid
            const fileRef = doc.fileReference || Buffer.alloc(0);
            return new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: fileRef,
                thumbSize: '', // Full size
            });
        }

        // 2. Check for Photo
        let photo = message.photo;
        if (!photo && message.media) {
            if (message.media.photo) photo = message.media.photo;
            else if (message.media.className === 'MessageMediaPhoto') photo = message.media.photo;
            else if (message.media.webpage && message.media.webpage.photo)
                photo = message.media.webpage.photo;
        }

        if (photo) {
            return new Api.InputPhotoFileLocation({
                id: photo.id,
                accessHash: photo.accessHash,
                fileReference: photo.fileReference || Buffer.alloc(0),
                thumbSize: 'y', // Largest usually
            });
        }

        return null;
    }

    async init() {
        this.emit('ready');
    }

    isDownloaded(groupId, messageId) {
        return dbIsDownloaded(groupId, messageId);
    }

    /**
     * Generate unique key using Telegram server-side IDs
     */
    generateKey(message) {
        const chatId =
            message.peerId?.channelId ||
            message.peerId?.chatId ||
            message.peerId?.userId ||
            message.chatId ||
            'unknown';
        return { key: `${chatId}_${message.id}`, groupId: String(chatId) };
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.workerCount = this.concurrency;
        for (let i = 0; i < this.concurrency; i++) {
            this.workers.push(this.runWorker(i));
        }
        this.emit('started', { workers: this.concurrency });

        // Dynamic scaler — tunable via config.advanced.downloader.scalerIntervalSec.
        const scalerSec = Number(this.config?.advanced?.downloader?.scalerIntervalSec);
        const scalerMs =
            Number.isFinite(scalerSec) && scalerSec > 0
                ? Math.floor(scalerSec * 1000)
                : DEFAULT_SCALER_INTERVAL_MS;
        this._scalerInterval = setInterval(() => this._autoScale(), scalerMs);
    }

    get pendingCount() {
        return this.queueManager.pendingCount;
    }

    _autoScale() {
        if (!this.running) return;
        const queueLen = this.pendingCount;
        const activeLen = this.active.size;
        const minC = Number(this.config?.advanced?.downloader?.minConcurrency) || MIN_CONCURRENCY;
        const maxC = Number(this.config?.advanced?.downloader?.maxConcurrency) || MAX_CONCURRENCY;

        // Scale UP: queue is building up, add more workers
        if (queueLen > this.workerCount * 2 && this.workerCount < maxC) {
            const add = Math.min(3, maxC - this.workerCount);
            for (let i = 0; i < add; i++) {
                const id = this.workerCount + i;
                this.workers.push(this.runWorker(id));
            }
            this.workerCount += add;
            this.concurrency = this.workerCount;
            this.emit('scale', { direction: 'up', workers: this.workerCount, queue: queueLen });
        }

        // Scale DOWN: queue is empty and few active, reduce target
        if (queueLen === 0 && activeLen < minC && this.workerCount > minC) {
            this.workerCount = Math.max(minC, activeLen + 1);
            this.concurrency = this.workerCount;
        }
    }

    /**
     * Called by FloodWait handler to throttle concurrency
     */
    throttle() {
        const minC = Number(this.config?.advanced?.downloader?.minConcurrency) || MIN_CONCURRENCY;
        this.workerCount = minC;
        this.concurrency = minC;
        this._consecutiveSuccess = 0;
        this.emit('scale', { direction: 'down', workers: minC, reason: 'flood' });
    }

    async stop() {
        this.running = false;
        if (this._scalerInterval) clearInterval(this._scalerInterval);

        // Flush pending disk usage save
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            await this.saveDiskUsageCache();
        }
    }

    /**
     * Re-enqueue a previously-failed job at the FRONT of the high lane so
     * a manual retry from the Queue page jumps the line. Caller passes the
     * raw job (the same shape originally handed to `enqueue`).
     */
    retryJob(job) {
        if (!job || !job.message) return false;
        const key = job.key || `${job.groupId}_${job.message.id}`;
        job.key = key;
        if (!job.addedAt) job.addedAt = Date.now();
        this._paused.delete(key);
        this._high.unshift(job);
        this._jobs.set(key, job);
        this.emit('queue', this.pendingCount);
        this.emit('queue_changed', { key, op: 'retry' });
        return true;
    }

    /**
     * Single-shot snapshot of the entire downloader state, used by the
     * Queue-page boot path (`GET /api/queue/snapshot`). Returns plain
     * JSON-serialisable data; the heavy `message` object stays inside
     * `_jobs` and is never emitted.
     */
    snapshot() {
        const mapJob = (job, status) => ({
            key: job.key,
            groupId: String(job.groupId || ''),
            groupName: job.groupName || null,
            mediaType: job.mediaType || null,
            messageId: job.message?.id ?? null,
            fileName: job.fileName || null,
            fileSize: job.fileSize || (job.message ? this.getFileSize(job.message) : 0) || 0,
            progress: 0,
            received: 0,
            total: 0,
            bps: 0,
            eta: null,
            status: this._paused.has(job.key) ? 'paused' : status,
            addedAt: job.addedAt || null,
            accountId: job.accountId || null,
            accountName: job.accountName || null,
        });
        const active = [];
        for (const [, st] of this.active) {
            const total = st.total || st.fileSize || 0;
            const received = st.received || 0;
            const bps = st.bps || 0;
            const eta = bps > 0 && total > received ? Math.round((total - received) / bps) : null;
            active.push({
                key: st.key,
                groupId: String(st.groupId || ''),
                groupName: st.groupName || null,
                mediaType: st.mediaType || null,
                messageId: st.message?.id ?? null,
                fileName: st.fileName || null,
                fileSize: total,
                progress: st.progress || 0,
                received,
                total,
                bps,
                eta,
                status: this._paused.has(st.key) ? 'paused' : 'active',
                addedAt: st.addedAt || st.startedAt || null,
                accountId: st.accountId || null,
                accountName: st.accountName || null,
            });
        }
        const queued = [];
        for (const j of this._high) queued.push(mapJob(j, 'queued'));
        for (const j of this.queue) queued.push(mapJob(j, 'queued'));
        return {
            active,
            queued,
            globalPaused: this._globalPaused,
            pausedCount: this._paused.size,
            workers: this.workerCount,
            pending: this.pendingCount,
        };
    }

    // --- SPILLOVER LOGIC ---
    // Backed by the queue_backlog SQLite table (was data/logs/queue_backlog.jsonl

    async runWorker(id) {
        while (this.running) {
            // 0. Globally paused? Spin without touching the lanes so resume
            //    is instantaneous.
            if (this._globalPaused) {
                await this.sleep(250);
                continue;
            }

            // 1. Drain high-priority (realtime) lane first, then history.
            let job = this._high.shift() || this.queue.shift();

            // 2. If RAM empty, check Disk Backlog
            if (!job) {
                const hasMore = await this.rehydrateFromDisk();
                if (hasMore) {
                    job = this._high.shift() || this.queue.shift();
                }
            }

            // 3. Still empty? Sleep.
            if (!job) {
                const idle =
                    Number(this.config?.advanced?.downloader?.idleSleepMs) || DEFAULT_IDLE_SLEEP_MS;
                await this.sleep(idle);
                continue;
            }

            // 4. Per-job pause: shove it to the back of the matching lane
            //    so other queued work keeps draining. Snapshot still shows
            //    it as 'paused' (see snapshot()).
            if (this._paused.has(job.key)) {
                this.queue.push(job);
                await this.sleep(150);
                continue;
            }

            // Belt-and-braces dedupe: if another worker already picked the
            // same key, put this copy back and let the first one finish.
            if (this.active.has(job.key)) {
                this.queue.push(job);
                await this.sleep(100);
                continue;
            }

            this.active.set(job.key, { ...job, workerId: id, progress: 0, startedAt: Date.now() });
            this._jobs.delete(job.key);
            this.emit('start', job);

            try {
                // Final Check DB before start (minimize race)
                if (this.isDownloaded(job.groupId, job.message.id)) {
                    this.active.delete(job.key);
                    continue;
                }

                const filePath = await this.download(job);
                this.emit('complete', { ...job, filePath });
            } catch (error) {
                await this.reportFailure(job, error.message);
                this.emit('error', { job, error: error.message });
            }

            this.active.delete(job.key);
        }
    }

    async reportFailure(job, reason) {
        const dl = DebugLogger();
        dl.error(new Error(reason), `Download Failed: ${job.key}`);
        // ALSO print to stdout so the user can see it in `docker logs`
        // without SSHing into the container to tail data/logs/errors.log.
        // Use process.stderr.write directly so the global console.error
        // wrap (which demotes gramJS reconnect chatter to network.log)
        // doesn't swallow real download failures.
        try {
            const safeName = String(job?.groupName || job?.groupId || '?');
            const mid = job?.message?.id ?? '?';
            process.stderr.write(`[downloader] FAILED ${safeName} #${mid}: ${reason}\n`);
        } catch (e) {
            logger.debug({ err: e.message }, 'Failed to write to stderr in reportFailure');
        }
    }

    async download(job, attempt = 1) {
        const maxRetries = this.config.download?.retries || 5;

        try {
            if (!job?.message || typeof job.message !== 'object') {
                const err = new Error('Invalid job payload: missing Telegram message object');
                err.nonRetryable = true;
                throw err;
            }
            // 1. Check Disk Quota
            if (this.config.diskManagement?.maxTotalSize) {
                const usage = await this.getDiskUsage();
                const limit = this.parseSize(this.config.diskManagement.maxTotalSize);
                if (usage > limit) {
                    throw new Error(`Disk Quota Exceeded: ${usage} / ${limit} bytes`);
                }
            }

            // 2. Prepare File Info & Check Limits
            const fileSize = this.getFileSize(job.message);
            const fileType = this.getFileTypeCategory(job.message);

            if (fileSize > 0 && fileType) {
                const typeName = fileType.charAt(0).toUpperCase() + fileType.slice(1); // 'Video', 'Image'
                const limitStr = this.config.diskManagement?.[`max${typeName}Size`];
                if (limitStr) {
                    const maxBytes = this.parseSize(limitStr);
                    if (fileSize > maxBytes) {
                        throw new Error(
                            `File too large (${this.formatBytes(fileSize)} > ${limitStr})`,
                        );
                    }
                }
            }

            const mediaInfo = this.describeDownloadableMedia(job.message);
            if (!mediaInfo.downloadable) {
                const err = new Error(
                    `Message has no downloadable media (${mediaInfo.description})`,
                );
                err.nonRetryable = true;
                throw err;
            }

            // 2b. Pre-download dedup: if a hash-verified file with the
            // same original Telegram filename + size already exists, skip
            // the download entirely and register a DB row pointing at the
            // existing file. Catches cross-group reposts without wasting
            // bandwidth on a full download + hash cycle.
            if (fileSize > 0 && attempt === 1) {
                const origName = this._getOriginalFilename(job.message);
                if (origName) {
                    try {
                        const existing = getDb()
                            .prepare(`
                                SELECT id, file_path, file_size, file_hash FROM downloads
                                 WHERE file_size = ? AND file_hash IS NOT NULL
                                 ORDER BY id ASC LIMIT 20
                            `)
                            .all(fileSize);
                        const match = existing.find((r) => {
                            const base = path.basename(r.file_path || '');
                            const ext = path.extname(base);
                            const origExt = path.extname(origName);
                            return (
                                ext === origExt &&
                                r.file_path &&
                                existsSync(
                                    path.isAbsolute(r.file_path)
                                        ? r.file_path
                                        : path.resolve(DOWNLOADS_DIR, r.file_path),
                                )
                            );
                        });
                        if (match) {
                            const storedPath = path.isAbsolute(match.file_path)
                                ? match.file_path
                                : path.resolve(DOWNLOADS_DIR, match.file_path);
                            const sniffedType = fileTypeFromExtension(storedPath);
                            const relPath = path.relative(DOWNLOADS_DIR, storedPath);
                            insertDownload({
                                groupId: String(job.groupId || 'unknown'),
                                groupName: job.groupName || null,
                                messageId: job.message.id,
                                fileName: path.basename(storedPath),
                                fileSize: match.file_size,
                                fileType: sniffedType,
                                filePath: relPath,
                                ttlSeconds: job.ttlSeconds || null,
                                fileHash: match.file_hash,
                                pendingUntil: job.pendingUntil || null,
                            });
                            this.emit('download_complete', {
                                filePath: relPath,
                                fileName: path.basename(storedPath),
                                size: match.file_size,
                                groupId: job.groupId,
                                groupName: job.groupName,
                                mediaType: job.mediaType,
                                message: job.message,
                                deduped: true,
                            });
                            return;
                        }
                    } catch {
                        // Non-fatal — fall through to normal download.
                    }
                }
            }

            // 3. Rate Limit
            if (this.rateLimiter && attempt === 1) await this.rateLimiter.acquire();

            // 4. Build Paths
            const finalPath = await this.buildPath(job);
            const partPath = `${finalPath}.part`;
            // Tell the disk-rotator: hands off these paths until we're done.
            // Both candidates go into the Set — the .part is the in-flight
            // write; finalPath is the rename target. The collision-suffix
            // path can't be predicted here but the .part is enough to guard
            // the dangerous moment.
            this._activeFilePaths.add(partPath);
            this._activeFilePaths.add(finalPath);

            // 5. Execute Download
            try {
                // Always start from a clean temp path. We don't depend on
                // gramJS resume semantics here; stale/truncated `.part` files
                // can cause immediate "0-byte success" on some media.
                try {
                    if (existsSync(partPath)) await fs.unlink(partPath);
                } catch (e) {
                    logger.debug(
                        { err: e.message, path: partPath },
                        'Failed to cleanup part file before download',
                    );
                }

                let prevBytes = 0n;
                let prevTs = Date.now();
                // Use the client that captured this job (poll/handler/resolver)
                // when present — falling back to the default client only for
                // legacy callers that haven't been updated to pass one.
                // Without this, every download went through the default
                // account, so a group that only the second/third account
                // could read silently failed (or pulled from the wrong
                // session) under multi-account setups.
                const dlClient = job.client || this.client;
                await dlClient.downloadMedia(job.message, {
                    outputFile: partPath,
                    progressCallback: (downloaded, total) => {
                        // Mid-flight cancel hook — Queue page → cancelJob()
                        // adds the key to `_cancelling`, throwing here makes
                        // gramJS reject the downloadMedia promise with our
                        // Cancelled error which the outer catch cleans up.
                        if (this.isCancelling(job.key)) {
                            const err = new Error('Cancelled');
                            err.cancelled = true;
                            throw err;
                        }
                        const downloadedN = BigInt(downloaded || 0);
                        const totalN = total ? BigInt(total) : 0n;
                        const pct = totalN ? Number((downloadedN * 100n) / totalN) : 0;
                        const now = Date.now();
                        const dtMs = Math.max(now - prevTs, 1);
                        const dB = Number(downloadedN - prevBytes);
                        const bps = dtMs > 50 ? Math.max(0, Math.round((dB * 1000) / dtMs)) : null;
                        if (dtMs > 200) {
                            prevTs = now;
                            prevBytes = downloadedN;
                        }

                        const active = this.active.get(job.key);
                        if (active) {
                            active.progress = pct;
                            active.received = Number(downloadedN);
                            active.total = Number(totalN);
                            if (bps !== null) active.bps = bps;
                        }
                        this.emit('progress', {
                            key: job.key,
                            groupId: job.groupId,
                            groupName: job.groupName,
                            mediaType: job.mediaType,
                            messageId: job.message?.id,
                            received: Number(downloadedN),
                            total: Number(totalN),
                            progress: pct,
                            bps,
                            accountId: job.accountId || null,
                            accountName: job.accountName || null,
                        });
                    },
                });
                // Belt-and-braces: gramJS may finish a tiny clip before any
                // progress tick fires, so check once more here. If cancel
                // was requested between dequeue and now, drop the .part.
                if (this.isCancelling(job.key)) {
                    this._cancelling.delete(job.key);
                    try {
                        if (existsSync(partPath)) await fs.unlink(partPath);
                    } catch (e) {
                        logger.debug(
                            { err: e.message, path: partPath },
                            'Failed to cleanup part file on cancel',
                        );
                    }
                    const err = new Error('Cancelled');
                    err.cancelled = true;
                    throw err;
                }

                // 7. Success — atomic rename + post-condition verify.
                //
                // The .part file is on the same fs as finalPath (same dir),
                // so `fs.rename` is atomic on POSIX. Re-stat the FINAL path
                // after the rename to defend against the rare case where the
                // rename returns success but the inode is gone (NFS, fuse,
                // overlay-on-overlay quirks). If the final file is missing
                // or zero bytes, treat the whole download as failed so the
                // retry path runs instead of registering a dead DB row.
                const partStats = await fs.stat(partPath);
                if (!partStats.size) {
                    try {
                        await fs.unlink(partPath);
                    } catch (e) {
                        logger.debug(
                            { err: e.message, path: partPath },
                            'Failed to cleanup 0-byte part file',
                        );
                    }
                    throw new Error(
                        `Downloaded file is empty (0 bytes); expected=${fileSize || 'unknown'}; media=${mediaInfo.description}`,
                    );
                }
                // Collision guard: `fs.rename` silently overwrites an
                // existing destination on every major platform, so two
                // accounts that produced the same final filename for
                // different content (rare but possible — same msg via
                // a forwarded copy etc.) would silently clobber. If the
                // target exists, suffix `(1)`, `(2)` … until we land on
                // a free name before the rename.
                let writtenPath = finalPath;
                if (existsSync(writtenPath)) {
                    const ext = path.extname(writtenPath);
                    const stem = writtenPath.slice(0, writtenPath.length - ext.length);
                    let i = 1;
                    while (i < 1000 && existsSync(`${stem} (${i})${ext}`)) i++;
                    writtenPath = `${stem} (${i})${ext}`;
                }
                await fs.rename(partPath, writtenPath);
                let finalStats;
                try {
                    finalStats = await fs.stat(writtenPath);
                } catch (e) {
                    throw new Error(`Post-rename verify failed: ${e.message}`);
                }
                if (!finalStats.size) {
                    try {
                        await fs.unlink(writtenPath);
                    } catch (e) {
                        logger.debug(
                            { err: e.message, path: writtenPath },
                            'Failed to cleanup 0-byte final file',
                        );
                    }
                    throw new Error(
                        `Final file is 0 bytes after rename; expected=${fileSize || 'unknown'}; media=${mediaInfo.description}`,
                    );
                }
                return await this.registerDownload(job, writtenPath, finalStats.size);
            } catch (error) {
                try {
                    if (existsSync(partPath)) await fs.unlink(partPath);
                } catch (cleanupErr) {}
                throw error;
            } finally {
                // Hand control of the paths back to the rotator regardless
                // of how this attempt ended (success, failure, retry,
                // cancel). A leaked entry here would silently freeze that
                // path against future deletion forever.
                this._activeFilePaths.delete(partPath);
                this._activeFilePaths.delete(finalPath);
            }
        } catch (error) {
            // User-initiated cancel — don't retry, don't report as failure.
            // The .part is already gone (cleanup in inner catch). Emit a
            // cancelled event so the Queue page can flip the row state.
            if (error?.cancelled) {
                if (this._cancelling) this._cancelling.delete(job.key);
                this.emit('cancelled', { key: job.key, groupId: job.groupId });
                this.emit('queue_changed', { key: job.key, op: 'cancel' });
                return; // swallow — runWorker treats absence of throw as "done"
            }

            if (error?.nonRetryable) throw error;

            if (error.errorMessage === 'FLOOD_WAIT' || error.message?.includes('FLOOD_WAIT')) {
                const seconds = error.seconds || 60;
                this.throttle(); // Dynamic: reduce concurrency on flood
                if (this.rateLimiter) await this.rateLimiter.pauseForFloodWait(seconds);
                else await this.sleep(seconds * 1000);
                // Bug fixed in v2.3.6: previously `return this.download(job, attempt)`
                // (no bump) — a sustained throttle would tight-loop forever
                // because `attempt` never crossed `maxRetries`. Track FloodWait
                // attempts on a SEPARATE counter so a transient flood doesn't
                // burn the normal retry budget, but a persistent one still
                // gives up cleanly.
                const floods = (job._floodAttempts = (job._floodAttempts || 0) + 1);
                const MAX_FLOOD_RETRIES = 8;
                if (floods <= MAX_FLOOD_RETRIES) {
                    return this.download(job, attempt);
                }
                throw new Error(
                    `FloodWait retry cap (${MAX_FLOOD_RETRIES}) exceeded for ${job.fileName || job.key}`,
                );
            }

            if (
                error.message?.includes('FILE_REFERENCE_EXPIRED') ||
                error.errorMessage === 'FILE_REFERENCE_EXPIRED'
            ) {
                if (attempt < maxRetries) {
                    try {
                        const refreshClient = job.client || this.client;
                        const messages = await refreshClient.getMessages(job.message.peerId, {
                            ids: [job.message.id],
                        });
                        if (messages && messages.length > 0) {
                            job.message = messages[0];
                            return this.download(job, attempt + 1);
                        }
                    } catch (e) {}
                }
            }

            if (attempt < maxRetries) {
                const delay = 1000 * attempt;
                this.emit('retry', { job, attempt, delay, error: error.message });
                await this.sleep(delay);
                return this.download(job, attempt + 1);
            }

            throw error;
        }
    }

    async registerDownload(job, filePath, size) {
        const groupId = job.groupId || 'unknown';
        const msgId = job.message.id;

        // ---- Download-time dedup (SHA-256) -------------------------------
        //
        // Hash the just-written file and check whether the same content is
        // already on disk under a previous DB row. If it is, drop the new
        // copy and point this row at the existing file. Net effect: no
        // duplicate bytes on disk, but the (group, message) → file mapping
        // is still recorded so the gallery shows the file in this group too.
        //
        // Failures here are non-fatal: any error (read failure, permission)
        // falls through and stores the row with the file in place. The
        // /api/maintenance/dedup catch-up scan will pick it up later.
        let fileHash = null;
        let storedPath = filePath;
        let storedSize = size;
        let bytesAddedToDisk = size;
        let sniffedType = null;
        try {
            // Trust bytes over Telegram metadata/extension. Some Telegram
            // uploads arrive as `photo` with a .jpg name while the payload is
            // actually MP4/TGS. Normalise before hashing/inserting so image
            // scanners never try to decode videos as JPEGs.
            try {
                const normalised = await this.normaliseDownloadedMediaPath(storedPath);
                storedPath = normalised.filePath;
                sniffedType = normalised.fileType;
                if (normalised.changed) {
                    console.warn(
                        `[downloader] corrected media type ${normalised.mime || 'unknown'}: ${path.basename(filePath)} -> ${path.basename(storedPath)} (${sniffedType})`,
                    );
                }
            } catch (e) {
                console.warn('[downloader] media sniff failed:', e?.message || e);
            }

            // Hash on a worker thread so the main event loop stays free
            // during multi-GB post-write hashing. Falls back automatically
            // to the in-process streamer if the pool is disabled.
            try {
                fileHash = await sha256OfFileViaPool(storedPath);
            } catch {
                fileHash = await sha256OfFile(storedPath);
            }
            // Match on hash AND size — size match guards against the
            // (vanishingly improbable) SHA-256 collision and rejects rows
            // with a NULL/zero size from older downloader versions.
            const dup = getDb()
                .prepare(`
                SELECT id, file_path, file_size FROM downloads
                 WHERE file_hash = ? AND file_size = ?
                 ORDER BY id ASC
                 LIMIT 1
            `)
                .get(fileHash, size);
            if (dup && dup.file_path) {
                // Confirm the existing pointer still resolves before we
                // unlink the freshly downloaded copy — otherwise we'd end
                // up with TWO DB rows pointing at a missing file.
                const dupAbs = path.isAbsolute(dup.file_path)
                    ? dup.file_path
                    : path.resolve(DOWNLOADS_DIR, dup.file_path);
                if (existsSync(dupAbs)) {
                    try {
                        await fs.unlink(storedPath);
                    } catch {
                        /* leave stale; integrity sweep handles it */
                    }
                    storedPath = dupAbs; // share the existing on-disk file
                    bytesAddedToDisk = 0; // no new bytes written
                    storedSize = dup.file_size; // exactly equal to `size` here
                }
            } else {
                // No local match — try the cluster catalog. If a paired peer
                // already holds this hash, drop the local bytes and store a
                // synthetic `_clusterref/<peerId>/<remoteId>` path. The
                // /files bridge resolves it transparently to a remote stream.
                try {
                    const { findHashAcrossCluster, clusterRefPath, recordDedupHit } = await import(
                        './cluster/dedup.js'
                    ).catch(() => ({}));
                    if (typeof findHashAcrossCluster === 'function') {
                        const hits = findHashAcrossCluster(fileHash, size);
                        const winner = hits.find((h) => h.peerStatus !== 'offline') || hits[0];
                        if (winner) {
                            try {
                                await fs.unlink(storedPath);
                            } catch {
                                /* leave stale; integrity sweep handles it */
                            }
                            // Encode the synthetic path. `path.relative` later
                            // would break it, so override storedPath to a marker
                            // and let the insert receive the synthetic value.
                            storedPath = path.join(
                                DOWNLOADS_DIR,
                                clusterRefPath(winner.peerId, winner.remoteId),
                            );
                            bytesAddedToDisk = 0;
                            storedSize = winner.fileSize || size;
                            recordDedupHit({
                                peerId: winner.peerId,
                                fileHash,
                                fileSize: storedSize,
                                remoteId: winner.remoteId,
                            });
                        }
                    }
                } catch {
                    /* cluster module not loaded — single-peer mode, no-op */
                }
            }
        } catch (e) {
            // Hash failed (very rare — file disappeared between rename and
            // open). Fall through and store the row with the new file path.
            console.warn('[downloader] dedup hash failed:', e?.message || e);
        }

        // DB Insert
        try {
            // Prefer content-sniffed type; fall back to extension for
            // unknown documents / legacy formats.
            const type = sniffedType || fileTypeFromExtension(storedPath);

            const insertResult = insertDownload({
                groupId: String(groupId),
                groupName: job.groupName || null,
                messageId: msgId,
                fileName: path.basename(storedPath),
                fileSize: storedSize,
                fileType: type,
                filePath: path.relative(DOWNLOADS_DIR, storedPath),
                ttlSeconds: job.ttlSeconds || null,
                fileHash,
                // Rescue Mode: when the monitor stamps `pendingUntil` on the
                // job, the row gets inserted with that expiry so the rescue
                // sweeper can prune it later (unless a delete event rescues
                // it first).
                pendingUntil: job.pendingUntil || null,
            });
            // Pre-generate the default-width thumbnail in the background so
            // the FIRST gallery scroll already finds the WebP in cache. The
            // generator queues behind the per-kind concurrency caps so this
            // never starves on-demand requests; failures (no cover art,
            // unreadable container) are silent and the on-demand path will
            // try again later.
            const newId = insertResult?.lastInsertRowid;
            if (newId) {
                // Background, fire-and-forget. Both are no-ops when their
                // respective features are disabled; thumbs is always-on,
                // NSFW is opt-in via config.advanced.nsfw.enabled.
                try {
                    pregenerateThumb(newId);
                } catch (e) {
                    logger.warn({ err: e.message }, 'pregenerateThumb failed');
                }
                try {
                    pregenerateNsfw(newId);
                } catch (e) {
                    logger.warn({ err: e.message }, 'pregenerateNsfw failed');
                }
                try {
                    // Priority hint: realtime monitor jobs (priority 1) +
                    // TTL/self-destruct unshifts (priority 0) jump ahead
                    // of history backfill (priority 2) so live ingest
                    // never starves behind a 100k-row backfill.
                    const priority = job?.priority < 2 ? 'realtime' : 'backfill';
                    pregenerateAi(newId, { priority });
                } catch (e) {
                    logger.warn({ err: e.message }, 'pregenerateAi failed');
                }
                // Faststart-optimise newly-downloaded MP4s so the
                // gallery's HTML5 player can seek + start audio
                // without waiting for the entire mdat to stream
                // through. No-op for non-MP4 / already-optimised rows
                // (the inner function decides by file extension, not
                // just `file_type`, so operator-mode downloads that
                // land as `'document'` but ARE `.mp4` still benefit).
                // Background, fire-and-forget; runs after the thumb so
                // the first paint of the gallery sees the cached
                // preview before the (slightly larger) file replaces
                // the original on disk. Runs for every priority lane
                // (realtime, TTL, history backfill) — backfilled files
                // benefit from faststart as much as live ingests.
                try {
                    faststartInBackground(newId);
                } catch (e) {
                    logger.warn({ err: e.message }, 'faststartInBackground failed');
                }
                // Seekbar sprite pregenerate — gated internally by
                // cfg.advanced.seekbar.{enabled, autoOnDownload}. Runs
                // AFTER faststart so the sprite matches the final byte
                // layout (faststart rewrites the moov atom, shifting
                // frame offsets — a sprite taken before that would
                // still render correctly but differ in hash from a
                // post-faststart sample).
                try {
                    const priority = job?.priority < 2 ? 'realtime' : 'backfill';
                    pregenerateSeekbar(newId, { priority });
                } catch (e) {
                    logger.warn({ err: e.message }, 'pregenerateSeekbar failed');
                }
            }
        } catch (e) {
            console.error('DB Insert Error', e);
        }

        // Only count the new bytes against the disk budget — a deduped
        // download added zero bytes, so the rotator quota stays accurate.
        if (bytesAddedToDisk > 0) this.incrementDiskUsage(bytesAddedToDisk);

        const wasDeduped = bytesAddedToDisk === 0;
        // Stash the flag on the job so the queue loop's `complete` event
        // payload (`{ ...job, filePath }`) carries `deduped` through to
        // runtime.js → broadcast → queue.js, which surfaces a "Duplicate"
        // tag on the row.
        try {
            job.deduped = wasDeduped;
        } catch {
            /* job object frozen — old path */
        }

        this.emit('download_complete', {
            filePath: storedPath,
            fileName: path.basename(storedPath),
            size: storedSize,
            groupId,
            groupName: job.groupName,
            message: job.message,
            mediaType: job.mediaType,
            // Surfaces the dedup result for monitor logs / future UI.
            deduped: wasDeduped,
        });

        return storedPath;
    }

    async normaliseDownloadedMediaPath(filePath) {
        const sniff = await sniffMediaFile(filePath);
        const fileType = sniff.fileType || fileTypeFromExtension(filePath);
        const wantedExt = sniff.ext || path.extname(filePath).toLowerCase() || '.bin';
        const folder =
            fileType === 'photo'
                ? 'images'
                : fileType === 'video'
                  ? 'videos'
                  : fileType === 'audio'
                    ? 'audio'
                    : 'documents';

        const currentExt = path.extname(filePath).toLowerCase();
        const currentDir = path.basename(path.dirname(filePath));
        const needsExt = wantedExt && currentExt !== wantedExt;
        const needsFolder = currentDir !== folder;
        if (!needsExt && !needsFolder) {
            return { filePath, fileType, mime: sniff.mime, changed: false };
        }

        const groupDir = path.dirname(path.dirname(filePath));
        const targetDir = path.join(groupDir, folder);
        await fs.mkdir(targetDir, { recursive: true });
        const parsed = path.parse(filePath);
        const baseName = `${parsed.name}${needsExt ? wantedExt : parsed.ext}`;
        let target = path.join(targetDir, baseName);
        if (existsSync(target) && path.resolve(target) !== path.resolve(filePath)) {
            const p = path.parse(target);
            let i = 1;
            while (i < 1000 && existsSync(path.join(p.dir, `${p.name} (${i})${p.ext}`))) i++;
            target = path.join(p.dir, `${p.name} (${i})${p.ext}`);
        }
        if (path.resolve(target) !== path.resolve(filePath)) {
            await fs.rename(filePath, target);
        }
        return { filePath: target, fileType, mime: sniff.mime, changed: true };
    }

    describeDownloadableMedia(message) {
        const media = message?.media || null;
        const cls = media?.className || message?.className || typeof media;
        let resolved = media;
        if (media instanceof Api.MessageMediaWebPage || cls === 'MessageMediaWebPage') {
            const wp = media.webpage || media.webPage;
            resolved = wp?.document || wp?.photo || null;
        }
        const resolvedCls = resolved?.className || resolved?.constructor?.name || typeof resolved;
        const downloadable = Boolean(
            message?.photo ||
                message?.document ||
                resolved instanceof Api.MessageMediaPhoto ||
                resolved instanceof Api.Photo ||
                resolved instanceof Api.MessageMediaDocument ||
                resolved instanceof Api.Document ||
                resolvedCls === 'MessageMediaPhoto' ||
                resolvedCls === 'Photo' ||
                resolvedCls === 'MessageMediaDocument' ||
                resolvedCls === 'Document',
        );
        const mime =
            resolved?.document?.mimeType || resolved?.mimeType || message?.document?.mimeType || '';
        return {
            downloadable,
            description: `${cls || 'unknown'}${resolved && resolved !== media ? `->${resolvedCls}` : ''}${mime ? ` mime=${mime}` : ''}`,
        };
    }

    _getOriginalFilename(message) {
        if (!message || typeof message !== 'object') return null;
        const doc = message.document || message.media?.document;
        if (!doc) return null;
        for (const attr of doc.attributes || []) {
            if (attr.fileName) return attr.fileName;
        }
        return null;
    }

    getFileSize(message) {
        if (!message || typeof message !== 'object') return 0;
        if (message.document) return Number(message.document.size);
        if (message.photo) {
            const sizes = message.photo.sizes;
            if (sizes && sizes.length > 0) {
                const last = sizes[sizes.length - 1];
                return last.size || 0;
            }
        }
        return 0;
    }

    getFileTypeCategory(message) {
        if (!message || typeof message !== 'object') return null;
        if (message.photo) return 'image';
        if (message.video) return 'video';
        if (message.voice || message.audio) return 'audio';
        if (message.document) return 'document';
        return null;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const dm = 2;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    async getDiskUsage() {
        // Keep quota enforcement aligned with the rotator and dashboard:
        // count non-evicted download rows, not the legacy disk_usage cache.
        try {
            const total = getTotalSizeBytes();
            if (Number.isFinite(total)) {
                this._diskUsageCache = { size: total, timestamp: Date.now() };
                this.saveDiskUsageCache();
                return total;
            }
        } catch (e) {}

        const total = await this.scanDiskDeep();
        this._diskUsageCache = { size: total, timestamp: Date.now() };
        this.saveDiskUsageCache();
        return total;
    }

    async scanDiskDeep() {
        let total = 0;
        let visitsSinceYield = 0;
        const basePath = this.config.download?.path || './data/downloads';
        // Yield to the event loop every YIELD_EVERY entries so a tree with
        // hundreds of thousands of files doesn't starve WS broadcasts /
        // health probes / queue progress for the duration of the walk.
        // See CLAUDE.md → Big-data patterns rule 2.
        const YIELD_EVERY = 100;
        const calculateSize = async (dir) => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                const files = [];
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await calculateSize(fullPath);
                        visitsSinceYield++;
                    } else {
                        files.push(fullPath);
                    }
                }

                const BATCH_SIZE = 50;
                for (let i = 0; i < files.length; i += BATCH_SIZE) {
                    const batch = files.slice(i, i + BATCH_SIZE);
                    const stats = await Promise.all(
                        batch.map((f) => fs.stat(f).catch(() => ({ size: 0 }))),
                    );
                    for (const s of stats) total += s.size || 0;

                    visitsSinceYield += batch.length;
                    if (visitsSinceYield >= YIELD_EVERY) {
                        visitsSinceYield = 0;
                        await new Promise((r) => setImmediate(r));
                    }
                }
            } catch (e) {}
        };
        await calculateSize(basePath);
        return total;
    }

    async saveDiskUsageCache() {
        let size = this._diskUsageCache?.size;
        if (!Number.isFinite(size)) {
            try {
                size = getTotalSizeBytes();
            } catch {
                return;
            }
        }
        try {
            kvSet('disk_usage', {
                size,
                lastScan: Date.now(),
                source: 'downloads_db',
            });
        } catch (e) {}
    }

    incrementDiskUsage(bytes) {
        this._diskUsageCache = null;
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => this.saveDiskUsageCache(), 10000);
    }

    parseSize(str) {
        const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
        const match = String(str).match(/^(\d+(\.\d+)?)\s*([A-Za-z]+)$/);
        if (!match) return Infinity;
        const val = parseFloat(match[1]);
        const unit = match[3].toUpperCase();
        return val * (units[unit] || 1);
    }

    async buildPath(job) {
        const basePath = this.config.download?.path || './data/downloads';
        const groupDir = this.sanitize(job.groupName || 'Unknown');

        let typeFolder = 'others';
        const type = job.mediaType || this.getFileTypeCategory(job.message);

        if (type === 'photos' || type === 'image') typeFolder = 'images';
        else if (type === 'videos' || type === 'video') typeFolder = 'videos';
        else if (type === 'audio' || type === 'voice') typeFolder = 'audio';
        else if (type === 'gifs') typeFolder = 'gifs';
        else if (type === 'stickers') typeFolder = 'stickers';
        else typeFolder = 'documents';

        const fullDir = path.join(basePath, groupDir, typeFolder);
        await fs.mkdir(fullDir, { recursive: true });

        const filename = this.generateFilename(job);
        return path.join(fullDir, filename);
    }

    generateFilename(job) {
        const msg = job.message;
        const ext = this.getExtension(msg);
        // Defensive: msg.date can be missing/NaN on stories or self-destruct
        // events — `new Date(NaN).toISOString()` throws "Invalid time value"
        // and used to bubble up as a Download Failed for the whole job.
        // Fall back to wall-clock so the file lands somewhere sensible.
        const epochSec = Number.isFinite(msg?.date) ? msg.date : Math.floor(Date.now() / 1000);
        const d = new Date(epochSec * 1000);
        const timestamp = (Number.isNaN(d.getTime()) ? new Date() : d)
            .toISOString()
            .replace(/[:.]/g, '-')
            .slice(0, 19);
        return `${timestamp}_${msg?.id ?? 'noid'}${ext}`;
    }

    getExtension(message) {
        if (!message || typeof message !== 'object') return '.bin';
        if (message.photo) return '.jpg';
        if (message.video) return '.mp4';
        if (message.voice) return '.ogg';
        if (message.audio) return '.mp3';
        if (message.videoNote) return '.mp4';
        if (message.sticker) return '.webp';

        if (message.document) {
            const attrs = message.document.attributes || [];
            for (const attr of attrs) {
                if (attr.fileName) {
                    const ext = path.extname(attr.fileName);
                    if (ext) return ext;
                }
            }
            return '.bin';
        }
        return '.bin';
    }

    sanitize(name) {
        return sanitizeName(name);
    }

    getStatus() {
        return {
            queued: this.pendingCount,
            active: this.active.size,
            completed: 0, // Could track via counter if needed
            downloads: Array.from(this.active.values()),
        };
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
