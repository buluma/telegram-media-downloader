import fs from 'fs/promises';
import path from 'path';
import { gunzipSync } from 'zlib';

const IMAGE_EXT_BY_MIME = new Map([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
    ['image/heic', '.heic'],
    ['image/heif', '.heif'],
]);

const VIDEO_EXT_BY_MIME = new Map([
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
    ['video/webm', '.webm'],
    ['video/x-matroska', '.mkv'],
]);

const AUDIO_EXT_BY_MIME = new Map([
    ['audio/mpeg', '.mp3'],
    ['audio/ogg', '.ogg'],
    ['audio/wav', '.wav'],
    ['audio/flac', '.flac'],
    ['audio/mp4', '.m4a'],
]);

function _ascii(buf, start, end) {
    return buf.subarray(start, Math.min(end, buf.length)).toString('ascii');
}

function _boxBrand(buf) {
    if (buf.length < 12 || _ascii(buf, 4, 8) !== 'ftyp') return '';
    return _ascii(buf, 8, Math.min(buf.length, 64));
}

function _looksLikeMp4(buf) {
    return _boxBrand(buf) !== '';
}

function _isTgsGzip(buf, fullBytes) {
    if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return false;
    try {
        const inflated = gunzipSync(fullBytes || buf, { finishFlush: 2 });
        const head = inflated.subarray(0, 256).toString('utf8').trimStart();
        return head.startsWith('{') && /"tgs"\s*:\s*1/.test(head);
    } catch {
        return false;
    }
}

function fileTypeForMime(mime) {
    if (!mime) return null;
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
}

function extForMime(mime) {
    return (
        IMAGE_EXT_BY_MIME.get(mime) ||
        VIDEO_EXT_BY_MIME.get(mime) ||
        AUDIO_EXT_BY_MIME.get(mime) ||
        (mime === 'application/x-tgsticker' ? '.tgs' : null)
    );
}

/**
 * Sniff actual media type from file magic bytes. This is intentionally small
 * and dependency-free; it covers formats Telegram commonly produces and falls
 * back to extension-based handling for unknown documents.
 *
 * @returns {Promise<{mime:string|null, fileType:string|null, ext:string|null, confident:boolean}>}
 */
export async function sniffMediaFile(absPath) {
    const fh = await fs.open(absPath, 'r');
    try {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        const b = head.subarray(0, bytesRead);
        let mime = null;
        let ext = null;
        let confident = true;

        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
            mime = 'image/jpeg';
        } else if (
            b.length >= 8 &&
            b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ) {
            mime = 'image/png';
        } else if (b.length >= 12 && _ascii(b, 0, 4) === 'RIFF' && _ascii(b, 8, 12) === 'WEBP') {
            mime = 'image/webp';
        } else if (
            b.length >= 6 &&
            (_ascii(b, 0, 6) === 'GIF87a' || _ascii(b, 0, 6) === 'GIF89a')
        ) {
            mime = 'image/gif';
        } else if (_looksLikeMp4(b)) {
            const brand = _boxBrand(b);
            if (/M4A|M4B/i.test(brand)) mime = 'audio/mp4';
            else if (/heic|heix|hevc|hevx|mif1|msf1|avif/i.test(brand)) mime = 'image/heic';
            else if (/qt {2}/.test(brand)) mime = 'video/quicktime';
            else if (/isom|iso2|mp41|mp42|avc1|dash|MSNV|3gp/i.test(brand)) mime = 'video/mp4';
            else mime = 'video/mp4';
        } else if (
            b.length >= 4 &&
            b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        ) {
            mime = 'video/x-matroska';
        } else if (b.length >= 4 && _ascii(b, 0, 4) === 'OggS') {
            mime = 'audio/ogg';
        } else if (b.length >= 4 && _ascii(b, 0, 4) === 'fLaC') {
            mime = 'audio/flac';
        } else if (b.length >= 12 && _ascii(b, 0, 4) === 'RIFF' && _ascii(b, 8, 12) === 'WAVE') {
            mime = 'audio/wav';
        } else if (b.length >= 3 && _ascii(b, 0, 3) === 'ID3') {
            mime = 'audio/mpeg';
        } else if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
            mime = 'audio/mpeg';
        } else if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) {
            // Need the full gzip payload to recognise Telegram animated
            // sticker JSON. Keep the full read limited to this rare case.
            const full = await fs.readFile(absPath);
            if (_isTgsGzip(b, full)) mime = 'application/x-tgsticker';
            else mime = 'application/gzip';
        } else {
            confident = false;
        }

        ext = extForMime(mime);
        return { mime, fileType: fileTypeForMime(mime), ext, confident };
    } finally {
        await fh.close().catch(() => {});
    }
}

export function fileTypeFromExtension(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif'].includes(ext)) return 'photo';
    if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video';
    if (['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac'].includes(ext)) return 'audio';
    return 'document';
}
