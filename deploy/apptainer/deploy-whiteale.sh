#!/usr/bin/env bash
# Deploy OpenViking to whiteale.fiehnlab.ucdavis.edu as an Apptainer container
# fronted by an nginx virtual host, with the durable store on the host's
# PostgreSQL and all credentials in a data-volume secrets folder.
#
#   Route 53 (viking.metabolomics.us) -> whiteale (128.120.143.172)
#     whiteale nginx vhost viking.metabolomics.us -> 127.0.0.1:8090
#        Apptainer container: OpenViking (node) over localhost Postgres
#        data volume: /opt/viking/data/{secrets,postgres}
#
# Idempotent. Requires: ssh access to whiteale as $REMOTE_USER, passwordless sudo.
#
# Usage: ./deploy/apptainer/deploy-whiteale.sh
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-whiteale.fiehnlab.ucdavis.edu}"
REMOTE_USER="${REMOTE_USER:-wohlgemuth}"
KEY="${KEY:-$HOME/.ssh/id_rsa}"
DOMAIN="${DOMAIN:-viking.metabolomics.us}"
APP_PORT="${APP_PORT:-8090}"
DATA=/opt/viking/data
SECRETS="$DATA/secrets/.env"
SIF=/opt/viking/openviking.sif
BUILD_DIR=/opt/viking/build
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

R() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_USER@$REMOTE_HOST" "$@"; }

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---- 1. push the service source up (private repo; scp the files) ----------
say "push OpenViking service source to whiteale"
R "sudo mkdir -p $BUILD_DIR && sudo chown $REMOTE_USER $BUILD_DIR"
scp -q -i "$KEY" -r "$REPO_ROOT/services/openviking/src" \
    "$REPO_ROOT/services/openviking/package.json" \
    "$REPO_ROOT/services/openviking/package-lock.json" \
    "$REPO_ROOT/deploy/apptainer/openviking.def" \
    "$REMOTE_USER@$REMOTE_HOST:$BUILD_DIR/"
echo "    source staged at $BUILD_DIR"

# ---- 2. build the Apptainer SIF --------------------------------------------
# Rebuild when the source changes, not just when the SIF is missing: stamp a
# hash of the local source we push (same files as step 1) and rebuild on drift,
# so a re-run never ships a stale image.
say "build Apptainer SIF if source changed"
SRC_HASH=$(tar -cf - \
  -C "$REPO_ROOT/services/openviking" src package.json package-lock.json \
  -C "$REPO_ROOT/deploy/apptainer" openviking.def \
  2>/dev/null | sha256sum | cut -d' ' -f1) || SRC_HASH=unknown
CURRENT_SHA=$(R "test -f /opt/viking/.openviking.src.sha256 && cat /opt/viking/.openviking.src.sha256" | tr -d '[:space:]' || true)
if [ -z "$CURRENT_SHA" ] || [ "$CURRENT_SHA" != "$SRC_HASH" ]; then
  echo "    source changed (${CURRENT_SHA:-<none>} -> $SRC_HASH); rebuilding SIF"
  R "cd $BUILD_DIR && sudo apptainer build $SIF openviking.def 2>&1 | tail -8"
  R "echo $SRC_HASH | sudo tee /opt/viking/.openviking.src.sha256 >/dev/null"
else
  echo "    SIF up to date (hash $SRC_HASH)"
fi
R "test -f $SIF && sudo apptainer inspect $SIF | head -8"

# ---- 3. create Postgres role + database (idempotent) -----------------------
say "create Postgres role/db for openviking"
R bash -s <<'REMOTE'
set -euo pipefail
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='openviking'" | grep -q 1; then
  PGPW=$(openssl rand -hex 24)
  sudo -u postgres psql -q -c "CREATE ROLE openviking LOGIN PASSWORD '$PGPW';"
  echo "openviking role created"
else
  echo "openviking role exists"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='openviking'" | grep -q 1 \
  || sudo -u postgres createdb -O openviking openviking
sudo -u postgres psql -q -c "GRANT ALL ON DATABASE openviking TO openviking;"
REMOTE

# ---- 4. write the secrets file (data volume, credentials folder) -----------
say "write secrets to the data volume: $SECRETS"
R "sudo mkdir -p $DATA/secrets $DATA/postgres && sudo chmod 700 $DATA/secrets"
R bash -s <<REMOTE
set -euo pipefail
SECRETS=$SECRETS
if [ -f "\$SECRETS" ]; then
  echo "    secrets already exist (keeping); rotating nothing"
else
  umask 077
  TOKEN=\$(openssl rand -hex 32)
  # Generate a fresh Postgres password, apply it to the role, and store the same
  # value in the secrets file so DATABASE_URL stays consistent with the role.
  PGPW=\$(openssl rand -hex 24)
  sudo -u postgres psql -q -c "ALTER ROLE openviking PASSWORD '\$PGPW';"
  sudo -u postgres psql -q -c "SELECT pg_reload_conf();" >/dev/null 2>&1 || true
  # secrets dir is root-owned, so write via sudo tee
  sudo tee "\$SECRETS" >/dev/null <<EOF
OPENVIKING_TOKEN=\$TOKEN
DATABASE_URL=postgres://openviking:\$PGPW@127.0.0.1:5432/openviking
POSTGRES_USER=openviking
POSTGRES_PASSWORD=\$PGPW
POSTGRES_DB=openviking
OPENVIKING_PORT=$APP_PORT
OPENVIKING_LOG=1
EOF
  sudo chmod 600 "\$SECRETS"
  echo "    wrote \$SECRETS"
fi
REMOTE
R "sudo cat $SECRETS | sed 's/=.*$/=<redacted>/'"

# ---- 5. systemd unit to run the Apptainer container ------------------------
say "install systemd unit (openviking.service)"
R bash -s <<REMOTE
set -euo pipefail
cat > /tmp/openviking.service <<'UNIT'
[Unit]
Description=OpenViking durable-memory service (Apptainer container)
Documentation=https://github.com/berlinguyinca/pi-engineering-runtime
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=$SECRETS
ExecStart=/usr/bin/apptainer run --env-file $SECRETS $SIF
Restart=on-failure
RestartSec=5
# journald logs; keep the container in the foreground so systemd owns restarts

[Install]
WantedBy=multi-user.target
UNIT
sudo install -m 644 /tmp/openviking.service /etc/systemd/system/openviking.service
sudo systemctl daemon-reload
sudo systemctl enable --now openviking.service
REMOTE

# ---- 6. nginx virtual host ------------------------------------------------
say "configure nginx vhost $DOMAIN -> 127.0.0.1:$APP_PORT"
# Build the config locally (quoted heredoc preserves nginx \$variables), substitute
# the two values, then scp it up and install. Avoids shell-expansion pitfalls.
cat > /tmp/viking.conf <<'NGINX'
# /etc/nginx/conf.d/viking.conf  on whiteale (128.120.143.172)
# viking.metabolomics.us -> OpenViking Apptainer container on 127.0.0.1:__APP_PORT__.
# Mirrors mcp.conf: ACME on :80, TLS on :443, proxy to the local service.

upstream viking_backend {
    server 127.0.0.1:__APP_PORT__;
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    location /.well-known/acme-challenge/ {
        root /var/lib/letsencrypt;
        default_type "text/plain";
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name __DOMAIN__;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include conf.d/tls-common.inc;

    client_max_body_size 2m;
    access_log /var/log/nginx/viking.access.log;
    error_log  /var/log/nginx/viking.error.log;

    location / {
        proxy_pass http://viking_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }
}
NGINX
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__APP_PORT__/$APP_PORT/g" /tmp/viking.conf > /tmp/viking.conf.resolved
scp -q -i "$KEY" /tmp/viking.conf.resolved "$REMOTE_USER@$REMOTE_HOST:/tmp/viking.conf"

# Stage A: install a minimal :80 ACME server block first so nginx -t passes and
# Let's Encrypt can reach the challenge (mirrors mcp.conf's bootstrap ordering).
cat > /tmp/viking-acme.conf <<'ACME'
# temporary ACME-only :80 vhost for __DOMAIN__ (replaced by full viking.conf after the cert is issued)
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;
    location /.well-known/acme-challenge/ {
        root /var/lib/letsencrypt;
        default_type "text/plain";
    }
    location / { return 404; }
}
ACME
sed "s/__DOMAIN__/$DOMAIN/g" /tmp/viking-acme.conf > /tmp/viking-acme.conf.resolved
scp -q -i "$KEY" /tmp/viking-acme.conf.resolved "$REMOTE_USER@$REMOTE_HOST:/tmp/viking-acme.conf"
R "sudo install -m 644 /tmp/viking-acme.conf /etc/nginx/conf.d/viking.conf && sudo nginx -t && sudo nginx -s reload"

say "issue TLS certificate with certbot (webroot, $DOMAIN)"
R "sudo certbot certonly --webroot -w /var/lib/letsencrypt -d $DOMAIN --non-interactive --agree-tos --register-unsafely-without-email 2>&1 | tail -10"
R "sudo ls -la /etc/letsencrypt/live/$DOMAIN/"

# Stage B: install the full vhost (80 redirect + 443 TLS) now that the cert exists.
R "sudo install -m 644 /tmp/viking.conf /etc/nginx/conf.d/viking.conf && sudo nginx -t && sudo nginx -s reload && echo 'nginx reloaded'"

say "start + verify OpenViking container"
sleep 3
R "sudo systemctl restart openviking.service && sleep 2 && sudo systemctl is-active openviking.service"
R "sudo journalctl -u openviking --no-pager -n 20 | tail -12"

say "=== local verification on whiteale ==="
R "curl -s -o /dev/null -w '127.0.0.1:$APP_PORT/health -> HTTP %{http_code}\n' http://127.0.0.1:$APP_PORT/health"
R "curl -s http://127.0.0.1:$APP_PORT/metrics | grep -E 'openviking_up' || true"

say "done. Next: point Route 53 $DOMAIN -> 128.120.143.172"
echo "  then test: curl https://$DOMAIN/health"
