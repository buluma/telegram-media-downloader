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
 */
import { afterAll } from 'vitest';

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
