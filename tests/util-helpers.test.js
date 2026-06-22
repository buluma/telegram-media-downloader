// Tests for shared utility helpers: toPosixPath and swallow.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// toPosixPath is a pure function — no setup needed.
let toPosixPath;
let swallow;
let swallowAsync;

beforeEach(async () => {
    ({ toPosixPath } = await import('../src/core/util/paths.js'));
    ({ swallow, swallowAsync } = await import('../src/core/util/swallow.js'));
});

describe('toPosixPath', () => {
    it('replaces backslashes with forward slashes', () => {
        expect(toPosixPath('foo\\bar\\baz')).toBe('foo/bar/baz');
    });

    it('leaves forward slashes unchanged', () => {
        expect(toPosixPath('foo/bar/baz')).toBe('foo/bar/baz');
    });

    it('handles mixed slashes', () => {
        expect(toPosixPath('foo\\bar/baz\\qux')).toBe('foo/bar/baz/qux');
    });

    it('returns empty string for non-string input', () => {
        expect(toPosixPath(null)).toBe('');
        expect(toPosixPath(undefined)).toBe('');
        expect(toPosixPath(42)).toBe('');
    });

    it('handles empty string', () => {
        expect(toPosixPath('')).toBe('');
    });

    it('handles Windows-style absolute paths', () => {
        expect(toPosixPath('C:\\Users\\me\\file.txt')).toBe('C:/Users/me/file.txt');
    });
});

describe('swallow', () => {
    it('does not throw on null/undefined', () => {
        expect(() => swallow(null, 'test')).not.toThrow();
        expect(() => swallow(undefined, 'test')).not.toThrow();
    });

    it('does not throw on ENOENT', () => {
        const err = new Error('file not found');
        err.code = 'ENOENT';
        expect(() => swallow(err, 'test')).not.toThrow();
    });

    it('does not throw on abort', () => {
        const err = new Error('aborted');
        err.code = 'ABORT_ERR';
        expect(() => swallow(err, 'test')).not.toThrow();
    });

    it('does not throw on real errors', () => {
        expect(() => swallow(new Error('disk full'), 'test')).not.toThrow();
    });
});

describe('swallowAsync', () => {
    it('returns a function', () => {
        const handler = swallowAsync('test');
        expect(typeof handler).toBe('function');
    });

    it('returned function does not throw', () => {
        const handler = swallowAsync('test');
        expect(() => handler(new Error('boom'))).not.toThrow();
    });

    it('works as a .catch handler', async () => {
        const p = Promise.reject(new Error('fail')).catch(swallowAsync('test'));
        await expect(p).resolves.toBeUndefined();
    });
});
