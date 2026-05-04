// FTP / FTPS provider — STUB.
//
// The optional `basic-ftp` dependency does the heavy lifting. The
// upload + delete + list + stat shape will mirror the LocalProvider
// (paths under a configured remoteRoot) so the wizard form stays
// minimal for non-technical operators.
//
// Tracking issue: see docs/BACKUP.md → "TODO providers".

import { BackupProvider } from './base.js';

export class FtpProvider extends BackupProvider {
    static get name() { return 'ftp'; }
    static get displayName() { return 'FTP / FTPS (coming soon)'; }
    static get configSchema() {
        return [
            { name: 'host',       label: 'Host',       type: 'text',     required: true },
            { name: 'port',       label: 'Port',       type: 'number',                    placeholder: '21' },
            { name: 'username',   label: 'Username',   type: 'text',     required: true },
            { name: 'password',   label: 'Password',   type: 'password', secret: true },
            { name: 'secure',     label: 'FTPS (TLS)', type: 'select',
                options: [
                    { value: 'false',   label: 'Plain FTP' },
                    { value: 'true',    label: 'Implicit FTPS' },
                    { value: 'control', label: 'Explicit FTPS (AUTH TLS)' },
                ] },
            { name: 'remoteRoot', label: 'Remote root', type: 'text',    required: true,
                placeholder: '/tgdl-backup' },
        ];
    }

    async init(_cfg, _ctx) {
        throw new Error(
            'FTP provider not implemented yet — see docs/BACKUP.md "TODO providers" for status. ' +
            'Use SFTP if you need a stop-gap; SFTP runs over SSH on port 22.',
        );
    }

    async upload() { throw new Error('not implemented'); }
    async delete() { throw new Error('not implemented'); }
    async stat()   { throw new Error('not implemented'); }
    // eslint-disable-next-line require-yield
    async *list()  { throw new Error('not implemented'); }
    async testConnection() { return { ok: false, detail: 'FTP provider not implemented yet' }; }
}
