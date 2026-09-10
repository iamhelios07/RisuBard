#!/usr/bin/env bash
set -euo pipefail
SMOKE_ROOT="$(mktemp -d -t risubard-smoke.XXXXXX)"
LOCK_CONTAINER="risubard-lock-${GITHUB_RUN_ID:-local}-${RANDOM}"
cleanup() {
  docker rm -f "$LOCK_CONTAINER" >/dev/null 2>&1 || true
  [[ "$SMOKE_ROOT" == /tmp/risubard-smoke.* ]] || return 1
  sudo rm -rf -- "$SMOKE_ROOT"
}
trap cleanup EXIT
SCRIPT="$PWD/.github/scripts/verify-mounted-migration.cjs"
docker run --rm -v "$SMOKE_ROOT:/app/save" -v "$SCRIPT:/verify.cjs:ro" "$SMOKE_IMAGE" node /verify.cjs
docker run -d --name "$LOCK_CONTAINER" -v "$SMOKE_ROOT:/app/save" -v "$SCRIPT:/verify.cjs:ro" "$SMOKE_IMAGE" node /verify.cjs hold-lock
for attempt in {1..100}; do
  [[ -f "$SMOKE_ROOT/lock-ready" ]] && break
  sleep 0.1
done
test -f "$SMOKE_ROOT/lock-ready"
docker run --rm -v "$SMOKE_ROOT:/app/save" -v "$SCRIPT:/verify.cjs:ro" "$SMOKE_IMAGE" node /verify.cjs contend
docker kill "$LOCK_CONTAINER"
docker run --rm -v "$SMOKE_ROOT:/app/save" -v "$SCRIPT:/verify.cjs:ro" "$SMOKE_IMAGE" node /verify.cjs reacquire
