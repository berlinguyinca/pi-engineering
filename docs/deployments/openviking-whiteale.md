# OpenViking — Production deployment (whiteale, Apptainer)

OpenViking is the tier-1 durable-memory endpoint that pi workers talk to. The
production deployment runs as an **Apptainer (Singularity) container** on the
lab's whiteale server, fronted by an **nginx virtual host**, and is reachable at:

- **`https://viking.metabolomics.us`**
- Health: `GET https://viking.metabolomics.us/health` (200 ok / 503 degraded)
- Metrics: `GET https://viking.metabolomics.us/metrics` (Prometheus text format)

DNS for `viking.metabolomics.us` is forwarded via **Route 53** to the whiteale
server (`128.120.143.172`).

## Architecture

```
                    Route 53   viking.metabolomics.us  ->  128.120.143.172
                                    (A record, TTL 300)
                                    |
                        whiteale.fiehnlab.ucdavis.edu  (128.120.143.172, kvm-node-12)
                                    |
                       nginx virtual host (conf.d/viking.conf)
                    :80 ACME challenge  +  :443 TLS (Let's Encrypt, auto-renew)
                       80 -> 301 redirect to 443
                                    |
                        proxy_pass 127.0.0.1:8090
                                    |
                      Apptainer container: OpenViking (node:22-slim SIF)
                    stateless; env from the secrets file; no data inside
                                    |
                        host PostgreSQL (local, 127.0.0.1:5432)
                        durable memory (system of record)
```

### The data volume (keys & passwords)

All credentials and durable state for the deployment live on whiteale under the
**data volume** `/opt/viking/data`:

```
/opt/viking/data/
  secrets/.env      <- OPENVIKING_TOKEN, DATABASE_URL, POSTGRES_USER,
                       POSTGRES_PASSWORD, POSTGRES_DB, OPENVIKING_PORT
                       (chmod 600, root)  — the single folder with every key/password
  postgres/         <- (reserved) host Postgres data lives at /var/lib/pgsql/data
```

`secrets/.env` is generated at first deploy with `openssl rand -hex` (32-byte
API token, 24-byte Postgres password). The `openviking.service` systemd unit
loads it via `EnvironmentFile` / Apptainer `--env-file`, so the container gets
the token + `DATABASE_URL` at runtime without baking secrets into the image.

> The container is **stateless**. Durable memory lives only in the host's
> PostgreSQL (`openviking` role/db). Redeploying the container loses nothing.

## Components on whiteale

| Component         | Details                                                        |
|-------------------|---------------------------------------------------------------|
| Apptainer image   | `/opt/viking/openviking.sif` (built from `deploy/apptainer/openviking.def`) |
| Build source      | `/opt/viking/build/` (scp'd service files; repo is private)    |
| systemd service   | `openviking.service` — `apptainer run --env-file ... openviking.sif`, listens `127.0.0.1:8090`, auto-restart |
| nginx vhost       | `/etc/nginx/conf.d/viking.conf` (mirrors `mcp.conf`)           |
| TLS               | Let's Encrypt, `/etc/letsencrypt/live/viking.metabolomics.us`, certbot auto-renew |
| Postgres          | host Postgres 18, role/db `openviking`, `GRANT ALL ON DATABASE` |
| Logs              | `journalctl -u openviking`; nginx `viking.{access,error}.log`   |

## Deploy / update

```bash
# from this repo (needs ssh access to whiteale as $REMOTE_USER, passwordless sudo)
./deploy/apptainer/deploy-whiteale.sh
```

Idempotent: re-running skips the SIF build (if present) and existing secrets,
re-asserts the role/db, reinstalls the systemd unit + nginx vhost (reissuing the
cert if needed), and restarts. To rebuild the container from new service code,
remove `/opt/viking/openviking.sif` on whiteale first (or delete it in the script).

## Pointing pi workers at it

Workers use the `openviking` durable provider with the token from
`/opt/viking/data/secrets/.env` on whiteale:

```ts
durable: {
  kind: "openviking",
  baseUrl: "https://viking.metabolomics.us",
  token: "<OPENVIKING_TOKEN>",
  providerTimeoutMs: 10_000,
}
```

## Integrating into status.metabolomics.us

`status.metabolomics.us` is a separate campus box (`128.120.136.17`) behind an
oauth2-proxy sign-in page for which no credentials are available from this
environment, so it cannot be edited directly here. The service is already
instrumented for tracking there — add two monitors:

1. **HTTP(S) up monitor** → `https://viking.metabolomics.us/health`
   (200 = up; 503 = Postgres unreachable = degraded).
2. **Metrics scrape** → `https://viking.metabolomics.us/metrics`
   (`openviking_up{kind,version,auth}`, `openviking_memory_records`,
   `openviking_requests_total{method,route,status}`).

## Notes

- Port `8090` on whiteale is the container's bind; nginx proxies to
  `127.0.0.1:8090`. The API is Bearer-token protected (`auth=on`), matching the
  box's existing `mcp` service convention of binding the service port openly.
- The AWS deployment created earlier was decommissioned (all EC2/ALB/EIP/IAM/
  S3/ACM resources removed). The Route 53 record now points at whiteale.
