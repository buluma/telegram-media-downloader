// Single source of truth for /api/monitor/status.
//
// WS-first design: every state change (monitor_state, download_progress,
// download_complete, history_progress, history_done, history_error,
// config_updated, monitor_event) calls refreshNow() from the relevant
// handler — so the snapshot is fresh within the WS round-trip latency,
// not the poll interval. The 30-second background poll is just a
// safety net that catches up after a WS disconnect / missed event.
//
// Calls suspend while document.hidden so a background tab doesn't keep
// hammering the API. On tab return we refresh immediately if the
// snapshot is older than one cycle.

import { api } from './api.js';

// Safety-net interval — was 3 s when WS coverage was incomplete. With
// the WS now driving the active updates, 30 s is plenty for "catch up
// after a missed event" duty.
const POLL_INTERVAL_MS = 30000;

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
