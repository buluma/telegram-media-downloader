// Covers the centralised media-URL builders in
// src/web/public/js/media-url.js. These are the single point where
// federated-gallery routing (own row vs. peer row) is decided, so a
// regression here silently sends every peer thumbnail to the local
// /api/thumbs route and renders broken tiles across the whole gallery.
//
// Pure functions, no DOM — imported directly, no jsdom.

import { describe, it, expect } from 'vitest';
import {
    getThumbUrl,
    getMediaUrl,
    getDownloadUrl,
    isPeerRow,
} from '../src/web/public/js/media-url.js';

describe('getThumbUrl', () => {
    it('builds the local route for own rows', () => {
        expect(getThumbUrl({ id: 42, peer_id: 'self' }, 320)).toBe('/api/thumbs/42?w=320');
    });

    it('treats a missing peer_id as an own row', () => {
        expect(getThumbUrl({ id: 42 }, 320)).toBe('/api/thumbs/42?w=320');
    });

    it('builds the cluster proxy route for peer rows', () => {
        expect(getThumbUrl({ id: 7, peer_id: 'heimdal' }, 160)).toBe(
            '/api/cluster/thumbs/heimdal/7?w=160',
        );
    });

    it('percent-encodes peer ids and row ids', () => {
        expect(getThumbUrl({ id: 'a/b', peer_id: 'peer one' }, 96)).toBe(
            '/api/cluster/thumbs/peer%20one/a%2Fb?w=96',
        );
    });

    it('returns null when the row has no id (sticker / placeholder tile)', () => {
        expect(getThumbUrl({ peer_id: 'self' }, 320)).toBeNull();
        expect(getThumbUrl({ id: null }, 320)).toBeNull();
        expect(getThumbUrl(null, 320)).toBeNull();
        expect(getThumbUrl(undefined, 320)).toBeNull();
    });

    it('keeps id 0 — a falsy but valid id', () => {
        expect(getThumbUrl({ id: 0 }, 320)).toBe('/api/thumbs/0?w=320');
    });
});

describe('getMediaUrl', () => {
    it('defaults to inline for own rows', () => {
        expect(getMediaUrl({ fullPath: 'downloads/cat.jpg' })).toBe(
            '/files/downloads%2Fcat.jpg?inline=1',
        );
    });

    it('appends the peer param for peer rows', () => {
        expect(getMediaUrl({ fullPath: 'a.jpg', peer_id: 'heimdal' })).toBe(
            '/files/a.jpg?inline=1&peer=heimdal',
        );
    });

    it('drops inline=1 when inline is explicitly false', () => {
        expect(getMediaUrl({ fullPath: 'a.jpg' }, { inline: false })).toBe('/files/a.jpg');
        expect(getMediaUrl({ fullPath: 'a.jpg', peer_id: 'p' }, { inline: false })).toBe(
            '/files/a.jpg?peer=p',
        );
    });

    it('only opts out of inline on an explicit false, not any falsy value', () => {
        expect(getMediaUrl({ fullPath: 'a.jpg' }, {})).toBe('/files/a.jpg?inline=1');
        expect(getMediaUrl({ fullPath: 'a.jpg' }, { inline: undefined })).toBe(
            '/files/a.jpg?inline=1',
        );
    });

    it('returns null without a fullPath', () => {
        expect(getMediaUrl({ id: 1 })).toBeNull();
        expect(getMediaUrl(null)).toBeNull();
        expect(getMediaUrl({ fullPath: '' })).toBeNull();
    });
});

describe('getDownloadUrl', () => {
    it('is getMediaUrl without the inline flag', () => {
        expect(getDownloadUrl({ fullPath: 'dir/file.mp4' })).toBe('/files/dir%2Ffile.mp4');
    });

    it('still routes peer rows through the peer param', () => {
        expect(getDownloadUrl({ fullPath: 'f.mp4', peer_id: 'heimdal' })).toBe(
            '/files/f.mp4?peer=heimdal',
        );
    });
});

describe('isPeerRow', () => {
    it('is true only for a peer_id other than self', () => {
        expect(isPeerRow({ peer_id: 'heimdal' })).toBe(true);
        expect(isPeerRow({ peer_id: 'self' })).toBe(false);
        expect(isPeerRow({})).toBe(false);
        expect(isPeerRow(null)).toBe(false);
    });

    it('returns a boolean, never a truthy string', () => {
        expect(typeof isPeerRow({ peer_id: 'heimdal' })).toBe('boolean');
    });
});
