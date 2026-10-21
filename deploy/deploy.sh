#!/usr/bin/env bash
# Create or update the Mystica server on Azure Container Apps.
#   bash deploy/deploy.sh
# Idempotent: the first run creates the resource group, registry, environment, storage and app;
# later runs just build a new image and roll the app. Builds happen in Azure (az acr build), so no
# local Docker. The world database lives on an Azure Files share mounted at /data.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/_common.sh

# Nothing ships that does not parse or whose simulation test crashes (2026-10-18: a one-line edit left
# main.js unparseable and the deploy ran anyway; the game would not load for seven minutes).
for f in server/*.js prototype/*.js; do node --check "$f" || { echo "refusing to deploy: $f does not parse" >&2; exit 1; }; done
node server/test-fight.js > /dev/null || { echo "refusing to deploy: server/test-fight.js failed" >&2; exit 1; }

TAG="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%s)" # unique per deploy: an uncommitted tree must still roll a new revision
echo "== resource group $RG ($LOCATION)"
az group show -n "$RG" -o none 2>/dev/null || az group create -n "$RG" -l "$LOCATION" -o none

echo "== container registry"
ACR="$(acr_name)"
if [ -z "$ACR" ]; then ACR="mysticaacr$(rand_hex)"; az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -o none; fi
az acr build -r "$ACR" -t "mystica:$TAG" -f Dockerfile . -o none
IMAGE="$ACR.azurecr.io/mystica:$TAG"
ACR_USER="$(az acr credential show -n "$ACR" --query username -o tsv)"
ACR_PASS="$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)"

echo "== container apps environment"
az containerapp env show -g "$RG" -n "$ENV_NAME" -o none 2>/dev/null || \
  az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOCATION" --logs-destination none -o none
# Logs that survive a restart (2026-10-18): a Log Analytics workspace as the environment's destination. The
# first 5 GB a month are free and this is kilobytes a day. Read them with deploy/logs.sh. Not fatal if it fails.
LOGS_NAME="${LOGS_NAME:-mystica-logs}"
if [ "$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query 'properties.appLogsConfiguration.destination' -o tsv 2>/dev/null)" != "log-analytics" ]; then
  if ! (
    az monitor log-analytics workspace create -g "$RG" -n "$LOGS_NAME" -l "$LOCATION" --retention-time 30 -o none &&
    LOGS_ID="$(az monitor log-analytics workspace show -g "$RG" -n "$LOGS_NAME" --query customerId -o tsv)" &&
    LOGS_KEY="$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LOGS_NAME" --query primarySharedKey -o tsv)" &&
    az containerapp env update -g "$RG" -n "$ENV_NAME" --logs-destination log-analytics --logs-workspace-id "$LOGS_ID" --logs-workspace-key "$LOGS_KEY" -o none
  ); then echo "   (logs: could not point the environment at Log Analytics; the console log still streams, nothing is kept)" >&2; else echo "   logs: kept in Log Analytics workspace $LOGS_NAME"; fi
fi

echo "== storage for the world database"
SA="$(storage_account)"
if [ -z "$SA" ]; then
  SA="mystica$(rand_hex)"
  az storage account create -g "$RG" -n "$SA" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 -o none
fi
SA_KEY="$(az storage account keys list -g "$RG" -n "$SA" --query '[0].value' -o tsv)"
az storage share-rm show -g "$RG" --storage-account "$SA" -n "$STORAGE_NAME" -o none 2>/dev/null || \
  az storage share-rm create -g "$RG" --storage-account "$SA" -n "$STORAGE_NAME" --quota 1 -o none
az containerapp env storage set -g "$RG" -n "$ENV_NAME" --storage-name "$STORAGE_NAME" \
  --azure-file-account-name "$SA" --azure-file-account-key "$SA_KEY" --azure-file-share-name "$STORAGE_NAME" --access-mode ReadWrite -o none

echo "== admin token"
# The server's ADMIN_TOKEN (reset, the shared sliders). Kept in deploy/admin.token (git-ignored) so every
# deploy reuses it; delete the file to rotate. Use it as ?admin=<token> on the game URL.
TOKEN_FILE="deploy/admin.token"
if [ ! -s "$TOKEN_FILE" ]; then rand_hex > "$TOKEN_FILE"; rand_hex >> "$TOKEN_FILE"; tr -d '\n' < "$TOKEN_FILE" > "$TOKEN_FILE.tmp" && mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"; echo "   new token written to $TOKEN_FILE"; fi
ADMIN_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"

echo "== app"
ENV_ID="$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query id -o tsv)"
YAML="$(mktemp)"
sed -e "s|@LOCATION@|$LOCATION|g" -e "s|@ENV_ID@|$ENV_ID|g" -e "s|@IMAGE@|$IMAGE|g" \
    -e "s|@ACR@|$ACR|g" -e "s|@ACR_USER@|$ACR_USER|g" -e "s|@ACR_PASS@|$ACR_PASS|g" \
    -e "s|@STORAGE_NAME@|$STORAGE_NAME|g" -e "s|@SEED@|$SEED|g" -e "s|@ADMIN_TOKEN@|$ADMIN_TOKEN|g" -e "s|@EVENT@|${EVENT:-0}|g" deploy/app.yaml.tmpl > "$YAML"
echo "   event mode: ${EVENT:-0}   (EVENT=1 bash deploy/deploy.sh: given names, read-only boards; plain deploy.sh turns it off)"
if az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az containerapp update -g "$RG" -n "$APP" --yaml "$YAML" -o none
else
  az containerapp create -g "$RG" -n "$APP" --yaml "$YAML" -o none
fi
rm -f "$YAML"

FQDN="$(app_fqdn)"
echo "== deployed $IMAGE"
echo "   https://$FQDN"
echo "   admin:  https://$FQDN/?admin=$ADMIN_TOKEN   (keep this one to yourself)"
for i in $(seq 1 30); do
  if curl -fsS "https://$FQDN/healthz" >/dev/null 2>&1; then echo "   healthy: $(curl -fsS "https://$FQDN/healthz")"; exit 0; fi
  sleep 5
done
echo "   not healthy yet; check: az containerapp logs show -g $RG -n $APP --follow" >&2
exit 1
