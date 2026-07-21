# Contributing to openclaw-csgclaw-extension

Thank you for your interest in contributing to the CSGClaw extension for OpenClaw! This guide will help you get started.

## Quick Links

- [Project Overview](#project-overview)
- [Development Setup](#development-setup)
- [Building & Testing](#building--testing)
- [CI/CD Pipeline](#cicd-pipeline)
- [Version Release](#version-release)
- [Pull Request Process](#pull-request-process)

## Project Overview

This repository contains an [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that bridges CSGClaw IM conversations into the OpenClaw gateway.

**Key components:**
- TypeScript plugin for OpenClaw gateway
- Docker images for sandbox deployment
- Bidirectional IM bridge (SSE inbound, REST outbound)

## Development Setup

### Prerequisites

- Node.js >= 24.14.0
- pnpm >= 10
- Docker with Buildx (for image builds)
- A running CSGClaw server (for integration testing)

### Local Development

```bash
# Clone the repository
git clone https://github.com/OpenCSGs/openclaw-csgclaw-extension.git
cd openclaw-csgclaw-extension

# Install dependencies
pnpm install --frozen-lockfile

# Build the plugin
pnpm run build

# Run in development mode (if available)
pnpm run dev
```

### Configuration

Add to your `openclaw.json`:

```json
{
  "channels": {
    "csgclaw": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:18080",
      "participantId": "your-bot-id"
    }
  },
  "plugins": {
    "load": { "paths": ["./path-to/csgclaw-extension"] },
    "entries": { "csgclaw": { "enabled": true } }
  }
}
```

## Building & Testing

### Build Plugin Only

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### Build Docker Image (Local)

```bash
# Build and load into local Docker
make image-local
```

### Run Tests

```bash
pnpm run test
```

## CI/CD Pipeline

This project uses a **dual-CI** setup:

| Platform | Trigger | Purpose |
|----------|---------|---------|
| GitHub Actions | Pull requests | TypeScript build check |
| GitLab CI | `main` branch push | Multi-arch Docker build → ACR |

### How CI Works

```
GitHub (source of truth)
  ↓ Push to main
GitLab Mirror Sync (via ghfast.top proxy)
  ↓ Auto-trigger (30 min interval)
GitLab CI Build
  ↓
ACR (Alibaba Cloud Container Registry)
  opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw:YYYYMMDD.N-csgclaw
```

### Manually Triggering CI Builds

GitLab CI automatically triggers when `main` is updated via mirror sync (default: 30 min interval).

**To trigger an immediate build:**

1. Go to [GitLab Repository Settings → Mirroring](https://git-devops.opencsg.com/product/agentichub/openclaw-csgclaw-extension/-/settings/repository#js-push-remote-settings)
2. Find the mirror entry for this repository
3. Click the **refresh button** (🔄) next to the mirror entry
4. Check **CI/CD → Pipelines** for build status

**Image tag format:** `YYYYMMDD.{daily_publish_number}-csgclaw`
- The number resets every day in UTC+8 and is derived from images already published to ACR.
- Failed builds do not consume a number; same-day publishes are serialized to avoid duplicate tags.

## Version Release

### Version Bump Process

1. Update `version` in `package.json`
2. Update `OPENCLAW_BASE_VERSION` if upgrading OpenClaw base
3. Commit changes to `main`
4. Push to GitHub → GitLab mirror sync → CI auto-build

`package.json` is the single source of truth for the plugin version. Docker
builds copy it into the image and do not maintain a separate version value.

### npm Package

The npm package name is `openclaw-csgclaw-extension`:

```bash
pnpm run build
npm publish --access public
```

OpenClaw installs it with
`openclaw plugins install npm:openclaw-csgclaw-extension` and can update it
independently from the runtime image.

## Pull Request Process

1. **Fork** the repository
2. **Create a feature branch** from `main`
3. **Make your changes** following the code style
4. **Run tests** locally: `pnpm run test`
5. **Submit a PR** to `main`
6. **Wait for CI** — GitHub Actions will run TypeScript checks
7. **Address review feedback** if any
8. **Merge** after approval

### PR Guidelines

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- Keep PRs focused on a single concern
- Include tests for new features
- Update documentation if changing behavior
- Ensure CI passes before requesting review

## Docker Images

### Image Variants

| Target | Command | Output |
|--------|---------|--------|
| Local dev | `make image-local` | `openclaw-csgclaw:local` |
| ACR publish | `make image TAG=<tag>` | `<registry>/opencsghq/openclaw:<tag>` |
| Base only | `make base-image` | Pre-baked runtime base |

### Dockerfile Selection

| File | Use Case |
|------|----------|
| `docker/Dockerfile` | Production (pulls from npm) |
| `docker/Dockerfile.ci` | CI builds (uses local `dist/`) |
| `docker/Dockerfile.base` | Base image (rare updates) |

See [docker/README.md](./docker/README.md) for details.

## Troubleshooting

### CI Build Fails

- **pnpm not found**: CI uses base image with pnpm pre-installed. Check if base image is accessible.
- **Base image platform mismatch**: Ensure base image has both `linux/amd64` and `linux/arm64` manifests.

### Local Build Issues

- **Permission denied on plugin dir**: Dockerfile uses `--chown=root:root`. This is intentional for OpenClaw plugin discovery.
- **Image not found in ACR**: Check tag format matches `YYYYMMDD.N-csgclaw`.

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/OpenCSGs/openclaw-csgclaw-extension/issues)
- **OpenClaw docs**: https://github.com/openclaw/openclaw
- **CSGClaw docs**: https://github.com/OpenCSGs/csgclaw

## License

By contributing, you agree that your contributions will be licensed under the project's [LICENSE](LICENSE).
