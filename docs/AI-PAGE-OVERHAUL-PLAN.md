# AI Page Overhaul Plan

## Goal

Turn the AI maintenance page from a collection of scan buttons into an **AI operations console and discovery hub**.

The page should immediately answer:

1. Can AI run right now?
2. What is running, blocked, or failed?
3. What useful data has AI produced?
4. What needs operator attention?

---

## Current pain points

- Scanner buttons can start jobs that are doomed because the sidecar is missing a capability.
- Failures are mostly visible only in logs.
- Sidecar readiness, model readiness, and endpoint availability are not first-class UI concepts.
- Scanner state and derived data health are mixed together.
- AI outputs are not surfaced enough as browsing/discovery tools.
- Data hygiene issues, such as mislabeled media, are discovered indirectly through scanner failures.
- Destructive/reset actions are not clearly separated by feature and risk level.

---

## Proposed page structure

Use either top-level tabs or stacked sections.

Recommended tabs:

```txt
Overview
Scanners
People
Tags
Search
Issues
Settings
```

If keeping a single-page layout, use this order:

1. AI Health / Readiness
2. Active Jobs
3. Scanner Cards
4. AI Issues
5. Discovery / Results
6. Advanced Settings

---

## 1. Overview tab

### Purpose

The Overview tab should be the operator landing page.

It should show:

- AI enabled/disabled state
- sidecar state
- active jobs
- latest failures
- scan coverage summary
- quick actions

### Layout

#### AI readiness card

Example:

```txt
AI Sidecar: Ready
URL: http://127.0.0.1:8011
Version: 0.3.2
Mode: local python / docker / override
Uptime: 2h 14m
```

Show capabilities:

```txt
Faces       Ready
CLIP tags   Ready
WD14 tags   Ready
OCR         Disabled
Objects     Missing endpoint
```

Actions:

- Recheck capabilities
- Restart sidecar
- Preload models
- View sidecar logs
- Copy diagnostic JSON

#### Scan coverage summary

Example:

```txt
Photos eligible: 3,145
Faces indexed: 2,810
CLIP tagged: 2,217
WD14 tagged: 1,944
OCR scanned: 600
```

Use progress bars per feature.

#### Active jobs card

Example:

```txt
AI Tags
281 / 928 · 30% · 2.4 files/min · ETA 4h 29m
Skipped: 1 · Failed: 0
[Pause] [Cancel]
```

#### Recent jobs

Show last 10 jobs:

```txt
Tags scan failed — sidecar /tag missing
NSFW bulk delete done — 382 removed
WD14 scan done — 913 scanned, 7 skipped
Faces scan cancelled — 1,024 / 3,145
```

---

## 2. Scanners tab

### Purpose

Give every scanner a clear status, readiness check, configuration summary, and safe actions.

Scanner cards:

- Faces
- CLIP Tags
- WD14 Tags
- OCR
- Objects / General Detection
- Optional: Embeddings / Semantic Search

Each card should include:

- enabled/disabled state
- required sidecar capability
- model readiness
- eligible rows
- scanned rows
- failed rows
- skipped rows
- last scan time
- current config summary
- actions

### Standard scanner card actions

- Scan missing
- Retry failed
- Rescan selected scope
- Reset feature data
- View failures
- Open settings

### Capability-aware actions

Buttons must be disabled when preflight fails.

Example:

```txt
Start CLIP Tags
Disabled: sidecar does not expose /tag
```

Example:

```txt
Start WD14
Disabled: WD14 model is not loaded
```

### Scanner-specific details

#### Faces

Show:

- indexed media count
- detected faces
- people clusters
- unnamed clusters
- low-quality/skipped faces
- provider info: CPU/CoreML/CUDA/etc.

Actions:

- Scan missing
- Recluster only
- Reset faces
- Merge/split people review
- Tune clustering

Config summary:

- detector model
- provider
- include videos
- video frame interval
- max frames per video
- clustering epsilon
- min points

#### CLIP Tags

Show:

- tagged photos
- vocabulary preset
- vocabulary size
- average tags per image
- skipped invalid images
- failed rows

Actions:

- Scan missing
- Retry failed
- Reset CLIP tags
- Change vocabulary preset

Config summary:

- model id
- vocabulary preset
- custom labels
- threshold
- top K
- concurrency

#### WD14 Tags

WD14 should be first-class if the library benefits from booru/adult/anime-style tags.

Show:

- WD14 model readiness
- tagged rows
- min confidence
- top tags
- failed rows

Actions:

- Scan missing
- Retry failed
- Reset WD14 tags
- Adjust threshold

Config summary:

- model id
- min score
- file types
- batch size

#### OCR

Show:

- OCR scanned rows
- text rows
- languages
- failed rows

Actions:

- Scan missing
- Retry failed
- Reset OCR

Config summary:

- language
- file types
- timeout

#### WD14 Tagging

Keep WD14 distinct from CLIP tags and OCR in scanner status, counts, and result explanations.
- scanned rows
- object rows
- top object classes

---

## 3. People tab

### Purpose

Make face clustering useful as a media organization tool.

Sections:

- people grid
- unnamed people
- merge suggestions
- low-confidence clusters
- recently updated clusters

### People grid

Each person card:

- cover face/media
- name
- media count
- face count
- confidence/quality summary

Actions:

- Rename
- Merge
- Split
- Hide/ignore
- Open media

### Review tools

- Merge duplicates
- Split mixed clusters
- Mark as ignored
- Recluster selected

### Filters

- named / unnamed
- minimum media count
- low quality
- recently seen
- source group

---

## 4. Tags tab

### Purpose

Make tag data browseable and auditable.

Sections:

- top tags
- tag search
- tag co-occurrence
- low-confidence tags
- recently tagged media

### Tag browser

Show:

```txt
portrait     824
outdoor      301
beach         93
selfie        74
```

Each tag opens matching media.

### Tag details

For a selected tag:

- count
- average score
- score histogram
- sample media grid
- related tags

Actions:

- create smart album from tag
- hide/exclude tag
- rescan tag source

### Tag source distinction

Clearly separate:

- CLIP tags
- WD14 tags
- object tags
- OCR tokens, if surfaced

Do not mix sources without labels.

---

## 5. Search tab

### Purpose

Expose AI output as a discovery interface.

Search modes:

- natural language / semantic
- tag search
- person search
- OCR text search
- filename search
- combined search

Example query UI:

```txt
Search: "beach selfie with Alice"
Sources: [Semantic] [Tags] [People] [OCR] [Filename]
File types: [Photos] [Videos]
```

Results should show why each item matched:

```txt
Matched: tag=beach 0.88, person=Alice, OCR=no match
```

Actions:

- save as smart album
- bulk select
- open viewer
- exclude false positives

---

## 6. Issues tab

### Purpose

Surface operational and data problems without requiring log spelunking.

Issue categories:

- sidecar unavailable
- sidecar capability mismatch
- model not ready
- scanner failures
- invalid image decode
- missing file
- mislabeled media
- corrupt media
- parent row vanished during scan
- foreign key/integrity issues
- stale processing locks
- orphan derived rows

Example:

```txt
AI Issues

12 invalid image rows
- 10 mislabeled videos fixed
- 2 corrupt images

3 sidecar timeouts
1 stale processing lock
0 foreign key errors
```

### Per-issue actions

For media issues:

- Open file
- Reveal path
- Retry scan
- Mark skipped
- Fix media type
- Delete row
- Delete file + row

For sidecar issues:

- Restart sidecar
- Recheck capabilities
- View logs
- Copy diagnostics

For DB issues:

- Run integrity check
- Repair orphan rows
- Reindex from disk

---

## 7. Settings tab

### Purpose

Move advanced configuration out of the main workflow.

Sections:

#### Global AI settings

- AI enabled
- sidecar mode: auto / docker / override / disabled
- sidecar URL
- auto-start sidecar
- auto-preload models
- default file types

#### Job settings

- global scanner concurrency
- per-scanner concurrency
- batch size
- timeout
- retry attempts
- retry backoff

#### Faces settings

- detector model
- provider preference
- include videos
- video frame interval
- max frames
- clustering epsilon
- min points

#### CLIP settings

- model id
- vocabulary preset
- custom vocabulary
- threshold
- top K

#### WD14 settings

- model id
- min score
- rating tags include/exclude

#### OCR settings

- language
- preprocessing options

#### Advanced / dangerous actions

- reset all AI data
- reset only failed states
- reset per-feature data
- purge orphan derived rows
- rebuild counts

Dangerous actions should require confirmation and show affected row counts.

---

## API requirements

### AI status endpoint

Add/extend:

```txt
GET /api/ai/status
```

Should return:

```json
{
  "success": true,
  "enabled": true,
  "sidecar": {
    "state": "ready",
    "url": "http://127.0.0.1:8011",
    "mode": "python",
    "version": "0.3.2",
    "uptimeMs": 123456,
    "capabilities": {
      "faces": true,
      "tag": true,
      "wd14": true,
      "ocr": true,
    },
    "models": {
      "faces": { "ready": true, "id": "buffalo_l" },
      "clip": { "ready": true, "id": "Xenova/clip-vit-base-patch32" },
      "wd14": { "ready": false, "error": null }
    }
  },
  "counts": {
    "eligiblePhotos": 3145,
    "facesIndexed": 2810,
    "clipTagged": 2217,
    "wd14Tagged": 1944,
    "ocrScanned": 600
  },
  "jobs": {
    "active": [],
    "recent": []
  },
  "issues": {
    "total": 0,
    "byType": {}
  }
}
```

### Job endpoints

```txt
GET  /api/ai/jobs
POST /api/ai/jobs/:feature/start
POST /api/ai/jobs/:jobId/cancel
POST /api/ai/jobs/:jobId/retry-failed
GET  /api/ai/jobs/:jobId
```

### Issue endpoints

```txt
GET  /api/ai/issues
POST /api/ai/issues/:id/retry
POST /api/ai/issues/:id/mark-skipped
POST /api/ai/issues/:id/repair
POST /api/ai/issues/bulk-repair
```

### Health endpoints

```txt
GET  /api/ai/health
POST /api/ai/health/check
POST /api/ai/sidecar/restart
GET  /api/ai/sidecar/logs
```

---

## Sidecar contract requirements

The sidecar `/info` endpoint should return a stable capability contract.

Recommended shape:

```json
{
  "service": "tgdl-faces",
  "version": "0.3.2",
  "schema": 2,
  "platform": "darwin/arm64",
  "python": "3.14.5",
  "providers": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
  "endpoints": {
    "detect": true,
    "detect_batch": true,
    "tag": true,
    "tag_wd14": true,
    "ocr": true,
    "embed_image": true,
    "embed_text": true
  },
  "models": {
    "faces": {
      "ready": true,
      "id": "buffalo_l",
      "dim": 512
    },
    "clip": {
      "ready": true,
      "id": "Xenova/clip-vit-base-patch32",
      "vocabulary_size": 193
    },
    "wd14": {
      "ready": true,
      "id": "SmilingWolf/wd-v1-4-vit-tagger-v2"
    },
    "ocr": {
      "ready": false,
      "error": null
    }
  }
}
```

Also add:

```txt
GET /healthz  -> process alive
GET /readyz   -> required deps/models ready
```

---

## Job model requirements

Long-running jobs should have durable state.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  feature TEXT,
  status TEXT NOT NULL,
  resources TEXT,
  requested_by TEXT,
  request_json TEXT,
  total INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
```

Suggested scan-state table:

```sql
CREATE TABLE IF NOT EXISTS media_scan_state (
  download_id INTEGER NOT NULL,
  scanner TEXT NOT NULL,
  status TEXT NOT NULL,
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

---

## UI implementation phases

### Phase 1 — make failures visible

- Add AI Health card.
- Add capability-aware scanner buttons.
- Add active job cards with progress/skipped/failed counters.
- Add Issues panel with recent scanner failures.
- Add sidecar diagnostic JSON copy button.

### Phase 2 — scanner cards

- Split current AI page into scanner cards.
- Add per-scanner status and actions.
- Add retry failed / reset feature actions.
- Disable actions when sidecar preflight fails.

### Phase 3 — discovery UI

- Add Tags tab.
- Improve People tab.
- Add Search tab with match explanations.
- Add smart album creation from search/tag/person.

### Phase 4 — durable job and issue model

- Add `maintenance_jobs`.
- Add `media_scan_state`.
- Replace `_scanned_` sentinel reliance where practical.
- Add retryable failure handling and stale lock recovery.

### Phase 5 — advanced operations

- Add data hygiene tools.
- Add orphan repair.
- Add mislabeled media audit.
- Add DB integrity checks.
- Add sidecar restart/log UI.

---

## Acceptance criteria

- [ ] AI page shows sidecar readiness and capabilities before any scan starts.
- [ ] Scanner buttons are disabled with clear reasons when prerequisites fail.
- [ ] Active scans show progress, skipped count, failed count, ETA, and cancel action.
- [ ] Recent failures are visible without opening logs.
- [ ] Invalid/mislabeled media appears in Issues with repair actions.
- [ ] CLIP tags, WD14 tags, OCR, and faces are visually distinct.
- [ ] Dangerous reset actions are per-feature and show affected row counts.
- [ ] Search results explain why each item matched.
- [ ] Sidecar version/capability mismatch is detected and clearly reported.
