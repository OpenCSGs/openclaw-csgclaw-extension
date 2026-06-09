# openclaw-csgclaw-extension — Agent Guide

## Project Identity

- **Repository**: `openclaw-csgclaw-extension`
- **npm package**: `csgclaw-extension` (name unchanged on npm)
- **Purpose**: OpenClaw channel plugin bridging CSGClaw IM ↔ OpenClaw gateway

---

## Key Info (Not Obvious from Code)

### Version Sync

Three places must stay in sync when bumping version:
1. `package.json` → `version`
2. `Makefile` → `CSGCLAW_EXTENSION_VERSION`
3. `docker/Dockerfile` → `ARG CSGCLAW_EXTENSION_VERSION`

### Docker Images

| File | Use Case |
|------|----------|
| `docker/Dockerfile` | Production (pulls from npm) |
| `docker/Dockerfile.ci` | CI only (uses local `dist/`) |
| `docker/Dockerfile.base` | Base image (rare updates) |

### CI/CD

- **GitLab CI**: triggers on `main` push (via mirror sync from GitHub)
- **Tag format**: `YYYYMMDD.{CI_PIPELINE_IID}-csgclaw` — auto-incrementing, same-day unique
- **Registry**: `opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw`

### GitLab Mirror

- Uses `ghfast.top` proxy (GitHub blocked in CN)
- Must enable **"Trigger pipelines for mirror updates"** to auto-trigger CI
- Default sync: 30 min, or manually refresh in Settings → Repository

### Plugin Ownership in Docker

Dockerfile uses `--chown=root:root` for plugin dirs. CSGClaw sandbox runs as host uid; OpenClaw discovery rejects plugins owned by non-root non-current-uid.

---

## Commands

```bash
# Dev
pnpm install --frozen-lockfile
pnpm run build

# Docker
make image-local          # local single-arch
make image                # push multi-arch to ACR
make base-image           # rebuild base (rare)
```

---

## Release Checklist

1. Bump version in `package.json`
2. Sync `CSGCLAW_EXTENSION_VERSION` in `Makefile` + `docker/Dockerfile`
3. Commit & push to `main`
4. Wait for GitLab mirror sync → CI auto-build
5. Verify image on ACR

---

## References

- [Docker files docs](./docker/README.md)
- [npm package](https://www.npmjs.com/package/csgclaw-extension)
