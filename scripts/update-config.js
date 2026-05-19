#!/usr/bin/env node
/**
 * Update group settings in the SQLite kv-store config.
 *
 * Key prefixes:
 *   filter.<key>=<value>   → sets g.filters[key]
 *   <key>=<value>          → sets g.autoForward[key] (legacy default for
 *                            deleteAfterForward / keepImages / keepVideos)
 *                            OR g[key] directly for known top-level keys
 *                            (trackComments, enabled, rescueMode)
 *
 * Usage:
 *   node scripts/update-config.js --list
 *   node scripts/update-config.js --all filter.videos=false filter.voice=true
 *   node scripts/update-config.js --all trackComments=true
 *   node scripts/update-config.js --all deleteAfterForward=true keepImages=true
 *   node scripts/update-config.js "Group Name" keepVideos=false
 */

import { getDb } from '../src/core/db.js';

const TOP_LEVEL_KEYS = new Set(['trackComments', 'enabled', 'rescueMode', 'name']);

const db = getDb();
const row = db.prepare(`SELECT value FROM kv WHERE key = 'config'`).get();
if (!row) {
    console.error('No config found in kv store');
    process.exit(1);
}

const config = JSON.parse(row.value);

function list() {
    console.log('Group settings:\n');
    for (const g of config.groups || []) {
        const af = g.autoForward || {};
        const f = g.filters || {};
        console.log(
            `${g.name.padEnd(35)} ` +
                `enabled=${String(g.enabled ?? true).padEnd(5)} ` +
                `trackComments=${String(g.trackComments ?? false).padEnd(5)} ` +
                `delete=${String(af.deleteAfterForward ?? false).padEnd(5)} ` +
                `keepImgs=${String(af.keepImages ?? false).padEnd(5)} ` +
                `keepVids=${String(af.keepVideos ?? false).padEnd(5)} ` +
                `videos=${String(f.videos ?? true).padEnd(5)} ` +
                `voice=${String(f.voice ?? false).padEnd(5)} ` +
                `urls=${String(f.urls ?? true).padEnd(5)}`,
        );
    }
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: node scripts/update-config.js <group-name|--all> <key>=<value> [...]');
    console.log('       node scripts/update-config.js --list');
    console.log(
        'Key prefixes: filter.<key>=<value> sets filters; others set autoForward or top-level.',
    );
    process.exit(0);
}

if (args[0] === '--list') {
    list();
    process.exit(0);
}

let targetGroups;
let keyValues = [];

if (args[0] === '--all') {
    targetGroups = config.groups || [];
    keyValues = args.slice(1);
} else {
    const groupName = args[0];
    targetGroups = (config.groups || []).filter((g) => g.name === groupName);
    if (targetGroups.length === 0) {
        console.error(`No group found matching "${groupName}"`);
        console.log('Available groups:');
        for (const g of config.groups || []) console.log(`  ${g.name}`);
        process.exit(1);
    }
    keyValues = args.slice(1);
}

// Parse key=value pairs
const filterUpdates = {};
const afUpdates = {};
const topUpdates = {};

for (const kv of keyValues) {
    const m = kv.match(/^([\w.]+)=(.*)$/);
    if (!m) {
        console.error(`Invalid key=value: ${kv}`);
        process.exit(1);
    }
    let [, key, val] = m;
    let parsed;
    if (val === 'true') parsed = true;
    else if (val === 'false') parsed = false;
    else if (/^\d+$/.test(val)) parsed = parseInt(val, 10);
    else parsed = val;

    if (key.startsWith('filter.')) {
        filterUpdates[key.slice(7)] = parsed;
    } else if (TOP_LEVEL_KEYS.has(key)) {
        topUpdates[key] = parsed;
    } else {
        afUpdates[key] = parsed;
    }
}

for (const g of targetGroups) {
    if (Object.keys(filterUpdates).length > 0) {
        if (!g.filters) g.filters = {};
        Object.assign(g.filters, filterUpdates);
    }
    if (Object.keys(afUpdates).length > 0) {
        if (!g.autoForward) g.autoForward = {};
        Object.assign(g.autoForward, afUpdates);
    }
    Object.assign(g, topUpdates);
    console.log(
        `✓ ${g.name}: filters=${JSON.stringify(filterUpdates)} af=${JSON.stringify(afUpdates)} top=${JSON.stringify(topUpdates)}`,
    );
}

db.prepare(`UPDATE kv SET value = ? WHERE key = 'config'`).run(JSON.stringify(config));

console.log('\nFinal state:');
list();
