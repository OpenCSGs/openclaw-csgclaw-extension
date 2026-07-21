# openclaw-csgclaw-extension

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that connects OpenClaw agents to [CSGClaw](https://github.com/OpenCSGs/csgclaw).

The plugin receives messages through CSGClaw's participant SSE API and sends agent replies through its REST API.

## Features

- Direct messages and group rooms
- Group mention filtering
- Topic and thread context
- Optional Feishu event forwarding
- Prebuilt multi-architecture Docker image

## Quick Start

Requirements:

- Node.js 24.14 or later
- pnpm 10 or later
- A running CSGClaw server

Install the published plugin into an OpenClaw home:

```bash
openclaw plugins install npm:openclaw-csgclaw-extension
```

After a new npm release, update the installed plugin without rebuilding the
OpenClaw image:

```bash
openclaw plugins update csgclaw
```

If an older CSGClaw image loads `/home/node/openclaw-plugins` explicitly, remove
that broad CSGClaw load path before installing the npm package; explicit load
paths take precedence over managed npm installs. Keep the Feishu plugin path as
`/home/node/openclaw-plugins/feishu` when it is still needed.

Install dependencies and build the plugin:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

The compiled plugin is written to `dist/`.

## Configuration

Add the channel and plugin to your OpenClaw configuration:

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
    "load": {
      "paths": ["./path-to/csgclaw-extension"]
    },
    "entries": {
      "csgclaw": {
        "enabled": true
      }
    }
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `baseUrl` | Yes | CSGClaw server URL |
| `participantId` | Yes | Bot participant ID; `botId` is also accepted |
| `accessToken` | No | Bearer token used for API authentication |
| `enabled` | No | Enables the channel; defaults to `true` |

The same values can be provided through `CSGCLAW_BASE_URL`, `CSGCLAW_PARTICIPANT_ID` (or `CSGCLAW_BOT_ID`), and `CSGCLAW_ACCESS_TOKEN`.

### Group Messages

The bot responds in group rooms only when mentioned by default. Per-room behavior can be changed with `groups`:

```json
{
  "channels": {
    "csgclaw": {
      "groups": {
        "room-abc": {
          "requireMention": false
        },
        "*": {
          "requireMention": true
        }
      }
    }
  }
}
```

## Development

```bash
pnpm run build
pnpm test
```

Build and load a local single-architecture Docker image:

```bash
make image-local
```

For production image targets and release details, see [docker/README.md](docker/README.md).

The plugin version is maintained only in `package.json`. Docker builds copy that
file into the image, so no separate build variable needs to be synchronized.

## License

This project uses the same modified Apache License 2.0 as CSGClaw. See [LICENSE](LICENSE) for details.
