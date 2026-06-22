# Docker 构建文件说明

本目录包含 `csgclaw-extension` 相关的 Docker 构建文件。

## 文件清单

| 文件 | 用途 | 使用场景 |
|------|------|----------|
| `Dockerfile` | 生产镜像（从 npm 拉取 extension） | 正式发布，通过 `make image` 构建 |
| `Dockerfile.base` | 基础镜像（OpenClaw + 依赖环境） | 构建基础层，通过 `make base-image` 构建 |
| `Dockerfile.ci` | CI 专用镜像（使用本地 dist） | GitLab CI 自动构建，避免依赖 npm 发布 |

## 各文件详细说明

### Dockerfile（生产镜像）

从 npm registry 拉取 `csgclaw-extension` 包构建镜像。

**构建命令**：
```bash
make image          # 推送到 ACR
make image-local    # 本地加载
```

**特点**：
- 依赖 npm 上已发布的 extension 版本
- 适合正式发布流程
- 需要预先发布 npm 包

### Dockerfile.base（基础镜像）

构建 OpenClaw 基础运行环境，包含 Node.js、pnpm、Python 等依赖。

**构建命令**：
```bash
make base-image          # 推送到 ACR
make base-image-local    # 本地加载
```

**特点**：
- 作为其他 Dockerfile 的 base image
- 包含 OpenClaw 运行时依赖
- 更新频率低，仅在基础依赖升级时重建

### Dockerfile.ci（CI 专用镜像）

使用本地构建的 `dist/` 目录，不依赖 npm registry。

**使用场景**：
- GitLab CI 自动构建
- 本地开发测试（`docker build -f Dockerfile.ci .`）

**特点**：
- 从本地 `dist/` 拷贝 extension 代码
- 无需预先发布 npm 包
- 适合 CI/CD 流水线

## 目录结构

```
docker/
├── README.md              # 本说明文件
── Dockerfile             # 生产镜像（npm 拉取）
├── Dockerfile.base        # 基础镜像
└── Dockerfile.ci          # CI 专用镜像（本地 dist）
```

## 镜像标签格式

| 镜像 | 标签格式 | 示例 |
|------|----------|------|
| openclaw (生产) | `YYYYMMDD.N-csgclaw` | `20260609.1-csgclaw` |
| openclaw-csgclaw-base | `YYYY.M.D-node24-pnpm10-py3` | `2026.5.26-node24-pnpm10-py3` |

## CI/CD 触发

GitLab CI 配置在 `.gitlab/ci.yml`，触发条件：
- 分支：`main`
- 推送后自动构建
- 镜像推送到阿里云 ACR
