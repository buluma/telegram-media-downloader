/**
 * Auto Forwarder - Uploads downloaded media to a destination channel
 * Supports: Single Aggregation Channel, Custom Destination, Delete after forward
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Api } from 'telegram';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { deferDelete } from './delete-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.resolve(__dirname, '../../data/downloads');

export class AutoForwarder {
    constructor(client, config, accountManager = null) {
        this.client = client;
        this.config = config;
        this.accountManager = accountManager;
        this.storageChannelId = null; // Cache for the single storage channel
    }

    /**
     * Main processing entry point
     * @param {Object} downloadInfo - From downloader 'download_complete' event
     */
    async process(downloadInfo) {
        const { filePath, groupId, groupName, message, mediaType, deduped } = downloadInfo;

        // Skip forwarding for deduplicated files — the original was already forwarded
        // when first downloaded; re-sending creates identical copies in the destination.
        if (deduped) {
            logger.info(
                { group: groupName, file: filePath ? path.basename(filePath) : groupName },
                '⏭️  [AutoForward] Skipping duplicate file',
            );
            return;
        }

        // 1. Check Group Config
        const groupConfig = this.config.groups.find((g) => String(g.id) === String(groupId));
        if (!groupConfig || !groupConfig.autoForward || !groupConfig.autoForward.enabled) {
            return;
        }

        const settings = groupConfig.autoForward;

        // Use per-group forward account if configured
        const fwdClient =
            this.accountManager && groupConfig.forwardAccount
                ? this.accountManager.getClient(groupConfig.forwardAccount)
                : this.client;

        logger.info({ group: groupName }, '➡️  [AutoForward] Processing');

        try {
            // 2. Resolve Destination
            let targetPeer = await this.resolveDestination(settings.destination, fwdClient);
            if (!targetPeer) {
                logger.warn(
                    { group: groupName, destination: settings.destination },
                    '⚠️  [AutoForward] Could not resolve destination. Skipping.',
                );
                return;
            }

            // 3. Prepare Caption with Message Link
            const TG_CAPTION_LIMIT = 1024;
            let body = message?.message || message?.text || '';

            // Generate message link
            // Format: t.me/c/CHANNEL_ID/MESSAGE_ID (private) or t.me/USERNAME/MESSAGE_ID (public)
            let messageLink = '';
            const msgId = message?.id;
            if (msgId && groupId) {
                // For private channels: use /c/ format with positive ID
                const cleanId = String(groupId).replace(/^-100/, '');
                messageLink = `https://t.me/c/${cleanId}/${msgId}`;
            }

            const suffix = messageLink
                ? `\n\n📌 Source: [${groupName}](${messageLink})`
                : `\n\n📌 Source: **${groupName}**`;

            // Truncate body so body + suffix fits within Telegram's 1024-char limit.
            const maxBody = TG_CAPTION_LIMIT - suffix.length;
            if (body.length > maxBody) {
                body = `${body.slice(0, Math.max(0, maxBody - 1))}…`;
            }

            const caption = body + suffix;

            // 4. Upload & Send with retry — transient errors (FLOOD_WAIT,
            // network hiccups) get up to 3 attempts with exponential backoff.
            // FLOOD_WAIT carries the required wait in seconds; respect it.
            try {
                await fs.access(filePath);
            } catch {
                logger.warn(
                    { file: path.basename(filePath) },
                    '⚠️  [AutoForward] File missing on disk — skipping',
                );
                return;
            }
            const MAX_ATTEMPTS = 3;
            let sentMsg;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    sentMsg = await fwdClient.sendFile(targetPeer, {
                        file: filePath,
                        caption: caption,
                        forceDocument: false,
                        workers: 1,
                    });
                    break;
                } catch (sendErr) {
                    const floodMatch = String(sendErr?.message || '').match(/FLOOD_WAIT_(\d+)/);
                    if (floodMatch) {
                        const waitSec = Number(floodMatch[1]) + 2;
                        logger.warn(
                            { waitSec, attempt, maxAttempts: MAX_ATTEMPTS },
                            '⏳ [AutoForward] Flood wait',
                        );
                        await new Promise((r) => setTimeout(r, waitSec * 1000));
                    } else if (attempt < MAX_ATTEMPTS) {
                        const backoff = 2 ** attempt * 1000;
                        logger.warn(
                            {
                                attempt,
                                maxAttempts: MAX_ATTEMPTS,
                                retrySec: backoff / 1000,
                                err: sendErr?.message,
                            },
                            '⚠️  [AutoForward] Send failed, retrying',
                        );
                        await new Promise((r) => setTimeout(r, backoff));
                    } else {
                        throw sendErr;
                    }
                }
            }

            // GramJS returns the new message; surface its TG message-id in the log
            // so operators can trace the destination copy back from the dashboard.
            const sentMsgId = sentMsg?.id ?? sentMsg?.message?.id ?? null;
            const dest = settings.destination || 'Storage Channel';
            const tail = sentMsgId ? ` (msg #${sentMsgId})` : '';
            logger.info(
                { destination: dest, msgId: sentMsgId },
                `✅ [AutoForward] Sent to ${dest}${tail}`,
            );

            // 5. Cleanup (if enabled). Isolate the unlink in its own
            // try/catch so a successful upload isn't reported as failed
            // when the local delete races with another process. The
            // hourly integrity sweep will eventually drop the orphan
            // DB row whose file is gone (or here, whose file we
            // intentionally couldn't delete).
            //
            // When keepImages / keepVideos is enabled, photos/videos are
            // kept locally even when deleteAfterForward is true. This lets
            // users auto-forward without losing their local copy.
            const shouldDeletePhoto = mediaType === 'photos' ? !settings.keepImages : true;
            const shouldDeleteVideo = mediaType === 'videos' ? !settings.keepVideos : true;
            if (settings.deleteAfterForward && shouldDeletePhoto && shouldDeleteVideo) {
                try {
                    // Skip delete when other DB rows share this file — it is
                    // the dedup canonical copy and removing it would corrupt
                    // every other group that points at the same path.
                    const relPath = path.relative(DOWNLOADS_DIR, filePath).replace(/\\/g, '/');
                    const sharedCount =
                        getDb()
                            .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_path = ?`)
                            .get(relPath)?.n ?? 0;
                    if (sharedCount > 1) {
                        logger.info(
                            { file: path.basename(filePath), sharedCount },
                            '⏭️  [AutoForward] Skipping delete — file shared by multiple rows',
                        );
                    } else {
                        // 60-second grace period so the backup worker can
                        // finish uploading before the file is removed from
                        // disk. See docs/ROADMAP.md item 3 (Option C).
                        await new Promise((r) => setTimeout(r, 60_000));
                        await deferDelete(filePath);
                        logger.info(
                            { file: path.basename(filePath) },
                            '🗑️  [AutoForward] Deleted local file',
                        );
                    }
                } catch (unlinkErr) {
                    logger.warn(
                        { file: path.basename(filePath), err: unlinkErr.message },
                        '⚠️  [AutoForward] Forwarded but local delete failed',
                    );
                }
            }
        } catch (error) {
            logger.error({ err: error.message, group: groupName }, '❌ [AutoForward] Error');
        }
    }

    /**
     * Resolve where to send the file
     */
    async resolveDestination(destination, client) {
        client = client || this.client;
        // Case A: Specific Destination
        if (destination && destination !== 'storage') {
            // Saved Messages — accept both 'me' and 'saved' aliases.
            if (destination === 'me' || destination === 'saved') return 'me';

            // Try to parse if it's an ID
            if (/^-?\d+$/.test(destination)) {
                try {
                    const id = BigInt(destination);

                    // Primary: cheap, returns InputPeer if GramJS already has the entity cached.
                    try {
                        return await client.getInputEntity(id);
                    } catch {
                        /* fall through */
                    }

                    // Secondary: heavier — scans dialogs and resolves usernames/peers, often
                    // succeeds where getInputEntity fails (e.g. channel never seen on this client).
                    try {
                        const entity = await client.getEntity(id);
                        if (entity) return entity;
                    } catch {
                        /* fall through */
                    }

                    // Last resort: hand-roll an InputPeer from the canonical -100… layout.
                    // accessHash=0 only resolves for channels the bot/user has interacted with
                    // server-side; for fully-private channels the send will fail and the caller
                    // will see a clear error (CHANNEL_INVALID / PEER_ID_INVALID) instead of a
                    // mysterious resolve hang. Logging the fallback so operators can spot it.
                    const raw = String(destination);
                    if (raw.startsWith('-100')) {
                        logger.warn(
                            { destination: raw },
                            '⚠️  [AutoForward] Falling back to manual InputPeerChannel — peer not in dialog cache. If sends fail, open the channel once from the configured account.',
                        );
                        return new Api.InputPeerChannel({
                            channelId: BigInt(raw.replace(/^-100/, '')),
                            accessHash: BigInt(0),
                        });
                    }
                    if (raw.startsWith('-')) {
                        logger.warn(
                            { destination: raw },
                            '⚠️  [AutoForward] Falling back to manual InputPeerChat',
                        );
                        return new Api.InputPeerChat({ chatId: BigInt(raw.replace(/^-/, '')) });
                    }
                    return id;
                } catch {
                    return destination;
                }
            }

            // Treat as username or phone
            return destination;
        }

        // Case B: Auto Storage Channel (Single Channel)
        if (this.storageChannelId) return this.storageChannelId;

        // Try to find existing "Telegram Downloader Storage" in dialogs
        try {
            const dialogs = await client.getDialogs({ limit: 100 });
            const found = dialogs.find((d) => d.title === 'Telegram Downloader Storage');

            if (found) {
                this.storageChannelId = found.entity;
                return this.storageChannelId;
            }

            // Create new if not found
            logger.info('🛠️  [AutoForward] Creating storage channel');
            const result = await client.invoke(
                new Api.channels.CreateChannel({
                    title: 'Telegram Downloader Storage',
                    about: 'Auto-forwarded media storage from Telegram Media Downloader',
                    broadcast: true,
                    megagroup: false,
                }),
            );

            // Access the created channel
            if (result.chats && result.chats[0]) {
                this.storageChannelId = result.chats[0];
                logger.info('✅ [AutoForward] Created channel: Telegram Downloader Storage');
                return this.storageChannelId;
            }
        } catch (e) {
            logger.error(
                { err: e.message },
                '❌ [AutoForward] Failed to create/find storage channel',
            );
        }

        return null;
    }
}
