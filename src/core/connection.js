/**
 * Connection Health Checker
 * Keeps the connection alive and reconnects if dropped
 */

import { logger } from './logger.js';

export class ConnectionManager {
    constructor(client, options = {}) {
        this.client = client;
        this.interval = options.interval || 60000; // Check every 60s
        this.running = false;
        this.timer = null;
        this.failures = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.check(); // Initial check
        this.timer = setInterval(() => this.check(), this.interval);
        // Don't keep the process alive just for the health-check timer.
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
        logger.info('💓 Connection health check started');
    }

    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async check() {
        if (!this.running) return;

        try {
            // 1. Check if connected property is true
            if (!this.client.connected) {
                throw new Error('Client disconnected');
            }

            // 2. Verified active ping (optional, lightweight)
            // getMe is cached by gramjs usually, so it's cheap but confirms session is valid
            // We can also use client.checkAuthorization() -> returns true/false
            const authorized = await this.client.checkAuthorization();
            if (!authorized) {
                throw new Error('Session invalid');
            }

            // Reset failures if successful
            this.failures = 0;
        } catch (error) {
            this.failures++;
            logger.warn({ attempt: this.failures, err: error.message }, '⚠️ Connection lost');

            try {
                // Force reconnect
                await this.client.disconnect();
                await this.client.connect();
                logger.info('✅ Reconnected successfully');
                this.failures = 0;
            } catch (reconnectError) {
                logger.error({ err: reconnectError.message }, '❌ Reconnect failed');
                // Will try again next interval
            }
        }
    }
}
