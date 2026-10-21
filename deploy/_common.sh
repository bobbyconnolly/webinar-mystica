# Shared names for the Azure scripts. Source this; do not run it.
# Everything lives in one resource group so destroy.sh can remove it all.
RG="mystica"
LOCATION="canadacentral"
ENV_NAME="mystica-env"
APP="mystica"
STORAGE_NAME="world"          # the environment storage definition and the file share
SEED="${SEED:-7}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need az

# The registry and storage account get random suffixes (globally unique names); find them by group.
acr_name() { az acr list -g "$RG" --query "[0].name" -o tsv 2>/dev/null; }
storage_account() { az storage account list -g "$RG" --query "[0].name" -o tsv 2>/dev/null; }
app_fqdn() { az containerapp show -g "$RG" -n "$APP" --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null; }
rand_hex() { od -An -N4 -tx1 /dev/urandom | tr -d ' \n'; }
