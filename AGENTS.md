# CSGClaw Extension — Agent Guide

本文件面向后续维护该项目的 Agent，提供关键信息和操作指南。

## 项目定位

`csgclaw-extension` 是 OpenClaw 的 channel 插件，负责将 CSGClaw IM 消息桥接到 OpenClaw gateway。

**核心职责**：
- 消费 CSGClaw 的 SSE participant events（ inbound 消息）
- 通过 REST API 发送回复到 CSGClaw（outbound 消息）
- 构建 Docker 镜像供 CSGClaw sandbox 使用

**技术栈**：TypeScript + Node.js 24 + pnpm 10

---

## 目录结构

```
csgclaw-extension/
├── index.ts                 # 插件入口：defineChannelPluginEntry
├── setup-entry.ts           # OpenClaw CLI wizard 的 setup entry
├── openclaw.plugin.json     # 插件 manifest（id, kind, channels）
├── package.json             # npm 包定义，version 需与 Dockerfile 同步
├── src/
│   ├── channel.ts           # Channel 插件定义（capabilities, routing, outbound）
│   ├── config.ts            # Account 解析、API URL 构建
│   ├── monitor.ts           # SSE 事件消费 + inbound dispatch + outbound send
│   └── sse.ts               # 基于 fetch() 的 SSE stream reader
├── docker/
│   ├── README.md            # Docker 文件说明
│   ├── Dockerfile           # 生产镜像（从 npm 拉取 extension）
│   ├── Dockerfile.base      # 基础镜像（OpenClaw 运行环境）
│   └── Dockerfile.ci        # CI 专用镜像（使用本地 dist，无需 npm 发布）
├── .gitlab/ci.yml           # GitLab CI 配置（main 分支触发）
├── .github/workflows/       # GitHub Actions（PR 检查）
└── Makefile                 # 构建命令
```

---

## 关键命令

### 开发

```bash
pnpm install --frozen-lockfile   # 安装依赖
pnpm run build                   # 构建到 dist/
pnpm run dev                     # 开发模式（如有）
```

### Docker 镜像

```bash
# 本地构建（单平台，加载到本地 Docker）
make image-local

# 发布到 ACR（多平台：amd64 + arm64）
make image

# 构建基础镜像（更新频率低，仅在基础依赖升级时）
make base-image
make base-image-local
```

### 版本同步

修改 `package.json` 的 `version` 后，必须同步更新：
- `Makefile` 中的 `CSGCLAW_EXTENSION_VERSION`
- `docker/Dockerfile` 中的 `CSGCLAW_EXTENSION_VERSION`

---

## CI/CD 流程

### GitLab CI（生产构建）

**触发条件**：`main` 分支 push

**版本标签格式**：`YYYYMMDD.{CI_PIPELINE_IID}-csgclaw`
- `CI_PIPELINE_IID` 是 GitLab 项目级自增 ID
- 同一天多次推送会生成：`20260609.1-csgclaw`、`20260609.2-csgclaw`...
- 天然不重复

**构建流程**：
1. `pnpm install && pnpm build` → 生成 `dist/`
2. `git clone csgclaw && make build` → 生成 `csgclaw-cli` (amd64 + arm64)
3. `docker buildx build -f docker/Dockerfile.ci` → 多架构镜像
4. 推送到 ACR：`opencsg-registry.cn-beijing.cr.aliyuncs.com/opencsghq/openclaw`
5. 验证镜像在两个平台运行正常

**所需 CI/CD Variables**（在 GitLab Settings → CI/CD → Variables 配置）：
- `ACR_REGISTRY` — `opencsg-registry.cn-beijing.cr.aliyuncs.com`
- `ACR_USERNAME` — 阿里云容器镜像服务用户名
- `ACR_PASSWORD` — 阿里云容器镜像服务密码

### GitHub Actions（PR 检查）

**触发条件**：PR 创建/更新

**检查内容**：TypeScript 编译、lint

---

## 镜像链路

```
GitHub push (main)
  ↓
GitLab 镜像同步（Pull，通过 ghfast.top 代理）
  ↓
GitLab CI 自动触发
  ↓
构建多架构 Docker 镜像
  ↓
推送到 ACR
  ↓
CSGClaw 使用镜像作为 manager/worker agent runtime
```

**关键依赖**：
- `csgclaw` 仓库：提供 `csgclaw-cli` 二进制文件
- `openclaw-csgclaw-base` 基础镜像：提供 OpenClaw 运行环境

---

## 发布流程

### 发布 npm 包（可选，用于非 Docker 场景）

```bash
pnpm run build
npm publish  # 需要 npm token
```

### 发布 Docker 镜像（主要发布方式）

1. 确保 `package.json` 版本号已更新
2. 同步更新 `Makefile` 和 `docker/Dockerfile` 中的 `CSGCLAW_EXTENSION_VERSION`
3. 提交并推送到 GitHub `main` 分支
4. GitLab 镜像同步后自动触发 CI 构建
5. 验证 ACR 上镜像已推送成功

---

## 注意事项

### 版本同步

以下三处的版本号必须保持一致：
1. `package.json` → `version`
2. `Makefile` → `CSGCLAW_EXTENSION_VERSION`
3. `docker/Dockerfile` → `ARG CSGCLAW_EXTENSION_VERSION`

### Docker 文件选择

- **生产发布**：使用 `docker/Dockerfile`（从 npm 拉取）
- **CI/CD**：使用 `docker/Dockerfile.ci`（使用本地 dist）
- **基础镜像更新**：使用 `docker/Dockerfile.base`

### 镜像标签

- 生产镜像：`YYYYMMDD.N-csgclaw`（如 `20260609.1-csgclaw`）
- 基础镜像：`YYYY.M.D-node24-pnpm10-py3`（如 `2026.5.26-node24-pnpm10-py3`）

### GitLab 镜像同步

- 使用 `ghfast.top` 代理访问 GitHub
- 必须勾选 **Trigger pipelines for mirror updates** 才能自动触发 CI
- 同步间隔默认 30 分钟，可手动刷新

### 插件所有权

Dockerfile 中使用 `--chown=root:root` 设置插件目录所有权，因为：
- CSGClaw sandbox 以 host uid 运行
- OpenClaw 插件发现机制拒绝非 root 且非当前 uid 的文件

---

## 常见问题

### Q: CI 构建失败，提示找不到 csgclaw-cli

A: CI 会自动 clone `csgclaw` 仓库并构建 CLI。如果失败，检查：
- GitHub 访问是否正常（CI  runner 需要能访问 github.com）
- `csgclaw` 仓库的 `Makefile` 是否有变更

### Q: 镜像推送成功但 CSGClaw 无法使用

A: 检查：
- ACR 镜像标签是否与 `csgclaw` 配置中的 `manager_image` 匹配
- 镜像是否包含 `csgclaw-cli`（`docker run --rm <image> csgclaw-cli --help`）

### Q: 如何本地测试镜像

A: 
```bash
make image-local
docker run --rm openclaw-csgclaw:local csgclaw-cli --help
docker run --rm openclaw-csgclaw:local node -e "fetch('http://127.0.0.1:18789/healthz')"
```

---

## 参考资源

- [OpenClaw 插件开发文档](https://github.com/openclaw/openclaw)
- [CSGClaw 主仓库](../csgclaw/)
- [Docker 文件说明](./docker/README.md)
