#!/usr/bin/env bash
# Scale the world to zero and switch ingress off. The database on the share keeps everything.
# The server flushes on SIGTERM, so nothing is lost beyond the last few seconds of play.
set -euo pipefail
cd "$(dirname "$0")/.."; source deploy/_common.sh
az containerapp update -g "$RG" -n "$APP" --min-replicas 0 --max-replicas 1 -o none
az containerapp ingress disable -g "$RG" -n "$APP" -o none
echo "down: compute is now free; the world is on the file share"
