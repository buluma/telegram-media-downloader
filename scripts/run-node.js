#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localstorageFile = path.join(repoRoot, 'data', 'localstorage.json');
const major = Number(String(process.versions.node || '').split('.')[0]);

if (major < 22) {
    console.error(`Unsupported Node.js ${process.versions.node} at ${process.execPath}. Node 22 or later required (see .nvmrc).`);
    process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: node scripts/run-node.js <node-args...>');
    process.exit(1);
}

const localstorageArg = `--localstorage-file=${localstorageFile}`;
const existingNodeOptions = process.env.NODE_OPTIONS || '';
const nodeOptions = existingNodeOptions.includes('--localstorage-file=')
    ? existingNodeOptions
    : [existingNodeOptions, localstorageArg].filter(Boolean).join(' ');

const result = spawnSync(process.execPath, [localstorageArg, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
    },
});

if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
