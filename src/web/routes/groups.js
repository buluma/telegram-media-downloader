import express from 'express';
import fs from 'fs/promises';
import fsSync, { existsSync } from 'fs';
import path from 'path';
import { getDb } from '../../core/db.js';
import { getMessageIdRange } from '../../core/db.js';
import { DIALOG_CACHE_TTL_MS } from '../../core/constants.js';

// Mirror of the SPA's `looksUnresolved`. If a name is empty / "Unknown" /
// the bare numeric id / a "Group ..." placeholder, the caller should
// prefer any other source instead of trusting it.
export function nameLooksUnresolved(name, id) {
    if (!name) return true;
    const s = String(name).trim();
    if (!s) return true;
    if (s === 'Unknown' || s === 'unknown') return true;
    if (id != null && s === String(id)) return true;
    if (/^-?\d{6,}$/.test(s)) return true;
    if (/^Group\s/i.test(s)) return true;
    return false;
}

// Best-available name for a group id. Resolution priority:
//   1. Live Telegram dialogs name (same source the Browse-chats picker
//      uses — most authoritative; reflects renames immediately).
//   2. Config-set label.
//   3. DB's most-recently-saved `group_name` for that id.
//   4. Last-resort placeholder — never the bare numeric id.
export function bestGroupName(id, configName, dbName, dialogsName) {
    if (!nameLooksUnresolved(dialogsName, id)) return dialogsName;
    if (!nameLooksUnresolved(configName, id)) return configName;
    if (!nameLooksUnresolved(dbName, id)) return dbName;
    return `Unknown chat (#${id})`;
}

/**
 * Dialogs, groups listing, groups CRUD, photo serving, and refresh routes.
 *
 * Dialog-cache state is held as `let` vars in server.js so that:
 *   - the maintenance router's resetDialogsCaches closure can reset them, and
 *   - the downloads router can read `_dialogsNameCache.byId` via its own closure.
 * The router reads/writes them exclusively via the getter/setter pairs below.
 *
 * @param {object} ctx
 * @param {string}   ctx.configPath
 * @param {string}   ctx.photosDir
 * @param {string}   ctx.sessionsDir
 * @param {Function} ctx.broadcast
 * @param {Function} ctx.getAccountManager        async () => AccountManager
 * @param {Function} ctx.getTelegramClient        () => TelegramClient|null
 * @param {Function} ctx.resolveEntityAcrossAccounts async (idStr) => {entity}|null
 * @param {Function} ctx.downloadProfilePhoto     async (groupId) => url|null
 * @param {Function} ctx.writeConfigAtomic        async (config) => void
 * @param {Function} ctx.getJobTracker            (key) => JobTracker
 * @param {Function} ctx.spawnInternalBackfill    async (opts) => void
 * @param {Function} ctx.isBackfillActive         (groupId) => boolean
 * @param {Function} ctx.getDialogsRespCache      () => { at, body }
 * @param {Function} ctx.setDialogsRespCache      (v) => void
 * @param {Function} ctx.getDialogsNamesState     () => { at, byId: Map }
 * @param {Function} ctx.setDialogsNamesState     (v) => void
 * @param {Function} ctx.getDialogsTypeMap        () => Map<string,string>
 * @param {Function} ctx.setDialogsTypeMap        (v) => void
 */
export function createGroupsRouter({
    configPath, photosDir, sessionsDir, broadcast,
    getAccountManager, getTelegramClient,
    resolveEntityAcrossAccounts, downloadProfilePhoto,
    writeConfigAtomic, getJobTracker,
    spawnInternalBackfill, isBackfillActive,
    getDialogsRespCache, setDialogsRespCache,
    getDialogsNamesState, setDialogsNamesState,
    getDialogsTypeMap, setDialogsTypeMap,
}) {
    const router = express.Router();

    // Calls Telegram API if the name cache is cold; returns Map<id, name>.
    // Also refreshes the type cache as a side-effect (free — we already have
    // the dialog objects in hand). Both caches are stored in server.js `let`
    // vars via the setter pairs so existing closures in maintenance / downloads
    // continue to work without re-wiring.
    async function refreshDialogsNameCache() {
        const now = Date.now();
        const byId = new Map();
        const typeById = new Map();
        try {
            const am = await getAccountManager();
            const clientList = [];
            for (const [, c] of am.clients) clientList.push(c);
            const legacyClient = getTelegramClient();
            if (legacyClient?.connected && !clientList.includes(legacyClient)) clientList.push(legacyClient);

            for (const client of clientList) {
                if (!client?.connected) continue;
                try {
                    const [active, archived] = await Promise.all([
                        client.getDialogs({ limit: 500 }).catch(() => []),
                        client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                    ]);
                    for (const d of [...active, ...archived]) {
                        const id = String(d.id);
                        const name = d.title
                            || d.name
                            || ((d.entity?.firstName || '') + (d.entity?.lastName ? ' ' + d.entity.lastName : '')).trim()
                            || d.entity?.username
                            || null;
                        if (name && !nameLooksUnresolved(name, id) && !byId.has(id)) {
                            byId.set(id, name);
                        }
                        if (!typeById.has(id)) {
                            let t = 'group';
                            if (d.isChannel) t = 'channel';
                            else if (d.isUser && d.entity?.bot) t = 'bot';
                            else if (d.isUser) t = 'user';
                            typeById.set(id, t);
                        }
                    }
                } catch { /* one bad client doesn't kill the whole sweep */ }
            }
        } catch { /* no AM — fresh install */ }
        setDialogsNamesState({ at: now, byId });
        setDialogsTypeMap(typeById);
        return byId;
    }

    // Lookup helper used by /api/groups and /api/downloads (via ctx function).
    function dialogsTypeFor(id) {
        return getDialogsTypeMap().get(String(id)) || null;
    }

    // Returns the cached name Map, calling Telegram if the cache is cold.
    async function getDialogsNameCache() {
        const now = Date.now();
        const state = getDialogsNamesState();
        if (Math.max(0, now - state.at) < DIALOG_CACHE_TTL_MS && state.byId.size > 0) {
            return state.byId;
        }
        return refreshDialogsNameCache();
    }

    // 2. Dialogs API (Groups)
    // /api/dialogs response cache. Telegram rate-limits getDialogs aggressively
    // and the picker is opened many times in a typical session — caching the
    // fully-built result for 5 min cuts the Telegram round-trip out of every
    // repeat open. `?fresh=1` forces a refetch if the user wants to see a
    // just-added chat.
    // `at` is wallclock milliseconds; comparisons elsewhere always use Math.max(0, …)
    // to stay safe across NTP backward jumps.
    router.get('/api/dialogs', async (req, res) => {
        try {
            const wantFresh = req.query.fresh === '1';
            const now = Date.now();
            const respCache = getDialogsRespCache();
            if (!wantFresh
                && respCache.body
                && Math.max(0, now - respCache.at) < DIALOG_CACHE_TTL_MS) {
                return res.json(respCache.body);
            }

            // Collect every connected client + its account metadata. Using only
            // the default client made groups visible to a second/third account
            // silently disappear from the picker.
            const clientPairs = [];
            try {
                const am = await getAccountManager();
                for (const [accountId, c] of am.clients) {
                    if (!c?.connected) continue;
                    const meta = am.metadata.get(accountId) || { id: accountId };
                    clientPairs.push({ id: accountId, meta, client: c });
                }
            } catch { /* no creds yet */ }
            const legacyClient = getTelegramClient();
            if (legacyClient?.connected && !clientPairs.some(p => p.client === legacyClient)) {
                clientPairs.push({
                    id: 'legacy',
                    meta: { id: 'legacy', name: 'Default', phone: '', username: '' },
                    client: legacyClient,
                });
            }
            if (clientPairs.length === 0) {
                // Distinguish "no Telegram account configured yet" (operator
                // hasn't run through Add Account) from "client is briefly
                // disconnected" — the SPA renders a friendly empty-state with
                // an Add Account CTA for the former, vs. a red error for the
                // latter.
                const hasSession = existsSync(sessionsDir)
                    && fsSync.readdirSync(sessionsDir).some(f => f.endsWith('.enc'));
                if (!hasSession) {
                    return res.status(503).json({ error: 'no_account', message: 'No Telegram account configured' });
                }
                return res.status(503).json({ error: 'not_connected', message: 'Telegram client not connected' });
            }

            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const configGroups = config.groups || [];
            const allowDM = config.allowDmDownloads === true;

            // Fan out across every account — active + archived per client in
            // parallel. One bad client (e.g. mid-reconnect) doesn't kill the
            // sweep; we just lose its chats from this response.
            const perClient = await Promise.all(clientPairs.map(async (p) => {
                const [a, ar] = await Promise.all([
                    p.client.getDialogs({ limit: 500 }).catch(() => []),
                    p.client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                ]);
                return { accountId: p.id, accountMeta: p.meta, active: a, archived: ar };
            }));

            // Build maps keyed by dialog id:
            //   firstDialog[id] -> { d, archived } picked on first sighting (active wins over archived)
            //   accountIds[id]  -> Set of every accountId that sees this chat
            const firstDialog = new Map();
            const accountIds = new Map();

            // Side-effect: warm the name cache used by /api/groups + /api/downloads.
            // Free since we already have the dialog objects in hand.
            const nameById = new Map(getDialogsNamesState().byId);
            for (const p of perClient) {
                for (const isArchived of [false, true]) {
                    const list = isArchived ? p.archived : p.active;
                    for (const d of list) {
                        const id = String(d.id);

                        if (!accountIds.has(id)) accountIds.set(id, new Set());
                        accountIds.get(id).add(p.accountId);

                        if (!firstDialog.has(id)) firstDialog.set(id, { d, archived: isArchived });

                        const nm = d.title
                            || d.name
                            || ((d.entity?.firstName || '') + (d.entity?.lastName ? ' ' + d.entity.lastName : '')).trim()
                            || d.entity?.username
                            || null;
                        if (nm && !nameLooksUnresolved(nm, id)) nameById.set(id, nm);
                    }
                }
            }
            setDialogsNamesState({ at: now, byId: nameById });
            const merged = [];
            for (const [, entry] of firstDialog) {
                merged.push(entry);
            }

            // Account directory for the response — lets the SPA render account
            // chips by id without a second round-trip to /api/accounts.
            const accounts = clientPairs.map(p => ({
                id: p.id,
                name: p.meta?.name || p.meta?.username || p.id,
                phone: p.meta?.phone || '',
                username: p.meta?.username || '',
            }));

            const results = merged
                .filter(({ d }) => {
                    if (d.isGroup || d.isChannel) return true;
                    // DMs (user/bot conversations) are off by default for privacy;
                    // gated behind the allowDmDownloads master switch.
                    return !!d.isUser && allowDM;
                })
                .map(({ d, archived }) => {
                    const id = d.id.toString();
                    const configGroup = configGroups.find(g => String(g.id) === id);
                    let type = 'group';
                    if (d.isChannel) type = 'channel';
                    else if (d.isUser && d.entity?.bot) type = 'bot';
                    else if (d.isUser) type = 'user';
                    return {
                        id,
                        name: d.title || d.name || (d.entity?.firstName || '') + (d.entity?.lastName ? ' ' + d.entity.lastName : '') || 'Unknown',
                        type,
                        username: d.username,
                        archived,
                        members: d.entity?.participantsCount || null,
                        enabled: configGroup?.enabled || false,
                        inConfig: !!configGroup,
                        filters: configGroup?.filters || { photos: true, videos: true, files: true, links: true, voice: false, gifs: false, stickers: false },
                        autoForward: configGroup?.autoForward || { enabled: false, destination: null, deleteAfterForward: false },
                        photoUrl: `/api/groups/${id}/photo`,
                        accountIds: Array.from(accountIds.get(id) || []).sort(),
                    };
                });

            const body = { success: true, dialogs: results, allowDM, accounts };
            setDialogsRespCache({ at: now, body });
            res.json(body);
        } catch (error) {
            console.error('GET /api/dialogs:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 3. Config Groups List (with Photo URLs)
    router.get('/api/groups', async (req, res) => {
        try {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            // Pull the best DB-side name per group_id so a config row with
            // "Unknown" doesn't shadow a real name we already saved at
            // download time. Plain MAX(group_name) misbehaves on this
            // schema because "Unknown" sorts above most ASCII titles —
            // a group with rows ["Unknown", "Cool Channel"] would surface
            // "Unknown". CASE-filter out the placeholders before MAX, then
            // fall back to MAX(any) only if every row was a placeholder.
            let dbNames = new Map();
            try {
                const rows = getDb().prepare(`
                    SELECT group_id,
                           MAX(CASE
                                 WHEN group_name IS NOT NULL
                                  AND group_name != ''
                                  AND group_name != 'Unknown'
                                  AND group_name != 'unknown'
                                  AND group_name NOT GLOB '-?[0-9]*'
                                  AND group_name NOT GLOB 'Group [0-9]*'
                               THEN group_name END) AS best_name,
                           MAX(group_name) AS any_name
                      FROM downloads
                     GROUP BY group_id`).all();
                for (const r of rows) dbNames.set(String(r.group_id), r.best_name || r.any_name);
            } catch {}

            // Live dialogs from every connected account — same source the
            // Browse-chats picker uses, so the sidebar shows the same name.
            const dialogsNames = await getDialogsNameCache();

            const groupsWithPhotos = await Promise.all((config.groups || []).map(async (group) => {
                const photoPath = path.join(photosDir, `${group.id}.jpg`);
                const hasPhoto = existsSync(photoPath);
                return {
                    ...group,
                    name: bestGroupName(group.id, group.name, dbNames.get(String(group.id)), dialogsNames.get(String(group.id))),
                    // Sidebar uses `type` to render the right corner icon
                    // (megaphone vs group vs user/bot). Without this the
                    // Downloaded Groups list defaulted to the id-prefix
                    // heuristic in createAvatar() which painted every
                    // supergroup as a channel.
                    type: group.type || dialogsTypeFor(group.id),
                    photoUrl: hasPhoto ? `/photos/${group.id}.jpg` : null
                };
            }));
            res.json(groupsWithPhotos);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 8. Group Update
    router.put('/api/groups/:id', async (req, res) => {
        try {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const groupId = req.params.id;
            let groupIndex = config.groups.findIndex(g => String(g.id) === groupId);

            if (groupIndex === -1) {
                // Create new — resolve a real name from any loaded account.
                let groupName = req.body.name;
                if (!groupName || groupName === 'Unknown' || groupName === groupId || groupName.startsWith('Group ')) {
                    const r = await resolveEntityAcrossAccounts(groupId);
                    if (r?.entity) {
                        const e = r.entity;
                        groupName = e.title
                            || (e.firstName && (e.firstName + (e.lastName ? ' ' + e.lastName : '')))
                            || e.username
                            || groupName;
                    }
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
            if (req.body.topics !== undefined) {
                // Allow {enabled, ids:[]} or null to clear.
                if (req.body.topics === null) delete group.topics;
                else group.topics = {
                    enabled: !!req.body.topics.enabled,
                    ids: Array.isArray(req.body.topics.ids) ? req.body.topics.ids.map(Number).filter(Number.isFinite) : [],
                };
            }

            // Comment media tracking
            if (req.body.trackComments !== undefined) {
                group.trackComments = !!req.body.trackComments;
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

            // Rescue Mode (per-group). 'auto' = follow global cfg.rescue.enabled,
            // 'on' / 'off' override. Empty / null falls back to default ('auto').
            if (req.body.rescueMode !== undefined) {
                const v = req.body.rescueMode;
                if (v === 'on' || v === 'off' || v === 'auto') group.rescueMode = v;
                else delete group.rescueMode;
            }
            if (req.body.rescueRetentionHours !== undefined) {
                const n = parseInt(req.body.rescueRetentionHours, 10);
                if (Number.isFinite(n) && n > 0) {
                    group.rescueRetentionHours = Math.max(1, Math.min(720, n));
                } else {
                    delete group.rescueRetentionHours;
                }
            }

            await writeConfigAtomic(config);
            broadcast({ type: 'config_updated', config });

            // Auto-backfill on first add (v2.3.34) — when a group transitions
            // from "never seen / disabled" → "enabled" AND has zero rows in
            // downloads yet, kick off a background backfill of the last N
            // messages so the user gets immediate gallery content without
            // having to navigate to the Backfill page. Bounded by config so
            // operators who don't want this behavior can disable it.
            try {
                if (req.body.enabled === true && !isBackfillActive(String(group.id))) {
                    const histCfg = config.advanced?.history || {};
                    const autoOn = histCfg.autoFirstBackfill !== false;     // default ON
                    const autoLim = Number(histCfg.autoFirstLimit ?? 100);  // default 100
                    if (autoOn && autoLim > 0) {
                        const { count } = getMessageIdRange(String(group.id));
                        if (count === 0) {
                            // Fire-and-forget — calling our handler logic directly
                            // keeps everything in one process without an HTTP hop.
                            // Failures are non-fatal: the user can always trigger
                            // backfill manually from the Backfill page.
                            spawnInternalBackfill({
                                groupId: String(group.id),
                                limit: Math.max(1, Math.min(10000, autoLim)),
                                mode: 'pull-older',
                                reason: 'auto-first',
                            }).catch((e) => console.warn('[auto-backfill] first-add failed:', e?.message || e));
                        }
                    }
                }
            } catch (e) {
                // Non-fatal — group save still succeeded.
                console.warn('[auto-backfill] hook error:', e?.message || e);
            }

            res.json({ success: true, group: config.groups[groupIndex] });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 9. Profile Photos
    router.get('/api/groups/:id/photo', async (req, res) => {
        const id = req.params.id;
        // Telegram entity IDs are signed integers — anything else is suspicious
        // (path-traversal attempts, control chars, NUL, etc.). Reject hard
        // before we touch the filesystem.
        if (!/^-?\d+$/.test(id)) return res.status(400).send('Invalid id');
        const photoPath = path.join(photosDir, `${id}.jpg`);

        // Realpath check defends against the case where photosDir or one of
        // its descendants is a symlink that points outside the data dir.
        const send = () => {
            try {
                const real = fsSync.realpathSync(photoPath);
                const realRoot = fsSync.realpathSync(photosDir);
                if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
                    return res.status(400).send('Path escape detected');
                }
                // Override the global /api/* `no-store` policy — avatar bytes
                // are content-addressed by group ID and the file is rewritten
                // in place when the group's photo changes, so a 1-day private
                // cache is safe AND eliminates the per-render avatar flicker
                // (every renderGroupsList re-paint was triggering a fresh
                // round trip thanks to no-store).
                res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
                return res.sendFile(real);
            } catch { return res.status(404).send('Not found'); }
        };

        if (existsSync(photoPath)) return send();

        // Try download if not exists
        const url = await downloadProfilePhoto(id);
        if (url && existsSync(photoPath)) return send();

        res.status(404).send('Not found');
    });

    // Walks every group (config-defined and DB-only) and tries to resolve a
    // human-readable name + cached profile photo. Used by the SPA when it
    // detects a row whose name is "Unknown" or just the numeric id.
    //
    // Fire-and-forget — with 100 groups × Telegram rate limits this can take
    // 30+ s. POST returns instantly; per-id progress streams via
    // `groups_refresh_info_progress`, the final `updates` array via
    // `groups_refresh_info_done`. The legacy `groups_refreshed` broadcast is
    // preserved for clients that already subscribe to it.
    router.post('/api/groups/refresh-info', async (req, res) => {
        const tracker = getJobTracker('groupsRefreshInfo');
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const ids = new Set((config.groups || []).map(g => String(g.id)));
            try {
                const rows = getDb().prepare('SELECT DISTINCT group_id, group_name FROM downloads').all();
                for (const rr of rows) ids.add(String(rr.group_id));
            } catch {}

            let updated = 0;
            let mutatedConfig = false;
            const updates = [];
            const total = ids.size;
            let processed = 0;
            onProgress({ processed: 0, total, updated: 0, stage: 'resolving' });
            for (const id of ids) {
                const resolved = await resolveEntityAcrossAccounts(id);
                if (resolved) {
                    const { entity } = resolved;
                    const realName = entity?.title
                        || (entity?.firstName && (entity.firstName + (entity.lastName ? ' ' + entity.lastName : '')))
                        || entity?.username || null;
                    if (realName) {
                        const cg = (config.groups || []).find(g => String(g.id) === id);
                        if (cg && (!cg.name || cg.name === 'Unknown' || cg.name === id || cg.name.startsWith('Group '))) {
                            cg.name = realName;
                            mutatedConfig = true;
                        }
                        try {
                            const stmt = getDb().prepare(`UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`);
                            stmt.run(realName, id, id);
                        } catch {}
                        updates.push({ id, name: realName });
                        updated++;
                    }
                    await downloadProfilePhoto(id).catch(() => {});
                }
                processed += 1;
                onProgress({ processed, total, updated, stage: 'resolving' });
            }
            if (mutatedConfig) await writeConfigAtomic(config);
            if (updates.length) {
                try { broadcast({ type: 'groups_refreshed', updates }); } catch {}
            }
            return { updated, scanned: total, updates };
        });
        if (!r.started) {
            // Hydrate the snapshot so the front-end keeps the button disabled
            // and doesn't show a misleading "failed" toast.
            return res.status(409).json({ error: 'Group refresh already in progress', code: 'ALREADY_RUNNING', snapshot: r.snapshot });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/groups/refresh-info/status', async (req, res) => {
        res.json(getJobTracker('groupsRefreshInfo').getStatus());
    });

    router.post('/api/groups/refresh-photos', async (req, res) => {
        const tracker = getJobTracker('groupsRefreshPhotos');
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const groups = config.groups || [];
            const total = groups.length;
            let processed = 0;
            const results = [];
            onProgress({ processed: 0, total, stage: 'downloading' });
            for (const group of groups) {
                const url = await downloadProfilePhoto(group.id).catch(() => null);
                results.push({ id: group.id, url });
                processed += 1;
                onProgress({ processed, total, stage: 'downloading' });
            }
            return { results };
        });
        if (!r.started) {
            return res.status(409).json({ error: 'Photo refresh already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/api/groups/refresh-photos/status', async (req, res) => {
        res.json(getJobTracker('groupsRefreshPhotos').getStatus());
    });

    return router;
}
