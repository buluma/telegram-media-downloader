import express from 'express';

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
 * Monitor / runtime control routes — status, start, stop.
 *
 * @param {object} ctx
 * @param {Function} ctx.getMonitorStatus  async () => monitor status snapshot
 * @param {Function} ctx.getAccountManager async () => AccountManager
 * @param {object}   ctx.runtime           Runtime instance
 * @param {Function} ctx.loadConfig        () => config object (sync, cached)
 */
export function createMonitorRouter({ getMonitorStatus, getAccountManager, runtime, loadConfig }) {
    const router = express.Router();

    router.get('/api/monitor/status', async (req, res) => {
        res.json(await getMonitorStatus());
    });

    router.post('/api/monitor/start', async (req, res) => {
        try {
            const am = await getAccountManager();
            if (am.count === 0) {
                return res.status(409).json({
                    error: 'No Telegram accounts loaded. Add one in Settings → Accounts first.',
                });
            }
            await runtime.start({ config: loadConfig(), accountManager: am });
            res.json({ success: true, status: runtime.status() });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status === 400 ? 500 : status).json(body.error ? body : { error: e.message });
        }
    });

    router.post('/api/monitor/stop', async (req, res) => {
        try {
            await runtime.stop();
            res.json({ success: true, status: runtime.status() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
