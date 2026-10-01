import { describe, it, expect } from 'vitest';
import { resolveCatchUpLimit } from '../src/core/catch-up-limit.js';
import { BACKFILL_MAX_LIMIT } from '../src/core/constants.js';

describe('resolveCatchUpLimit', () => {
    it('keeps the legacy 10x first-add limit when no catch-up limit is set', () => {
        expect(resolveCatchUpLimit({})).toBe(500);
        expect(resolveCatchUpLimit({ autoFirstLimit: 50 })).toBe(500);
        expect(resolveCatchUpLimit({ autoFirstLimit: 20 })).toBe(200);
    });

    it('treats an autoCatchUpLimit of 0 as automatic', () => {
        expect(resolveCatchUpLimit({ autoFirstLimit: 50, autoCatchUpLimit: 0 })).toBe(500);
    });

    it('uses autoCatchUpLimit on its own, independent of the first-add limit', () => {
        expect(resolveCatchUpLimit({ autoFirstLimit: 50, autoCatchUpLimit: 100 })).toBe(100);
        expect(resolveCatchUpLimit({ autoFirstLimit: 0, autoCatchUpLimit: 100 })).toBe(100);
    });

    it('is unbounded only when both limits are 0', () => {
        expect(resolveCatchUpLimit({ autoFirstLimit: 0 })).toBeNull();
        expect(resolveCatchUpLimit({ autoFirstLimit: 0, autoCatchUpLimit: 0 })).toBeNull();
    });

    it('never exceeds the global backfill ceiling', () => {
        expect(resolveCatchUpLimit({ autoCatchUpLimit: BACKFILL_MAX_LIMIT * 2 })).toBe(
            BACKFILL_MAX_LIMIT,
        );
        expect(resolveCatchUpLimit({ autoFirstLimit: BACKFILL_MAX_LIMIT })).toBe(
            BACKFILL_MAX_LIMIT,
        );
    });

    it('ignores garbage values', () => {
        expect(resolveCatchUpLimit({ autoCatchUpLimit: 'lots' })).toBe(500);
        expect(resolveCatchUpLimit({ autoCatchUpLimit: -5 })).toBe(500);
        expect(resolveCatchUpLimit(undefined)).toBe(500);
    });
});
