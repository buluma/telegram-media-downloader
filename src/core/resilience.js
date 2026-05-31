/**
 * Resilience System - "The Immune System"
 * Proactively traps errors, decides on recovery, and keeps the process alive.
 */

import { logger, NATIVE_LOAD_FAIL, suppressNoise } from './logger.js';

export class Resilience {
    constructor() {
        this.maxLogSize = 1000;
        this.errorLogBuffer = new Array(this.maxLogSize);
        this.errorLogHead = 0;
        this.errorLogCount = 0;
        this.notifier = null;
        this.nativeLoadFailWarned = false;
        this.circuitBreakers = new Map();
    }

    setNotifier(notifier) {
        this.notifier = notifier;
    }

    init() {
        // Global Trap - only register once
        process.removeAllListeners('uncaughtException');
        process.removeAllListeners('unhandledRejection');

        process.on('uncaughtException', (err) => this.handleFatal('Uncaught Exception', err));
        process.on('unhandledRejection', (reason) =>
            this.handleFatal('Unhandled Rejection', reason),
        );

        logger.info('🛡️  Resilience System Active');
    }

    /**
     * Wrap critical async functions with automatic recovery
     */
    async guard(fn, context = 'Operation') {
        try {
            return await fn();
        } catch (error) {
            return this.handleError(error, context);
        }
    }

    handleFatal(type, error) {
        const msg = error?.message || String(error);

        // Suppress known noise
        if (
            suppressNoise(
                msg,
                type === 'Unhandled Rejection' ? 'unhandledRejection' : 'uncaughtException',
            )
        ) {
            return;
        }

        if (NATIVE_LOAD_FAIL.test(msg)) {
            if (!this.nativeLoadFailWarned) {
                this.nativeLoadFailWarned = true;
                logger.warn(
                    { msg: msg.slice(0, 200) },
                    '[startup] An optional native module failed to load. The dashboard will keep running; only the feature that triggered this load will be unavailable.',
                );
            }
            return;
        }

        logger.fatal({ err: error?.stack || String(error), type }, `💀 FATAL: ${type}`);
        this.logError(error, 'FATAL');

        // Specific recovery for common fatal-looking but recoverable errors
        if (error?.code === 'ECONNRESET' || msg.includes('Connection')) {
            logger.info('🔄 Emergency Reconnect logged (process stays alive)...');
            // We just let the process live; connection managers or retries should handle it.
            return;
        }

        // Non-native uncaught exceptions are real bugs — surface them and
        // crash so the watchdog can restart cleanly.
        if (type === 'Uncaught Exception') {
            process.emit('SIGTERM'); // Signal the server to gracefully close
            setTimeout(() => process.exit(1), 5000).unref();
        }
    }

    handleError(error, context) {
        // 1. Classify Error
        const msg = error?.message || String(error);
        const isNetwork = error?.code === 'ECONNRESET' || msg.includes('fetch');
        const isAuth = error?.errorMessage === 'AUTH_KEY_UNREGISTERED';
        const isFlood = error?.seconds || msg.includes('FLOOD_WAIT');

        // 2. Log
        logger.warn({ context, err: msg }, `⚠️ [${context}] ${msg}`);
        this.logError(error, context);

        // 3. Decide Action
        if (isFlood) {
            return { action: 'WAIT', duration: error.seconds || 60 };
        }
        if (isNetwork) {
            return { action: 'RETRY', delay: 5000 };
        }
        if (isAuth) {
            logger.error('❌ Session Invalid. Halting downloads. Login required.');
            process.emit('tgdl:auth_error');
            return;
        }

        // Default: Throw to caller if not handled
        throw error;
    }

    logError(error, context) {
        const entry = {
            timestamp: new Date().toISOString(),
            context,
            message: error?.message || String(error),
            stack: error?.stack,
        };

        this.errorLogBuffer[this.errorLogHead] = entry;
        this.errorLogHead = (this.errorLogHead + 1) % this.maxLogSize;
        if (this.errorLogCount < this.maxLogSize) this.errorLogCount++;
    }

    getLogs() {
        if (this.errorLogCount === 0) return [];
        if (this.errorLogCount < this.maxLogSize)
            return this.errorLogBuffer.slice(0, this.errorLogCount);
        return [
            ...this.errorLogBuffer.slice(this.errorLogHead, this.maxLogSize),
            ...this.errorLogBuffer.slice(0, this.errorLogHead),
        ];
    }
}

export const resilience = new Resilience();
