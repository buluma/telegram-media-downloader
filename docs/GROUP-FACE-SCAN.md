# Manual Group-Level Face Scan

## Goal
Allow operators to trigger face detection and clustering for a specific group. This is useful for prioritizing new content or re-scanning a specific chat without waiting for a full library scan.

## Architecture

The face scan process consists of two phases:
1.  **Phase A (Detection):** Iterates through downloads where `ai_indexed_at IS NULL` and runs face detection + embedding.
2.  **Phase B (Clustering):** Runs a global DBSCAN pass over *all* detected faces to form or update people clusters.

The group-level scan restricts Phase A to a specific `group_id`, while Phase B remains global to ensure the new faces are correctly integrated into the project-wide people database.

## Implementation Plan

### 1. Database Layer (`src/core/db/faces.js`)

Update `getUnindexedAiBatch` to support an optional `groupId` filter.

```javascript
export function getUnindexedAiBatch({ fileTypes = ['photo'], limit = 50, groupId = null } = {}) {
    const types = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['photo'];
    const placeholders = types.map(() => '?').join(',');
    const params = [...types];
    
    let where = `file_type IN (${placeholders}) AND ai_indexed_at IS NULL AND deleted_at IS NULL`;
    
    if (groupId) {
        where += ` AND group_id = ?`;
        params.push(String(groupId));
    }

    return getDb()
        .prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_type, file_size, created_at
          FROM downloads
         WHERE ${where}
         ORDER BY created_at ASC, id ASC
         LIMIT ?
    `)
        .all(...params, Math.max(1, Math.min(500, Number(limit) || 50)));
}
```

### 2. Scan Runner (`src/core/ai/scan-runner.js`)

Update `startFacesScan` to read `groupId` from the config and apply it to the Phase A total count and batch selection.

```javascript
export function startFacesScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'faces',
        cfg,
        async (state, signal, bump, log, cfg, logEntry) => {
            const groupId = cfg.groupId || null;
            // ... resolve fileTypes ...

            // Update Phase A count query
            const phaseATotal = db
                .prepare(`
                    SELECT COUNT(*) AS n FROM downloads
                     WHERE file_type IN (${fileTypes.map(() => '?').join(',')})
                       AND ai_indexed_at IS NULL
                       ${groupId ? 'AND group_id = ?' : ''}
                `)
                .get(...fileTypes, ...(groupId ? [groupId] : [])).n;
            
            // ...
            
            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize, groupId });
                if (!batch.length) break;
                // ... process batch ...
            }
            
            // Phase B (DBSCAN) remains global
            // ...
        }
    );
}
```

### 3. API Route (`src/web/routes/ai.js`)

Update the `POST /api/ai/scan/start` endpoint to accept `groupId` from the request body and pass it into the scan configuration.

```javascript
router.post('/ai/scan/start', async (req, res) => {
    // ...
    const feature = String(req.body?.feature || '').toLowerCase();
    const groupId = req.body?.groupId || null;
    
    // ... validation ...

    const scanCfg = { ...cfg, groupId };
    const claim = tracker.tryStart(({ onProgress, signal }) => {
        return new Promise((resolve, reject) => {
            starter(scanCfg, onProgress, (finalState) => {
                // ...
            });
        });
    });
    // ...
});
```

### 4. Web UI (`src/web/public/js/maintenance-ai.js`)

Add a "Scan Faces" button to the **Group → Data** tab.
- The button triggers `POST /api/ai/scan/start` with `{ feature: 'faces', groupId: currentGroupId }`.
- Progress is tracked via the existing `aiPeople` job tracker.

## Considerations

- **Force Rescan:** To support re-scanning a group even if items are already indexed, a `force: true` flag can be added to the API. If present, it should run `UPDATE downloads SET ai_indexed_at = NULL WHERE group_id = ?` before starting the scan.
- **Race Conditions:** The `JobTracker` already prevents multiple face scans from running concurrently. A group-level scan will block a full-library scan and vice-versa.
- **Phase B Impact:** Since DBSCAN runs over the entire `faces` table, adding faces from one group might cause cluster IDs to change or merge project-wide. This is the intended behavior for consistent person identification.
