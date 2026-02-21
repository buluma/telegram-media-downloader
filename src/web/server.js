
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
import { getDb, getDownloads, getStats as getDbStats, deleteGroupDownloads, deleteAllDownloads, backfillGroupNames } from '../core/db.js';
import { sanitizeName } from '../core/downloader.js';

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

// Body parsing middleware
app.use(express.json());

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

// Serve static files AFTER auth
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTOS_DIR));

// ============ API ENDPOINTS ============

// 0. Accounts API — List saved accounts with metadata
app.get('/api/accounts', async (req, res) => {
    try {
        const sessionsDir = path.join(DATA_DIR, 'sessions');
        if (!existsSync(sessionsDir)) {
            return res.json([]);
        }
        const files = fsSync.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.enc'))
            .sort((a, b) => {
                const statA = fsSync.statSync(path.join(sessionsDir, a));
                const statB = fsSync.statSync(path.join(sessionsDir, b));
                return statA.mtimeMs - statB.mtimeMs;
            });

        // Try to load metadata from config
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configAccounts = config.accounts || [];

        const accounts = files.map((f, index) => {
            const id = path.basename(f, '.enc');
            const meta = configAccounts.find(a => a.id === id) || {};
            return {
                id,
                name: meta.name || id,
                username: meta.username || '',
                phone: meta.phone || '',
                isDefault: index === 0
            };
        });
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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

        // Query DB for aggregation with group_name (MAX ignores NULLs)
        const rows = db.prepare(`
            SELECT group_id, MAX(group_name) as group_name, COUNT(*) as count, SUM(file_size) as size
            FROM downloads 
            GROUP BY group_id
        `).all();
        
        const results = rows.map(r => {
            const cfg = configGroups.find(g => String(g.id) === r.group_id);
            const name = cfg?.name || r.group_name;
            if (!name) return null; // Skip groups without a resolved name
            const hasPhoto = existsSync(path.join(PHOTOS_DIR, `${r.group_id}.jpg`));
            
            return {
                id: r.group_id,
                name: name,
                totalFiles: r.count,
                sizeFormatted: formatBytes(r.size || 0),
                photoUrl: hasPhoto ? `/photos/${r.group_id}.jpg` : null,
                enabled: cfg ? cfg.enabled : false
            };
        }).filter(Boolean);

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

        // Find group name from config or DB to build correct folder path
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
        const dbRow = getDb().prepare('SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(String(groupId));
        const groupFolder = sanitizeName(configGroup?.name || dbRow?.group_name || 'unknown');

        const result = getDownloads(groupId, limit, offset, type);

        // DB file_path stores bare filename only.
        // Actual path on disk: sanitizedGroupName/typeFolder/filename
        const files = result.files.map(row => {
            // Map DB file_type to folder name
            const typeFolder = row.file_type === 'photo' ? 'images' 
                : row.file_type === 'video' ? 'videos' 
                : row.file_type === 'audio' ? 'audio' 
                : row.file_type === 'sticker' ? 'stickers'
                : 'documents';
            
            const fullPath = `${groupFolder}/${typeFolder}/${row.file_name}`;
            
            return {
                name: row.file_name,
                path: row.file_path,
                fullPath,
                size: row.file_size,
                sizeFormatted: formatBytes(row.file_size),
                type: typeFolder,
                extension: path.extname(row.file_name),
                modified: row.created_at
            };
        });

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

// 6b. Purge Group (Files + DB + Config + Photo — No Trace)
app.delete('/api/groups/:id/purge', async (req, res) => {
    try {
        const groupId = req.params.id;
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
        const dbRow = getDb().prepare('SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(String(groupId));
        const groupName = configGroup?.name || dbRow?.group_name || 'unknown';
        const folderName = sanitizeName(groupName);

        // 1. Delete files on disk
        const folderPath = path.join(DOWNLOADS_DIR, folderName);
        let filesDeleted = 0;
        if (existsSync(folderPath)) {
            // Count files before deleting
            const countFiles = (dir) => {
                let count = 0;
                const items = fsSync.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
                    else count++;
                }
                return count;
            };
            filesDeleted = countFiles(folderPath);
            await fs.rm(folderPath, { recursive: true, force: true });
        }

        // 2. Delete DB records
        const dbResult = deleteGroupDownloads(groupId);

        // 3. Remove from config
        config.groups = (config.groups || []).filter(g => String(g.id) !== String(groupId));
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));

        // 4. Delete profile photo
        const photoPath = path.join(PHOTOS_DIR, `${groupId}.jpg`);
        if (existsSync(photoPath)) await fs.unlink(photoPath);

        console.log(`🗑️ PURGED: ${groupName} — ${filesDeleted} files, ${dbResult.deletedDownloads} DB records`);
        broadcast({ type: 'group_purged', groupId });
        res.json({
            success: true,
            deleted: {
                files: filesDeleted,
                dbRecords: dbResult.deletedDownloads,
                queueRecords: dbResult.deletedQueue,
                group: groupName
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6c. Purge ALL (Everything — Factory Reset)
app.delete('/api/purge/all', async (req, res) => {
    try {
        // 1. Delete all download folders
        let totalFiles = 0;
        if (existsSync(DOWNLOADS_DIR)) {
            const dirs = fsSync.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
            for (const dir of dirs) {
                if (dir.isDirectory()) {
                    const dirPath = path.join(DOWNLOADS_DIR, dir.name);
                    totalFiles += fsSync.readdirSync(dirPath, { recursive: true }).length;
                    await fs.rm(dirPath, { recursive: true, force: true });
                }
            }
        }

        // 2. Delete all DB records
        const dbResult = deleteAllDownloads();

        // 3. Clear groups from config
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        config.groups = [];
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));

        // 4. Delete all profile photos
        if (existsSync(PHOTOS_DIR)) {
            const photos = fsSync.readdirSync(PHOTOS_DIR);
            for (const photo of photos) {
                await fs.unlink(path.join(PHOTOS_DIR, photo));
            }
        }

        console.log(`🗑️ PURGE ALL: ${totalFiles} files, ${dbResult.deletedDownloads} DB records`);
        broadcast({ type: 'purge_all' });
        res.json({
            success: true,
            deleted: {
                files: totalFiles,
                dbRecords: dbResult.deletedDownloads,
                queueRecords: dbResult.deletedQueue
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/config', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        // Strip sensitive fields
        const safe = { ...config };
        if (safe.web) safe.web = { ...safe.web, password: undefined };
        res.json(safe);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7b. Config Update
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
            // Resolve real name from Telegram if not provided or generic
            let groupName = req.body.name;
            if (!groupName || groupName.startsWith('Group ')) {
                try {
                    if (telegramClient && isConnected) {
                        const entity = await telegramClient.getEntity(BigInt(groupId));
                        groupName = entity?.title || entity?.firstName || entity?.username || groupName;
                    }
                } catch { /* keep whatever name we have */ }
            }
            const newGroup = {
                id: groupId.startsWith('-') ? parseInt(groupId) : groupId,
                name: groupName || `Unknown`,
                enabled: req.body.enabled ?? false,
                filters: { photos: true, videos: true, files: true, links: true, voice: false, gifs: false, stickers: false },
                autoForward: { enabled: false, destination: null, deleteAfterForward: false },
                trackUsers: { enabled: false, users: [] },
                topics: { enabled: false, ids: [] }
            };
            config.groups.push(newGroup);
            groupIndex = config.groups.length - 1;
        }
        
        // Update fields
        const group = config.groups[groupIndex];
        if (req.body.enabled !== undefined) group.enabled = req.body.enabled;
        if (req.body.name) group.name = req.body.name;
        if (req.body.filters) {
            group.filters = { ...group.filters, ...req.body.filters };
        }
        if (req.body.autoForward) {
            group.autoForward = { ...group.autoForward, ...req.body.autoForward };
        }
        
        // Multi-Account assignments
        if (req.body.monitorAccount !== undefined) {
            if (!req.body.monitorAccount) delete group.monitorAccount;
            else group.monitorAccount = req.body.monitorAccount;
        }
        if (req.body.forwardAccount !== undefined) {
            if (!req.body.forwardAccount) delete group.forwardAccount;
            else group.forwardAccount = req.body.forwardAccount;
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
    // Backfill group names for existing records
    try {
        const config = JSON.parse(fsSync.readFileSync(CONFIG_PATH, 'utf8'));
        const updated = backfillGroupNames(config.groups || []);
        if (updated > 0) console.log(`📝 Backfilled group names for ${updated} records`);
    } catch (e) { /* config not ready yet */ }

    console.log(`
╔════════════════════════════════════════════════════════════╗
║   🌐 Telegram Downloader - SQLite Edition                 ║
║   Server: http://localhost:${PORT}                          ║
╚════════════════════════════════════════════════════════════╝
`);
    await connectTelegram();

    // Resolve group names from Telegram for any DB records still unnamed
    await resolveGroupNamesFromTelegram();
});

/**
 * Resolve group names from Telegram API for DB records with NULL or default group_name.
 * Strategy: 1) fetch dialogs and match by normalized ID, 2) fallback to getEntity for unmatched.
 * Also fixes config.json entries with generic names.
 */
async function resolveGroupNamesFromTelegram() {
    if (!telegramClient || !isConnected) return;
    try {
        // Collect all IDs that need fixing (from config)
        let config;
        try {
            config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        } catch {
            config = { groups: [] };
        }
        const configUnknowns = (config.groups || []).filter(g => !g.name || g.name.startsWith('Group '));

        // Also check DB
        const db = getDb();
        const dbUnknowns = db.prepare(`SELECT DISTINCT group_id FROM downloads WHERE group_name IS NULL OR group_name LIKE 'Group %'`).all();

        if (dbUnknowns.length === 0 && configUnknowns.length === 0) return;

        // Collect all unique IDs that need resolution
        const needIds = new Set();
        configUnknowns.forEach(g => needIds.add(String(g.id)));
        dbUnknowns.forEach(r => needIds.add(r.group_id));

        console.log(`🔍 Resolving names for ${needIds.size} groups: ${[...needIds].join(', ')}`);

        // Strategy 1: Fetch dialogs and build lookup
        const resolvedNames = new Map(); // raw ID string -> resolved name
        try {
            const dialogs = await telegramClient.getDialogs({ limit: 500 });
            const normalize = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');
            
            for (const rawId of needIds) {
                const nid = normalize(rawId);
                for (const d of dialogs) {
                    const dnid = normalize(d.id);
                    if (dnid === nid) {
                        const title = d.title || d.name;
                        if (title) {
                            resolvedNames.set(rawId, title);
                            console.log(`  📌 Dialog match: ${rawId} → "${title}"`);
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`  ⚠️ getDialogs failed: ${e.message}`);
        }

        // Strategy 2: For unresolved, try getEntity directly
        for (const rawId of needIds) {
            if (resolvedNames.has(rawId)) continue;
            
            // Try multiple ID formats
            const candidates = [
                Number(rawId),
                BigInt(rawId),
            ];
            // If it starts with -, also try -100 prefix variant
            if (rawId.startsWith('-') && !rawId.startsWith('-100')) {
                candidates.push(Number('-100' + rawId.slice(1)));
                candidates.push(BigInt('-100' + rawId.slice(1)));
            }

            for (const tryId of candidates) {
                try {
                    const entity = await telegramClient.getEntity(tryId);
                    if (entity) {
                        const title = entity.title || entity.firstName || entity.username;
                        if (title) {
                            resolvedNames.set(rawId, title);
                            console.log(`  📌 Entity match: ${rawId} → "${title}"`);
                            break;
                        }
                    }
                } catch { /* try next format */ }
            }
        }

        // Apply fixes to DB
        let dbResolved = 0;
        const stmt = db.prepare(`UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name LIKE 'Group %')`);
        for (const row of dbUnknowns) {
            const name = resolvedNames.get(row.group_id);
            if (name) {
                stmt.run(name, row.group_id);
                dbResolved++;
            }
        }

        // Apply fixes to config
        let configChanged = false;
        let configResolved = 0;
        for (const g of configUnknowns) {
            const name = resolvedNames.get(String(g.id));
            if (name) {
                g.name = name;
                configChanged = true;
                configResolved++;
            }
        }
        if (configChanged) {
            await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));
        }

        const total = resolvedNames.size;
        const failed = needIds.size - total;
        if (total > 0) console.log(`✅ Resolved ${total} group names (${dbResolved} DB, ${configResolved} config)`);
        if (failed > 0) console.log(`⚠️  ${failed} groups could not be resolved (may have left the group)`);
    } catch (e) {
        console.log('⚠️ Could not resolve group names:', e.message);
    }
}

export { broadcast };
