import { describe, it, expect } from 'vitest';
import { resolveSizeLimit, normalizeSizeLimit } from '../src/core/size-limit.js';

const cfg = (over = {}) => ({
    diskManagement: { maxVideoSize: '1GB', maxImageSize: '10MB' },
    groups: [
        { id: '-100', name: 'A' },
        { id: '-200', name: 'B', maxVideoSize: '500MB' },
        { id: '-300', name: 'C', maxVideoSize: 'none' },
        { id: '-400', name: 'D', maxVideoSize: '' },
    ],
    ...over,
});

describe('resolveSizeLimit', () => {
    it('falls back to the system default when the group sets nothing', () => {
        expect(resolveSizeLimit(cfg(), '-100', 'Video')).toBe('1GB');
        expect(resolveSizeLimit(cfg(), '-400', 'Video')).toBe('1GB');
    });

    it('falls back to the system default for a group that is not in config', () => {
        expect(resolveSizeLimit(cfg(), '-999', 'Video')).toBe('1GB');
        expect(resolveSizeLimit(cfg(), undefined, 'Video')).toBe('1GB');
    });

    it('uses the group limit over the system default', () => {
        expect(resolveSizeLimit(cfg(), '-200', 'Video')).toBe('500MB');
    });

    it('lets a group opt out of the system limit with "none"', () => {
        expect(resolveSizeLimit(cfg(), '-300', 'Video')).toBeNull();
    });

    it('matches group ids as strings (Telegram ids overflow numbers)', () => {
        const c = cfg({ groups: [{ id: '-1001234567890123', maxVideoSize: '2GB' }] });
        expect(resolveSizeLimit(c, '-1001234567890123', 'Video')).toBe('2GB');
        expect(resolveSizeLimit(c, -1001234567890123, 'Video')).toBe('2GB');
    });

    it('only overrides videos; other types keep the system default', () => {
        expect(resolveSizeLimit(cfg(), '-200', 'Image')).toBe('10MB');
        expect(resolveSizeLimit(cfg(), '-300', 'Image')).toBe('10MB');
        expect(resolveSizeLimit(cfg(), '-200', 'Document')).toBeUndefined();
    });

    it('uses the parent group for a comment: group with no entry of its own', () => {
        const c = cfg({ groups: [{ id: '-200', maxVideoSize: '500MB' }] });
        expect(resolveSizeLimit(c, 'comment:-200', 'Video')).toBe('500MB');
    });

    it('prefers a comment: group entry over its parent', () => {
        const c = cfg({
            groups: [
                { id: '-200', maxVideoSize: '500MB' },
                { id: 'comment:-200', maxVideoSize: '100MB' },
            ],
        });
        expect(resolveSizeLimit(c, 'comment:-200', 'Video')).toBe('100MB');
    });

    it('returns undefined with no config at all', () => {
        expect(resolveSizeLimit(undefined, '-1', 'Video')).toBeUndefined();
        expect(resolveSizeLimit({}, '-1', 'Video')).toBeUndefined();
    });
});

describe('normalizeSizeLimit', () => {
    it('accepts sizes and tidies them', () => {
        expect(normalizeSizeLimit('500MB')).toBe('500MB');
        expect(normalizeSizeLimit(' 1.5 gb ')).toBe('1.5GB');
        expect(normalizeSizeLimit('2tb')).toBe('2TB');
    });

    it('keeps "none" as the explicit no-limit marker', () => {
        expect(normalizeSizeLimit('none')).toBe('none');
        expect(normalizeSizeLimit('NONE')).toBe('none');
    });

    it('treats empty / null as "not set"', () => {
        expect(normalizeSizeLimit('')).toBeNull();
        expect(normalizeSizeLimit(null)).toBeNull();
        expect(normalizeSizeLimit(undefined)).toBeNull();
    });

    it('rejects anything it cannot parse', () => {
        for (const bad of ['lots', '10', 'MB', '-5MB', '5 parsecs', '0MB', 12, {}]) {
            expect(normalizeSizeLimit(bad), String(bad)).toBe(false);
        }
    });
});
