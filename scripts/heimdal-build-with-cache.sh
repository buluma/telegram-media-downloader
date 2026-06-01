#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="${BUILDKIT_CACHE_DIR:-/home/heimdal/.cache/tgdl-buildkit}"
IMAGE_TAG="${IMAGE_TAG:-ghcr.io/buluma/telegram-media-downloader:latest}"
SERVICE="${SERVICE:-telegram-downloader}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
BUILDX_BUILDER="${BUILDX_BUILDER:-tgdlbuilder}"
BUILDX_DRIVER="${BUILDX_DRIVER:-docker-container}"
GIT_SHA="${GIT_SHA:-$(git rev-parse --short HEAD)}"
BUILT_AT="${BUILT_AT:-$(date -u +%FT%TZ)}"
RUNTIME_BASE_IMAGE="${RUNTIME_BASE_IMAGE:-runtime-base}"

usage() {
    cat <<EOF
Build TGDL on-host with persistent BuildKit cache, then restart compose service.

Usage:
  $0 [--cache-dir <dir>] [--image <ref>] [--service <name>] [--compose-file <file>] [--compose-override-file <file>] [--buildx-builder <name>] [--dry-run]

Env overrides:
  BUILDKIT_CACHE_DIR, IMAGE_TAG, SERVICE, COMPOSE_FILE, COMPOSE_OVERRIDE_FILE,
  BUILDX_BUILDER, BUILDX_DRIVER, GIT_SHA, BUILT_AT, RUNTIME_BASE_IMAGE
EOF
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --cache-dir) CACHE_DIR="$2"; shift 2 ;;
        --image) IMAGE_TAG="$2"; shift 2 ;;
        --service) SERVICE="$2"; shift 2 ;;
        --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
        --compose-override-file) COMPOSE_OVERRIDE_FILE="$2"; shift 2 ;;
        --buildx-builder) BUILDX_BUILDER="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
    esac
done

mkdir -p "${CACHE_DIR}"

if ! docker buildx inspect "${BUILDX_BUILDER}" >/dev/null 2>&1; then
    docker buildx create --name "${BUILDX_BUILDER}" --driver "${BUILDX_DRIVER}" --use >/dev/null
else
    docker buildx use "${BUILDX_BUILDER}" >/dev/null
fi
docker buildx inspect --bootstrap >/dev/null

COMPOSE_ARGS=(-f "${COMPOSE_FILE}")
if [[ -n "${COMPOSE_OVERRIDE_FILE}" ]]; then
    COMPOSE_ARGS+=(-f "${COMPOSE_OVERRIDE_FILE}")
fi

BUILD_CMD=(
    docker buildx build
    --load
    --builder "${BUILDX_BUILDER}"
    --tag "${IMAGE_TAG}"
    --cache-from "type=local,src=${CACHE_DIR}"
    --cache-to "type=local,dest=${CACHE_DIR},mode=max,ignore-error=true"
    --build-arg "GIT_SHA=${GIT_SHA}"
    --build-arg "BUILT_AT=${BUILT_AT}"
    --build-arg "RUNTIME_BASE_IMAGE=${RUNTIME_BASE_IMAGE}"
    .
)

UP_CMD=(
    docker compose
    "${COMPOSE_ARGS[@]}"
    up -d
    --no-deps
    --no-build
    "${SERVICE}"
)

echo "build cache dir: ${CACHE_DIR}"
echo "buildx builder: ${BUILDX_BUILDER} (driver=${BUILDX_DRIVER})"
echo "runtime base image: ${RUNTIME_BASE_IMAGE}"
echo "target image: ${IMAGE_TAG}"
if [[ ${DRY_RUN} -eq 1 ]]; then
    printf 'dry-run build: %q ' "${BUILD_CMD[@]}"
    echo
    printf 'dry-run up: %q ' "${UP_CMD[@]}"
    echo
    exit 0
fi

"${BUILD_CMD[@]}"
"${UP_CMD[@]}"
echo "Service ${SERVICE} rebuilt and restarted."
