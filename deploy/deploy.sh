#!/usr/bin/env bash
# Runs on the VPS in one of three modes:
# - registry (default): invoked by .github/workflows/deploy.yml over SSH with
#   the registry token on stdin; pulls the image from GHCR. The volume is
#   assumed to already have owner bootstrap and embedding spaces.
# - build (SECOND_BRAIN_DEPLOY_MODE=build): invoked by an operator or the
#   installer after uploading the source tree; builds the image on the VPS.
#   Waits for auth only. Engine, admin, and worker need owner bootstrap first.
# - wait-engine (SECOND_BRAIN_DEPLOY_MODE=wait-engine): restart engine and
#   admin/worker and wait until they stay up. Call this after owner bootstrap.
# Requires /opt/second-brain/.env (see vps-setup.sh).
set -euo pipefail
cd /opt/second-brain

[ -f .env ] || { echo "ERROR: /opt/second-brain/.env missing — run deploy/vps-setup.sh first" >&2; exit 1; }

MODE="${SECOND_BRAIN_DEPLOY_MODE:-registry}"

# Persist the deployed image ref so manual `docker compose ...` on the VPS
# (restarts, account bootstrap, logs) resolves the same image, not a stale one.
upsert() {
  if grep -q "^${1}=" .env; then sed -i "s|^${1}=.*|${1}=${2}|" .env
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

# Compose interpolates SECOND_BRAIN_CONFIG_ENCRYPTION_KEY as required. Hosts
# provisioned before that variable existed still have a working .env without
# it. Generate once; never rotate a present value, because stored secret
# overrides cannot be decrypted with a new key.
ensure_configuration_encryption_key() {
  if grep -Eq '^SECOND_BRAIN_CONFIG_ENCRYPTION_KEY=.+' .env; then
    return 0
  fi
  command -v openssl >/dev/null || {
    echo "ERROR: OpenSSL is required to generate SECOND_BRAIN_CONFIG_ENCRYPTION_KEY, or set it in /opt/second-brain/.env" >&2
    exit 1
  }
  local key
  key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  upsert SECOND_BRAIN_CONFIG_ENCRYPTION_KEY "$key"
  chmod 600 .env
  echo "Generated SECOND_BRAIN_CONFIG_ENCRYPTION_KEY in .env — back this value up and do not rotate it."
}

ensure_configuration_encryption_key

dump_state() {
  echo "--- docker compose ps ---"; docker compose ps || true
  # One section per service so the tail of this output stays coherent when
  # the caller truncates it; likely-failing services come first-to-last in
  # startup order.
  for svc in migrate auth engine admin automation-worker; do
    echo "--- ${svc} logs ---"
    docker compose logs --no-color --tail=40 "$svc" 2>/dev/null || true
  done
}

wait_healthy() {
  local svc="$1"
  local seconds="${2:-180}"
  local deadline=$(( $(date +%s) + seconds ))
  local cid status
  while :; do
    cid="$(docker compose ps -q "$svc" || true)"
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
    [ "$status" = "healthy" ] && { echo "$svc: healthy"; return 0; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ERROR: $svc did not become healthy within ${seconds}s (last: $status)" >&2
      dump_state
      exit 1
    fi
    sleep 5
  done
}

wait_worker() {
  local deadline=$(( $(date +%s) + 30 ))
  local cid status
  while :; do
    cid="$(docker compose ps -q automation-worker || true)"
    status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
    [ "$status" = "running" ] && { echo "automation-worker: running"; return 0; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ERROR: automation-worker did not remain running (last: $status)" >&2
      dump_state
      exit 1
    fi
    sleep 2
  done
}

wait_engine_stack() {
  # Force a new process so crash-looping containers pick up embedding spaces
  # created by owner bootstrap. `up -d` is a no-op when they already exist.
  docker compose up -d --no-build --quiet-pull engine admin automation-worker
  docker compose restart engine admin automation-worker
  wait_healthy engine
  wait_healthy admin
  wait_worker
}

if [ "$MODE" = "wait-engine" ]; then
  wait_engine_stack
  echo "Engine ready"
  exit 0
fi

if [ "$MODE" = "build" ]; then
  export SECOND_BRAIN_IMAGE=second-brain SECOND_BRAIN_IMAGE_TAG=local
  upsert SECOND_BRAIN_IMAGE "$SECOND_BRAIN_IMAGE"
  upsert SECOND_BRAIN_IMAGE_TAG "$SECOND_BRAIN_IMAGE_TAG"
  # Migrate, engine, auth, admin, and the worker share one image; building one
  # service
  # produces it exactly once. `up --build` would build the same tag repeatedly
  # times in parallel, which races on the containerd image store
  # ("already exists").
  docker compose build engine
  docker compose up -d --no-build --quiet-pull --remove-orphans || { dump_state; exit 1; }
  # Auth can start before owner bootstrap. Engine, admin, and worker cannot:
  # they
  # require the embedding spaces that bootstrap creates. Waiting for them here
  # deadlocks the installer, which bootstraps only after this script returns.
  wait_healthy auth
elif [ "$MODE" = "registry" ]; then
  : "${SECOND_BRAIN_IMAGE:?}" "${SECOND_BRAIN_IMAGE_TAG:?}" "${GHCR_USER:?}"
  upsert SECOND_BRAIN_IMAGE "$SECOND_BRAIN_IMAGE"
  upsert SECOND_BRAIN_IMAGE_TAG "$SECOND_BRAIN_IMAGE_TAG"

  # The token arrives on stdin; --password-stdin keeps it out of argv and history.
  docker login ghcr.io -u "$GHCR_USER" --password-stdin
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

  docker compose pull
  docker compose up -d --no-build --remove-orphans || { dump_state; exit 1; }
  wait_healthy engine
  wait_healthy auth
  wait_healthy admin
  wait_worker
else
  echo "ERROR: SECOND_BRAIN_DEPLOY_MODE must be build, registry, or wait-engine." >&2
  exit 1
fi

docker image prune -f >/dev/null
echo "Deployed ${SECOND_BRAIN_IMAGE}:${SECOND_BRAIN_IMAGE_TAG}"
