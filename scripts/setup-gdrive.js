#!/usr/bin/env node
// Walk an operator through the Google Drive OAuth flow on the command
// line and print a refresh token suitable for pasting into the
// backup-destination wizard.
//
// Usage:
//   node scripts/setup-gdrive.js
//
// You'll be prompted for the OAuth client ID + secret (created in the
// Google Cloud Console — see docs/BACKUP.md), then a browser opens
// the consent screen. After approval, a one-shot localhost listener
// captures the authorization code and exchanges it for a refresh token.
//
// No data is sent anywhere except Google's token endpoint. The
// `googleapis` SDK is required: `npm install googleapis`.

import http from 'http';
import readline from 'readline';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

function ask(rl, q) {
    return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

/**
 * Start a one-shot HTTP listener on a random available port. Returns a
 * promise that resolves with the authorization code from Google's
 * redirect, plus the port the server is listening on.
 */
// `error` comes straight from the redirect's query string, so it must not
// reach the page as markup.
function escapeHtml(value) {
    return String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
}

function startCallbackServer() {
    return new Promise((resolve, reject) => {
        let settled = false;
        const server = http.createServer((req, res) => {
            if (settled) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Already processed — you can close this tab.');
                return;
            }
            const url = new URL(req.url, `http://127.0.0.1`);
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(
                    `<h2>Authorization denied</h2><p>${escapeHtml(error)}</p><p>You can close this tab.</p>`,
                );
                settled = true;
                server.close();
                reject(new Error(`Authorization denied: ${error}`));
                return;
            }
            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing authorization code in callback.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                '<h2>Authorization received</h2>' +
                    '<p>You can close this tab and return to the terminal.</p>',
            );
            settled = true;
            server.close();
            resolve(code);
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            // Attach port so the caller can build the redirect URI.
            server._boundPort = port;
        });
        // Surface listen errors (port conflict, etc.)
        server.once('error', (e) => {
            if (!settled) reject(e);
        });
        // Resolve immediately with the server so the caller can read the port.
        // The code comes back later via the promise above.
        // We use a two-step approach: return server synchronously for the port,
        // return a separate promise for the code.
    });
}

async function main() {
    let google;
    try {
        ({ google } = await import('googleapis'));
    } catch {
        console.error('Missing dependency. Run: npm install googleapis');
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\nGoogle Drive OAuth refresh-token helper');
    console.log('Need a client ID + secret? See docs/BACKUP.md → Google Drive setup.\n');

    const clientId = await ask(rl, 'OAuth client ID: ');
    const clientSecret = await ask(rl, 'OAuth client secret: ');

    if (!clientId || !clientSecret) {
        console.error('Both clientId and clientSecret are required.');
        rl.close();
        process.exit(1);
    }

    // Start a one-shot localhost listener to capture the OAuth callback.
    // A promise resolves with the code once Google redirects back.
    const server = http.createServer();
    const codePromise = new Promise((resolve, reject) => {
        let settled = false;
        server.on('request', (req, res) => {
            if (settled) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Already processed — you can close this tab.');
                return;
            }
            const url = new URL(req.url, 'http://127.0.0.1');
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(
                    `<h2>Authorization denied</h2><p>${escapeHtml(error)}</p><p>You can close this tab.</p>`,
                );
                settled = true;
                server.close();
                reject(new Error(`Authorization denied: ${error}`));
                return;
            }
            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing authorization code in callback.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                '<h2>Authorization received</h2>' +
                    '<p>You can close this tab and return to the terminal.</p>',
            );
            settled = true;
            server.close();
            resolve(code);
        });
        server.once('error', (e) => {
            if (!settled) reject(e);
        });
    });

    await new Promise((res, rej) => {
        server.listen(0, '127.0.0.1', () => res());
        server.once('error', rej);
    });
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}`;

    const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const authUrl = oauth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [SCOPE],
    });

    console.log('\n1) Open this URL in your browser:');
    console.log(`   ${authUrl}`);
    console.log(`\n2) Sign in, click "Allow", and wait for the redirect to localhost:${port}.`);
    console.log('   The authorization code will be captured automatically.\n');

    // Try to open the browser automatically (best-effort).
    try {
        const { exec } = await import('child_process');
        const cmd =
            process.platform === 'darwin'
                ? `open "${authUrl}"`
                : process.platform === 'win32'
                  ? `start "" "${authUrl}"`
                  : `xdg-open "${authUrl}"`;
        exec(cmd);
    } catch {
        // Manual open is fine — URL is printed above.
    }

    console.log('Waiting for authorization...');

    let code;
    try {
        code = await codePromise;
    } catch (e) {
        console.error(e.message);
        rl.close();
        process.exit(1);
    }

    rl.close();

    let tokens;
    try {
        const r = await oauth.getToken(code);
        tokens = r.tokens;
    } catch (e) {
        console.error('Token exchange failed:', e?.message || e);
        process.exit(1);
    }

    if (!tokens.refresh_token) {
        console.error(
            'Google did not return a refresh_token. This usually means you have already ' +
                'authorised this app — go to https://myaccount.google.com/permissions, revoke ' +
                'the app, then re-run this script.',
        );
        process.exit(1);
    }

    console.log('\n✅ Success. Paste these into the dashboard wizard:\n');
    console.log('  clientId:     ' + clientId);
    console.log('  clientSecret: ' + clientSecret);
    console.log('  refreshToken: ' + tokens.refresh_token);
    console.log('\nKeep the refresh token secret — it grants ongoing access to your Drive.');
    console.log(
        '\n⚠️  If your Cloud project\'s OAuth consent screen is in "Testing" mode,\n' +
            '   refresh tokens expire every 7 days. Publish it to "Production" (no\n' +
            '   Google review needed for drive.file scope) to get non-expiring tokens.',
    );
}

main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
});
