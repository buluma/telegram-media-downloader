import express from 'express';
import fs from 'fs/promises';
import * as ai from '../../core/ai/index.js';
import * as integrity from '../../core/integrity.js';
import { applyShareLimits } from '../../core/share.js';
import { getDiskRotator } from '../../core/disk-rotator.js';
import { getRescueSweeper } from '../../core/rescue.js';
import { getRescueStats } from '../../core/db.js';
import { NSFW_DEFAULTS } from '../../core/nsfw.js';
import { BACKPRESSURE_CAP_DEFAULT, BACKPRESSURE_MAX_WAIT_MS_DEFAULT } from '../../core/constants.js';

/**
 * Config read/write and rescue stats routes.
 *
 * @param {object} ctx
 * @param {string}   ctx.configPath
 * @param {Function} ctx.broadcast
 * @param {Function} ctx.invalidateConfigCache        () => void
 * @param {Function} ctx.invalidateShareConfigCache   () => void
 * @param {Function} ctx.refreshShareLimiter          () => void
 * @param {Function} ctx.refreshRateLimitConfig       async () => void
 * @param {Function} ctx.resetAccountManager          async () => void — disconnects + nulls _accountManager
 */
export function createConfigRouter({
    configPath, broadcast,
    invalidateConfigCache, invalidateShareConfigCache, refreshShareLimiter,
    refreshRateLimitConfig, resetAccountManager,
}) {
    const router = express.Router();

    router.get('/api/config', async (req, res) => {
        try {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const safe = JSON.parse(JSON.stringify(config));
            // The Telegram apiId is essentially public (it identifies the
            // application registration, not a user) so we surface it to the SPA
            // for editing. apiHash IS sensitive — replace with a presence flag.
            if (safe.telegram) {
                const hashSet = !!safe.telegram.apiHash;
                delete safe.telegram.apiHash;
                safe.telegram.apiHashSet = hashSet;
            }
            if (safe.web) {
                delete safe.web.password;
                delete safe.web.passwordHash;
            }
            if (Array.isArray(safe.accounts)) {
                safe.accounts = safe.accounts.map(a => ({
                    id: a.id, name: a.name, username: a.username,
                }));
            }
            // Per-group account assignments are an internal mapping; surface only
            // a boolean so the SPA can show "(custom account)".
            if (Array.isArray(safe.groups)) {
                safe.groups = safe.groups.map(g => {
                    const out = { ...g };
                    if (out.monitorAccount) { out.hasMonitorAccount = true; delete out.monitorAccount; }
                    if (out.forwardAccount) { out.hasForwardAccount = true; delete out.forwardAccount; }
                    return out;
                });
            }
            res.json(safe);
        } catch (error) {
            console.error('GET /api/config:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Rescue Mode stats — counters for the SPA's Rescue panel.
    router.get('/api/rescue/stats', async (req, res) => {
        try {
            res.json(getRescueStats());
        } catch (e) {
            console.error('GET /api/rescue/stats:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 7b. Config Update
    router.post('/api/config', async (req, res) => {
        try {
            // Reject anything that smells like an attempt to inject auth state
            // through the config endpoint. Web auth lives in dedicated routes.
            if (req.body?.web?.password || req.body?.web?.passwordHash) {
                return res.status(400).json({
                    error: 'Use /api/auth/setup or /api/auth/change-password to manage dashboard auth.',
                });
            }

            // Defence-in-depth against prototype pollution. JSON.parse already
            // rejects __proto__ as a key on most engines, but a cooperating
            // client could still attempt `constructor.prototype` etc. Strip
            // those keys recursively before any spread/merge below.
            const sanitizePollutionKeys = (obj) => {
                if (!obj || typeof obj !== 'object') return obj;
                for (const k of ['__proto__', 'constructor', 'prototype']) {
                    if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
                }
                for (const v of Object.values(obj)) {
                    if (v && typeof v === 'object') sanitizePollutionKeys(v);
                }
                return obj;
            };
            sanitizePollutionKeys(req.body);

            const currentConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
            const newConfig = { ...currentConfig, ...req.body };

            // Deep-merge sub-sections so a partial PATCH (e.g., only telegram.apiId)
            // doesn't blow away the rest of that section (e.g., telegram.apiHash).
            if (req.body.telegram) newConfig.telegram = { ...currentConfig.telegram, ...req.body.telegram };
            if (req.body.download) newConfig.download = { ...currentConfig.download, ...req.body.download };
            if (req.body.rateLimits) newConfig.rateLimits = { ...currentConfig.rateLimits, ...req.body.rateLimits };
            if (req.body.diskManagement) newConfig.diskManagement = { ...currentConfig.diskManagement, ...req.body.diskManagement };
            if (req.body.rescue) newConfig.rescue = { ...(currentConfig.rescue || {}), ...req.body.rescue };
            if (req.body.proxy === null) newConfig.proxy = null; // explicit clear
            else if (req.body.proxy && typeof req.body.proxy === 'object') {
                // Deep-merge so the SPA can omit unchanged fields (e.g., the
                // password) without wiping them. Pass an explicit `null` for a
                // field to remove it.
                const merged = { ...(currentConfig.proxy || {}), ...req.body.proxy };
                for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
                newConfig.proxy = merged;
            }
            if (req.body.web) {
                // Allow toggling enabled flag, but never let the route alter
                // password/passwordHash regardless of source.
                const safeWeb = { ...currentConfig.web, ...req.body.web };
                delete safeWeb.password;
                if (!currentConfig.web?.passwordHash) delete safeWeb.passwordHash;
                else safeWeb.passwordHash = currentConfig.web.passwordHash;
                newConfig.web = safeWeb;
            }

            // Advanced runtime tuning — two-level deep-merge so a PATCH that
            // touches one sub-namespace (e.g. only advanced.downloader) keeps the
            // others intact. Per-field clamping below; out-of-range values are
            // silently dropped to the original constants instead of 400-ing the
            // whole save (the SPA shouldn't fail to save the rest of the form
            // because someone typed `0` into a number field).
            if (req.body.advanced && typeof req.body.advanced === 'object') {
                const cur = currentConfig.advanced || {};
                const inc = req.body.advanced || {};
                const clampInt = (v, lo, hi, def) => {
                    const n = parseInt(v, 10);
                    if (!Number.isFinite(n)) return def;
                    return Math.max(lo, Math.min(hi, n));
                };
                const merged = {
                    downloader: {
                        ...(cur.downloader || {}),
                        ...(inc.downloader || {}),
                    },
                    history: {
                        ...(cur.history || {}),
                        ...(inc.history || {}),
                    },
                    diskRotator: {
                        ...(cur.diskRotator || {}),
                        ...(inc.diskRotator || {}),
                    },
                    integrity: {
                        ...(cur.integrity || {}),
                        ...(inc.integrity || {}),
                    },
                    web: {
                        ...(cur.web || {}),
                        ...(inc.web || {}),
                    },
                    share: {
                        ...(cur.share || {}),
                        ...(inc.share || {}),
                    },
                    nsfw: {
                        ...(cur.nsfw || {}),
                        ...(inc.nsfw || {}),
                    },
                    thumbs: {
                        ...(cur.thumbs || {}),
                        ...(inc.thumbs || {}),
                    },
                    ai: (() => {
                        // Two-level deep-merge for the AI namespace so the
                        // model-swap UI can PATCH a single capability's model
                        // id without flattening the others. Per-capability
                        // sub-objects are spread individually for the same
                        // reason.
                        const c = cur.ai || {};
                        const i = inc.ai || {};
                        const merged = {
                            ...c,
                            ...i,
                            embeddings: { ...(c.embeddings || {}), ...(i.embeddings || {}) },
                            faces:      { ...(c.faces || {}),      ...(i.faces || {}) },
                            tags:       { ...(c.tags || {}),       ...(i.tags || {}) },
                            phash:      { ...(c.phash || {}),      ...(i.phash || {}) },
                        };
                        // HuggingFace access token — string only; trim + cap at
                        // 256 chars (real tokens are ~37 chars, anything longer
                        // is malformed input). Empty string clears the token.
                        if (typeof merged.hfToken === 'string') {
                            merged.hfToken = merged.hfToken.trim().slice(0, 256);
                        } else if (merged.hfToken != null) {
                            merged.hfToken = '';
                        }
                        return merged;
                    })(),
                };
                // ffmpeg hwaccel — allow-list validation. An attacker who
                // got past the admin gate could otherwise pass arbitrary
                // text into the ffmpeg `-hwaccel <…>` arg. Allow-list keeps
                // the universe of accepted values explicit; anything off-list
                // falls back to '' (CPU). Documented in docs/DEPLOY.md.
                const HWACCEL_ALLOW = new Set(['', 'vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va', 'dxva2']);
                const hwIn = String(merged.thumbs?.hwaccel || '').toLowerCase().trim();
                merged.thumbs.hwaccel = HWACCEL_ALLOW.has(hwIn) ? hwIn : '';
                // warnMisses — boolean, default true. Coerce non-false to true
                // so a hand-edited string ("yes", 1) doesn't quietly disable
                // the helpful warning.
                merged.thumbs.warnMisses = merged.thumbs.warnMisses !== false;
                // Clamp every numeric so a typo can't ban the user from logging
                // in (sessionTtlDays=0) or hose the downloader (minConcurrency=0).
                const d = merged.downloader;
                d.minConcurrency      = clampInt(d.minConcurrency,       1,    100, 3);
                d.maxConcurrency      = clampInt(d.maxConcurrency,       1,    100, 20);
                if (d.maxConcurrency < d.minConcurrency) d.maxConcurrency = d.minConcurrency;
                d.scalerIntervalSec   = clampInt(d.scalerIntervalSec,    1,    600, 5);
                d.idleSleepMs         = clampInt(d.idleSleepMs,         50,  10000, 200);
                d.spilloverThreshold  = clampInt(d.spilloverThreshold, 100, 100000, 2000);

                const h = merged.history;
                h.backpressureCap         = clampInt(h.backpressureCap,         10, 100000, BACKPRESSURE_CAP_DEFAULT);
                h.backpressureMaxWaitMs   = clampInt(h.backpressureMaxWaitMs, 5000, 3600000, BACKPRESSURE_MAX_WAIT_MS_DEFAULT);
                h.shortBreakEveryN        = clampInt(h.shortBreakEveryN,         0, 100000, 100);
                h.longBreakEveryN         = clampInt(h.longBreakEveryN,          0, 1000000, 1000);
                // Recent-backfills retention. Anything older than this gets
                // pruned at next read of `data/history-jobs.json`. 1-3650 days.
                h.retentionDays           = clampInt(h.retentionDays,            1, 3650, 30);
                // v2.3.34 — auto-backfill knobs
                h.autoFirstBackfill       = h.autoFirstBackfill !== false;       // default ON
                h.autoFirstLimit          = clampInt(h.autoFirstLimit,           0, 10000, 100);
                h.autoCatchUp             = h.autoCatchUp !== false;             // default ON
                h.autoCatchUpThreshold    = clampInt(h.autoCatchUpThreshold,     1, 100000, 5);
                h.batchInsertSize         = clampInt(h.batchInsertSize,          1, 500, 50);
                h.batchInsertMaxAgeMs     = clampInt(h.batchInsertMaxAgeMs,    100, 60000, 1000);

                const sh = merged.share;
                // 1 second floor / 10 years ceiling. Defaults match the spec
                // values share.js uses pre-config (60 / 90d / 7d).
                sh.ttlMinSec       = clampInt(sh.ttlMinSec,        1, 315360000, 60);
                sh.ttlMaxSec       = clampInt(sh.ttlMaxSec, sh.ttlMinSec, 315360000, 7776000);
                // ttlDefault must lie inside [min, max] — clamped here so the
                // SPA can't ship an out-of-range default that fails the picker.
                sh.ttlDefaultSec   = clampInt(sh.ttlDefaultSec, sh.ttlMinSec, sh.ttlMaxSec, 604800);
                sh.rateLimitWindowMs = clampInt(sh.rateLimitWindowMs, 1000, 3600000, 60000);
                sh.rateLimitMax      = clampInt(sh.rateLimitMax,         1, 100000,    60);

                // NSFW review tool. All values are config-driven — no hardcoded
                // model id, threshold, or concurrency in code.
                const ns = merged.nsfw;
                ns.enabled    = ns.enabled === true;          // explicit opt-in only
                // Threshold is on a 0-1 score axis; clamped via integer math by
                // multiplying through so the same clampInt helper works.
                const tInt = Math.round((Number(ns.threshold) || NSFW_DEFAULTS.threshold) * 1000);
                ns.threshold  = clampInt(tInt, 100, 990, 600) / 1000;
                ns.concurrency = clampInt(ns.concurrency, 1, 4, NSFW_DEFAULTS.concurrency);
                ns.batchSize   = clampInt(ns.batchSize,  10, 500, NSFW_DEFAULTS.batchSize);
                // Model id + cache dir + fileTypes are strings/arrays — light
                // validation only (string coerce, allowlist-strip).
                ns.model = (typeof ns.model === 'string' && ns.model.trim())
                    ? ns.model.trim() : NSFW_DEFAULTS.model;
                // dtype controls which ONNX variant is fetched from HuggingFace.
                // Allow-list keeps a typo from sending arbitrary text to the
                // transformers.js loader and helps the UI fall back to the
                // documented default when the operator clears the field.
                const NSFW_DTYPES = new Set(['q8', 'fp16', 'fp32', 'q4']);
                const dIn = String(ns.dtype || '').toLowerCase().trim();
                ns.dtype = NSFW_DTYPES.has(dIn) ? dIn : NSFW_DEFAULTS.dtype;
                ns.cacheDir = (typeof ns.cacheDir === 'string' && ns.cacheDir.trim())
                    ? ns.cacheDir.trim() : NSFW_DEFAULTS.cacheDir;
                const ALLOWED_TYPES = ['photo', 'video', 'sticker', 'document'];
                ns.fileTypes = (Array.isArray(ns.fileTypes) ? ns.fileTypes : NSFW_DEFAULTS.fileTypes)
                    .map(s => String(s).toLowerCase())
                    .filter(s => ALLOWED_TYPES.includes(s));
                if (!ns.fileTypes.length) ns.fileTypes = NSFW_DEFAULTS.fileTypes.slice();

                const r = merged.diskRotator;
                r.sweepBatch         = clampInt(r.sweepBatch,         1,   1000, 50);
                r.maxDeletesPerSweep = clampInt(r.maxDeletesPerSweep, 1, 100000, 5000);

                const it = merged.integrity;
                it.intervalMin = clampInt(it.intervalMin, 1, 10080, 60);
                it.batchSize   = clampInt(it.batchSize,   1,  1024, 64);

                const w = merged.web;
                w.sessionTtlDays = clampInt(w.sessionTtlDays, 1, 365, 7);

                newConfig.advanced = merged;
            }

            // Range / type sanity for the most-abused fields
            const dl = newConfig.download || {};
            if (dl.concurrent != null && (dl.concurrent < 1 || dl.concurrent > 50)) {
                return res.status(400).json({ error: 'download.concurrent must be 1-50' });
            }
            if (dl.retries != null && (dl.retries < 0 || dl.retries > 50)) {
                return res.status(400).json({ error: 'download.retries must be 0-50' });
            }
            if (newConfig.pollingInterval != null && newConfig.pollingInterval < 1) {
                return res.status(400).json({ error: 'pollingInterval must be >= 1 (seconds)' });
            }

            // Atomic write — write to a temp file then rename so a crash mid-write
            // can't leave config.json half-flushed.
            const tmpPath = configPath + '.tmp';
            await fs.writeFile(tmpPath, JSON.stringify(newConfig, null, 4));
            await fs.rename(tmpPath, configPath);
            invalidateConfigCache();
            // Re-apply runtime knobs that depend on advanced.share / advanced.history
            // so a save takes effect immediately without a process restart.
            try {
                applyShareLimits(newConfig.advanced?.share || {});
                invalidateShareConfigCache();
                refreshShareLimiter();
            } catch {}

            // Reset the lazy AccountManager singleton if Telegram credentials
            // changed — a stale instance would still be wired to the old apiId.
            if (req.body.telegram) {
                await resetAccountManager();
            }

            // Refresh the cached rate-limit config so the toggle / RPM change
            // takes effect immediately instead of waiting for the 30s sweep.
            if (req.body.web?.rateLimit) refreshRateLimitConfig();

            // Drop cached AI pipelines for any capability whose model id
            // changed. Without this, a save through the model-swap UI would
            // not take effect until the process restarted because the old
            // pipeline handle is still cached under the old id.
            if (req.body.advanced?.ai) {
                try {
                    const oldAi = currentConfig.advanced?.ai || {};
                    const newAi = newConfig.advanced?.ai || {};
                    const _drop = async (oldId) => {
                        if (oldId) await ai.clearPipelineForModel(oldId);
                    };
                    for (const cap of ['embeddings', 'faces', 'tags']) {
                        const o = oldAi[cap]?.model || '';
                        const n = newAi[cap]?.model || '';
                        if (o && o !== n) _drop(o).catch(() => {});
                    }
                } catch (e) { console.warn('[ai] pipeline reset failed:', e.message); }
            }

            // Restart the disk rotator if the user changed any diskManagement
            // field — picks up the new cap / enabled / interval on the very next
            // sweep instead of waiting for whatever was already scheduled.
            if (req.body.diskManagement || req.body.advanced?.diskRotator) {
                try { getDiskRotator()?.restart(); } catch (e) { console.warn('[disk-rotator] restart failed:', e.message); }
            }
            // Same story for the rescue sweeper — sweep cadence (and the global
            // enabled flag, since per-group 'auto' follows it) needs to take
            // effect immediately, not on the next scheduled tick.
            if (req.body.rescue) {
                try { getRescueSweeper()?.restart(); } catch (e) { console.warn('[rescue] restart failed:', e.message); }
            }
            // Re-arm the integrity sweeper when its cadence/batch changes so the
            // user doesn't have to wait a full hour for the new interval to kick
            // in. Reads the merged config (newConfig) for the latest values.
            if (req.body.advanced?.integrity) {
                try {
                    const ai = newConfig?.advanced?.integrity || {};
                    integrity.start({
                        broadcast,
                        intervalMin: Number(ai.intervalMin) > 0 ? Number(ai.intervalMin) : 60,
                        batchSize:   Number(ai.batchSize)   > 0 ? Number(ai.batchSize)   : 64,
                    });
                } catch (e) { console.warn('[integrity] restart failed:', e.message); }
            }

            broadcast({ type: 'config_updated' });
            res.json({ success: true });
        } catch (error) {
            console.error('POST /api/config:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    return router;
}
