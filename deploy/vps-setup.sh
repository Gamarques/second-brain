#!/usr/bin/env bash
# One-time VPS bootstrap for CI/CD deploys. Idempotent; safe to re-run.
# Usage from your dev machine:
#   scp deploy/vps-setup.sh <user>@<vps>:/tmp/ && ssh <user>@<vps> bash /tmp/vps-setup.sh
set -euo pipefail

command -v docker >/dev/null || { echo "ERROR: install Docker first (the Hostinger Docker template ships it)" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose v2 plugin required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "ERROR: OpenSSL is required to generate deployment secrets" >&2; exit 1; }

mkdir -p /opt/second-brain

if [ ! -f /opt/second-brain/.env ]; then
  SECOND_BRAIN_INITIAL_CONFIG_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  cat > /opt/second-brain/.env <<EOF
# Required — edit every value below. Full variable reference: .env.example in the repo.
POSTGRES_PASSWORD=replace-with-a-strong-database-password
OPENROUTER_API_KEY=change-me
SECOND_BRAIN_PUBLIC_URL=https://brain.example.com
SECOND_BRAIN_PUBLIC_HOST=brain.example.com
SECOND_BRAIN_CONFIG_ENCRYPTION_KEY=${SECOND_BRAIN_INITIAL_CONFIG_KEY}
SECOND_BRAIN_WORKER_ID=second-brain-automation-1

# Managed by deploys — do not edit:
SECOND_BRAIN_IMAGE=second-brain
SECOND_BRAIN_IMAGE_TAG=local
EOF
  unset SECOND_BRAIN_INITIAL_CONFIG_KEY
  chmod 600 /opt/second-brain/.env
  echo "Created /opt/second-brain/.env — EDIT IT NOW: nano /opt/second-brain/.env"
else
  echo "/opt/second-brain/.env already exists — preserving configured values"
fi

if ! grep -q '^SECOND_BRAIN_CONFIG_ENCRYPTION_KEY=' /opt/second-brain/.env; then
  SECOND_BRAIN_INITIAL_CONFIG_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  printf '%s=%s\n' SECOND_BRAIN_CONFIG_ENCRYPTION_KEY "$SECOND_BRAIN_INITIAL_CONFIG_KEY" >> /opt/second-brain/.env
  unset SECOND_BRAIN_INITIAL_CONFIG_KEY
fi
if ! grep -q '^SECOND_BRAIN_WORKER_ID=' /opt/second-brain/.env; then
  printf '%s=%s\n' SECOND_BRAIN_WORKER_ID second-brain-automation-1 >> /opt/second-brain/.env
fi
chmod 600 /opt/second-brain/.env

cat <<'EOF'
Next steps:
 1. Edit /opt/second-brain/.env (database password, OpenRouter key, public URL,
    and hostname). Keep the generated encryption key unchanged and backed up.
    Configure spending limits in the OpenRouter dashboard. The
    Traefik edge that ships with the Hostinger Docker template routes to the
    stack through container labels — no proxy config here.
 2. Point your domain's DNS A record at this VPS.
 3. In your GitHub repo add Actions secrets: VPS_HOST, VPS_USER, VPS_SSH_KEY (private
    key whose public half is in ~/.ssh/authorized_keys here), optional VPS_PORT.
 4. Push to main (or run the Deploy workflow manually). CI copies the compose file
    here and starts the stack.
 5. After the first successful deploy, create the first owner account, singleton
    automation settings, and embedding spaces:
      cd /opt/second-brain && docker compose run --rm auth node dist/services/auth/bootstrap-account.js
 6. Restart the engine stack, then open https://brain.example.com/admin and
    sign in with the existing OAuth owner account:
      cd /opt/second-brain && SECOND_BRAIN_DEPLOY_MODE=wait-engine bash deploy/deploy.sh
EOF
