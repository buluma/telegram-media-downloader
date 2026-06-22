// Tests for the free-standing getMediaType function extracted from the
// RealtimeMonitor class. Ensures the singleton removal didn't break
// media classification.

import { describe, it, expect, beforeAll } from 'vitest';

let getMediaType;
let _getMediaType;

beforeAll(async () => {
    const mod = await import('../src/core/monitor.js');
    getMediaType = mod.getMediaType;
    _getMediaType = mod._getMediaType;
});

describe('getMediaType (free function)', () => {
    it('classifies photos', () => {
        expect(getMediaType({ photo: true })).toBe('photos');
        expect(getMediaType({ media: { className: 'MessageMediaPhoto' } })).toBe('photos');
    });

    it('classifies videos', () => {
        expect(getMediaType({ video: true })).toBe('videos');
        expect(getMediaType({ videoNote: true })).toBe('videos');
    });

    it('classifies gifs', () => {
        expect(getMediaType({ video: true, gif: true })).toBe('gifs');
        expect(
            getMediaType({
                media: {
                    className: 'MessageMediaDocument',
                    document: { mimeType: 'image/gif' },
                },
            }),
        ).toBe('gifs');
    });

    it('classifies stickers', () => {
        expect(getMediaType({ sticker: true })).toBe('stickers');
        expect(
            getMediaType({
                media: {
                    className: 'MessageMediaDocument',
                    document: { mimeType: 'image/webp' },
                },
            }),
        ).toBe('stickers');
    });

    it('classifies voice and audio', () => {
        expect(getMediaType({ voice: true })).toBe('voice');
        expect(getMediaType({ audio: true })).toBe('audio');
    });

    it('falls back to files', () => {
        expect(getMediaType({ media: {} })).toBe('files');
    });

    it('_getMediaType alias works identically', () => {
        expect(_getMediaType({ photo: true })).toBe('photos');
        expect(_getMediaType).toBe(getMediaType);
    });
});
