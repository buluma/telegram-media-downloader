# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   - "deps" installs prod dependencies only (npm ci --omit=dev) so the runtime
#     image stays small.
#   - "runtime" copies node_modules from "deps" + the source, runs as the
#     non-root `node` user, exposes 3000, and ships a healthcheck that hits
#     the dashboard's /api/auth_check endpoint.
#
# Pin a specific patch version. Floating tags drift; this image is reproducible.
ARG RUNTIME_BASE_IMAGE=runtime-base

FROM node:26.5.0-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# better-sqlite3's prebuilt arm64 binary can require a newer glibc than this
# bookworm-slim base ships (seen: prebuild wanting GLIBC_2.38 against 2.36 here).
# Force it to compile from source with the toolchain installed above instead
# of trusting whatever prebuild npm resolves.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm_config_build_from_source=true npm rebuild better-sqlite3

FROM node:26.5.0-bookworm-slim AS runtime-base

# tini    — proper PID 1 (signal handling + zombie reaping). Debian ships
#           the binary at /usr/bin/tini.
# gosu    — drop from root → node after the entrypoint fixes /app/data perms
#           (su-exec equivalent on Debian; same `gosu user "$@"` syntax).
# ffmpeg  — used by src/core/thumbs.js for video first-frame thumbnails
#           and audio cover-art extraction. ~30 MB — tiny next to libvips
#           and node_modules.
# intel-media-va-driver / i965-va-driver — VA-API userland drivers needed
#           for `-hwaccel vaapi` (Intel iGPU + AMD via the same libva ABI).
#           Without these the ffmpeg path in thumbs.js falls back to CPU
#           decode even when the host exposes /dev/dri. iHD is Gen8+ and
#           the Quick Sync runtime; i965 covers Gen4-Gen7 hardware.
# vainfo  — `vainfo` from libva-utils. Not used by the app itself, but
#           lets operators `docker exec <ctr> vainfo` to confirm the
#           driver actually loaded inside the container without having
#           to bake their own debug image.
#
# Base is bookworm-slim (glibc) rather than alpine (musl) because
# `onnxruntime-node` (pulled in by @huggingface/transformers for the NSFW
# classifier) ships glibc-only prebuilt .so files; loading them on musl
# crashes the whole process at boot with "ld-linux-x86-64.so.2: No such
# file or directory". libstdc++ is part of the base image, no install needed.
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini gosu ffmpeg procps vainfo \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        apt-get install -y --no-install-recommends \
            intel-media-va-driver i965-va-driver; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# Optional optimization path:
#   - default: `RUNTIME_BASE_IMAGE=runtime-base` (uses the stage above)
#   - faster deploy path: point at a prebuilt base image that already has
#     ffmpeg/libva tooling baked in, e.g.
#       RUNTIME_BASE_IMAGE=ghcr.io/buluma/tgdl-runtime-base:bookworm-node26-arm64
# This avoids re-running the heavy apt install block on each app rebuild.
FROM ${RUNTIME_BASE_IMAGE} AS runtime

# Build identity — passed in by CI (`docker build --build-arg GIT_SHA=…
# --build-arg BUILT_AT=…`) and surfaced via `/api/version` so the
# status-bar chip always reflects what's actually deployed.
ARG GIT_SHA=dev
ARG BUILT_AT=
ENV NODE_ENV=production \
    PORT=3000 \
    GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT}

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules

# Copy scripts + manifests before src so model/seekbar download layers are
# only cache-busted when scripts or node_modules change, not on every src edit.
COPY scripts ./scripts
COPY runner.js config.example.json package.json LICENSE README.md SECURITY.md CHANGELOG.md ./

# Pre-warm the AI model cache at build time so a first scan completes in
# milliseconds instead of waiting on a cold ~150 MB download. Allowed to
# fail with `|| true` for offline / firewalled CI machines — first run
# falls back to lazy download. Skips silently when @huggingface/transformers
# isn't installed (minimal builds without the optional dep).
RUN node scripts/pre-download-models.js || true

# Bake the seekbar Go binary into the image so the first container boot
# doesn't trigger a runtime download race. The `|| true` lets offline/CI
# builds succeed — spawn.js auto-downloads on first use as a fallback.
RUN node scripts/pre-download-seekbar.js || true

# Source copied last — changes here don't bust the model/seekbar cache layers.
COPY src ./src

# Persistent state (sessions, config, downloads) — mount this as a volume.
# `chmod a+rX` guarantees files end up readable + dirs traversable even when
# BuildKit lays down mode 0 (seen on Windows hosts and some gha-cache hits),
# which previously surfaced as `Cannot find module '/app/src/web/server.js'`.
RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions /app/data/backups /app/data/models \
    && chmod -R a+rX /app \
    && chmod +x /app/scripts/docker-entrypoint.sh \
    && chown -R node:node /app

# We deliberately run the entrypoint as root so it can chown the bind-mounted
# /app/data volume on first boot — gosu drops to `node` before exec'ing
# CMD, so the actual app process is still non-root.
EXPOSE 3000

# --timeout must stay above healthcheck.js's own internal request timeout
# (8s) or Docker kills the check process before that timeout ever fires.
# docker-compose.yml's healthcheck block overrides this for compose-based
# deployments; kept in sync here for anyone running the bare image.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "src/web/server.js"]
