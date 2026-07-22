#!/bin/sh

set -eu

agent_ref=${1:-}
container=${2:-}
docker_bin=${DOCKER:-docker}
npm_bin=${NPM:-npm}
node_bin=${NODE:-node}
timeout=${DEV_SYNC_TIMEOUT:-30}
plugin_dir=/home/node/openclaw-plugins/csgclaw-extension
state_file=${CSGCLAW_STATE_FILE:-}

if [ -z "$state_file" ]; then
  state_file=$HOME/.csgclaw/state.json
fi

if [ -z "$container" ]; then
  if [ -z "$agent_ref" ]; then
    echo "An agent name or ID is required." >&2
    echo "Usage: make build dev-o-3" >&2
    exit 2
  fi

  if [ -f "$state_file" ]; then
    agent_id=$(
      "$node_bin" - "$state_file" "$agent_ref" <<'NODE'
const fs = require("node:fs");

const [stateFile, agentRef] = process.argv.slice(2);
let state;
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch (error) {
  console.error(`Unable to read CSGClaw state ${stateFile}: ${error.message}`);
  process.exit(1);
}

const agents = state?.agents?.items;
if (!Array.isArray(agents)) {
  console.error(`CSGClaw state ${stateFile} does not contain agents.items.`);
  process.exit(1);
}

const idMatches = agents.filter((agent) => agent?.id === agentRef);
if (idMatches.length === 1) {
  process.stdout.write(agentRef);
  process.exit(0);
}

const nameMatches = agents.filter((agent) => agent?.name === agentRef);
if (nameMatches.length === 0) {
  console.error(`CSGClaw agent ${JSON.stringify(agentRef)} was not found in ${stateFile}.`);
  process.exit(1);
}
if (nameMatches.length > 1) {
  console.error(`CSGClaw agent name ${JSON.stringify(agentRef)} matched multiple agents in ${stateFile}; use an agent ID.`);
  process.exit(1);
}

const agentID = nameMatches[0]?.id;
if (typeof agentID !== "string" || agentID.length === 0) {
  console.error(`CSGClaw agent ${JSON.stringify(agentRef)} does not have an ID in ${stateFile}.`);
  process.exit(1);
}
process.stdout.write(agentID);
NODE
    )
  else
    case "$agent_ref" in
      agent-*|u-*) agent_id=$agent_ref ;;
      *)
        echo "CSGClaw state file $state_file was not found; cannot resolve agent name $agent_ref." >&2
        exit 1
        ;;
    esac
  fi

  if [ "$agent_ref" != "$agent_id" ]; then
    echo "Resolved CSGClaw agent $agent_ref -> $agent_id."
  fi
  container="csgclaw-$agent_id"
fi

if ! "$docker_bin" inspect "$container" >/dev/null 2>&1; then
  echo "Docker container $container was not found." >&2
  exit 1
fi

if [ "$("$docker_bin" inspect --format '{{.State.Running}}' "$container")" != "true" ]; then
  echo "Docker container $container is not running." >&2
  exit 1
fi

host_tmp=$(mktemp -d)
remote_package="/tmp/openclaw-csgclaw-extension-dev-$$.tgz"
remote_copied=false

cleanup() {
  rm -rf "$host_tmp"
  if [ "$remote_copied" = "true" ]; then
    "$docker_bin" exec --user 0 "$container" rm -f "$remote_package" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

echo "Packing local extension..."
"$npm_bin" pack --silent --ignore-scripts --pack-destination "$host_tmp" . >/dev/null
package=$(find "$host_tmp" -maxdepth 1 -type f -name '*.tgz' -print -quit)
if [ -z "$package" ]; then
  echo "npm pack did not produce an extension package." >&2
  exit 1
fi

echo "Copying extension into $container..."
"$docker_bin" cp "$package" "$container:$remote_package"
remote_copied=true

"$docker_bin" exec --user 0 \
  --env DEV_EXTENSION_PACKAGE="$remote_package" \
  --env DEV_EXTENSION_TARGET="$plugin_dir" \
  "$container" sh -ceu '
    work_dir=$(mktemp -d)
    trap '\''rm -rf "$work_dir" "$DEV_EXTENSION_PACKAGE"'\'' EXIT HUP INT TERM
    mkdir -p "$work_dir/package"
    tar -xzf "$DEV_EXTENSION_PACKAGE" -C "$work_dir/package" --strip-components=1
    test -f "$work_dir/package/package.json"
    test -f "$work_dir/package/openclaw.plugin.json"
    test -f "$work_dir/package/dist/index.js"
    mkdir -p "$DEV_EXTENSION_TARGET"
    find "$DEV_EXTENSION_TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    cp -R "$work_dir/package/." "$DEV_EXTENSION_TARGET/"
    mkdir -p "$DEV_EXTENSION_TARGET/node_modules"
    ln -sfn /app "$DEV_EXTENSION_TARGET/node_modules/openclaw"
    chown -R 0:0 "$DEV_EXTENSION_TARGET"
  '
remote_copied=false

echo "Restarting $container..."
"$docker_bin" restart "$container" >/dev/null

attempt=0
while [ "$attempt" -lt "$timeout" ]; do
  if "$docker_bin" exec "$container" node -e "fetch('http://127.0.0.1:18789/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "Extension synced and $container is ready."
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Extension was copied, but $container did not become ready within ${timeout}s." >&2
exit 1
