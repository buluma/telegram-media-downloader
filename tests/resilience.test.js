import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Resilience } from '../src/core/resilience.js';

describe('Resilience', () => {
    let r;

    beforeEach(() => {
        r = new Resilience();
    });

    describe('guard', () => {
        it('returns fn result on success', async () => {
            const result = await r.guard(async () => 42, 'test');
            expect(result).toBe(42);
        });

        it('calls handleError on throw', async () => {
            const networkErr = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
            const result = await r.guard(async () => { throw networkErr; }, 'test');
            expect(result).toEqual({ action: 'RETRY', delay: 5000 });
        });
    });

    describe('handleError', () => {
        it('returns WAIT action for flood errors (seconds field)', () => {
            const err = Object.assign(new Error('FLOOD_WAIT'), { seconds: 30 });
            const result = r.handleError(err, 'test');
            expect(result).toEqual({ action: 'WAIT', duration: 30 });
        });

        it('returns WAIT action with default 60s when seconds missing', () => {
            const err = new Error('FLOOD_WAIT exceeded');
            const result = r.handleError(err, 'test');
            expect(result).toEqual({ action: 'WAIT', duration: 60 });
        });

        it('returns RETRY action for ECONNRESET', () => {
            const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
            const result = r.handleError(err, 'test');
            expect(result).toEqual({ action: 'RETRY', delay: 5000 });
        });

        it('returns RETRY action for fetch errors', () => {
            const err = new Error('fetch error occurred');
            const result = r.handleError(err, 'test');
            expect(result).toEqual({ action: 'RETRY', delay: 5000 });
        });

        it('calls process.exit(1) for AUTH_KEY_UNREGISTERED', () => {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
            const err = Object.assign(new Error('auth failed'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
            r.handleError(err, 'test');
            expect(exitSpy).toHaveBeenCalledWith(1);
            exitSpy.mockRestore();
        });

        it('re-throws unclassified errors', () => {
            const err = new Error('something unknown');
            expect(() => r.handleError(err, 'test')).toThrow('something unknown');
        });

        it('logs error to errorLog', () => {
            const err = new Error('network fetch failed');
            r.handleError(err, 'ctx');
            expect(r.errorLog).toHaveLength(1);
            expect(r.errorLog[0].context).toBe('ctx');
            expect(r.errorLog[0].message).toBe('network fetch failed');
        });
    });

    describe('handleFatal', () => {
        it('returns without exiting for ECONNRESET', () => {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
            const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            r.handleFatal('Uncaught Exception', err);
            expect(exitSpy).not.toHaveBeenCalled();
            exitSpy.mockRestore();
        });

        it('returns without exiting for Connection errors', () => {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
            const err = new Error('Connection closed unexpectedly');
            r.handleFatal('Uncaught Exception', err);
            expect(exitSpy).not.toHaveBeenCalled();
            exitSpy.mockRestore();
        });

        it('exits for unrecoverable errors', () => {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
            const err = new Error('out of memory');
            r.handleFatal('Uncaught Exception', err);
            expect(exitSpy).toHaveBeenCalledWith(1);
            exitSpy.mockRestore();
        });

        it('logs fatal errors to errorLog', () => {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
            const err = new Error('fatal boom');
            r.handleFatal('test', err);
            expect(r.errorLog.some(e => e.message === 'fatal boom')).toBe(true);
            exitSpy.mockRestore();
        });
    });

    describe('logError', () => {
        it('appends entry with timestamp, context, message', () => {
            const err = new Error('oops');
            r.logError(err, 'myContext');
            expect(r.errorLog).toHaveLength(1);
            const entry = r.errorLog[0];
            expect(entry.context).toBe('myContext');
            expect(entry.message).toBe('oops');
            expect(entry.timestamp).toBeTruthy();
        });

        it('accumulates multiple entries', () => {
            r.logError(new Error('a'), 'ctx1');
            r.logError(new Error('b'), 'ctx2');
            expect(r.errorLog).toHaveLength(2);
        });
    });
});
