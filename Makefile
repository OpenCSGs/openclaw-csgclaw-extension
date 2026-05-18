# ACR image: <registry>/<namespace>/openclaw:<yyyymmdd>.<n>-csgclaw
# OPENCLAW_BASE_VERSION in Dockerfile selects the upstream ghcr.io/openclaw/openclaw slim base.
REGISTRY ?= opencsg-registry.cn-beijing.cr.aliyuncs.com
IMAGE_REPO ?= opencsghq/openclaw
# Bump date segment or .<n> when publishing (release counter per day).
TAG ?= 20260518.1-csgclaw
# Optional additional tags for environment aliases or staged promotion.
# Example: make image EXTRA_TAGS="dev-csgclaw stg-csgclaw"
EXTRA_TAGS ?=
# Tags to move to an already-pushed immutable image tag.
# Example: make promote-image PROMOTE_TAGS="dev-csgclaw stg-csgclaw"
PROMOTE_TAGS ?=

IMAGE_TAGS := $(TAG) $(EXTRA_TAGS)
IMAGE_TAG_ARGS := $(foreach tag,$(IMAGE_TAGS),-t $(REGISTRY)/$(IMAGE_REPO):$(tag))

# Path to the sibling csgclaw repo (provides cmd/csgclaw-cli sources).
CSGCLAW_DIR ?= ../csgclaw

# Default platform list when invoking `make image` (multi-arch publish).
PLATFORMS ?= linux/amd64,linux/arm64

# Local builder loads the image into the local docker daemon, so it must build
# a single platform. Override with PLATFORM=linux/amd64 if you cross-build.
PLATFORM ?= $(shell uname -m | sed -e 's/arm64/linux\/arm64/' -e 's/aarch64/linux\/arm64/' -e 's/x86_64/linux\/amd64/' -e 's/amd64/linux\/amd64/')

CSGCLAW_CLI_DIR := docker/csgclaw-cli

.PHONY: prepare-csgclaw-cli
prepare-csgclaw-cli:
	@mkdir -p $(CSGCLAW_CLI_DIR)
	@if [ ! -d "$(CSGCLAW_DIR)" ]; then \
	  echo "csgclaw repo not found at $(CSGCLAW_DIR); set CSGCLAW_DIR=/abs/path"; exit 1; \
	fi
	$(MAKE) -C $(CSGCLAW_DIR) build-csgclaw-cli TARGET_OS=linux TARGET_ARCH=amd64
	cp $(CSGCLAW_DIR)/bin/csgclaw-cli $(CSGCLAW_CLI_DIR)/csgclaw-cli_linux_amd64
	$(MAKE) -C $(CSGCLAW_DIR) build-csgclaw-cli TARGET_OS=linux TARGET_ARCH=arm64
	cp $(CSGCLAW_DIR)/bin/csgclaw-cli $(CSGCLAW_CLI_DIR)/csgclaw-cli_linux_arm64

# Build the plugin's dist/ on the host so the Docker build can COPY it
# directly. dist is arch-independent (transpiled JS), so a single build
# suffices for all platforms in PLATFORMS.
.PHONY: prepare-dist
prepare-dist:
	@if [ ! -d node_modules ]; then \
	  pnpm install --frozen-lockfile; \
	fi
	pnpm run build

BUILDX_BUILDER ?= csgclaw-builder

.PHONY: image
image: prepare-csgclaw-cli prepare-dist
	docker buildx build \
	  --builder $(BUILDX_BUILDER) \
	  --platform $(PLATFORMS) \
	  $(IMAGE_TAG_ARGS) \
	  --push .

.PHONY: image-local
image-local: prepare-csgclaw-cli prepare-dist
	docker buildx build \
	  --platform $(PLATFORM) \
	  -t openclaw-csgclaw:local \
	  --load .

.PHONY: image-tags
image-tags:
	@printf '%s\n' $(foreach tag,$(IMAGE_TAGS),$(REGISTRY)/$(IMAGE_REPO):$(tag))

.PHONY: promote-image
promote-image:
	@if [ -z "$(strip $(PROMOTE_TAGS))" ]; then \
	  echo "PROMOTE_TAGS is required, e.g. make promote-image PROMOTE_TAGS=\"dev-csgclaw stg-csgclaw\""; exit 1; \
	fi
	docker buildx imagetools create \
	  $(foreach tag,$(PROMOTE_TAGS),-t $(REGISTRY)/$(IMAGE_REPO):$(tag)) \
	  $(REGISTRY)/$(IMAGE_REPO):$(TAG)
