# ACR image: <registry>/<namespace>/openclaw:<yyyymmdd>.<n>-csgclaw
REGISTRY ?= opencsg-registry.cn-beijing.cr.aliyuncs.com
IMAGE_REPO ?= opencsghq/openclaw
# Bump date segment or .<n> when publishing (release counter per day).
TAG ?= 20260715.1-csgclaw-beta
# Optional additional tags for environment aliases or staged promotion.
# Example: make image EXTRA_TAGS="dev-csgclaw stg-csgclaw"
EXTRA_TAGS ?=
# Tags to move to an already-pushed immutable image tag.
# Example: make promote-image PROMOTE_TAGS="dev-csgclaw stg-csgclaw"
PROMOTE_TAGS ?=

IMAGE_TAGS := $(TAG) $(EXTRA_TAGS)
IMAGE_TAG_ARGS := $(foreach tag,$(IMAGE_TAGS),-t $(REGISTRY)/$(IMAGE_REPO):$(tag))

# Default platform list when invoking `make image` (multi-arch publish).
PLATFORMS ?= linux/amd64,linux/arm64

# Local builder loads the image into the local docker daemon, so it must build
# a single platform. Override with PLATFORM=linux/amd64 if you cross-build.
PLATFORM ?= $(shell uname -m | sed -e 's/arm64/linux\/arm64/' -e 's/aarch64/linux\/arm64/' -e 's/x86_64/linux\/amd64/' -e 's/amd64/linux\/amd64/')

PNPM ?= pnpm
NPM ?= npm
NODE ?= node
DOCKER ?= docker
DEV_SYNC_TIMEOUT ?= 30
DEPS_FINGERPRINT_FILE ?= node_modules/.csgclaw-deps-fingerprint
DEPS_FINGERPRINT_CMD = node -e 'const crypto=require("node:crypto");const fs=require("node:fs");const hash=crypto.createHash("sha256");for(const path of ["package.json","pnpm-lock.yaml"]){hash.update(path);hash.update("\0");hash.update(fs.readFileSync(path));hash.update("\0");}process.stdout.write(hash.digest("hex"));'
OPENCLAW_BASE_VERSION ?= 2026.5.26
OPENCLAW_UPSTREAM_IMAGE ?= ghcr.io/openclaw/openclaw:$(OPENCLAW_BASE_VERSION)-slim
OPENCLAW_FEISHU_VERSION ?= $(OPENCLAW_BASE_VERSION)
BASE_IMAGE_REPO ?= opencsghq/openclaw-csgclaw-base
BASE_TAG ?= $(OPENCLAW_BASE_VERSION)-node24-pnpm10-py3
OPENCLAW_BASE_IMAGE ?= $(REGISTRY)/$(BASE_IMAGE_REPO):$(BASE_TAG)

# Support `make build <agent-name>` as a build followed by a local dev sync.
# A plain `make build` remains build-only. The extra goal is declared below so
# make does not try to find a file or rule with the agent's name.
BUILD_SYNC_AGENT :=
ifeq ($(firstword $(MAKECMDGOALS)),build)
ifneq ($(words $(MAKECMDGOALS)),1)
ifneq ($(words $(MAKECMDGOALS)),2)
$(error Usage: make build [agent-name-or-id])
endif
BUILD_SYNC_AGENT := $(word 2,$(MAKECMDGOALS))
.PHONY: $(BUILD_SYNC_AGENT)
$(BUILD_SYNC_AGENT): build
	@:
endif
endif

# Install only when the declared dependencies or current pnpm install state changed.
.PHONY: ensure-deps
ensure-deps:
	@expected="$$( $(DEPS_FINGERPRINT_CMD))" || exit $$?; \
	actual="$$(sed -n '1p' "$(DEPS_FINGERPRINT_FILE)" 2>/dev/null || true)"; \
	if [ "$$expected" != "$$actual" ] || \
	   [ ! -f node_modules/.pnpm/lock.yaml ] || \
	   [ ! -x node_modules/.bin/tsc ] || \
	   ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then \
		echo "Dependencies changed or missing; running $(PNPM) install --frozen-lockfile"; \
		if ! $(PNPM) install --frozen-lockfile; then exit 1; fi; \
		mkdir -p node_modules; \
		printf '%s\n' "$$expected" > "$(DEPS_FINGERPRINT_FILE)"; \
	else \
		echo "Dependencies are up to date; skipping $(PNPM) install"; \
	fi

.PHONY: build
build: ensure-deps
	@echo "Building openclaw-csgclaw-extension..."
	@if ! $(PNPM) run build; then \
		echo "Build failed"; \
		exit 1; \
	fi
	@if [ ! -f dist/index.js ]; then \
		echo "Build failed: dist/index.js was not generated"; \
		exit 1; \
	fi
	@echo "Build succeeded: dist/index.js"
	@if [ -n "$(BUILD_SYNC_AGENT)" ]; then \
		DOCKER="$(DOCKER)" NPM="$(NPM)" NODE="$(NODE)" DEV_SYNC_TIMEOUT="$(DEV_SYNC_TIMEOUT)" \
			sh docker/dev-sync.sh "$(BUILD_SYNC_AGENT)" ""; \
	fi
# Build the plugin dist/ on the host for local npm publish/dev and images.
.PHONY: prepare-dist
prepare-dist: build

BUILDX_BUILDER ?= csgclaw-builder

.PHONY: base-image
base-image:
	docker buildx build \
	  --builder $(BUILDX_BUILDER) \
	  --platform $(PLATFORMS) \
	  --build-arg OPENCLAW_UPSTREAM_IMAGE=$(OPENCLAW_UPSTREAM_IMAGE) \
	  -t $(OPENCLAW_BASE_IMAGE) \
	  --push \
	  -f docker/Dockerfile.base .

.PHONY: base-image-local
base-image-local:
	docker buildx build \
	  --platform $(PLATFORM) \
	  --build-arg OPENCLAW_UPSTREAM_IMAGE=$(OPENCLAW_UPSTREAM_IMAGE) \
	  -t openclaw-csgclaw-base:local \
	  --load \
	  -f docker/Dockerfile.base .

.PHONY: image
image: prepare-dist
	docker buildx build \
	  --builder $(BUILDX_BUILDER) \
	  --platform $(PLATFORMS) \
	  --build-arg OPENCLAW_BASE_IMAGE=$(OPENCLAW_BASE_IMAGE) \
	  --build-arg OPENCLAW_FEISHU_VERSION=$(OPENCLAW_FEISHU_VERSION) \
	  $(IMAGE_TAG_ARGS) \
	  --push \
	  -f docker/Dockerfile .

.PHONY: image-local
image-local: prepare-dist
	docker buildx build \
	  --platform $(PLATFORM) \
	  --build-arg OPENCLAW_BASE_IMAGE=$(OPENCLAW_BASE_IMAGE) \
	  --build-arg OPENCLAW_FEISHU_VERSION=$(OPENCLAW_FEISHU_VERSION) \
	  -t openclaw-csgclaw:local \
	  --load \
	  -f docker/Dockerfile .

.PHONY: image-tags
image-tags:
	@printf '%s\n' $(foreach tag,$(IMAGE_TAGS),$(REGISTRY)/$(IMAGE_REPO):$(tag))

.PHONY: base-image-tags
base-image-tags:
	@printf '%s\n' $(OPENCLAW_BASE_IMAGE)

.PHONY: promote-image
promote-image:
	@if [ -z "$(strip $(PROMOTE_TAGS))" ]; then \
	  echo "PROMOTE_TAGS is required, e.g. make promote-image PROMOTE_TAGS=\"dev-csgclaw stg-csgclaw\""; exit 1; \
	fi
	docker buildx imagetools create \
	  $(foreach tag,$(PROMOTE_TAGS),-t $(REGISTRY)/$(IMAGE_REPO):$(tag)) \
	  $(REGISTRY)/$(IMAGE_REPO):$(TAG)
