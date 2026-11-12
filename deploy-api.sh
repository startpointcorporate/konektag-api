#!/usr/bin/env bash
# Deploy a committed API release into the existing K3s application PVC.
# No image build, Helm upgrade, rollout, or MCP/worker changes.
set -euo pipefail

cd "$(dirname "$0")"
HOST="${KONEKTAG_K3S_HOST:-konektag-core}"
NS="konektag-api"
SETUP="konektag-api-setup"
APP="konektag-api"
SHA="$(git rev-parse HEAD)"

if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  echo "ERROR: commit tracked changes before deploying." >&2
  exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: untracked files present; commit or ignore them before deploying." >&2
  exit 1
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid Git SHA" >&2; exit 1; }

K="sudo k3s kubectl -n $NS"
echo "Deploying Konektag API $SHA to $HOST/$NS"

ACTIVATED=0
rollback() {
  if [ "$ACTIVATED" = 1 ]; then
    echo "ERROR: deployment failed; restoring $CURRENT" >&2
    ssh "$HOST" "$K exec -i deployment/$APP -- sh -s -- $CURRENT" <<'REMOTE_ROLLBACK' || true
set -eu
version="$1"
printf "%s\n" "$version" > /app/active-version.tmp
mv /app/active-version.tmp /app/active-version
REMOTE_ROLLBACK
  fi
}
finish() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$status" != 0 ]; then rollback; fi
  if ! bash scripts/api-build-pod.sh cleanup; then
    echo "ERROR: build pod cleanup failed; PVC retained" >&2
    if [ "$status" = 0 ]; then status=1; fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ssh "$HOST" "$K get deployment $APP >/dev/null"
CURRENT="$(ssh "$HOST" "$K exec deployment/$APP -- cat /app/active-version" | tr -d '\r\n')"
if [ "$CURRENT" = "$SHA" ]; then
  echo "Already active: $SHA"
  exit 0
fi

bash scripts/api-build-pod.sh ensure

# Refuse to overwrite a previously published release; immutable versions only.
ssh "$HOST" "$K exec $SETUP -- sh -c 'test ! -e /app/releases/$SHA && mkdir -p /app/releases/$SHA'"

echo "=== Upload committed source ==="
git archive --format=tar HEAD |
  ssh "$HOST" "$K exec -i $SETUP -- tar -xf - -C /app/releases/$SHA"

echo "=== Build on Linux x64 inside K3s ==="
ssh "$HOST" "$K exec -i $SETUP -- sh -s -- $SHA" <<'REMOTE_BUILD'
set -eu
version="$1"
cd "/app/releases/$version"
test "$(node -p process.platform)" = linux
test "$(node -p process.arch)" = x64
npm ci --no-audit --no-fund
npm run build
test -s dist/server.mjs
test -s dist/openapi.json
node -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync("dist/openapi.json","utf8"));if(s.openapi!=="3.1.0")process.exit(1)'
npm prune --omit=dev --no-audit --no-fund
touch .ready
echo BUILD_OK
REMOTE_BUILD

echo "=== Atomic activation ==="
ssh "$HOST" "$K exec -i deployment/$APP -- sh -s -- $SHA" <<'REMOTE_ACTIVATE'
set -eu
version="$1"
test -f "/app/releases/$version/.ready"
printf "%s\n" "$version" > /app/active-version.tmp
mv /app/active-version.tmp /app/active-version
REMOTE_ACTIVATE
ACTIVATED=1

echo "=== Validate running process and HTTP ==="
OK=0
for attempt in $(seq 1 30); do
  if ssh "$HOST" "$K exec -i deployment/$APP -- node - $SHA" >/dev/null 2>&1 <<'REMOTE_CHECK'
const fs=require("node:fs");
const expected=process.argv[2];
const processes=fs.readdirSync("/proc").filter(p=>/^\d+$/.test(p));
const running=processes.some(pid=>{
  try {
    const cmd=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").replace(/\0/g," ");
    return cmd.includes("node dist/server.mjs") &&
      fs.readlinkSync("/proc/"+pid+"/cwd")==="/app/releases/"+expected;
  } catch { return false; }
});
if(!running) process.exit(1);
(async()=>{
  for(const path of ["/livez","/api/internal/health","/openapi.json","/docs"]){
    const r=await fetch("http://127.0.0.1:3000"+path);
    if(!r.ok) process.exit(1);
    if(path==="/api/internal/health"){
      const d=await r.json();
      if(d.checks?.postgresql!==true || d.checks?.redis!==true) process.exit(1);
    }
  }
})().catch(()=>process.exit(1));
REMOTE_CHECK
  then
    OK=1
    break
  fi
  sleep 2
done

if [ "$OK" != 1 ]; then
  echo "ERROR: new process not healthy after activation" >&2
  false
fi

ACTIVATED=0
echo "SUCCESS: $CURRENT -> $SHA"
echo "Swagger: https://api.konektag.eu/docs"
