#!/usr/bin/env bash
# Build, pack and reinstall signalk-livedepth-plugin into a local Signal K
# container, then restart it, so a change can be tested immediately.
#
# Dev-only helper; not shipped (the package `files` whitelist excludes
# dev-tools). Defaults suit a rootful podman container named `signalk` whose
# Signal K config lives at /home/node/.signalk.

set -euo pipefail

CONTAINER="${SIGNALK_CONTAINER:-signalk}"
CONFIG_DIR="${SIGNALK_CONFIG_DIR:-/home/node/.signalk}"
UNIT="${SIGNALK_UNIT:-signalk.service}"

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_DIR"

echo "== build + pack =="
TGZ=$(npm pack --silent 2>&1 | tail -1)
echo "   $TGZ"

echo "== install into $CONTAINER =="
sudo podman cp "$TGZ" "$CONTAINER:/tmp/"
sudo podman exec "$CONTAINER" sh -c \
  "cd $CONFIG_DIR && npm install --no-audit --no-fund /tmp/$TGZ 2>&1 | tail -2"

echo "== restart $UNIT =="
sudo systemctl restart "$UNIT"
sleep 10

echo "== installed build hash (to confirm it landed) =="
sudo podman exec "$CONTAINER" sh -c \
  "md5sum $CONFIG_DIR/node_modules/signalk-livedepth-plugin/public/js/renderer.js 2>/dev/null | cut -c1-12"
echo done
