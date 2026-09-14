# OpenViking — AWS Production Deployment

OpenViking is the tier-1 OpenViking service (shared durable memory provider for
pi workers) running in production on AWS, reachable at:

- **`https://viking.metabolomics.us`**
- Health: `GET https://viking.metabolomics.us/health`
- Metrics: `GET https://viking.metabolomics.us/metrics` (Prometheus text format)

This document describes the live deployment and how to operate it.

## Architecture

```
                        public internet
                              |
                 Route 53 A  viking.metabolomics.us
                              |
                      AWS ALB (internet-facing)
                 TLS terminated (ACM cert, auto-renewed)
              80 -> 301 redirect to 443
                              |
                      target group :8080   (health check GET /health)
                              |
                      EC2 t3.small  (us-west-2, Ubuntu 24.04)
                   docker compose: openviking + postgres
                              |
                  DATA VOLUME  /opt/viking/data
                    secrets/  <- ALL credentials
                    postgres/ <- durable memory (system of record)
                    letsencrypt/  nginx/
```

The EC2 is reached by the ALB only (port 8080 is open solely to the ALB's
security group). The service container is stateless; ALL durable memory and
every credential live under `/opt/viking/data`, so the box can be replaced and
everything recovered from the data volume + a `docker compose up`.

### Resource inventory (account 702514165722, region us-west-2)

| Resource            | Name / value                                            |
|---------------------|---------------------------------------------------------|
| DNS (Route 53)      | `viking.metabolomics.us` A → ALB (zone Z2ANBWTR462YC8)  |
| Load balancer       | `viking-openviking` (ALB, 2 subnets, TLS via ACM)       |
| Target group        | `viking-openviking` HTTP :8080, health `/health`        |
| Certificate (ACM)   | `viking.metabolomics.us` (DNS-validated, auto-renewed)  |
| EC2 instance        | `viking-openviking` (i-0cd791feaef8a43d0, t3.small)     |
| Elastic IP          | `32.186.196.253` (stable SSH address)                    |
| Security groups     | `viking-openviking-{alb,ec2}`                            |
| IAM (EC2 role)      | `viking-openviking-ec2` (S3 read for bootstrap)          |
| S3 bucket           | `viking-metabolomics-us-702514165722` (bootstrap artifact)|
| Containers          | `viking-openviking-1` (:8080), `viking-postgres-1`      |

## The data volume (keys & passwords)

Everything secret and durable lives on the box under the **data volume**:

```
/opt/viking/data/
  secrets/.env      <- OPENVIKING_TOKEN, POSTGRES_USER, POSTGRES_PASSWORD,
                       POSTGRES_DB, OPENVIKING_PORT   (chmod 600, root)
  postgres/         <- PostgreSQL data files (the durable memory store)
  letsencrypt/      <- (reserved) TLS state if certbot is ever used
  nginx/            <- (reserved) reverse-proxy config
```

`secrets/.env` is the single place all keys/passwords for this installation
live. It was generated at first boot with `openssl rand -hex` (32-byte API
token, 24-byte Postgres password). Back this folder up — it is the recovery key
for the deployment.

> Compose commands must pass the secrets file so compose can substitute
> `${POSTGRES_PASSWORD}` / `${OPENVIKING_TOKEN}`:
> `cd /opt/viking && sudo docker compose --env-file ./data/secrets/.env <cmd>`
> (`env_file` alone only injects into containers, not into compose substitution.)

## Accessing the box

Two options:

1. **Elastic IP + keypair** (if you hold the `wohlgemuth` keypair private key):
   `ssh -i wohlgemuth.pem ubuntu@32.186.196.253`
2. **EC2 Instance Connect** (no stored key needed; IAM `ec2-instance-connect`
   permission):
   ```bash
   aws ec2-instance-connect send-ssh-public-key \
     --instance-id i-0cd791feaef8a43d0 --instance-os-user ubuntu \
     --ssh-public-key file://~/.ssh/id_rsa.pub --region us-west-2 \
     --availability-zone us-west-2a
   ssh -i ~/.ssh/id_rsa ubuntu@32.186.196.253   # do this within ~60s
   ```

## Configuring pi workers against this installation

Workers point at this service via the `openviking` durable provider. They need
the bearer token (from `/opt/viking/data/secrets/.env` on the box):

```ts
durable: {
  kind: "openviking",
  baseUrl: "https://viking.metabolomics.us",
  token: "<OPENVIKING_TOKEN>",
  providerTimeoutMs: 10_000,
}
```

The provider is role-gated and fail-closed exactly as the tier-1 contract in
`docs/specs/blackhole-implementation-plan.md` and `services/openviking/README.md`.

## Integrating into status.metabolomics.us

`status.metabolomics.us` is a campus box (`128.120.136.17`) behind an
oauth2-proxy sign-in page for which no credentials are available from this
environment, so the dashboard cannot be edited directly here. The service is
already instrumented so it can be tracked there; add two monitors:

1. **HTTP(S) up monitor** — target `https://viking.metabolomics.us/health`.
   Healthy when HTTP 200 (the service returns 503 when the backing Postgres is
   unreachable, so a 503 means degraded, not just "down").
2. **Metrics scrape** — target `https://viking.metabolomics.us/metrics`
   (Prometheus text format; unauthenticated for scraping). Useful series:
   - `openviking_up{kind,version,auth}` — 1 when serving
   - `openviking_memory_records` — count of promoted durable memory records
   - `openviking_requests_total{method,route,status}` — traffic/error counters

If you can add it to `status.metabolomics.us` (e.g., a UptimeRobot / Grafana
HTTP check or a Prometheus `blackbox_exporter` probe), use the two URLs above.

## Redeploy / update the app

The app tarball is uploaded to S3 and pulled by user-data only at first boot.
To push a new build of the service to the running box:

```bash
# on the box:
cd /opt/viking
sudo docker compose --env-file ./data/secrets/.env up -d --build
```

The compose + source can be refreshed from the repo (`services/openviking/`).
The data volume is untouched by redeploys.

## Tear down

`./deploy/aws/teardown.sh` (see `deploy/aws/`). **Before tearing down**, download
`/opt/viking/data/secrets/.env` and back up `/opt/viking/data/postgres` if you
need the durable memory.
