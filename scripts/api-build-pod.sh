#!/usr/bin/env bash
# Provision/clean only the versioned technical pod, never its existing PVC.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KONEKTAG_K3S_HOST:-konektag-core}"
K="sudo -n k3s kubectl -n konektag-api"
POD="konektag-api-setup"
MANIFEST="$ROOT/deploy/k3s/api-setup.json"
ACTION="${1:-}"
case "$ACTION" in ensure|cleanup) ;; *) echo 'Usage: api-build-pod.sh ensure|cleanup' >&2; exit 2;; esac
TEMP="$(mktemp -d)"
trap 'rm -f "$TEMP/pod.json" "$TEMP/deployment.json"; rmdir "$TEMP"' EXIT
ssh "$HOST" "$K get pod $POD --ignore-not-found -o json" > "$TEMP/pod.json"
if [ "$ACTION" = ensure ]; then
  ssh "$HOST" "$K get deployment konektag-api -o json" > "$TEMP/deployment.json"
  STATE="$(node "$ROOT/scripts/api-build-pod-state.mjs" "$MANIFEST" "$TEMP/pod.json" "$TEMP/deployment.json")"
else
  STATE="$(node "$ROOT/scripts/api-build-pod-state.mjs" "$MANIFEST" "$TEMP/pod.json")"
fi
if [ "$ACTION" = cleanup ]; then
  if [ "$STATE" != absent ]; then
    ssh "$HOST" "$K delete pod $POD --ignore-not-found --wait=true --timeout=120s"
  fi
  exit 0
fi
if [ "$STATE" = terminating ]; then
  ssh "$HOST" "$K wait --for=delete pod/$POD --timeout=120s"
  STATE=absent
elif [ "$STATE" = stopped ]; then
  ssh "$HOST" "$K delete pod $POD --wait=true --timeout=120s"
  STATE=absent
fi
if [ "$STATE" = absent ]; then
  ssh "$HOST" "$K create -f -" < "$MANIFEST"
fi
# Includes both an already operational pod and a freshly started one.
ssh "$HOST" "$K wait --for=condition=Ready pod/$POD --timeout=180s"
