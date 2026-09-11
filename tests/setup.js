/**
 * Global vitest setup — runs before each test file.
 *
 * Registers a global `afterAll` hook that closes any lingering better-sqlite3
 * connection before the test file's own `afterAll` / `afterEach` cleanup runs.
 * This prevents `EBUSY` errors on Windows when `fs.rmSync` tries to delete
 * the temp SQLite directory while the connection is still open.
 *
 * The `globalThis` key (set by src/core/db.js) survives `vi.resetModules()`,
 * so we can reach the connection even after the module cache has been cleared.
 *
 * Also pins an isolated data dir and an in-memory `localStorage` — see below.
 */
import { afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point every test at a throwaway data root.
//
// src/core/db.js resolves DB_PATH from TGDL_DATA_DIR and falls back to the
// in-repo `data/` — i.e. the operator's real 60+ MB db.sqlite. Individual
// test files have always been free to set this themselves, and about half
// do; the rest silently read (and, through loadConfig -> kvSet, can write)
// the real database. Opt-in isolation only protects the files that opted
// in, so set it here for everyone. A test that wants its own directory
// still just overwrites the variable.
//
// One directory per worker process, not per file: the db singleton lives on
// globalThis and outlives a single file's module registry, so a per-file
// path would leave a connection pointing at a directory nothing else uses.
if (!process.env.TGDL_DATA_DIR) {
    const stateKey = Symbol.for('tgdl.test.data-dir');
    let state = globalThis[stateKey];

    if (!state) {
        state = { dir: path.join(os.tmpdir(), `tgdl-test-${process.pid}`) };
        fs.mkdirSync(state.dir, { recursive: true });
        globalThis[stateKey] = state;
        process.once('exit', () => {
            try {
                fs.rmSync(state.dir, { recursive: true, force: true });
            } catch {
                // best-effort — a stray tmpdir is not worth failing a run over
            }
        });
    }

    process.env.TGDL_DATA_DIR = state.dir;
}

// Node >= 25 ships a built-in `localStorage` that prints
// "`--localstorage-file` was provided without a valid path" on first read.
// Frontend modules under src/web/public/js read it at import time
// (store.js resolves the saved gallery scope there, deliberately), so the
// warning fires before any test body runs and dirties the output.
//
// Setup files are evaluated before the test module graph, so defining the
// global here beats those import-time reads. `defineProperty` rather than
// assignment: under jsdom the global is an accessor whose setter does not
// stick. `writable` keeps per-file polyfills (see shortcut-overrides) able
// to replace this with their own store.
{
    const store = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
            clear: () => store.clear(),
            key: (i) => [...store.keys()][i] ?? null,
            get length() {
                return store.size;
            },
        },
    });
}

afterAll(() => {
    // Attempt to close the db connection stored on globalThis by db.js.
    // If the test file didn't import db.js at all, getGlobalDb returns null
    // and closeDb() is a safe no-op.
    if (globalThis.__tgdl_db__) {
        try {
            globalThis.__tgdl_db__.close();
        } catch {
            // already closed or never opened — ignore
        }
        delete globalThis.__tgdl_db__;
    }
});
