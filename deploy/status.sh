#!/usr/bin/env bash
# What exists, whether it is up, and whether it answers.
set -uo pipefail
cd "$(dirname "$0")/.."; source deploy/_common.sh
az resource list -g "$RG" --query "[].{name:name, type:type}" -o table 2>/dev/null || { echo "no resource group $RG"; exit 0; }
echo
az containerapp show -g "$RG" -n "$APP" --query "{fqdn:properties.configuration.ingress.fqdn, minReplicas:properties.template.scale.minReplicas, image:properties.template.containers[0].image, status:properties.runningStatus}" -o table 2>/dev/null
echo
az containerapp replica list -g "$RG" -n "$APP" --query "[].{replica:name, state:properties.runningState}" -o table 2>/dev/null
FQDN="$(app_fqdn)"
[ -n "$FQDN" ] && { echo; echo "health: $(curl -fsS --max-time 10 "https://$FQDN/healthz" 2>/dev/null || echo 'no answer')"; }
