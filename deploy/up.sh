#!/usr/bin/env bash
# Bring the world up: one replica, ingress on. Use before a session.
set -euo pipefail
cd "$(dirname "$0")/.."; source deploy/_common.sh
az containerapp ingress enable -g "$RG" -n "$APP" --type external --target-port 8080 --transport auto -o none
az containerapp update -g "$RG" -n "$APP" --min-replicas 1 --max-replicas 1 -o none
echo "up: https://$(app_fqdn)"
