import { logger } from './logger.js';

/**
 * Active Spam Defense System
 */
export class SpamGuard {
    constructor() {
        this.userRateLimits = new Map();
        this.contentHashes = new Map();
        this.interval = setInterval(() => this.cleanup(), 60000);
        this.interval.unref?.();
    }

    isSpam(message) {
        const userId = message.senderId ? String(message.senderId) : null;
        if (!userId) return false;

        // 1. User Rate Limit (Max 20 msgs / 5 sec)
        const now = Date.now();

        if (!this.userRateLimits.has(userId)) {
            this.userRateLimits.set(userId, { count: 1, reset: now + 5000 });
        } else {
            const entry = this.userRateLimits.get(userId);
            if (now > entry.reset) {
                entry.count = 1;
                entry.reset = now + 5000;
            } else {
                entry.count++;
                if (entry.count > 20) {
                    if (entry.count === 21)
                        logger.warn({ userId }, `🛡️  SpamGuard: Temp Ban User ${userId}`);
                    return true;
                }
            }
        }

        // 2. Duplicate Content Check
        let signature = null;
        if (message.message) signature = `txt:${message.message.slice(0, 50)}`;
        else if (message.document) signature = `doc:${message.document.size}`;
        else if (message.photo) signature = `img:${message.photo.id}`;

        if (signature) {
            if (!this.contentHashes.has(signature)) {
                this.contentHashes.set(signature, { count: 1, reset: now + 10000 });
            } else {
                const entry = this.contentHashes.get(signature);
                if (now > entry.reset) {
                    entry.count = 1;
                    entry.reset = now + 10000;
                } else {
                    entry.count++;
                    if (entry.count > 5) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    cleanup() {
        const now = Date.now();
        for (const [key, val] of this.userRateLimits) {
            if (now > val.reset + 60000) this.userRateLimits.delete(key);
        }
        for (const [key, val] of this.contentHashes) {
            if (now > val.reset + 60000) this.contentHashes.delete(key);
        }
    }
}
