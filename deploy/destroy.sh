#!/usr/bin/env bash
# Delete the whole resource group: app, environment, registry, storage and the world database with it.
set -euo pipefail
cd "$(dirname "$0")/.."; source deploy/_common.sh
echo "This deletes resource group '$RG' and the world database in it."
read -r -p "Type the group name to confirm: " ANSWER
[ "$ANSWER" = "$RG" ] || { echo "not confirmed"; exit 1; }
az group delete -n "$RG" --yes
