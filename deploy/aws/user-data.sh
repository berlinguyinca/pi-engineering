#!/usr/bin/env bash
# EC2 user-data bootstrap for the OpenViking tier-1/prod deployment.
#
# Runs as root at first boot. Installs Docker + compose, creates the DATA VOLUME
# at /opt/viking/data with a secrets/ folder (the single place every key and
# password for this installation lives), downloads the app from S3, and deploys
# it with docker compose. Idempotent: re-running on the same host keeps existing
# secrets/data.
#
# Placeholders __BUCKET__ and __REGION__ are substituted by deploy.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "==> installing docker + compose"
apt-get update -y
apt-get install -y ca-certificates curl awscli
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

echo "==> creating data volume layout: /opt/viking/data/{secrets,postgres,letsencrypt,nginx}"
# The DATA VOLUME. All durable memory + every credential live under /opt/viking/data.
mkdir -p /opt/viking/data/secrets /opt/viking/data/postgres /opt/viking/data/letsencrypt /opt/viking/data/nginx
chmod 700 /opt/viking/data /opt/viking/data/secrets

echo "==> generating secrets (idempotent)"
SECRETS=/opt/viking/data/secrets/.env
if [ ! -f "$SECRETS" ]; then
  umask 077
  TOKEN=$(openssl rand -hex 32)
  PGPASS=$(openssl rand -hex 24)
  cat > "$SECRETS" <<EOF
OPENVIKING_TOKEN=$TOKEN
POSTGRES_USER=openviking
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=openviking
OPENVIKING_PORT=8080
EOF
  chmod 600 "$SECRETS"
  echo "    wrote $SECRETS (OPENVIKING_TOKEN + POSTGRES_PASSWORD generated)"
else
  echo "    $SECRETS already exists; keeping existing secrets"
fi

echo "==> fetching app from S3"
mkdir -p /opt/viking
aws s3 cp "s3://__BUCKET__/openviking/openviking.tar.gz" /opt/viking/openviking.tar.gz --region __REGION__
tar -xzf /opt/viking/openviking.tar.gz -C /opt/viking
rm -f /opt/viking/openviking.tar.gz

echo "==> deploying with docker compose"
cd /opt/viking
# compose reads ./data/secrets/.env -> /opt/viking/data/secrets/.env
docker compose up -d --build

echo "==> bootstrap complete"
docker compose ps || true
