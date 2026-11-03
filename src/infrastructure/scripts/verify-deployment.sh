#!/usr/bin/env bash
set -euo pipefail
: "${NAMESPACE:?Set NAMESPACE}"
: "${RELEASE:?Set RELEASE}"
kubectl -n "$NAMESPACE" get deployments -l "app.kubernetes.io/instance=$RELEASE" -o name >/dev/null
# Labels on pod templates are not deployment labels: use explicit workload names.
for role in api mcp-erpnext mcp-m365 mcp-unipile; do
  kubectl -n "$NAMESPACE" rollout status "deployment/$RELEASE-$role" --timeout=5m
done
for role in outbox accounting; do
  if kubectl -n "$NAMESPACE" get "deployment/$RELEASE-$role" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" rollout status "deployment/$RELEASE-$role" --timeout=5m
  fi
done
pod="$(kubectl -n "$NAMESPACE" get pod -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=api" -o jsonpath='{.items[0].metadata.name}')"
kubectl -n "$NAMESPACE" exec "$pod" -- node --input-type=module -e '
  const health=await fetch("http://127.0.0.1:3000/api/internal/health");
  const data=await health.json();
  if(!health.ok||data.checks?.postgresql!==true||data.checks?.redis!==true) process.exit(1);
  const spec=await fetch("http://127.0.0.1:3000/openapi.json");
  if(!spec.ok||(await spec.json()).openapi!=="3.1.0")process.exit(1);
  console.log("API dependencies and OpenAPI verified");'
