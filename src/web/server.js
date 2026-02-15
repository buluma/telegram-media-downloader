
/**
 * Web GUI Server - Configuration + Profile Photos + SQLite Data
 * Features: Groups, Settings, Viewer, Real Telegram Profile Photos
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import fsSync, { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import crypto from 'crypto';

import { getOrGenerateSecret } from '../core/secret.js';
import { getDb, getDownloads, getStats as getDbStats } from '../core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const SESSION_PATH = path.join(DATA_DIR, 'session.enc');
const SESSION_PASSWORD = getOrGenerateSecret();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

// Telegram client
let telegramClient = null;
let isConnected = false;

// Ensure photos directory exists
if (!fsSync.existsSync(PHOTOS_DIR)) {
    fsSync.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTOS_DIR));

// ============ AUTHENTICATION ============

// Simple cookie parser middleware
app.use((req, res, next) => {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach((cookie) => {
            const parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }
    req.cookies = list;
    next();
});

// Auth Middleware
async function checkAuth(req, res, next) {
    // 1. Check if auth is enabled in config
    let config = {};
    try {
        config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    } catch (e) {}

    const password = config.web?.password;
    const isEnabled = config.web?.enabled !== false; // Default true if not explicitly false

    // If disabled or no password configured, Open Access
    if (!isEnabled || !password) return next();

    // 2. Check Cookie
    const sessionCookie = req.cookies['tg_dl_session'];
    
    // Simple verification: Cookie value = Password
    // In prod, use real sessions/JWT. For this tool, this is sufficient.
    if (sessionCookie === password) {
        return next();
    }

    // 3. API Request? Return 401
    if (req.path.startsWith('/api/') && req.path !== '/api/login') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 4. Page Request? Redirect to Login
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/login') && !req.path.startsWith('/css') && !req.path.startsWith('/js')) {
         return res.redirect('/login.html');
    }
    
    next();
}

app.post('/api/login', async (req, res) => {
    try {
        const { password } = req.body;
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const target = config.web?.password;

        if (!target) {
            return res.json({ success: true, message: 'No password set' });
        }

        if (password === target) {
            // Set Cookie (HttpOnly)
            res.cookie('tg_dl_session', password, { 
                httpOnly: true, 
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            // Express doesn't auto-set cookie header without cookie-parser response helper in some versions, matches standard?
            // Actually `res.cookie` is provided by `express`.
            
            return res.json({ success: true });
        }

        res.status(401).json({ error: 'Invalid password' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/auth_check', async (req, res) => {
    // If it hit this endpoint, middleware passed (or no password set)
    // But middleware might have passed because it wasn't applied globally yet? 
    // We need to apply it globally.
    res.json({ success: true });
});

// Apply Auth Globally
app.use(checkAuth);

// ============ API ENDPOINTS ============

// 1. Stats API (SQLite)
app.get('/api/stats', async (req, res) => {
    try {
        const dbStats = getDbStats(); // From DB
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        
        // Disk Usage Cache (or read from disk_usage.json if preferred)
        let diskUsage = 0;
        const diskUsagePath = path.join(DATA_DIR, 'disk_usage.json');
        if (existsSync(diskUsagePath)) {
            const d = JSON.parse(await fs.readFile(diskUsagePath, 'utf8'));
            diskUsage = d.size;
        }

        res.json({
            // DB Stats
            totalFiles: dbStats.totalFiles,
            totalSize: dbStats.totalSize,
            
            // Disk Stats
            diskUsage: diskUsage,
            diskUsageFormatted: formatBytes(diskUsage),
            maxDiskSize: config.diskManagement?.maxTotalSize || '0',
            
            // Config Stats
            totalGroups: config.groups?.length || 0,
            enabledGroups: config.groups?.filter(g => g.enabled).length || 0,
            
            telegramConnected: isConnected
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Dialogs API (Groups)
app.get('/api/dialogs', async (req, res) => {
    try {
        if (!telegramClient || !telegramClient.connected) {
            return res.status(503).json({ error: 'Telegram client not connected' });
        }
        
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroups = config.groups || [];
        
        const dialogs = await telegramClient.getDialogs({ limit: 200 });
        const results = dialogs
            .filter(d => d.isGroup || d.isChannel)
            .map(d => {
                const id = d.id.toString();
                const configGroup = configGroups.find(g => String(g.id) === id);
                return {
                    id,
                    name: d.title || d.name || 'Unknown',
                    type: d.isChannel ? 'channel' : 'group',
                    username: d.username,
                    enabled: configGroup?.enabled || false,
                    inConfig: !!configGroup,
                    filters: configGroup?.filters || { photos: true, videos: true, files: true, links: true, voice: false, gifs: false },
                    autoForward: configGroup?.autoForward || { enabled: false, destination: null, deleteAfterForward: false },
                    photoUrl: `/api/groups/${id}/photo`
                };
            });
            
        res.json({ success: true, dialogs: results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Config Groups List (with Photo URLs)
app.get('/api/groups', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const groupsWithPhotos = await Promise.all((config.groups || []).map(async (group) => {
            const photoPath = path.join(PHOTOS_DIR, `${group.id}.jpg`);
            const hasPhoto = existsSync(photoPath);
            return {
                ...group,
                photoUrl: hasPhoto ? `/photos/${group.id}.jpg` : null
            };
        }));
        res.json(groupsWithPhotos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Downloads Aggregate (Folders + DB Counts)
app.get('/api/downloads', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroups = config.groups || [];
        const db = getDb();

        // Query DB for aggregation
        const rows = db.prepare(`
            SELECT group_id, COUNT(*) as count, SUM(file_size) as size 
            FROM downloads 
            GROUP BY group_id
        `).all();
        
        const results = rows.map(r => {
            // Find name in config
            const cfg = configGroups.find(g => String(g.id) === r.group_id);
            const name = cfg ? cfg.name : `Group ${r.group_id}`;
            const hasPhoto = existsSync(path.join(PHOTOS_DIR, `${r.group_id}.jpg`));
            
            return {
                id: r.group_id,
                name: name,
                totalFiles: r.count,
                sizeFormatted: formatBytes(r.size || 0),
                photoUrl: hasPhoto ? `/photos/${r.group_id}.jpg` : null,
                enabled: cfg ? cfg.enabled : false
            };
        });

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Downloads Per Group (SQLite Pagination)
app.get('/api/downloads/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const type = req.query.type || 'all';
        const offset = (page - 1) * limit;

        const result = getDownloads(groupId, limit, offset, type);

        // Map fields for frontend
        const files = result.files.map(row => ({
            name: row.file_name,
            path: row.file_path, // Relative
            fullPath: `${groupId}/${row.file_path}`, // web accessible path construction
            size: row.file_size,
            sizeFormatted: formatBytes(row.file_size),
            type: row.file_type === 'photo' ? 'images' : (row.file_type === 'video' ? 'videos' : 'documents'),
            extension: path.extname(row.file_name),
            modified: row.created_at
        }));

        res.json({
            files,
            total: result.total,
            page,
            totalPages: Math.ceil(result.total / limit)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Delete File (Physical + DB)
app.delete('/api/file', async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'Path required' });

        // Security check
        const absolutePath = path.resolve(path.join(DOWNLOADS_DIR, filePath));
        if (!absolutePath.startsWith(path.resolve(DOWNLOADS_DIR))) {
             return res.status(403).json({ error: 'Access denied' });
        }

        if (existsSync(absolutePath)) {
            await fs.unlink(absolutePath);
            console.log(`🗑️ Deleted: ${filePath}`);
            
            // Remove from DB
            const db = getDb();
            const fileName = path.basename(filePath);
            db.prepare('DELETE FROM downloads WHERE file_name = ?').run(fileName);
            
            broadcast({ type: 'file_deleted', path: filePath });
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Config Update
app.post('/api/config', async (req, res) => {
    try {
        // Read existing first to preserve structure
        const currentConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const newConfig = { ...currentConfig, ...req.body };
        
        // Deep merge for specific sections
        if (req.body.download) newConfig.download = { ...currentConfig.download, ...req.body.download };
        if (req.body.rateLimits) newConfig.rateLimits = { ...currentConfig.rateLimits, ...req.body.rateLimits };
        if (req.body.diskManagement) newConfig.diskManagement = { ...currentConfig.diskManagement, ...req.body.diskManagement };
        
        await fs.writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 4));
        broadcast({ type: 'config_updated', config: newConfig });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. Group Update
app.put('/api/groups/:id', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const groupId = req.params.id;
        let groupIndex = config.groups.findIndex(g => String(g.id) === groupId);
        
        if (groupIndex === -1) {
            // Create new
            const newGroup = {
                id: groupId.startsWith('-') ? parseInt(groupId) : groupId,
                name: req.body.name || `Group ${groupId}`,
                enabled: false,
                filters: { photos: true, videos: true, files: true, links: true },
                autoForward: { enabled: false }
            };
            config.groups.push(newGroup);
            groupIndex = config.groups.length - 1;
        }
        
        // Update fields
        config.groups[groupIndex] = { ...config.groups[groupIndex], ...req.body };
        if (req.body.filters) {
            config.groups[groupIndex].filters = { ...config.groups[groupIndex].filters, ...req.body.filters };
        }
        
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));
        broadcast({ type: 'config_updated', config });
        res.json({ success: true, group: config.groups[groupIndex] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. Profile Photos
app.get('/api/groups/:id/photo', async (req, res) => {
    const id = req.params.id;
    const photoPath = path.join(PHOTOS_DIR, `${id}.jpg`);
    
    if (existsSync(photoPath)) return res.sendFile(photoPath);
    
    // Try download if not exists
    const url = await downloadProfilePhoto(id);
    if (url && existsSync(photoPath)) return res.sendFile(photoPath);
    
    res.status(404).send('Not found');
});

app.post('/api/groups/refresh-photos', async (req, res) => {
   try {
       const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
       const results = [];
       for (const group of config.groups || []) {
           const url = await downloadProfilePhoto(group.id);
           results.push({ id: group.id, url });
       }
       res.json({ success: true, results });
   } catch (e) {
       res.status(500).json({ error: e.message });
   }
});

// ============ FILE SERVING (Performance) ============
const directoryCache = new Map(); // Normalized -> Real Name

// Serve static files with Optimized Caching Strategy
app.use('/files', async (req, res, next) => {
    try {
        const reqPath = decodeURIComponent(req.path).replace(/^\//, '');
        if (!reqPath) return next();

        // Need to match strict path for DB consistency?
        // Actually, frontend requests /files/GroupName/images/file.jpg
        // We can just rely on reqPath
        
        const fullPath = path.join(DOWNLOADS_DIR, reqPath);
        
        // Security check
        if (!fullPath.startsWith(path.resolve(DOWNLOADS_DIR))) {
            return res.status(403).send('Forbidden');
        }

        if (existsSync(fullPath)) {
            res.sendFile(fullPath);
        } else {
            next();
        }
    } catch (e) {
        next();
    }
});


// ============ TELEGRAM CONNECTION ============

async function loadSession() {
    try {
        if (existsSync(SESSION_PATH)) {
            const encryptedStr = await fs.readFile(SESSION_PATH, 'utf8');
            const encrypted = JSON.parse(encryptedStr);
            const key = crypto.scryptSync(SESSION_PASSWORD, 'tg-dl-salt-v1', 32);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'hex'));
            decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
            const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'hex')), decipher.final()]);
            return decrypted.toString('utf8');
        }
    } catch (e) {
        console.log('Could not load session:', e.message);
    }
    return '';
}

async function connectTelegram() {
    if (telegramClient && isConnected) return telegramClient;
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const sessionString = await loadSession();
        if (!sessionString) return null;

        const stringSession = new StringSession(sessionString);
        telegramClient = new TelegramClient(stringSession, parseInt(config.telegram.apiId), config.telegram.apiHash, { connectionRetries: 3, useWSS: false });
        telegramClient.setLogLevel('none');
        await telegramClient.connect();

        if (await telegramClient.isUserAuthorized()) {
            isConnected = true;
            console.log('✅ Connected to Telegram (for profile photos)');
            return telegramClient;
        }
    } catch (error) {
        console.log('⚠️ Telegram connection failed:', error.message);
    }
    return null;
}

// Entity & Photo Helpers
const entityCache = new Map();
async function downloadProfilePhoto(groupId) {
    const idStr = String(groupId);
    const photoPath = path.join(PHOTOS_DIR, `${idStr}.jpg`);
    if (existsSync(photoPath)) return `/photos/${idStr}.jpg`;

    const client = await connectTelegram();
    if (!client) return null;

    try {
        let entity = entityCache.get(idStr);
        if (!entity) {
            try { entity = await client.getEntity(idStr); } catch (e) {}
            if (!entity) {
                 try { entity = await client.getEntity(BigInt(idStr)); } catch (e) {}
            }
        }

        if (entity) {
            entityCache.set(idStr, entity);
            if (entity.photo) {
                const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
                if (buffer) {
                    await fs.writeFile(photoPath, buffer);
                    return `/photos/${idStr}.jpg`;
                }
            }
        }
    } catch (e) {
        console.log(`Error processing ${idStr}:`, e.message);
    }
    return null;
}

// ============ SERVER START ============

function normalizeName(name) {
    if (!name) return '';
    return name.replace(/[_|]+/g, ' ').replace(/\s+/g, ' ').replace(/[\/\\:*?"<>]/g, '').trim().toLowerCase();
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) client.send(message);
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║   🌐 Telegram Downloader - SQLite Edition                 ║
║   Server: http://localhost:${PORT}                          ║
╚════════════════════════════════════════════════════════════╝
`);
    await connectTelegram();
});

export { broadcast };
