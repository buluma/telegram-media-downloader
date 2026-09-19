/**
 * Video trim/clip — cut a [startSec, endSec) range out of an existing video
 * download and save it as a brand new downloads row, leaving the source
 * untouched.
 *
 * Uses stream-copy (`-c copy`), the same approach as faststart.js's remux:
 * no re-encode, so a multi-minute clip finishes in a fraction of a second
 * once ffmpeg has seeked to the cut point. The tradeoff (shared with any
 * `-c copy` trim) is that the cut can only land on the source's existing
 * keyframes — the clip may start up to one GOP early. Frame-exact trimming
 * would need `-c:v libx264` re-encode instead; not implemented here, see
 * SHA-149 for the tradeoff writeup.
 *
 * Row identity: a clip keeps its source's group_id (so it sits in the same
 * gallery grouping) but needs a message_id distinct from every real
 * Telegram message in that group — `downloads` has `UNIQUE(group_id,
 * message_id)` and a collision would make `insertDownload`'s `INSERT OR
 * IGNORE` silently no-op. Real message_ids are always positive, so clips
 * take negative ids from a dedicated, monotonically-decreasing kv counter
 * — guaranteed never to collide, and to survive a restart without reuse.
 */

import path from 'path';
import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { kvGet, kvSet } from './db/kv.js';
import { getDownloadById, insertDownload } from './db/downloads.js';
import { resolveFfmpegBin, resolveFfprobeBin } from './thumbs.js';
import { toPosixPath } from './util/paths.js';
import { swallow } from './util/swallow.js';
import { safeResolveDownload } from '../web/lib/resolve-download.js';

const CLIP_MSG_ID_KV = 'clip_message_id_seq';

// Same set faststart.js treats as MP4/ISOBMFF-family containers where a
// `-c copy` trim + `+faststart` remux is meaningful.
const CLIPPABLE_EXTS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);

// Cached like thumbs.js's own resolveFfmpegBin/resolveFfprobeBin — a
// spawnSync per request would block the event loop for the full process
// spawn on every single clip call, worse on slower/AV-scanned hosts.
// `null` means "not checked yet"; a real check runs at most once per
// process (an operator installing ffmpeg mid-run needs a restart to pick
// it up, same as every other binary-presence check in this codebase).
let _hasFfmpegCached = null;

export function hasFfmpeg() {
    if (_hasFfmpegCached !== null) return _hasFfmpegCached;
    try {
        // Both binaries matter: ffmpeg does the trim, ffprobe verifies the
        // output. Checking only ffmpeg let a broken/missing ffprobe surface
        // as a misleading "clip failed verification" on every request
        // instead of a clear "not available" up front.
        const ff = spawnSync(resolveFfmpegBin(), ['-version'], { windowsHide: true });
        const fp = spawnSync(resolveFfprobeBin(), ['-version'], { windowsHide: true });
        _hasFfmpegCached = ff.status === 0 && fp.status === 0;
    } catch {
        _hasFfmpegCached = false;
    }
    return _hasFfmpegCached;
}

function _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(resolveFfmpegBin(), args, { windowsHide: true });
        const errChunks = [];
        p.stderr.on('data', (c) => errChunks.push(c));
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) {
                const stderr = Buffer.concat(errChunks).toString('utf8');
                return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 400)}`));
            }
            resolve();
        });
    });
}

export function probeDuration(absPath) {
    return new Promise((resolve) => {
        const p = spawn(
            resolveFfprobeBin(),
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', absPath],
            { windowsHide: true },
        );
        const out = [];
        p.stdout.on('data', (c) => out.push(c));
        p.on('error', () => resolve(null));
        p.on('close', (code) => {
            if (code !== 0) return resolve(null);
            try {
                const parsed = JSON.parse(Buffer.concat(out).toString('utf8'));
                const d = Number(parsed?.format?.duration);
                resolve(Number.isFinite(d) ? d : null);
            } catch {
                resolve(null);
            }
        });
    });
}

/** Next negative, never-reused message_id for a synthetic (non-Telegram) row. */
function _nextClipMessageId() {
    const prev = Number(kvGet(CLIP_MSG_ID_KV)) || 0;
    const next = prev - 1; // starts at -1, then -2, -3, …
    kvSet(CLIP_MSG_ID_KV, next);
    return next;
}

/**
 * Trim `[startSec, endSec)` out of download `id` and save it as a new
 * downloads row in the same group.
 *
 * Returns one of:
 *   { status:'ok', id, fileName, filePath, fileSize, durationSec }
 *   { status:'error', error }
 */
export async function createClip(id, startSec, endSec) {
    const dlId = parseInt(id, 10);
    if (!Number.isInteger(dlId) || dlId <= 0) return { status: 'error', error: 'Invalid id' };

    const start = Number(startSec);
    const end = Number(endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        return { status: 'error', error: 'Invalid range: startSec must be >= 0 and < endSec' };
    }

    const row = getDownloadById(dlId);
    if (!row) return { status: 'error', error: 'Download not found' };

    // Same operator-mode tolerance as faststart.js: an MP4 sometimes lands
    // as file_type='document' when Telegram doesn't set the video
    // attribute, so decide by extension too, not just file_type. Checked
    // before touching disk so "not a video" and "file missing" don't get
    // reported as each other.
    const ext = path.extname(row.file_path || '').toLowerCase();
    if ((row.file_type !== 'video' && row.file_type !== 'document') || !CLIPPABLE_EXTS.has(ext)) {
        return { status: 'error', error: 'Not a video' };
    }
    // Canonical resolver (also used by every downloads.js route) — real
    // traversal/symlink-escape hardening via realpath containment, not
    // just an existsSync check. See SHA-149 review: the module's own
    // resolver had none of that.
    const sr = await safeResolveDownload(row.file_path);
    if (!sr.ok) return { status: 'error', error: 'Source file not found on disk' };
    const abs = sr.real;
    if (!hasFfmpeg()) return { status: 'error', error: 'ffmpeg not available' };

    const duration = await probeDuration(abs);
    if (duration !== null && end > duration + 0.25) {
        // +0.25s slack for float/container rounding — a genuine
        // beyond-the-end request should still be rejected.
        return {
            status: 'error',
            error: `Requested end (${end}s) exceeds source duration (${duration.toFixed(2)}s)`,
        };
    }

    const dir = path.dirname(abs);
    const base = path.basename(abs, ext);
    // A short random suffix, not just the rounded start/end seconds — two
    // trims whose bounds round to the same integer second (a re-trim of a
    // near-identical range, or a retried request) would otherwise produce
    // the same outName and the second fs.rename below would silently
    // overwrite the first clip's file while insertDownload still created a
    // second, now-dangling DB row pointing at the same path.
    const uniq = randomBytes(3).toString('hex');
    const outName = `${base}.clip-${Math.round(start)}s-${Math.round(end)}s-${uniq}${ext}`;
    const outAbs = path.join(dir, outName);
    const tmpAbs = outAbs + `.tmp.${Date.now()}`;

    try {
        await _runFfmpeg([
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(start),
            '-t',
            String(end - start),
            '-i',
            abs,
            '-c',
            'copy',
            '-map',
            '0',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            '-y',
            tmpAbs,
        ]);
    } catch (e) {
        try {
            await fs.unlink(tmpAbs);
        } catch (e2) {
            swallow(e2, 'clip');
        }
        return { status: 'error', error: e?.message || String(e) };
    }

    if (!existsSync(tmpAbs)) return { status: 'error', error: 'ffmpeg produced no output' };
    const clipDuration = await probeDuration(tmpAbs);
    if (clipDuration === null || clipDuration < 0.05) {
        try {
            await fs.unlink(tmpAbs);
        } catch (e) {
            swallow(e, 'clip');
        }
        return { status: 'error', error: 'Clip output failed verification (no playable stream)' };
    }

    await fs.rename(tmpAbs, outAbs);
    const st = await fs.stat(outAbs);

    const relDir = row.file_path ? path.posix.dirname(toPosixPath(row.file_path)) : '';
    const nextRel = relDir && relDir !== '.' ? `${relDir}/${outName}` : outName;

    const ins = insertDownload({
        groupId: row.group_id,
        groupName: row.group_name,
        messageId: _nextClipMessageId(),
        fileName: outName,
        fileSize: Number(st.size) || 0,
        fileType: 'video',
        filePath: nextRel,
        caption: row.caption ? `Clip of: ${row.caption}` : `Clip of ${row.file_name || 'video'}`,
        durationSec: clipDuration,
    });
    if (!ins.lastInsertRowid) {
        // Should not happen — the negative kv-counter id is guaranteed
        // unique — but never leave an on-disk clip with no DB row pointing
        // at it if it somehow does.
        try {
            await fs.unlink(outAbs);
        } catch (e) {
            swallow(e, 'clip');
        }
        return { status: 'error', error: 'Failed to record clip in database' };
    }

    return {
        status: 'ok',
        id: Number(ins.lastInsertRowid),
        fileName: outName,
        filePath: nextRel,
        fileSize: Number(st.size) || 0,
        durationSec: clipDuration,
    };
}
