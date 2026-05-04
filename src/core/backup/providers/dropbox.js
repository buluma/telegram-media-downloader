// Dropbox provider — STUB.
//
// Targets the official `dropbox` SDK with a long-lived refresh token
// (Dropbox dropped non-expiring access tokens in late 2021). Files
// uploaded > 150 MB need the chunked-upload session API; small files
// can use `filesUpload`.
//
// Tracking issue: see docs/BACKUP.md → "TODO providers".

import { BackupProvider } from './base.js';

export class DropboxProvider extends BackupProvider {
    static get name() { return 'dropbox'; }
    static get displayName() { return 'Dropbox (coming soon)'; }
    static get configSchema() {
        return [
            { name: 'appKey',       label: 'App key',       type: 'text',     required: true, secret: true },
            { name: 'appSecret',    label: 'App secret',    type: 'password', required: true, secret: true },
            { name: 'refreshToken', label: 'Refresh token', type: 'password', required: true, secret: true,
                help: 'Generate via the Dropbox developer portal — short-lived access tokens are not supported.' },
            { name: 'remoteRoot',   label: 'Remote root',   type: 'text',     required: true,
                placeholder: '/tgdl-backup' },
        ];
    }

    async init(_cfg, _ctx) {
        throw new Error(
            'Dropbox provider not implemented yet — see docs/BACKUP.md "TODO providers" for status.',
        );
    }

    async upload() { throw new Error('not implemented'); }
    async delete() { throw new Error('not implemented'); }
    async stat()   { throw new Error('not implemented'); }
    // eslint-disable-next-line require-yield
    async *list()  { throw new Error('not implemented'); }
    async testConnection() { return { ok: false, detail: 'Dropbox provider not implemented yet' }; }
}
