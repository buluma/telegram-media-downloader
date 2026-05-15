/**
 * Resilience System - "The Immune System"
 * Proactively traps errors, decides on recovery, and keeps the process alive.
 */

import { logger } from './logger.js';

export class Resilience {
    constructor() {
        this.errorLog = [];
        this.notifier = null;
    }

    setNotifier(notifier) {
        this.notifier = notifier;
    }

    init() {
        // Global Trap
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
        logger.fatal({ err: error.stack || String(error), type }, `💀 FATAL: ${type}`);

        // Decide: Can we stay alive?
        // For production long-running, we might log and restart specific modules.
        // For CLI, we generally have to exit if state is corrupted.
        // But we want to avoid "silent" deaths.

        this.logError(error, 'FATAL');

        // Specific recovery for common fatal-looking but recoverable errors
        if (error.code === 'ECONNRESET' || error.message.includes('Connection')) {
            logger.info('🔄 Attempting Emergency Reconnect...');
            // Trigger external reconnect logic if possible
            return;
        }

        process.exit(1);
    }

    handleError(error, context) {
        // 1. Classify Error
        const isNetwork = error.code === 'ECONNRESET' || error.message.includes('fetch');
        const isAuth = error.errorMessage === 'AUTH_KEY_UNREGISTERED';
        const isFlood = error.seconds || error.message.includes('FLOOD_WAIT');

        // 2. Log
        logger.warn({ context, err: error.message }, `⚠️ [${context}] ${error.message}`);
        this.logError(error, context);

        // 3. Decide Action
        if (isFlood) {
            return { action: 'WAIT', duration: error.seconds || 60 };
        }
        if (isNetwork) {
            return { action: 'RETRY', delay: 5000 };
        }
        if (isAuth) {
            logger.error('❌ Session Invalid. Login required.');
            process.exit(1);
            // Tests stub process.exit; without an explicit return the throw
            // below would fire and turn a controlled shutdown into a rejection.
            return;
        }

        // Default: Throw to caller if not handled
        throw error;
    }

    logError(error, context) {
        this.errorLog.push({
            timestamp: new Date().toISOString(),
            context,
            message: error.message,
            stack: error.stack,
        });
        // Real production would append to errors.log here
    }
}

export const resilience = new Resilience();
