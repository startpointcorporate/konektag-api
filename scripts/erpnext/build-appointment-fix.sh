#!/usr/bin/env bash
# Prepare immutable patched image. NO Helm upgrade, DB migration or restart.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE=docker.io/konektag/erpnext:v16.53.0-custom
TAG=docker.io/konektag/erpnext:v16.53.0-custom-appointment-fix-20261105
ENGINE="${CONTAINER_BUILD_ENGINE:-docker}"
command -v "$ENGINE" >/dev/null || { echo "Missing build engine: $ENGINE" >&2; exit 2; }
"$ENGINE" image inspect "$BASE" >/dev/null || {
  echo "Base image not present in $ENGINE on this build host: $BASE" >&2
  echo "Use the original image build node / import the SAME image ID; never substitute a public ERPNext image." >&2
  exit 2
}
"$ENGINE" build --pull=false --no-cache -f scripts/erpnext/Dockerfile.appointment-fix -t "$TAG" .
"$ENGINE" run --rm --entrypoint /bin/sh "$TAG" -c '
  test -d /home/frappe/frappe-bench/apps/hospitality_core &&
  test -d /home/frappe/frappe-bench/apps/lumen_restaurants &&
  test -d /home/frappe/frappe-bench/apps/crm &&
  grep -q "def reassign_if_agent_busy" /home/frappe/frappe-bench/apps/erpnext/erpnext/crm/doctype/appointment/appointment.py &&
  grep -q "def get_free_agent" /home/frappe/frappe-bench/apps/erpnext/erpnext/crm/doctype/appointment/appointment.py &&
  echo IMAGE_CHECK_OK
'
echo "BUILT_AND_CHECKED $TAG"
echo "NOT DEPLOYED: validate image, backups, cluster import and the Helm source first."
