// Global webp/sticker block — download.blockWebp config option.
//
// When download.blockWebp = true, sticker-type media is rejected regardless
// of what any individual group's sticker filter says.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock config manager so we can swap download.blockWebp at will ──────────
const _config = { download: { blockWebp: false }, groups: [], advanced: {} };
vi.mock('../src/config/manager.js', () => ({
    getConfig: () => _config,
    watchConfig: () => () => {},
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function stickerMessage() {
    return {
        id: 1,
        sticker: { id: BigInt(1) },
        media: { sticker: { id: BigInt(1) } },
        peerId: { channelId: BigInt(1) },
    };
}

function webpDocumentMessage() {
    return {
        id: 2,
        document: { mimeType: 'image/webp', size: BigInt(1000) },
        media: {
            className: 'MessageMediaDocument',
            document: { mimeType: 'image/webp', size: BigInt(1000) },
        },
        peerId: { channelId: BigInt(1) },
    };
}

function photoMessage() {
    return {
        id: 3,
        photo: { id: BigInt(2) },
        media: { className: 'MessageMediaPhoto', photo: { id: BigInt(2) } },
        peerId: { channelId: BigInt(1) },
    };
}

// ── import monitor helpers under test ────────────────────────────────────────
// We only need getMediaType and the isBlockedByGlobalWebpRule logic.
// Import the module after the mock is set up.

let getMediaType;
let isBlockedByGlobalWebpRule;

beforeEach(async () => {
    // Reset module registry so mock is picked up fresh
    vi.resetModules();
    const mod = await import('../src/core/monitor.js');
    // Monitor exports these helpers for testing
    getMediaType = mod._getMediaType;
    isBlockedByGlobalWebpRule = mod._isBlockedByGlobalWebpRule;
});

// ── getMediaType classification ──────────────────────────────────────────────

describe('getMediaType', () => {
    it('classifies sticker message as stickers', () => {
        expect(getMediaType(stickerMessage())).toBe('stickers');
    });

    it('classifies image/webp document as stickers', () => {
        expect(getMediaType(webpDocumentMessage())).toBe('stickers');
    });

    it('classifies photo as photos', () => {
        expect(getMediaType(photoMessage())).toBe('photos');
    });
});

// ── isBlockedByGlobalWebpRule ────────────────────────────────────────────────

describe('isBlockedByGlobalWebpRule', () => {
    it('returns false when blockWebp is false (default)', () => {
        _config.download.blockWebp = false;
        expect(isBlockedByGlobalWebpRule('stickers', _config)).toBe(false);
    });

    it('returns true for stickers when blockWebp is true', () => {
        _config.download.blockWebp = true;
        expect(isBlockedByGlobalWebpRule('stickers', _config)).toBe(true);
    });

    it('returns false for photos even when blockWebp is true', () => {
        _config.download.blockWebp = true;
        expect(isBlockedByGlobalWebpRule('photos', _config)).toBe(false);
    });

    it('returns false for videos even when blockWebp is true', () => {
        _config.download.blockWebp = true;
        expect(isBlockedByGlobalWebpRule('videos', _config)).toBe(false);
    });
});
