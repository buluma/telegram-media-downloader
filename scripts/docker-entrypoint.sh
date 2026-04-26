#!/bin/sh
# Container entrypoint:
#   1. Fix ownership + permissions on the bind-mounted /app/data so the
#      `node` user (uid 1000) can always read/write — host-side perms
#      from `docker run -v ./data:/app/data` otherwise win and locked
#      out new installs on Linux hosts.
#   2. Drop privileges to `node` via su-exec and exec the CMD.
#
# Idempotent: safe to run on every container start. The chown/chmod walk
# is a no-op once perms are already correct (millisecond-cost on most
# volumes; if you have millions of files set FAST_BOOT=1 to skip it).

set -e

if [ "$(id -u)" = "0" ]; then
    if [ "${FAST_BOOT:-0}" != "1" ]; then
        mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions
        chown -R node:node /app/data 2>/dev/null || true
        chmod -R u+rwX,g+rwX,o+rX /app/data 2>/dev/null || true
    fi
    exec su-exec node:node "$@"
fi

exec "$@"
