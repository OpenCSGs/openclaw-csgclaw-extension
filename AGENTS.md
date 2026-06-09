# CSGClaw Extension — Agent Guide

This file is for agents maintaining this project. It provides key information and operational guidelines.

## Project Overview

`csgclaw-extension` is an OpenClaw channel plugin that bridges CSGClaw IM messages into the OpenClaw gateway.

**Core responsibilities**:
- Consume CSGClaw SSE participant events (inbound messages)
- Send replies to CSGClaw via REST API (outbound messages)
- Build Docker images for CSGClaw sandbox usage

**Tech stack**: TypeScript + Node.js 24 + pnpm 10

---

## Directory Structure

```
csgclaw-extension/
── index.ts                 # Plugin entry: defineChannelPluginEntry
├── setup-entry.ts           # Setup entry for OpenClaw CLI wizard
├── openclaw.plugin.json     # Plugin manifest (id, kind, channels)
├── package.json             # npm package definition, version must sync with Dockerfile
├── src/
│   ├── channel.ts           # Channel plugin definition (capabilities, routing, outbound)
│   ├── config.ts            # Account resolution, API URL builders
│   ├── monitor.ts           # SSE event consumer + inbound dispatch + outbound send
│   └── sse.ts               # Minimal SSE stream reader over fetch()
├── docker/
│   ├── README.md            # Docker files documentation
│   ├── Dockerfile           # Production image (pulls extension from npm)
│   ├── Dockerfile.base      # Base image (OpenClaw runtime environment)
│   └── Dockerfile.ci        # CI-only image (uses local dist, no npm publish needed)
├── .gitlab/ci.yml           # GitLab CI config (triggers on main branch)
├── .github/workflows/       # GitHub Actions (PR checks)
└── Makefile                 # Build commands
```

---

## Key Commands

### Development

```bash
pnpm install --frozen-lockfile   # Install dependencies
pnpm run build                   # Build to dist/
pnpm run dev                     # Dev mode (if available)
```

### Docker Images

```bash
# Local build (single platform, loads to local Docker)
make image-local

# Publish to ACR (multi-platform: amd64 + arm64)
make image

# Build base image (low update frequency, only when base dependencies upgrade)
make base-image
make base-image-local
```

### Version Sync

After modifying `package.json` version, you must also update:
- `Makefile` → `CSGCLAW_EXTENSION_VERSION`
- `docker/Dockerfile` → `CSGCLAW_EXTENSION_VERSION`

---

## CI/CD Pipeline

### GitLab CI (Production Build)

**Trigger**: `main` branch push

**Tag format**: `YYYYMMDD.{CI_PIPELINE_IID}-csgclaw`
- `CI_PIPELINE_IID` is a GitLab project-level monotonic ID
- Multiple pushes on the same day generate: `20260609.1-csgclaw`, `20260609.2-csgclaw`...
- Naturally unique, no conflicts

**Build flow**:
1. `pnpm install && pnpm build` → generates `dist/`
2. `git clone csgclaw && make build` → generates `csgclaw-cli` (amd64 + arm64)
3. `docker buildx build -f docker/Dockerfile.ci` → multi-arch image
4. Push to ACR: `opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw`
5. Validate image runs on both platforms

**Required CI/CD Variables** (configure in GitLab Settings → CI/CD → Variables):
- `ACR_REGISTRY` — `opencsg-registry.cn-beijing.cr.aliyuncs.com`
- `ACR_USERNAME` — Alibaba Cloud Container Registry username
- `ACR_PASSWORD` — Alibaba Cloud Container Registry password

### GitHub Actions (PR Checks)

**Trigger**: PR creation/update

**Checks**: TypeScript compilation, lint

---

## Image Pipeline

```
GitHub push (main)
  ↓
GitLab mirror sync (Pull, via ghfast.top proxy)
  ↓
GitLab CI auto-trigger
  ↓
Build multi-arch Docker image
  ↓
Push to ACR
  ↓
CSGClaw uses image as manager/worker agent runtime
```

**Key dependencies**:
- `csgclaw` repo: provides `csgclaw-cli` binaries
- `openclaw-csgclaw-base` base image: provides OpenClaw runtime environment

---

## Release Process

### Publish npm package (optional, for non-Docker scenarios)

```bash
pnpm run build
npm publish  # requires npm token
```

### Publish Docker image (primary release method)

1. Ensure `package.json` version is updated
2. Sync update `CSGCLAW_EXTENSION_VERSION` in `Makefile` and `docker/Dockerfile`
3. Commit and push to GitHub `main` branch
4. GitLab mirror sync triggers CI build automatically
5. Verify image pushed to ACR successfully

---

## Important Notes

### Version Sync

The following three version fields must stay in sync:
1. `package.json` → `version`
2. `Makefile` → `CSGCLAW_EXTENSION_VERSION`
3. `docker/Dockerfile` → `ARG CSGCLAW_EXTENSION_VERSION`

### Dockerfile Selection

- **Production release**: use `docker/Dockerfile` (pulls from npm)
- **CI/CD**: use `docker/Dockerfile.ci` (uses local dist)
- **Base image update**: use `docker/Dockerfile.base`

### Image Tags

- Production image: `YYYYMMDD.N-csgclaw` (e.g., `20260609.1-csgclaw`)
- Base image: `YYYY.M.D-node24-pnpm10-py3` (e.g., `2026.5.26-node24-pnpm10-py3`)

### GitLab Mirror Sync

- Uses `ghfast.top` proxy to access GitHub
- Must check **Trigger pipelines for mirror updates** to auto-trigger CI
- Default sync interval: 30 minutes, can manually refresh

### Plugin Ownership

Dockerfile uses `--chown=root:root` for plugin directory ownership because:
- CSGClaw sandbox runs with host uid
- OpenClaw plugin discovery rejects files owned by non-root and non-current uid

---

## Troubleshooting

### Q: CI build fails with "csgclaw-cli not found"

A: CI automatically clones `csgclaw` repo and builds CLI. If it fails, check:
- Whether GitHub access is normal (CI runner needs to access github.com)
- Whether `csgclaw` repo's `Makefile` has changes

### Q: Image pushed successfully but CSGClaw cannot use it

A: Check:
- Whether ACR image tag matches `manager_image` in `csgclaw` config
- Whether image contains `csgclaw-cli` (`docker run --rm <image> csgclaw-cli --help`)

### Q: How to test image locally

A: 
```bash
make image-local
docker run --rm openclaw-csgclaw:local csgclaw-cli --help
docker run --rm openclaw-csgclaw:local node -e "fetch('http://127.0.0.1:18789/healthz')"
```

---

## References

- [OpenClaw Plugin Development Docs](https://github.com/openclaw/openclaw)
- [CSGClaw Main Repo](../csgclaw/)
- [Docker Files Documentation](./docker/README.md)
