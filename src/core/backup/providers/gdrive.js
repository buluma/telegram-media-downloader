// Google Drive provider — STUB.
//
// Targets `googleapis` (a service-account JSON or an OAuth2 refresh
// token will be the two supported auth shapes). Drive's quota model is
// per-account and 750 GB/day egress, so the queue worker should expect
// 403 quotaExceeded responses and back off rather than retry the same
// file in tight loops.
//
// Tracking issue: see docs/BACKUP.md → "TODO providers".

import { BackupProvider } from './base.js';

export class GoogleDriveProvider extends BackupProvider {
    static get name() { return 'gdrive'; }
    static get displayName() { return 'Google Drive (coming soon)'; }
    static get configSchema() {
        return [
            { name: 'authType', label: 'Auth type', type: 'select',
                options: [
                    { value: 'service-account', label: 'Service account JSON' },
                    { value: 'oauth-refresh',   label: 'OAuth2 refresh token' },
                ] },
            { name: 'credentialsJson', label: 'Service account JSON', type: 'textarea', secret: true,
                help: 'Paste the full JSON the Cloud Console "Create key" wizard downloads.' },
            { name: 'refreshToken',    label: 'OAuth refresh token',  type: 'password', secret: true },
            { name: 'clientId',        label: 'OAuth client id',      type: 'text' },
            { name: 'clientSecret',    label: 'OAuth client secret',  type: 'password', secret: true },
            { name: 'folderId',        label: 'Target folder id',     type: 'text', required: true,
                help: 'Drive folder where uploads land. Find it in the Drive URL.' },
        ];
    }

    async init(_cfg, _ctx) {
        throw new Error(
            'Google Drive provider not implemented yet — see docs/BACKUP.md "TODO providers" for status. ' +
            'Cloud-storage backups are well covered by the S3 driver against an Cloudflare R2 bucket; ' +
            'consider that as a stop-gap.',
        );
    }

    async upload() { throw new Error('not implemented'); }
    async delete() { throw new Error('not implemented'); }
    async stat()   { throw new Error('not implemented'); }
    // eslint-disable-next-line require-yield
    async *list()  { throw new Error('not implemented'); }
    async testConnection() { return { ok: false, detail: 'Google Drive provider not implemented yet' }; }
}
