#!/usr/bin/env node
/**
 * Build-time helper: download the seekbar-server Go binary into
 * seekbar-service/bin/ so Docker images ship with the binary already present.
 * The runtime auto-download in spawn.js still works as a fallback, but
 * baking the binary in avoids the first-boot download race.
 *
 * Runs during `docker build` via:
 *   RUN node scripts/pre-download-seekbar.js || true
 *
 * The `|| true` means an offline build or unsupported arch still succeeds;
 * the runtime downloader picks up the slack when the container first starts.
 */

import { createWriteStream, existsSync, promises as fsp } from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SIDECAR_VERSION = '0.3.2';
const GH_BASE = `https://github.com/buluma/telegram-media-downloader/releases/download/seekbar-v${SIDECAR_VERSION}`;

function platformSlug() {
    const platMap = { win32: 'win', linux: 'linux', darwin: 'mac' };
    const plat = platMap[process.platform];
    if (!plat) return null;
    let arch;
    if (process.arch === 'x64') arch = 'x64';
    else if (process.arch === 'arm64') arch = 'arm64';
    else if (process.arch === 'ia32' && process.platform === 'linux') arch = 'x86';
    else return null;
    return `tgdl-seekbar-${plat}-${arch}`;
}

function download(url, dest, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers: { 'user-agent': 'tgdl-build' } }, (res) => {
            if (
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location &&
                redirectsLeft > 0
            ) {
                res.resume();
                download(
                    new URL(res.headers.location, url).toString(),
                    dest,
                    redirectsLeft - 1,
                ).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            const ws = createWriteStream(dest);
            res.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function main() {
    const slug = platformSlug();
    if (!slug) {
        console.log(
            `[pre-download-seekbar] skipping — unsupported platform ${process.platform}/${process.arch}`,
        );
        return;
    }

    // spawn.js _resolveBinary() checks seekbar-service/bin/seekbar-server
    // (the generic name) for developer/image-bundled builds.
    const binDir = path.join(PROJECT_ROOT, 'seekbar-service', 'bin');
    const finalPath = path.join(binDir, 'seekbar-server');

    if (existsSync(finalPath)) {
        console.log(`[pre-download-seekbar] already present: ${finalPath}`);
        return;
    }

    await fsp.mkdir(binDir, { recursive: true });

    const tarUrl = `${GH_BASE}/${slug}.tar.gz`;
    const tarPath = path.join(binDir, `${slug}.tar.gz`);

    console.log(`[pre-download-seekbar] downloading ${tarUrl}`);
    await download(tarUrl, tarPath);

    console.log('[pre-download-seekbar] extracting...');
    const res = spawnSync('tar', ['-xzf', tarPath, '-C', binDir], { stdio: 'inherit' });
    if (res.error || res.status !== 0) throw new Error(`tar failed: ${res.error?.message}`);

    await fsp.unlink(tarPath).catch(() => {});

    if (!existsSync(finalPath)) {
        throw new Error(`binary not found after extraction: ${finalPath}`);
    }
    await fsp.chmod(finalPath, 0o755);
    console.log(`[pre-download-seekbar] installed: ${finalPath}`);
}

main().catch((e) => {
    console.error('[pre-download-seekbar] failed:', e.message);
    process.exit(1);
});
