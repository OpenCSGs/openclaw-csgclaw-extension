# OpenClaw slim + csgclaw-extension baked under /home/node/openclaw-plugins/csgclaw-extension
#
# ACR (see Makefile): make image
#   -> opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw:<tag>
# Local: make image-local  -> openclaw-csgclaw:local
#
# The Makefile targets `prepare-dist` and `prepare-csgclaw-cli` produce all
# artifacts on the host before invoking docker build, so this Dockerfile is a
# pure assembly step (no package install or TypeScript build inside the image build).

ARG OPENCLAW_BASE_VERSION=2026.3.31
ARG BUN_IMAGE=opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/bun:1.3.4-debian

FROM ${BUN_IMAGE} AS bun-runtime

# Select the platform-specific csgclaw-cli binary. Pre-built artifacts must
# exist under docker/csgclaw-cli/ before invoking docker build; the Makefile
# target `prepare-csgclaw-cli` produces them from the sibling csgclaw repo.
FROM scratch AS csgclaw-cli
ARG TARGETARCH
COPY docker/csgclaw-cli/csgclaw-cli_linux_${TARGETARCH} /csgclaw-cli

FROM ghcr.io/openclaw/openclaw:${OPENCLAW_BASE_VERSION}-slim

# Add Bun as the preferred OpenClaw runtime for the CSGClaw image, while keeping
# the base image's Node binary available for compatibility with Node-specific
# scripts and OpenClaw internals.
USER root
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# OpenClaw v2026.3.31 probes this path before falling through to dist/entry.js.
# Node tolerates the missing optional import shape here; Bun needs the shim.
RUN printf '%s\n' 'export { installProcessWarningFilter } from "./infra/warning-filter.js";' > /app/dist/warning-filter.js

# Bake csgclaw-cli into the image so manager/worker agents do not need to
# fetch or install it at runtime. Using --chmod keeps a single layer and
# avoids switching to root/back to node 1000.
COPY --from=csgclaw-cli --chmod=0755 /csgclaw-cli /usr/local/bin/csgclaw-cli

# Drop pre-built csgclaw-extension straight into the OpenClaw plugins dir.
# The plugin is pure TypeScript and has no runtime npm dependencies (see
# csgclaw-extension/package.json), so OpenClaw discovers it via
# plugins.load.paths without an install step. dist/ is built on the host
# by `make prepare-dist` before docker build.
COPY --chown=1000:1000 dist /home/node/openclaw-plugins/csgclaw-extension/dist
COPY --chown=1000:1000 package.json /home/node/openclaw-plugins/csgclaw-extension/package.json
COPY --chown=1000:1000 openclaw.plugin.json /home/node/openclaw-plugins/csgclaw-extension/openclaw.plugin.json

# Python for workspace skills (e.g. manager-worker-dispatch): Debian `python3` with
# --no-install-recommends is already the smallest supported bundle that includes the
# full standard library (urllib, subprocess, ssl, ...). `python3-minimal` alone is too
# stripped for these scripts. Non-Debian bases (e.g. Alpine apk python3) would differ.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3 /usr/local/bin/python

USER 1000
ENV HOME=/home/node
WORKDIR /app

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Fallback for manual `docker run` and image smoke tests. CSGClaw supplies its
# own sandbox command, which overrides this CMD and also redirects gateway logs.
CMD ["bun", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"]
