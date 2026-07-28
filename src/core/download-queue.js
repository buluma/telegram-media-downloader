import { EventEmitter } from 'events';
import { logger } from './logger.js';
import { pushQueueBacklog, queueBacklogSize, popQueueBacklog } from './db.js';

const DEFAULT_SPILLOVER_THRESHOLD = 2000;

export class QueueManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this._high = [];
        this.queue = [];
        this._jobs = new Map();
        this._paused = new Set();
        this._globalPaused = false;
        this._cancelling = new Set();
    }

    get pendingCount() {
        return this._high.length + this.queue.length;
    }

    async enqueue(job, priority = 1, isDownloadedCheck, activeKeys) {
        const key = `${job.groupId}_${job.message.id}`;
        job.key = key;
        if (!job.addedAt) job.addedAt = Date.now();

        // Dedup check (Memory + Active)
        if (activeKeys.has(key)) return false;
        if (this._jobs.has(key)) return false;
        if (isDownloadedCheck(job.groupId, job.message.id)) return false;

        const spillover =
            Number(this.config?.advanced?.downloader?.spilloverThreshold) ||
            DEFAULT_SPILLOVER_THRESHOLD;
        if (priority === 2 && this.queue.length > spillover) {
            try {
                pushQueueBacklog(job);
            } catch (e) {
                this.queue.push(job);
            }
            return true;
        }

        if (priority === 2) this.queue.push(job);
        else if (priority === 0) this._high.unshift(job);
        else this._high.push(job);

        this._jobs.set(key, job);

        this.emit('queue', this.pendingCount);
        this.emit('queue_changed', { key, op: 'enqueue' });
        return true;
    }

    dequeue() {
        if (this._globalPaused) return null;
        if (this.pendingCount === 0) return null;

        let job = this._high.shift() || this.queue.shift();

        // Skip paused jobs
        if (job) {
            let skips = 0;
            while (job && this._paused.has(job.key)) {
                // cycle back
                this.queue.push(job);
                job = this._high.shift() || this.queue.shift();
                skips++;
                if (skips >= this.pendingCount) {
                    job = null; // all jobs are paused
                    break;
                }
            }
        }

        if (job) {
            this._jobs.delete(job.key);
            this.emit('queue', this.pendingCount);
        }

        return job;
    }

    pauseJob(key) {
        if (!key) return false;
        this._paused.add(key);
        this.emit('queue_changed', { key, op: 'pause' });
        return true;
    }

    resumeJob(key) {
        if (!key) return false;
        const had = this._paused.delete(key);
        if (had) this.emit('queue_changed', { key, op: 'resume' });
        return had;
    }

    isPaused(key) {
        return this._globalPaused || this._paused.has(key);
    }

    cancelJob(key, activeKeys) {
        if (!key) return false;

        const before = this.pendingCount;
        this._high = this._high.filter((j) => j.key !== key);
        this.queue = this.queue.filter((j) => j.key !== key);
        const dequeued = this.pendingCount < before;

        const wasActive = activeKeys.has(key);
        if (wasActive) {
            this._cancelling.add(key);
        }

        this._jobs.delete(key);
        this._paused.delete(key);

        if (dequeued || wasActive) {
            this.emit('queue', this.pendingCount);
            this.emit('queue_changed', { key, op: 'cancel' });
            return true;
        }
        return false;
    }

    isCancelling(key) {
        return this._cancelling.has(key);
    }

    clearCancelling(key) {
        this._cancelling.delete(key);
    }

    pauseAll() {
        this._globalPaused = true;
        this.emit('queue_changed', { op: 'pause-all' });
    }

    resumeAll() {
        this._globalPaused = false;
        this._paused.clear();
        this.emit('queue_changed', { op: 'resume-all' });
    }

    cancelAllQueued() {
        const removed = this.pendingCount;
        for (const j of this._high) this._jobs.delete(j.key);
        for (const j of this.queue) this._jobs.delete(j.key);
        this._high = [];
        this.queue = [];
        this.emit('queue', this.pendingCount);
        this.emit('queue_changed', { op: 'cancel-all' });
        return removed;
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

    async rehydrateFromDisk() {
        try {
            if (queueBacklogSize() === 0) return false;
            const popped = popQueueBacklog(1000);
            if (!popped.length) return false;
            for (const job of popped) this.queue.push(job);
            return true;
        } catch {
            return false;
        }
    }

    getHigh() {
        return this._high;
    }
    getQueue() {
        return this.queue;
    }
    getJobs() {
        return this._jobs;
    }
    getPaused() {
        return this._paused;
    }
    getGlobalPaused() {
        return this._globalPaused;
    }
}
