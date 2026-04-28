# OpenClaw slim + csgclaw-extension baked under /home/node/openclaw-plugins/csgclaw-extension
#
# ACR (see Makefile): make image
#   -> opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsg_public/openclaw-csgclaw:<tag>
# Local: make image-local  -> openclaw-csgclaw:local
#
# The Makefile targets `prepare-dist` and `prepare-csgclaw-cli` produce all
# artifacts on the host before invoking docker build, so this Dockerfile is a
# pure assembly step (no pnpm/npm/tsc inside the image build).

ARG OPENCLAW_BASE_VERSION=2026.3.31

# Select the platform-specific csgclaw-cli binary. Pre-built artifacts must
# exist under docker/csgclaw-cli/ before invoking docker build; the Makefile
# target `prepare-csgclaw-cli` produces them from the sibling csgclaw repo.
FROM scratch AS csgclaw-cli
ARG TARGETARCH
COPY docker/csgclaw-cli/csgclaw-cli_linux_${TARGETARCH} /csgclaw-cli

FROM ghcr.io/openclaw/openclaw:${OPENCLAW_BASE_VERSION}-slim

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

USER 1000
ENV HOME=/home/node
WORKDIR /app
