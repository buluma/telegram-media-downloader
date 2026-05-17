# TGDL ML Sidecar Plan: Immich-ML-Based Docker Service

## Goal

Build a project-owned ML sidecar (`tgdl-ml`) based on Immich's machine-learning architecture, while keeping a Telegram Media Downloader-compatible API.

This should eventually replace or reduce dependency on the current `tgdl-faces` sidecar for embeddings, OCR, and face detection, while preserving existing dashboard and database behavior.

## Why This Approach

Using an external Immich ML service works for experimentation, but a dedicated `tgdl-ml` image is cleaner long-term:

- No dependency on a running Immich install
- Stable API tailored to this project
- Easier Docker Compose setup
- Easier dashboard health/status integration
- Can keep existing `/detect`, `/embed-image`, `/embed-text`, and `/ocr` contracts
- Can borrow Immich's mature model/runtime stack:
  - FastAPI service
  - ONNX Runtime provider selection
  - CPU / CUDA / ROCm / OpenVINO / CoreML support
  - model cache/download behavior
  - CLIP image/text embeddings
  - InsightFace face detection/recognition
  - RapidOCR OCR

## Target Image

Publish Docker images such as:

```text
ghcr.io/buluma/tgdl-ml:latest
ghcr.io/buluma/tgdl-ml:cuda
ghcr.io/buluma/tgdl-ml:openvino
ghcr.io/buluma/tgdl-ml:rocm
```

Optional later:

```text
ghcr.io/buluma/tgdl-ml:rknn
ghcr.io/buluma/tgdl-ml:armnn
```

## API Compatibility Layer

Expose the API shape expected by this project.

### Required Endpoints

```text
GET  /health
GET  /info
POST /embed-image
POST /embed-text
POST /detect
POST /detect-embed
POST /ocr
```

### Optional Compatibility Endpoints

```text
POST /detect/batch
POST /tag
POST /detect-objects
GET  /providers
```

## Endpoint Mapping

| Current `tgdl-faces` endpoint | New implementation source |
|---|---|
| `/embed-image` | Immich CLIP visual model |
| `/embed-text` | Immich CLIP textual model |
| `/detect` | Immich InsightFace detection + recognition pipeline |
| `/detect-embed` | Alias of `/detect` |
| `/ocr` | Immich RapidOCR detection + recognition pipeline |
| `/health` | Sidecar readiness + model/provider info |
| `/info` | Model card + provider details |
| `/providers` | ONNX Runtime provider probe |

## Known Feature Gaps

Immich ML does not directly provide every current `tgdl-faces` feature.

### 1. CLIP tag scan (`/tag`)

Current behavior:

- Image is scored against a project vocabulary
- Results are written to `image_tags`

Options:

1. Disable tag scan in Immich-only mode
2. Emulate tags using CLIP embeddings:
   - Embed tag labels once with text encoder
   - Embed image with visual encoder
   - Rank tag labels by cosine similarity
3. Keep a small tgdl-specific tag module in `tgdl-ml`

Preferred: option 2 for first parity pass.

### 2. Object detection (`/detect-objects`)

Current behavior:

- YOLOv8-nano object detector returns COCO objects

Options:

1. Disable object detection in Immich-only mode
2. Port current YOLOv8 ONNX code into `tgdl-ml`
3. Replace with another supported detector

Preferred: defer initially; keep object detection tgdl-only or disabled until the core sidecar is stable.

### 3. Batch detection (`/detect/batch`)

Immich ML uses pipeline requests but not the same batch API.

Options:

1. Implement a simple loop in the compatibility layer
2. Add true batch support later

Preferred: simple loop first.

## Configuration

Add a provider mode:

```env
TGDL_AI_PROVIDER=tgdl     # existing behavior
TGDL_AI_PROVIDER=immich   # external Immich ML adapter
TGDL_AI_PROVIDER=tgdl-ml  # new Docker sidecar
TGDL_AI_PROVIDER=hybrid   # optional mixed mode
```

New sidecar URL:

```env
TGDL_ML_URL=http://tgdl-ml:3800
```

Model overrides:

```env
TGDL_ML_CLIP_MODEL=ViT-B-32__openai
TGDL_ML_FACE_MODEL=buffalo_l
TGDL_ML_OCR_MODEL=PP-OCRv5_mobile
```

Runtime knobs:

```env
TGDL_ML_TIMEOUT_MS=180000
TGDL_ML_MODEL_TTL=300
TGDL_ML_WORKERS=1
TGDL_ML_REQUEST_THREADS=4
TGDL_ML_DEVICE_IDS=0
```

## Docker Compose Target

Example compose service:

```yaml
services:
  tgdl-ml:
    image: ghcr.io/buluma/tgdl-ml:latest
    container_name: tgdl-ml
    restart: unless-stopped
    volumes:
      - ./data/ml-cache:/cache
    environment:
      TGDL_ML_CACHE_FOLDER: /cache
```

CUDA variant:

```yaml
services:
  tgdl-ml:
    image: ghcr.io/buluma/tgdl-ml:cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

OpenVINO variant:

```yaml
services:
  tgdl-ml:
    image: ghcr.io/buluma/tgdl-ml:openvino
    devices:
      - /dev/dri:/dev/dri
```

## Data Migration / Reindexing

Changing ML providers changes embedding spaces. Existing vectors must not be mixed.

Use model IDs like:

```text
tgdl:Xenova/clip-vit-base-patch32
immich:ViT-B-32__openai
tgdl-ml:ViT-B-32__openai
```

Required behavior:

1. Detect active embedding model at boot/status.
2. Compare with rows in `image_embeddings.model`.
3. Clear stale embeddings when model changes.
4. Set `downloads.ai_indexed_at = NULL` for rows needing rebuild.
5. Reindex through existing Maintenance → AI flow.

For faces, provider/model changes may require clearing/rebuilding:

- `faces`
- `people`
- face quality scores

OCR can be rebuilt independently by clearing/re-running OCR rows.

## Current Progress

Initial scaffold started in `tgdl-ml/`:

- FastAPI compatibility app
- Dockerfile based on `ghcr.io/immich-app/immich-machine-learning`
- `/health`, `/info`
- `/embed-image`, `/embed-text`
- `/detect`, `/detect-embed`, `/detect/batch`
- `/ocr`
- `/tag` and `/detect-objects` stubs return `501 not_implemented`
- Compose profile `tgdl-ml` added as an experimental service

## Implementation Phases

### Phase 1 — Minimal sidecar scaffold

- Create `tgdl-ml/` or replace/extend `faces-service/` with a new package boundary
- FastAPI app
- `/health`
- `/info`
- `/embed-image`
- `/embed-text`
- CPU-only Docker image
- Use Immich-style CLIP model classes and ONNX Runtime session handling

Expected outcome: semantic search embeddings work through `tgdl-ml`.

### Phase 2 — OCR

- Add RapidOCR detection + recognition
- Expose `/ocr` with current tgdl-compatible response:

```json
{
  "result": {
    "text": "...",
    "language": null,
    "confidence": 0.91
  }
}
```

Expected outcome: OCR scan can run without Tesseract.

### Phase 3 — Face detection + embeddings

- Add InsightFace detection + recognition pipeline
- Expose `/detect` and `/detect-embed`
- Map Immich face response to tgdl shape:

```json
{
  "faces": [
    {
      "x": 10,
      "y": 20,
      "w": 100,
      "h": 100,
      "score": 0.99,
      "embedding": [0.1, 0.2]
    }
  ],
  "image_w": 1920,
  "image_h": 1080
}
```

Expected outcome: people clustering can use `tgdl-ml`.

### Phase 4 — Docker hardware variants

- CPU image
- CUDA image
- OpenVINO image
- ROCm image if practical
- Compose profiles
- Provider probe endpoint

Expected outcome: NAS/GPU users can select the right image without custom installs.

### Phase 5 — Compatibility and UI

- Add provider capability flags to `/api/ai/status`
- Show active provider/model in Maintenance → AI
- Hide unsupported actions when using `tgdl-ml`
- Add reindex confirmation when provider/model changes

### Phase 6 — Tag/object parity

- Implement `/tag` via CLIP text-label similarity, or keep current tgdl tagger
- Optionally port YOLO object detection
- Add `/detect/batch` compatibility endpoint

## Risks

- Immich code/license compatibility must be reviewed before copying code directly.
- Model cache size can be large.
- First-run model downloads may be slow.
- Face embedding spaces differ by model; old clusters may need rebuild.
- OCR output shape differs from Tesseract; UI/search may need confidence normalization.
- Hardware acceleration variants add Docker build and support complexity.

## Recommendation

Do not hard-replace `tgdl-faces` immediately.

Recommended path:

1. Keep current hybrid Immich adapter for experiments.
2. Build `tgdl-ml` minimal CPU image for embeddings.
3. Add OCR.
4. Add face detection.
5. Add provider mode in app config.
6. Only then decide whether to deprecate `tgdl-faces`.

This avoids breaking tags/object detection while giving us a cleaner long-term ML runtime.
