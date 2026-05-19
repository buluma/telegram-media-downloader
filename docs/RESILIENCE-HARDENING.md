# Resilience Hardening Plan

This plan hardens the lifecycle around long-running jobs, scanners, deletes, and AI sidecar services. It is written for the current SQLite + Node + Python/Go sidecar architecture, while keeping a future Postgres migration possible.

**Implementation status:** All three phases (immediate hardening, lifecycle cleanup, observability/recovery) are complete. Phase 4 (Postgres scalability) is intentionally deferred. Sections 3, 4, 8–11 describe future polish.

## Goals

- Prevent destructive jobs from racing scanners.
- Make every scanner restartable and idempotent.
- Avoid marking rows as processed when infrastructure failed.
- Preserve database integrity under concurrent maintenance actions.
- Make sidecar capability/version drift visible before jobs start.
- Improve observability, recovery, and operator safety.

## Recent failure class

Observed sequence:

1. `aiTags` selected unscanned `downloads` rows.
2. NSFW bulk-delete removed some of those parent `downloads` rows.
3. `aiTags` later attempted `INSERT INTO image_tags(download_id, ...)` for a vanished row.
4. SQLite correctly raised `FOREIGN KEY constraint failed`.

This is an application lifecycle race, not primarily a database corruption issue. The fix is to coordinate jobs and treat selected rows as stale snapshots.

---

## 1. Job/resource coordination ✓

> **Done.** `checkJobConflict()` in `src/core/job-tracker.js` gates scanner starts and destructive job starts. `POST /ai/scan/start`, `POST /maintenance/nsfw/v2/bulk-delete`, `POST /maintenance/dedup/delete`, and `DELETE /purge/all` all check for conflicts and return `409 RESOURCE_BUSY` with the conflicting job name. Tests in `tests/maintenance.race.test.js`.

### Problem

Maintenance jobs currently run independently even when they operate on the same resources:

- `downloads` rows
- media files on disk
- AI derived tables: `image_tags`, `image_tags_wd14`, `image_text`, `faces`, embeddings
- thumbnails / seekbar sprites

### Recommendation

Add a central job coordinator with resource locks.

Example resource names:

```txt
downloads:read
downloads:delete
downloads:write
files:delete
ai:tags:write
ai:faces:write
ai:ocr:write
nsfw:write
thumbs:write
seekbar:write
sidecar:faces
sidecar:clip
sidecar:wd14
sidecar:seekbar
```

Compatibility policy:

| Job type | Resources | Can run with scanners? |
|---|---|---|
| AI tag scan | `downloads:read`, `ai:tags:write`, `sidecar:clip` | Yes, with other non-destructive scans |
| WD14 scan | `downloads:read`, `ai:wd14:write`, `sidecar:wd14` | Yes |
| Faces scan | `downloads:read`, `ai:faces:write`, `sidecar:faces` | Yes |
| NSFW scan | `downloads:read`, `nsfw:write` | Yes |
| NSFW bulk-delete | `downloads:delete`, `files:delete` | No |
| Duplicate delete | `downloads:delete`, `files:delete` | No |
| Re-index purge | `downloads:write`, `ai:*:write` | No |
| Verify/reindex from disk | `downloads:write`, `files:read` | No destructive jobs |

Minimum viable implementation:

- Before a bulk delete starts, block if AI/NSFW scanners are running.
- Before a scanner starts, block if a destructive job is running.
- Return `409 ALREADY_RUNNING` or `409 RESOURCE_BUSY` with the conflicting job name.

Better implementation:

- Add a `JobCoordinator` abstraction around current `JobTracker`s.
- Jobs declare `{ name, resources, mode }`.
- Coordinator rejects incompatible jobs and surfaces active conflicts to the UI.

Best implementation:

- Add pause/cancel support for long scans.
- Bulk-delete requests can optionally cancel scanners, wait for them to stop, then proceed.

---

## 2. Scanner write safety

### Rule

A row selected at batch start may no longer exist by write time. Every scanner must tolerate that.

### Required safe writes

Wrap writes to these tables:

- `image_tags`
- `image_tags_wd14`
- `image_text`
- `faces`
- `image_embeddings`
- `text_embeddings`
- `seekbar_sprites`
- thumbnail metadata if present

Pattern:

```js
function safeWriteDerived(downloadId, writeFn, log, context) {
  try {
    writeFn();
    return true;
  } catch (e) {
    if (/FOREIGN KEY/i.test(String(e?.message || e))) {
      log('warn', `${context}: parent download vanished id=${downloadId}`);
      return false;
    }
    throw e;
  }
}
```

Also prefer a pre-write existence check when cheap:

```sql
SELECT 1 FROM downloads WHERE id = ? AND deleted_at IS NULL;
```

The FK wrapper is still required because a row can vanish after the pre-check.

---

## 3. Idempotent scanner lifecycle

Every scanner should follow this lifecycle:

1. Select a small batch of eligible rows.
2. Resolve file path.
3. If file missing, record a deliberate skip state, not a crash.
4. Call model/sidecar.
5. If the sidecar/model failed infrastructurally, do **not** mark the row scanned.
6. Re-check/write through safe wrapper.
7. Mark complete only after successful processing or deliberate skip.

Distinguish outcomes:

| Outcome | Mark scanned? | Retry later? |
|---|---:|---:|
| Valid image processed, no tags/faces/OCR found | Yes | No |
| File missing on disk | Maybe, or queue integrity repair | Usually no |
| Unsupported file type | Yes | No |
| Corrupt/undecodable file | Yes with error metadata | No, unless repaired |
| Sidecar unavailable | No | Yes |
| Endpoint 404 / capability missing | No | Yes after upgrade/restart |
| Timeout | No, or retry with attempts | Yes |
| Parent row vanished | No | No |

Avoid using a single `_scanned_` sentinel for all cases. If a sentinel is needed, add error-specific metadata or a dedicated scan state table.

---

## 4. Durable scan state tables

Current pattern often infers scanned state by existence in derived tables. This is simple but makes error handling ambiguous.

Add a generic scan state table:

```sql
CREATE TABLE IF NOT EXISTS media_scan_state (
  download_id INTEGER NOT NULL,
  scanner TEXT NOT NULL,
  status TEXT NOT NULL, -- pending|processing|done|skipped|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at INTEGER,
  last_error TEXT,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (download_id, scanner),
  FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);
```

Benefits:

- Clear retry behavior.
- Better UI progress.
- No need to insert fake derived rows to suppress reprocessing.
- Easier health checks: show failed scans by scanner and reason.

SQLite-safe claim strategy:

- Use small batches.
- In one transaction, insert/update rows to `processing` where not already done.
- Workers only process rows they successfully claimed.

Future Postgres improvement:

```sql
FOR UPDATE SKIP LOCKED
```

---

## 5. Soft delete before hard delete ✓

> **Done.** `deleted_at` and `delete_reason` columns added via migration in `src/core/db.js`. `softDeleteDownloads(ids)` in `src/core/db/downloads.js` stamps rows idempotently. All scanner batch queries (`getUnindexedAiBatch`, `getUnscannedOcrBatch`, `getUnscannedWd14Batch`, `countUnscannedWd14`, `pageMissingSeekbarVideos`) exclude `deleted_at IS NULL`. `dedup.deleteByIds()` calls `softDeleteDownloads()` before file removal. Tests in `tests/maintenance.soft-delete.test.js`.

### Problem

Hard-deleting from `downloads` immediately invalidates in-flight scanner batches.

### Recommendation

Add soft delete columns:

```sql
ALTER TABLE downloads ADD COLUMN deleted_at INTEGER;
ALTER TABLE downloads ADD COLUMN delete_reason TEXT;
ALTER TABLE downloads ADD COLUMN delete_job_id TEXT;
```

Lifecycle:

1. Bulk-delete marks rows with `deleted_at`, `delete_reason`, `delete_job_id`.
2. Scanners exclude `deleted_at IS NOT NULL`.
3. File deletion runs asynchronously.
4. Hard purge removes rows after derived cleanup, thumbnails, sprites, shares, etc.

This reduces FK races and makes delete recovery/audit possible.

Minimum version:

- Add `deleted_at`.
- Update all scanner batch queries to include `deleted_at IS NULL`.
- Keep existing hard-delete path as final purge.

---

## 6. Destructive job safety (maintenance_jobs ✓, file safety pending)

> **Done (job audit table).** `maintenance_jobs` table exists in `src/core/db.js`. `createJob`, `updateJobProgress`, `finishJob` in `src/core/ai/jobs.js` are wired into scan runs in `src/web/routes/ai.js`. `GET /api/ai/jobs` surfaces durable history. Tests in `tests/ai/jobs.test.js`.
>
> Remaining: DB snapshot before bulk destructive actions, per-batch audit trails.

Before any destructive job:

- Confirm no incompatible job is running.
- Create a job audit row.
- Record requested filters, resolved IDs, and sample paths.
- Optionally snapshot the DB.

During destructive job:

- Process in small batches.
- Emit progress.
- Do not hold a giant transaction while deleting files.
- Keep an audit trail of removed/missing/failed rows.

After destructive job:

- Broadcast gallery refresh.
- Run lightweight integrity checks.
- Surface failures in UI.

Suggested audit table:

```sql
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT,
  request_json TEXT,
  resolved_count INTEGER,
  processed_count INTEGER DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
```

---

## 7. Sidecar capability/version hardening ✓

> **Done.** `checkSidecarCapability(scanner, sidecarUrl)` in `src/core/ai/preflight.js` calls `/info`, verifies the required endpoint is present and the model is ready, and returns `{ ok, code, reason }`. Wired into `startOcrScan` and `startWd14Scan` in `src/core/ai/scan-runner.js`. Throws with `fatal: true` before any rows are touched when preflight fails. Tests in `tests/ai/preflight.test.js`.

### Problem

A running sidecar may be stale, wrong, partially loaded, or missing an endpoint. Example: `/tag` returned `404` while the scanner expected it.

### Recommendation

Make `/info` a capability contract.

Desired `/info` shape:

```json
{
  "service": "tgdl-faces",
  "version": "x.y.z",
  "build": "git-sha-or-image-tag",
  "schema": 2,
  "providers": ["CPUExecutionProvider"],
  "endpoints": {
    "detect_faces": true,
    "tag": true,
    "tag_wd14": true,
    "ocr": true,
    "embed_image": true,
    "embed_text": true
  },
  "models": {
    "faces": { "ready": true, "id": "buffalo_l", "dim": 512 },
    "clip": { "ready": true, "id": "...", "vocabulary_size": 123 },
    "wd14": { "ready": true, "id": "..." },
    "ocr": { "ready": false, "error": null }
  }
}
```

Before starting a scan:

- Call `/info`.
- Verify the required endpoint exists.
- Verify required model is ready, or explicitly trigger/load it.
- If not ready, fail the job before processing rows.

Failure examples:

| Scanner | Required capability |
|---|---|
| AI tags | `endpoints.tag === true`, `models.clip.ready === true` |
| WD14 | `endpoints.tag_wd14 === true`, `models.wd14.ready === true` |
| Faces | `endpoints.detect_faces === true`, `models.faces.ready === true` |
| OCR | `endpoints.ocr === true`, `models.ocr.ready === true` |

Do not stamp rows as scanned when capability checks fail.

---

## 8. Sidecar request resilience

For every sidecar request:

- Use explicit timeout.
- Include request ID / job ID / download ID.
- Prefer path mode when allowed; fallback to base64 on `path_not_allowed` only.
- Treat `404` as capability mismatch, not per-file failure.
- Treat `503 model_not_ready` as retryable infrastructure failure.
- Treat `400 invalid_image` as per-file skip.
- Treat `500` as retryable up to an attempt limit.

Suggested response error shape:

```json
{
  "error": "tagger not ready",
  "code": "tagger_not_ready",
  "retryable": true
}
```

Suggested Node classification:

```txt
capability_missing: fatal job error, do not mark row
model_not_ready: retryable job error, do not mark row
path_not_allowed: fallback to base64
invalid_image: mark skipped
inference_failed: retry row with attempts
```

---

## 9. Sidecar process supervision

Improve sidecar lifecycle handling:

- Track spawned PID, URL, version, and startup time.
- Health check `/healthz` separately from `/info`.
- Add readiness check `/readyz` that verifies required models are loaded.
- Restart sidecar on repeated connection failures.
- Use exponential backoff to avoid restart loops.
- Expose sidecar status in Maintenance UI.

Suggested endpoints:

```txt
GET /healthz  -> process alive
GET /readyz   -> required runtime deps loaded
GET /info     -> capabilities/models/version
```

---

## 10. Database integrity and health checks

Add a Maintenance → Health action that runs:

```sql
PRAGMA foreign_key_check;
PRAGMA integrity_check;
```

Also report:

- derived rows whose parent is missing, if FK is off anywhere
- files missing on disk
- files on disk missing from DB
- `_scanned_` sentinel counts by scanner/table
- scan failures by scanner/error code
- soft-deleted rows awaiting purge
- stale `processing` scan locks
- sidecar capability mismatch

Health output should be JSON and UI-renderable.

---

## 11. Testing plan

Add race-condition tests:

1. Tag scan selects a row; delete parent before tag write; scan must not crash.
2. WD14/faces/OCR writes see missing parent; scan must skip and continue.
3. `/tag` returns `404`; scan must fail job and not mark row scanned.
4. Sidecar returns `503`; row remains retryable.
5. Missing file path does not call `existsSync(null)`.
6. Bulk delete while scanner active is rejected or waits.
7. Soft-deleted rows are excluded from scanner batches.
8. Crash mid-scan leaves stale `processing` rows recoverable.

Test target behavior:

- No uncaught exceptions.
- No FK violations.
- Accurate skipped/failed counters.
- Rows are retryable when infra fails.

---

## 12. Recommended implementation order

### Phase 1 — immediate hardening

- [x] Add resource conflict checks around destructive jobs and scanners.
- [x] Wrap all scanner DB writes with FK-safe helpers.
- [x] Treat sidecar `404` as fatal capability mismatch.
- [x] Add sidecar capability preflight before each scanner.
- [ ] Add health endpoint for FK/integrity checks.

### Phase 2 — lifecycle cleanup

- [x] Add `deleted_at` soft-delete flow.
- [x] Update scanner queries to exclude soft-deleted rows.
- [x] Add durable `media_scan_state` for WD14 — `src/core/db/scan-state.js`; WD14 scan writes done/failed/skipped on each row outcome.
- [x] Stop relying on `_scanned_` sentinels for infrastructure failures — WD14 now writes scan_state failed on sidecar error (retryable via `POST /ai/scan/retry-failed`) rather than silently marking the row done.

### Phase 3 — observability and recovery

- [x] Add `maintenance_jobs` audit table.
- [x] Add scan failure surface — `GET /ai/scan/failures` + `POST /ai/scan/retry-failed`; `_getAiIssues` surfaces durable failures and soft-deleted rows awaiting purge.
- [x] Add stale lock recovery — `recoverStaleLocks()` called at WD14 scan start; resets processing rows older than 30 min to failed.
- [x] Add DB backup before bulk destructive actions — `backupDb(label)` in `src/core/db/backup.js` uses better-sqlite3 `.backup()`; wired into dedup-delete, NSFW bulk-delete, purge-all; `GET /maintenance/db/backups` lists snapshots; keeps last 5 per operation.

### Phase 4 — future scalability

- Introduce a DB adapter layer.
- Keep SQLite implementation.
- Add optional Postgres implementation later using row-level locks and `SKIP LOCKED`.

---

## Acceptance checklist

- [x] Bulk delete cannot hard-delete rows while incompatible scans are active.
- [x] Scanners never crash if a parent `downloads` row vanishes.
- [x] Sidecar endpoint/capability mismatch fails the job before rows are stamped scanned.
- [x] Retryable infrastructure failures do not silently mark rows done — WD14 writes scan_state `failed`; retry-failed endpoint clears sentinel + scan_state to re-queue.
- [x] Health check surfaces scan failures and soft-deleted rows awaiting purge (via `_getAiIssues`).
- [x] Race tests cover scanner/delete interactions.
- [ ] Operators can see active jobs, conflicts, and failed scan reasons in the UI (backend endpoints exist; UI not yet built).
