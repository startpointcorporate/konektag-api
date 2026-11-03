#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
: "${NAMESPACE:?Set the existing target namespace}"
: "${RELEASE:?Set the Helm release name}"
: "${IMAGE_REPOSITORY:?Set the registry repository prefix}"
: "${IMAGE_TAG:?Set the full commit SHA}"
: "${VALUES_FILE:?Set a reviewed Helm values file referencing existing Secrets and PVCs}"
[[ "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]] || { echo 'IMAGE_TAG must be a full commit SHA' >&2; exit 1; }
[[ -f "$VALUES_FILE" ]] || { echo 'VALUES_FILE does not exist' >&2; exit 1; }
kubectl get namespace "$NAMESPACE" >/dev/null
helm upgrade --install "$RELEASE" src/infrastructure/k8s/konektag-api \
  --namespace "$NAMESPACE" --values "$VALUES_FILE" \
  --set-string image.repository="$IMAGE_REPOSITORY" --set-string image.tag="$IMAGE_TAG" \
  --atomic --wait --timeout 5m --history-max 10
./src/infrastructure/scripts/verify-deployment.sh
