# syntax=docker/dockerfile:1.7
#
# tgdl-ml is a thin compatibility API on top of Immich's machine-learning
# runtime. The base image supplies immich_ml, model code, ONNX Runtime
# variants, and hardware-acceleration support. This layer only swaps the
# public HTTP contract to match telegram-media-downloader.
#
# CPU:
#   docker build -t tgdl-ml:latest tgdl-ml
# CUDA/OpenVINO/ROCm:
#   docker build --build-arg BASE_IMAGE=ghcr.io/immich-app/immich-machine-learning:release-cuda -t tgdl-ml:cuda tgdl-ml

ARG BASE_IMAGE=ghcr.io/immich-app/immich-machine-learning:release
FROM ${BASE_IMAGE} AS runtime

WORKDIR /usr/src
COPY tgdl_ml /usr/src/tgdl_ml

ENV PYTHONPATH=/usr/src \
    TGDL_ML_HOST=0.0.0.0 \
    TGDL_ML_PORT=3800 \
    TGDL_ML_CACHE_FOLDER=/cache \
    MACHINE_LEARNING_CACHE_FOLDER=/cache

EXPOSE 3800

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python3", "-c", "import json,urllib.request; d=json.loads(urllib.request.urlopen('http://127.0.0.1:3800/health',timeout=3).read()); exit(0 if d.get('ok') else 1)"]

CMD ["python", "-m", "tgdl_ml"]
