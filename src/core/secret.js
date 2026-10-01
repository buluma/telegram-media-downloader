import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `TGDL_DATA_DIR` overrides the on-disk data root — mirrors core/db.js so
// the key lives beside the database it protects.
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(__dirname, '../../data');
const SECRET_PATH = path.join(DATA_DIR, 'secret.key');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

export function getOrGenerateSecret() {
    ensureDataDir();

    if (fs.existsSync(SECRET_PATH)) {
        try {
            const secret = fs.readFileSync(SECRET_PATH, 'utf8').trim();
            if (secret.length > 0) return secret;
        } catch (e) {
            console.error('Error reading secret file:', e);
        }
    }

    // Generate new secret
    const newSecret = crypto.randomBytes(32).toString('hex');
    try {
        // 'wx' so a concurrent first run can't overwrite a secret another
        // process just created (and already handed out).
        fs.writeFileSync(SECRET_PATH, newSecret, { mode: 0o600, flag: 'wx' }); // Restrict permissions
        console.log('🔐 New security secret generated and saved.');
    } catch (e) {
        if (e.code === 'EEXIST') {
            const existing = fs.readFileSync(SECRET_PATH, 'utf8').trim();
            if (existing.length > 0) return existing;
            // Empty leftover file: replace it. `mode` only applies on creation,
            // so tighten the existing file's permissions through the open fd.
            const fd = fs.openSync(SECRET_PATH, 'r+');
            try {
                fs.fchmodSync(fd, 0o600);
                fs.ftruncateSync(fd);
                fs.writeSync(fd, newSecret);
            } finally {
                fs.closeSync(fd);
            }
            return newSecret;
        }
        console.error('Error writing secret file:', e);
    }

    return newSecret;
}
