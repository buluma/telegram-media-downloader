#!/usr/bin/env bash
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/buluma/tgdl-runtime-base}"
IMAGE_TAG="${IMAGE_TAG:-bookworm-node26}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

usage() {
    cat <<EOF
Build and push the reusable runtime base image (apt-heavy layers only).

Usage:
  $0 [--repo <repo>] [--tag <tag>] [--platforms <csv>] [--dry-run]

Examples:
  $0
  $0 --repo ghcr.io/buluma/tgdl-runtime-base --tag bookworm-node26
  $0 --platforms linux/arm64
EOF
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) IMAGE_REPO="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --platforms) PLATFORMS="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
    esac
done

REF="${IMAGE_REPO}:${IMAGE_TAG}"
CMD=(
    docker buildx build
    --platform "${PLATFORMS}"
    --target runtime-base
    --tag "${REF}"
    --push
    .
)

echo "runtime-base publish ref: ${REF}"
echo "platforms: ${PLATFORMS}"
if [[ ${DRY_RUN} -eq 1 ]]; then
    printf 'dry-run cmd: %q ' "${CMD[@]}"
    echo
    exit 0
fi

"${CMD[@]}"
echo "Published ${REF}"
