// Shared numeric constants used across multiple modules.
// Single-use magic numbers local to one file live next to their usage instead.

// Maximum number of messages a backfill job will fetch in one run.
// Enforced at both the API boundary and internal spawn helpers.
export const BACKFILL_MAX_LIMIT = 50_000;

// TTL for in-process dialog/entity caches (dialogs list, name lookup).
export const DIALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// How long a completed/failed history job entry is retained in _historyJobs
// before being evicted, giving the UI time to poll the final status.
export const HISTORY_JOB_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Default and ceiling values for the history backpressure governor.
// Config keys: advanced.history.backpressureCap / backpressureMaxWaitMs.
export const BACKPRESSURE_CAP_DEFAULT = 500;
export const BACKPRESSURE_MAX_WAIT_MS_DEFAULT = 15 * 60 * 1000; // 15 minutes
