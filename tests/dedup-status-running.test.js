// The dedup scan route wraps every progress callback before it reaches
// JobTracker. If that payload smuggles a `running` flag into the
// tracker's `progress` object, the GET /maintenance/dedup/status
// flattening — `{ ...snap, ...(snap.progress || {}) }` — lets the stale
// progress field overwrite the tracker's canonical `running:false`
// after the run has completed. Every client recovery path (page-load
// recover, WS-reconnect sync, 6 s poll) reads that flattened `running`,
// so one poisoned field locks the UI at "Scanning…" forever, and Cancel
// is a no-op because no job is actually in flight.
//
// The tracker owns the canonical lifecycle flag, so the contract under
// test is: progress payloads must NOT be able to override `running`,
// neither in the stored snapshot nor in the flattened status-endpoint
// shape.
//
// Same no-Express approach as maintenance.race.test.js — the route is a
// thin adapter over JobTracker, so asserting the tracker contract with
// a runFn shaped like the real one covers the failure mode.

import { describe, it, expect } from 'vitest';
import { createJobTracker } from '../src/core/job-tracker.js';

function flushAsync(times = 8) {
    let p = Promise.resolve();
    for (let i = 0; i < times; i++) p = p.then(() => undefined);
    return p;
}

describe('dedup status endpoint running flag', () => {
    it('progress payload cannot override running:false after completion', async () => {
        const t = createJobTracker({
            kind: 'dedupScan',
            broadcast: () => {},
            eventPrefix: 'dedup',
        });

        // Mirror the real route runFn: the final onProgress before the
        // scan resolves carries stage:'done' — and (pre-fix) the route
        // wrapper injected `running: true` into every payload.
        const r = t.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'hashing', processed: 0, total: 0, running: true });
            onProgress({ stage: 'done', processed: 0, total: 0, running: true });
            return { scanned: 0, hashed: 0, errored: 0, duplicateSets: [] };
        });
        expect(r.started).toBe(true);
        await flushAsync(20);

        const snap = t.getStatus();
        expect(snap.running).toBe(false);

        // The status endpoint's exact flattening — progress fields are
        // spread over the snapshot for the legacy front-end contract.
        // `running` must survive as the tracker's canonical false.
        const flattened = { ...snap, ...(snap.progress || {}) };
        expect(flattened.running).toBe(false);

        // With no job in flight, cancel must report false — the UI uses
        // this to tell "nothing to cancel" apart from a real abort.
        expect(t.cancel()).toBe(false);
    });
});
