#!/usr/bin/env bash
set -euo pipefail

MODE="dry-run"
MIN_FREE_GB=0
REMOVE_VOLUMES=0

usage() {
    cat <<EOF
Predictable Docker cleanup with guardrails.

Default mode is dry-run (no deletions).

Usage:
  $0 [--apply] [--min-free-gb <n>] [--volumes]

Options:
  --apply          Execute prune operations.
  --min-free-gb N  Abort if current free disk is below N GiB.
  --volumes        Include anonymous volumes prune.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --apply) MODE="apply"; shift ;;
        --min-free-gb) MIN_FREE_GB="$2"; shift 2 ;;
        --volumes) REMOVE_VOLUMES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
    esac
done

if ! [[ "${MIN_FREE_GB}" =~ ^[0-9]+$ ]]; then
    echo "--min-free-gb must be a non-negative integer" >&2
    exit 2
fi

FREE_KB="$(df -Pk . | awk 'NR==2 {print $4}')"
FREE_GB="$((FREE_KB / 1024 / 1024))"
echo "Free disk now: ${FREE_GB} GiB"

if (( MIN_FREE_GB > 0 && FREE_GB < MIN_FREE_GB )); then
    echo "Guard hit: free disk (${FREE_GB} GiB) is below threshold (${MIN_FREE_GB} GiB)."
    echo "Aborting prune."
    exit 1
fi

echo
echo "Docker usage before:"
docker system df
echo

if [[ "${MODE}" == "dry-run" ]]; then
    echo "Dry-run: no prune commands executed."
    echo "Would run:"
    echo "  docker builder prune -f"
    echo "  docker image prune -f"
    echo "  docker container prune -f"
    echo "  docker network prune -f"
    if (( REMOVE_VOLUMES == 1 )); then
        echo "  docker volume prune -f"
    fi
    exit 0
fi

docker builder prune -f
docker image prune -f
docker container prune -f
docker network prune -f
if (( REMOVE_VOLUMES == 1 )); then
    docker volume prune -f
fi

echo
echo "Docker usage after:"
docker system df
