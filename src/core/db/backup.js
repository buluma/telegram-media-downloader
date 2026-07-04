import path from 'path';
import fs from 'fs';
import { getDb, getDataDir } from '../db.js';
import { swallow } from '../util/swallow.js';

const MAX_BACKUPS = 5;

function _backupsDir(dir) {
    return dir ?? path.join(getDataDir(), 'backups');
}

/**
 * Create a consistent SQLite backup before a destructive operation.
 * Uses better-sqlite3's built-in `.backup()` which is safe under concurrent reads.
 *
 * @param {string} label  Short identifier for the operation (e.g. 'dedup-delete').
 * @returns {Promise<{ path: string, filename: string, size: number }>}
 */
export async function backupDb(label = 'backup') {
    const dir = _backupsDir();
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const filename = `db-${label}-${ts}.sqlite`;
    const destPath = path.join(dir, filename);

    await getDb().backup(destPath);

    // Keep only the newest MAX_BACKUPS per label; delete the rest.
    const prefix = `db-${label}-`;
    const existing = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.sqlite'))
        .sort()
        .reverse();
    for (const old of existing.slice(MAX_BACKUPS)) {
        try {
            fs.unlinkSync(path.join(dir, old));
        } catch (e) {
            swallow(e, 'backup:backupDb');
        }
    }

    const size = fs.statSync(destPath).size;
    return { path: destPath, filename, size };
}

/**
 * List all backup files, newest first.
 *
 * @param {string} [dir]  Override backup directory (used by tests).
 * @returns {Array<{ filename: string, label: string, size: number, mtime: number }>}
 */
export function listBackups(dir) {
    const backupsDir = _backupsDir(dir);
    if (!fs.existsSync(backupsDir)) return [];

    return fs
        .readdirSync(backupsDir)
        .filter((f) => f.endsWith('.sqlite'))
        .map((filename) => {
            const full = path.join(backupsDir, filename);
            const stat = fs.statSync(full);
            // filename shape: db-<label>-<timestamp>.sqlite
            const label = filename
                .replace(/^db-/, '')
                .replace(/-\d{4}-\d{2}-\d{2}T[\w-]+\.sqlite$/, '');
            return { filename, label, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
}
