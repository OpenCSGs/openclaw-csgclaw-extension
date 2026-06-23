# openclaw-csgclaw-extension

[![PR](https://github.com/OpenCSGs/openclaw-csgclaw-extension/actions/workflows/pr.yml/badge.svg)](https://github.com/OpenCSGs/openclaw-csgclaw-extension/actions/workflows/pr.yml)

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that bridges CSGClaw IM conversations into the OpenClaw gateway. It connects to the CSGClaw server via **participant SSE** (Server-Sent Events) for inbound messages and **REST API** for outbound replies.

## Architecture

```
┌─────────────┐       SSE /events        ┌─────────────────────┐
│             │ ◄─────────────────────── │                     │
│  CSGClaw    │                          │  OpenClaw Gateway   │
│  Server     │ ◄─────── REST POST ──────│  + csgclaw-extension│
│             │       /messages          │                     │
└─────────────┘                          └─────────────────────┘
        │                                         │
        │                                         │
   IM Clients                              Agent Runtimes
 (Web / Feishu /                        (PicoClaw / Codex /
  CLI / API)                             Custom agents)
```

**Inbound flow:**

1. User sends a message in CSGClaw IM (room or DM)
2. CSGClaw server emits an SSE event on `/api/v1/channels/csgclaw/participants/{id}/events`
3. The plugin consumes the SSE stream, parses the event, and dispatches it into OpenClaw's reply pipeline
4. The assigned agent generates a response

**Outbound flow:**

1. Agent reply flows back through OpenClaw's channel send adapter
2. The plugin POSTs the text to `/api/v1/channels/csgclaw/participants/{id}/messages`
3. CSGClaw server delivers the reply to the IM client

## Features

- **CSGClaw channel** — full bidirectional IM bridge (DM + group rooms)
- **Feishu bridge** — optional Feishu channel pass-through via the same participant API
- **Group mention filtering** — only dispatches group messages when the bot is @-mentioned (configurable per room)
- **Topic/thread support** — preserves topic context for threaded conversations
- **Multi-arch Docker image** — pre-baked image with the channel plugins for `linux/amd64` and `linux/arm64`

## Project Structure

```
├── index.ts              # Plugin entry: defineChannelPluginEntry
├── setup-entry.ts        # Setup entry for OpenClaw CLI wizard
├── openclaw.plugin.json  # Plugin manifest (id, kind, channels)
├── src/
│   ├── channel.ts        # Channel plugin definition (capabilities, routing, outbound)
│   ├── config.ts         # Account resolution, API URL builders
│   ├── monitor.ts        # SSE event consumer + inbound dispatch + outbound send
│   └── sse.ts            # Minimal SSE stream reader over fetch()
── docker/                 # Docker files (see docker/README.md)
│   ├── Dockerfile          # Production image (pulls from npm)
│   ├── Dockerfile.base     # Base image (OpenClaw runtime)
│   └── Dockerfile.ci       # CI-only image (uses local dist)
├── .gitlab/ci.yml          # GitLab CI: main branch → multi-arch buildx → ACR
└── Makefile                # Build targets for local dev and CI image publishing
```

## Quick Start

### Prerequisites

- Node.js >= 24.14.0
- pnpm >= 10
- Docker with Buildx (for image builds)
- A running CSGClaw server with participant API access

### Install & Build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

Output goes to `dist/`.

### Configuration

Add to your `openclaw.json` (OpenClaw gateway config):

```json
{
  "channels": {
    "csgclaw": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:18080",
      "participantId": "your-bot-id",
      "accessToken": "optional-token"
    }
  },
  "plugins": {
    "load": { "paths": ["./path-to/csgclaw-extension"] },
    "entries": { "csgclaw": { "enabled": true } }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `baseUrl` | Yes | CSGClaw server URL |
| `participantId` | Yes | Bot participant ID (also accepts `botId`) |
| `accessToken` | No | Bearer token for API auth |
| `enabled` | No | Enable/disable the channel (default: `true`) |

Environment variables are also supported: `CSGCLAW_BASE_URL`, `CSGCLAW_PARTICIPANT_ID` (or `CSGCLAW_BOT_ID`), `CSGCLAW_ACCESS_TOKEN`.

#### Group Mention Behavior

By default, the bot only responds in group rooms when @-mentioned. Configure per-room overrides:

```json
{
  "channels": {
    "csgclaw": {
      "groups": {
        "room-abc": { "requireMention": false },
        "*": { "requireMention": true }
      }
    }
  }
}
```

#### Feishu Bridge

When both CSGClaw and Feishu channels are configured, the plugin can forward inbound Feishu events from the CSGClaw server and send replies through the Feishu participant API:

```json
{
  "channels": {
    "csgclaw": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:18080",
      "participantId": "my-bot"
    },
    "feishu": {
      "enabled": true,
      "accounts": {
        "my-bot": {
          "enabled": true,
          "appId": "cli_xxx",
          "appSecret": "xxx"
        }
      }
    }
  }
}
```

## Docker Image

The Dockerfile produces a ready-to-run OpenClaw gateway image with the CSGClaw extension and Feishu plugin pre-installed.

### Build Locally (single platform)

```bash
# Build and load into local Docker daemon
make image-local
```

### Build for ACR (multi-arch)

```bash
# Requires a buildx builder with ACR credentials
docker login <acr-registry>

make image TAG=20260609.1-csgclaw PLATFORMS=linux/amd64,linux/arm64
```

### Pre-baked Image Contents

| Component | Location in Image |
|---|---|
| OpenClaw runtime | `/app` |
| CSGClaw plugin | `/home/node/openclaw-plugins/csgclaw-extension/` |
| Feishu plugin | `/home/node/openclaw-plugins/feishu/` |

### Image Variants

| Target | Command | Output |
|---|---|---|
| Local dev | `make image-local` | `openclaw-csgclaw:local` |
| ACR publish | `make image TAG=<tag>` | `<registry>/opencsghq/openclaw:<tag>` |
| Base only | `make base-image` | Pre-baked runtime base (Node + Python + CA certs) |

## CI/CD

The project uses a **dual-CI** setup:

| Platform | Trigger | Purpose |
|---|---|---|
| GitHub Actions | Pull requests | TypeScript build check |
| GitLab CI | `main` branch push | Multi-arch Docker build → push to ACR |

### Repository Sync

```
GitHub (source of truth)
  git@github.com:OpenCSGs/openclaw-csgclaw-extension.git
       │
       │  GitLab Pull Mirror (Settings → Repository → Mirroring)
       ▼
GitLab (CI runner)
       │
       │  .gitlab/ci.yml (main branch triggered)
       ▼
ACR (Alibaba Cloud Container Registry)
  opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw:YYYYMMDD.N-csgclaw
```

### Triggering CI Builds

GitLab CI automatically triggers when the `main` branch is updated via mirror sync. The default sync interval is **30 minutes**.

**To manually trigger an immediate sync and CI build:**

1. Go to GitLab **Settings → Repository → Mirroring repositories**
2. Find the mirror entry for this repository
3. Click the **refresh button** (🔄) next to the mirror entry
4. Wait a few seconds, then check **CI/CD → Pipelines** for the build status

Direct link: https://git-devops.opencsg.com/product/agentichub/openclaw-csgclaw-extension/-/settings/repository#js-push-remote-settings

**Image tag format:** `YYYYMMDD.{CI_PIPELINE_IID}-csgclaw`
- `CI_PIPELINE_IID` is a GitLab project-level monotonic ID
- Multiple pushes on the same day get unique tags: `20260609.1-csgclaw`, `20260609.2-csgclaw`, etc.

## Development

### Build Plugin Only

```bash
pnpm install --frozen-lockfile
pnpm run build    # → dist/
```

### Build Everything (Plugin + Image)

```bash
# 1. Build plugin
pnpm install --frozen-lockfile
pnpm run build

# 2. Build local image
make image-local
```

### Version Bump

1. Update `version` in `package.json`
2. Update `CSGCLAW_EXTENSION_VERSION` in `Makefile` and `docker/Dockerfile`
3. Update `OPENCLAW_BASE_VERSION` if the upstream OpenClaw version changed
4. Commit and push to `main`
5. GitLab mirror sync triggers CI build automatically (or manually trigger sync)

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) — AI coding agent gateway
- [CSGClaw](https://github.com/OpenCSGs/csgclaw) — Multi-agent orchestration server
- [PicoClaw](https://github.com/OpenCSGs/picoclaw) — Lightweight agent runtime

## License

See [LICENSE](LICENSE) for details.
