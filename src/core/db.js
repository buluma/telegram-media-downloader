import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

// Singleton connection
let db;

export function getDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    
    // Performance tuning
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    initSchema();
    return db;
}

function initSchema() {
    // Downloads Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            group_name TEXT,
            message_id INTEGER NOT NULL,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT, -- photo, video, document
            file_path TEXT,
            status TEXT DEFAULT 'completed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_id ON downloads(group_id);
        CREATE INDEX IF NOT EXISTS idx_created_at ON downloads(created_at);
    `);

    // Migration: add group_name column to existing databases
    try {
        db.exec('ALTER TABLE downloads ADD COLUMN group_name TEXT');
    } catch (e) {
        // Column already exists -- safe to ignore
    }

    // Queue/Pending Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            meta TEXT, -- JSON payload
            priority INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending', -- pending, processing, failed
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

export function insertDownload(data) {
    const stmt = getDb().prepare(`
        INSERT OR IGNORE INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path)
        VALUES (@groupId, @groupName, @messageId, @fileName, @fileSize, @fileType, @filePath)
    `);
    return stmt.run(data);
}

export function isDownloaded(groupId, messageId) {
    const stmt = getDb().prepare('SELECT 1 FROM downloads WHERE group_id = ? AND message_id = ? LIMIT 1');
    return !!stmt.get(String(groupId), Number(messageId));
}

export function getDownloads(groupId, limit = 50, offset = 0, type = 'all') {
    let query = 'SELECT * FROM downloads WHERE group_id = ?';
    const params = [groupId];

    if (type !== 'all') {
        const typeMap = {
            'images': 'photo',
            'videos': 'video',
            'documents': 'document',
            'audio': 'audio'
        };
        // Use LIKE for flexibility or map precisely
        if (typeMap[type]) {
             query += ' AND file_type = ?';
             params.push(typeMap[type]);
        }
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = getDb().prepare(query);
    const rows = stmt.all(...params);
    
    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM downloads WHERE group_id = ?';
    const countParams = [groupId];
    
    // We reuse the type filter logic for count but it's cleaner to separate or build dynamically
    // For simplicity here:
    if (params.length > 3) { // If type filter was added
         countQuery += ' AND file_type = ?';
         countParams.push(params[1]); // existing type param
    }
    
    const total = getDb().prepare(countQuery).get(...countParams).total;

    return { files: rows, total };
}

export function getStats() {
    const db = getDb();
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM downloads').get().count;
    const totalSize = db.prepare('SELECT SUM(file_size) as size FROM downloads').get().size || 0;
    return { totalFiles, totalSize };
}

/**
 * Delete all download records for a specific group
 * @param {string} groupId - Telegram group ID
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteGroupDownloads(groupId) {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads WHERE group_id = ?').run(String(groupId));
    const del2 = db.prepare('DELETE FROM queue WHERE group_id = ?').run(String(groupId));
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Delete ALL download and queue records
 * @returns {{ deletedDownloads: number, deletedQueue: number }}
 */
export function deleteAllDownloads() {
    const db = getDb();
    const del1 = db.prepare('DELETE FROM downloads').run();
    const del2 = db.prepare('DELETE FROM queue').run();
    return { deletedDownloads: del1.changes, deletedQueue: del2.changes };
}

/**
 * Backfill group_name for existing records using config groups.
 * Call once on startup after config is loaded.
 * @param {Array<{id: string|number, name: string}>} groups - Config groups
 * @returns {number} Number of records updated
 */
export function backfillGroupNames(groups) {
    if (!groups || groups.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare('UPDATE downloads SET group_name = ? WHERE group_id = ? AND group_name IS NULL');
    let updated = 0;
    const tx = db.transaction(() => {
        for (const g of groups) {
            if (g.name) {
                const result = stmt.run(g.name, String(g.id));
                updated += result.changes;
            }
        }
    });
    tx();
    return updated;
}
