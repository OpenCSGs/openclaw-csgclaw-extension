# OpenClaw CSGClaw runtime base + local csgclaw-extension installed under
# /home/node/openclaw-plugins/csgclaw-extension
#
# ACR (see Makefile): make image
#   -> opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw:<tag>
# Local: make image-local  -> openclaw-csgclaw:local
#
# The CSGClaw plugin is copied from the local build output; Feishu is installed
# from npm during the image build.

ARG OPENCLAW_BASE_IMAGE=opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw-csgclaw-base:2026.5.26-node24-pnpm10-py3
ARG OPENCLAW_FEISHU_VERSION=2026.5.26
ARG CSGCLAW_EXTENSION_VERSION=0.3.9-ext.3-beta.3

FROM ${OPENCLAW_BASE_IMAGE}
ARG OPENCLAW_FEISHU_VERSION
ARG CSGCLAW_EXTENSION_VERSION

USER root
RUN mkdir -p /home/node/.openclaw/workspace/projects \
  && mkdir -p /home/node/openclaw-plugins/csgclaw-extension \
  && mkdir -p /home/node/openclaw-plugins/feishu \
  && chown -R 1000:1000 /home/node/.openclaw /home/node/openclaw-plugins

ENV HOME=/home/node

# Avoid Feishu's OpenClaw ping probe; it blocks manager bot group invites.
COPY --chown=1000:1000 docker/patch-openclaw-feishu-probe.mjs /tmp/patch-openclaw-feishu-probe.mjs
COPY --chown=1000:1000 package.json openclaw.plugin.json /home/node/openclaw-plugins/csgclaw-extension/
COPY --chown=1000:1000 dist /home/node/openclaw-plugins/csgclaw-extension/dist

USER 1000
RUN set -eux; \
  node -e "const fs=require('node:fs'); const pkg=JSON.parse(fs.readFileSync('/home/node/openclaw-plugins/csgclaw-extension/package.json','utf8')); if (pkg.version !== process.env.CSGCLAW_EXTENSION_VERSION) throw new Error('csgclaw-extension version mismatch: ' + pkg.version + ' != ' + process.env.CSGCLAW_EXTENSION_VERSION);"; \
  test -f /home/node/openclaw-plugins/csgclaw-extension/dist/index.js; \
  mkdir -p /home/node/openclaw-plugins/csgclaw-extension/node_modules; \
  ln -sfn /app /home/node/openclaw-plugins/csgclaw-extension/node_modules/openclaw; \
  tmpdir="$(mktemp -d)"; \
  cd "$tmpdir"; \
  npm pack --silent "@openclaw/feishu@${OPENCLAW_FEISHU_VERSION}"; \
  tarball="$(find "$tmpdir" -maxdepth 1 -name '*.tgz' -print -quit)"; \
  tar -xzf "$tarball" -C /home/node/openclaw-plugins/feishu --strip-components=1; \
  cd /home/node/openclaw-plugins/feishu; \
  node -e "const fs=require('node:fs'); const p='package.json'; const pkg=JSON.parse(fs.readFileSync(p,'utf8')); pkg.openclaw = pkg.openclaw || {}; pkg.openclaw.extensions = pkg.openclaw.runtimeExtensions || pkg.openclaw.extensions; pkg.openclaw.setupEntry = pkg.openclaw.runtimeSetupEntry || pkg.openclaw.setupEntry; fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');"; \
  node /tmp/patch-openclaw-feishu-probe.mjs /home/node/openclaw-plugins/feishu; \
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps --package-lock=false; \
  ln -sfn /app node_modules/openclaw; \
  rm -rf "$tmpdir"

USER root
# CSGClaw runs the sandbox as the host uid. Root-owned baked plugins are accepted
# by OpenClaw discovery for any runtime uid, while uid 1000 is not.
RUN chown -R root:root /home/node/openclaw-plugins

USER 1000
WORKDIR /app

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Fallback for manual `docker run` and image smoke tests. CSGClaw supplies its
# own sandbox command, which overrides this CMD and also redirects gateway logs.
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"]
