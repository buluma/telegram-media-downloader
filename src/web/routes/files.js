import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { getDownloadById } from '../../core/db/downloads.js';
import { getCloudStream } from '../../core/backup/manager.js';
import { toPosixPath } from '../../core/util/paths.js';
import { swallow } from '../../core/util/swallow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, '../../../data');

const _CT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.gz': 'application/gzip',
    '.zip': 'application/zip',
};

function _guessContentType(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return _CT[ext] || 'application/octet-stream';
}

/**
 * Stream a download to `res`. Serves the local file when present; falls back
 * to the cloud stream proxy (getCloudStream) when the file has been evicted.
 *
 * Extracted as a named export so tests can call it directly with a mock res
 * without standing up a full Express server.
 *
 * @param {number|string} id
 * @param {object} res      Express response or compatible mock
 * @param {string} dataDir  Overridable data root (defaults to project data/)
 */
export async function streamFileResponse(id, res, dataDir = DEFAULT_DATA_DIR) {
    const row = getDownloadById(Number(id));
    if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
    }

    const norm = toPosixPath(row.file_path || row.file_name);
    // Reject path traversal — any segment resolving above the downloads root.
    if (norm.includes('..') || path.posix.isAbsolute(norm)) {
        res.status(400).json({ error: 'Invalid file path' });
        return;
    }
    const localPath = path.resolve(
        path.join(dataDir, 'downloads'),
        ...norm.split('/').filter(Boolean),
    );

    if (fs.existsSync(localPath)) {
        const st = fs.statSync(localPath);
        if (!st.isFile()) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.setHeader('Content-Type', _guessContentType(localPath));
        res.setHeader('Content-Length', st.size);
        await new Promise((resolve, reject) => {
            const src = fs.createReadStream(localPath);
            src.on('error', reject);
            src.on('data', (chunk) => res.write(chunk));
            src.on('end', () => {
                res.end();
                resolve();
            });
        });
        return;
    }

    // Local file is absent (evicted) — try cloud stream proxy.
    let cloud = null;
    try {
        cloud = await getCloudStream(Number(id));
    } catch {
        // provider init failure — treat as unavailable
    }

    if (!cloud) {
        res.status(501).json({ error: 'File not available locally or in cloud' });
        return;
    }

    const { stream, size, provider } = cloud;
    const fileName = row.file_name || row.file_path || '';
    try {
        res.setHeader('Content-Type', _guessContentType(fileName));
        if (size) res.setHeader('Content-Length', size);
        await new Promise((resolve, reject) => {
            stream.on('error', reject);
            stream.on('data', (chunk) => res.write(chunk));
            stream.on('end', () => {
                res.end();
                resolve();
            });
        });
    } finally {
        try {
            await provider.close();
        } catch (e) {
            swallow(e, 'files');
        }
    }
}

export function createFilesRouter() {
    const router = express.Router();

    router.get('/files/:id/stream', async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id) || id <= 0) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        try {
            await streamFileResponse(id, res);
        } catch (e) {
            if (!res.headersSent) {
                res.status(500).json({ error: e?.message || 'Internal error' });
            }
        }
    });

    return router;
}
