import express from 'express';
import {
    getDb,
    createShareLink, listShareLinks, revokeShareLink,
} from '../../core/db.js';
import { buildShareUrlPath, clampTtlSeconds } from '../../core/share.js';

function _shareUrlFor(req, linkId, expSec) {
    return `${req.protocol}://${req.get('host')}${buildShareUrlPath(linkId, expSec)}`;
}

function _shareLinkPayload(req, row) {
    const expSec = Math.floor(row.expires_at ?? row.expiresAt ?? 0);
    const linkId = row.id;
    return {
        id: linkId,
        downloadId: row.download_id ?? row.downloadId,
        createdAt: row.created_at ?? row.createdAt,
        expiresAt: expSec,
        revokedAt: row.revoked_at ?? null,
        label: row.label ?? null,
        accessCount: row.access_count ?? 0,
        lastAccessedAt: row.last_accessed_at ?? null,
        fileName: row.file_name,
        fileType: row.file_type,
        fileSize: row.file_size,
        groupId: row.group_id,
        groupName: row.group_name,
        url: _shareUrlFor(req, linkId, expSec),
    };
}

/**
 * Share-link admin API — create, list, revoke.
 * Public share serving (/share/:linkId) stays in server.js (mounted before auth).
 *
 * @param {object} ctx
 * @param {Function} ctx.log  structured logger
 */
export function createShareRouter({ log }) {
    const router = express.Router();

    // Mint a new share link for a single download row.
    // Body: { downloadId, ttlSeconds?, label? }
    router.post('/api/share/links', async (req, res) => {
        try {
            const { downloadId, ttlSeconds, label } = req.body || {};
            const did = parseInt(downloadId, 10);
            if (!Number.isInteger(did) || did <= 0) {
                return res.status(400).json({ error: 'downloadId required' });
            }
            const exists = getDb().prepare('SELECT id FROM downloads WHERE id = ?').get(did);
            if (!exists) return res.status(404).json({ error: 'Download not found' });

            const ttl = clampTtlSeconds(ttlSeconds);
            const expSec = ttl === 0 ? 0 : Math.floor(Date.now() / 1000) + ttl;
            const cleanLabel = typeof label === 'string'
                ? label.replace(/[\r\n\t]/g, ' ').trim().slice(0, 80) || null
                : null;

            const { id } = createShareLink({ downloadId: did, expiresAt: expSec, label: cleanLabel });
            const list = listShareLinks({ downloadId: did, limit: 1000 });
            const row = list.find(r => r.id === id);
            res.json({ success: true, link: row ? _shareLinkPayload(req, row) : null });
        } catch (e) {
            log({ source: 'share', level: 'error', msg: `create link failed: ${e.message}` });
            res.status(500).json({ error: e.message });
        }
    });

    // List share links — ?downloadId=… filters to one file; no filter = all.
    router.get('/api/share/links', async (req, res) => {
        try {
            const downloadId = req.query.downloadId
                ? parseInt(req.query.downloadId, 10)
                : null;
            const includeRevoked = req.query.includeRevoked !== '0';
            const rows = listShareLinks({ downloadId, includeRevoked });
            res.json({ success: true, links: rows.map(r => _shareLinkPayload(req, r)) });
        } catch (e) {
            log({ source: 'share', level: 'error', msg: `list links failed: ${e.message}` });
            res.status(500).json({ error: e.message });
        }
    });

    // Revoke a single share link by id. Idempotent.
    router.delete('/api/share/links/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ error: 'Invalid id' });
            }
            const did = revokeShareLink(id);
            res.json({ success: true, revoked: did });
        } catch (e) {
            log({ source: 'share', level: 'error', msg: `revoke link failed: ${e.message}` });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
