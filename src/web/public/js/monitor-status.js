// Single source of truth for /api/monitor/status.
//
// Before this module existed, statusbar.js (5 s), engine.js (3 s) and
// onboarding.js (4 s) each polled the endpoint independently — three
// HTTP requests every few seconds, each waking the engine up. Now there
// is ONE poller; consumers subscribe via subscribe(fn) and receive the
// same snapshot via a synchronous callback after each refresh.
//
// Refresh cadence is the tightest of the original three (3 s). Calls
// suspend while document.hidden so a background tab doesn't keep
// hammering the API.
//
// `refreshNow()` triggers an out-of-band refresh — used by WS handlers
// (engine state transitions, queue length changes) that want the
// snapshot to update immediately instead of waiting for the next tick.

import { api } from './api.js';

const POLL_INTERVAL_MS = 3000;

let timer = null;
let inFlight = false;
let latest = null;
let lastFetchAt = 0;
const subscribers = new Set();

function notify() {
    for (const fn of subscribers) {
        try { fn(latest); } catch (e) { console.error('monitor-status subscriber', e); }
    }
}

async function refresh() {
    if (inFlight) return; // coalesce overlapping calls
    inFlight = true;
    try {
        latest = await api.get('/api/monitor/status');
        lastFetchAt = Date.now();
        notify();
    } catch {
        // Keep last snapshot — bootstrapping or transient network blip.
    } finally {
        inFlight = false;
    }
}

function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
        // Skip background tabs; we'll catch up via the visibilitychange
        // listener as soon as the user comes back.
        if (document.hidden) return;
        refresh();
    }, POLL_INTERVAL_MS);
}

function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Leave the timer running — the interval check above will no-op
            // while hidden, so we don't pay the wakeup cost. We deliberately
            // don't stopTimer() here because that risks losing the cadence
            // across rapid tab switches.
            return;
        }
        // On resume, refresh immediately if data is older than one cycle.
        if (Date.now() - lastFetchAt > POLL_INTERVAL_MS) refresh();
    });
}

/**
 * Subscribe to monitor status updates. Returns an unsubscribe function.
 * The callback is invoked on every successful refresh; if a snapshot is
 * already cached, the callback fires synchronously with that snapshot
 * before returning.
 */
export function subscribe(fn) {
    subscribers.add(fn);
    if (subscribers.size === 1) startTimer();
    if (latest) {
        try { fn(latest); } catch (e) { console.error('monitor-status subscriber', e); }
    } else {
        // First subscriber — kick off an immediate fetch so consumers
        // don't sit on stale UI for a full POLL_INTERVAL_MS.
        refresh();
    }
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) stopTimer();
    };
}

/** Force an immediate refresh outside the polling cadence. */
export function refreshNow() { refresh(); }

/** Latest cached snapshot, or null if none yet. */
export function getLatest() { return latest; }
