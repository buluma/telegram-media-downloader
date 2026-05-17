# tgdl-ml

Experimental Telegram Media Downloader ML sidecar built as a compatibility layer on top of Immich's machine-learning runtime.

This is the first implementation pass for `docs/TGDL-ML-IMMICH-PLAN.md`.

## Status

Implemented endpoints:

- `GET /health`
- `GET /info`
- `POST /embed-image`
- `POST /embed-text`
- `POST /detect`
- `POST /detect-embed`
- `POST /detect/batch`
- `POST /ocr`

Stubbed endpoints:

- `POST /tag` returns `501 not_implemented`
- `POST /detect-objects` returns `501 not_implemented`

## Docker

CPU image:

```bash
docker build -t tgdl-ml:latest tgdl-ml
```

CUDA image, using Immich's CUDA variant as the base:

```bash
docker build \
  --build-arg BASE_IMAGE=ghcr.io/immich-app/immich-machine-learning:release-cuda \
  -t tgdl-ml:cuda \
  tgdl-ml
```

Run locally:

```bash
docker run --rm -p 3800:3800 \
  -v "$PWD/data/ml-cache:/cache" \
  -v "$PWD/data/downloads:/app/data/downloads:ro" \
  -e TGDL_ML_ALLOW_ROOTS=/app/data/downloads \
  tgdl-ml:latest
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `TGDL_ML_HOST` | `0.0.0.0` | Bind host |
| `TGDL_ML_PORT` | `3800` | Bind port |
| `TGDL_ML_ALLOW_ROOTS` | empty | Comma-separated roots allowed for path-mode image reads |
| `TGDL_ML_CLIP_MODEL` | `ViT-B-32__openai` | CLIP model |
| `TGDL_ML_FACE_MODEL` | `buffalo_l` | InsightFace model |
| `TGDL_ML_OCR_MODEL` | `PP-OCRv5_mobile` | OCR model |
| `TGDL_ML_REQUEST_THREADS` | Immich default | Request thread pool size |

If `TGDL_ML_ALLOW_ROOTS` is empty, path-mode image requests are rejected with `403 path_not_allowed`; callers should use `image_b64` or configure allowed roots.

## Request examples

Health:

```bash
curl http://localhost:3800/health
```

Image embedding by base64:

```bash
B64=$(base64 -w0 photo.jpg)
curl -X POST http://localhost:3800/embed-image \
  -H 'content-type: application/json' \
  -d "{\"image_b64\":\"$B64\"}"
```

Text embedding:

```bash
curl -X POST http://localhost:3800/embed-text \
  -H 'content-type: application/json' \
  -d '{"text":"person on a beach"}'
```

Face detection:

```bash
curl -X POST http://localhost:3800/detect \
  -H 'content-type: application/json' \
  -d '{"path":"/app/data/downloads/example/images/photo.jpg"}'
```

OCR:

```bash
curl -X POST http://localhost:3800/ocr \
  -H 'content-type: application/json' \
  -d '{"path":"/app/data/downloads/example/images/screenshot.jpg"}'
```
