#!/usr/bin/env bash
set -euo pipefail
: "${NAMESPACE:?Set NAMESPACE}"
: "${RELEASE:?Set RELEASE}"
: "${REVISION:?Set an existing Helm revision from helm history}"
[[ "$REVISION" =~ ^[1-9][0-9]*$ ]] || exit 1
helm rollback "$RELEASE" "$REVISION" --namespace "$NAMESPACE" --wait --timeout 5m
"$(dirname "${BASH_SOURCE[0]}")/verify-deployment.sh"
