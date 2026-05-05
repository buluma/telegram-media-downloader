import express from 'express';
import fsSync from 'fs';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

function tgAuthErrorBody(e) {
    if (e?.code === 'NO_API_CREDS') {
        return {
            status: 503,
            body: { error: 'Telegram API credentials not configured. Add telegram.apiId and telegram.apiHash in Settings first.', code: 'NO_API_CREDS' },
        };
    }
    return { status: 400, body: { error: e?.message || 'Bad request' } };
}

/**
 * Telegram account management routes — list, add (phone→OTP→2FA wizard), remove.
 *
 * @param {object} ctx
 * @param {string} ctx.dataDir          Path to the data directory (for sessions/)
 * @param {string} ctx.configPath       Path to config.json
 * @param {Function} ctx.getAccountManager  async () => AccountManager instance
 */
export function createAccountsRouter({ dataDir, configPath, getAccountManager }) {
    const router = express.Router();

    router.get('/api/accounts', async (req, res) => {
        try {
            const sessionsDir = path.join(dataDir, 'sessions');
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

            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const configAccounts = config.accounts || [];

            const accounts = files.map((f, index) => {
                const id = path.basename(f, '.enc');
                const meta = configAccounts.find(a => a.id === id) || {};
                return {
                    id,
                    name: meta.name || id,
                    username: meta.username || '',
                    phone: meta.phone || '',
                    isDefault: index === 0,
                };
            });
            res.json(accounts);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ====== Telegram account add: phone → OTP → 2FA wizard ==================
    //
    // Each begin call returns a sessionId; subsequent submits use that id. The
    // underlying state machine lives in AccountManager._authFlows and parks
    // gramJS callbacks on deferred Promises.

    router.post('/api/accounts/auth/begin', async (req, res) => {
        try {
            const { label } = req.body || {};
            const am = await getAccountManager();
            const result = await am.beginPhoneAuth(label);
            res.json(result);
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status).json(body);
        }
    });

    router.post('/api/accounts/auth/phone', async (req, res) => {
        try {
            const { sessionId, phone } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.submitPhone(sessionId, phone));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.post('/api/accounts/auth/code', async (req, res) => {
        try {
            const { sessionId, code } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.submitCode(sessionId, code));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.post('/api/accounts/auth/2fa', async (req, res) => {
        try {
            const { sessionId, password } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.submit2fa(sessionId, password));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.post('/api/accounts/auth/cancel', async (req, res) => {
        try {
            const { sessionId } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.cancelAuth(sessionId));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.get('/api/accounts/auth/:sessionId', async (req, res) => {
        try {
            const am = await getAccountManager();
            const status = am.getAuthStatus(req.params.sessionId);
            if (!status) return res.status(404).json({ error: 'Auth session not found' });
            res.json(status);
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status).json(body);
        }
    });

    router.delete('/api/accounts/:id', async (req, res) => {
        try {
            const am = await getAccountManager();
            const id = req.params.id;
            if (!am.metadata.has(id)) return res.status(404).json({ error: 'Account not found' });
            await am.removeAccount(id);
            res.json({ success: true });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status).json(body);
        }
    });

    return router;
}
