#!/usr/bin/env bash
# The server's console log from the Log Analytics workspace: what survives a restart, oldest first.
#   bash deploy/logs.sh [hours=6] [lines=400]
# Times are UTC. Rows reach the workspace a minute or two after they are written.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/_common.sh
HOURS="${1:-6}"; LINES="${2:-400}"
WS="$(az monitor log-analytics workspace show -g "$RG" -n "${LOGS_NAME:-mystica-logs}" --query customerId -o tsv)"
az monitor log-analytics query -w "$WS" -o tsv --analytics-query "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '$APP' and TimeGenerated > ago(${HOURS}h) | project TimeGenerated, Log_s | order by TimeGenerated asc | take $LINES"
