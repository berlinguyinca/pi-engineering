# OpenViking (tier-1 service)

The cross-machine durable-memory endpoint that `pi-engineering-runtime`'s
`OpenVikingProvider` (`src/blackhole/durable.ts`) talks to. It is a thin,
stateless HTTP service over a durable backing store (PostgreSQL in production,
in-memory for dev/tests).

## HTTP contract

| Method | Path                  | Body / Query                          | Returns                        |
| ------ | --------------------- | ------------------------------------- | ------------------------------ |
| POST   | `/memory`             | `{ id, text, sourceRefs, promotedFrom, evidenceIds, promotedAt, promotedBy }` | `201 { id }` |
| GET    | `/memory`             | —                                     | all promoted records `[]`      |
| GET    | `/memory/search`      | `?q=` (tokens)                        | relevant records `[]`          |
| GET    | `/health`             | —                                     | `{ status: "ok" }`             |
| GET    | `/metrics`            | — (Prometheus text format)            | `openviking_up`, `openviking_memory_records`, `openviking_requests_total` |

`/metrics` is unauthenticated so external monitors (e.g. `status.metabolomics.us`)
can scrape it. `openviking_up{kind,version,auth}` is 1 when serving,
`openviking_memory_records` is the number of promoted records, and
`openviking_requests_total{method,route,status}` counts traffic by route/status.

If `OPENVIKING_TOKEN` is set, every request must send
`Authorization: Bearer <token>` (this is exactly what `OpenVikingProvider`
sends when given a `token`).

## Run locally (in-memory, zero deps)

```sh
node src/index.mjs                # storage=memory
curl http://127.0.0.1:8080/health
```

## Run with Postgres (tier-1)

```sh
cp .env.example .env
# edit .env: set OPENVIKING_TOKEN and POSTGRES_PASSWORD
docker compose up -d --build
curl http://localhost:8080/health
```

The service is stateless — all durable memory lives in the Postgres data volume
(`./data/postgres`), so you can move the container to another host and keep the
data. In production the `docker-compose.yml` uses a data volume whose
`./data/secrets/.env` holds every credential and whose `./data/postgres` holds
the durable memory (see `docs/deployments/openviking-aws.md`).

## Point pi workers at it

```ts
blackhole: {
  config: {
    enabled: true,
    durable: { kind: "openviking", baseUrl: "http://<host>:8080", token: "<OPENVIKING_TOKEN>" },
  },
}
```

## Production deployment (AWS)

Live at `https://viking.metabolomics.us` (Route 53 → ALB → EC2 → docker compose
over Postgres). See `docs/deployments/openviking-aws.md` for the architecture,
data-volume layout (where the secrets/keys live), how to access the box, and how
`status.metabolomics.us` can monitor it via `/health` + `/metrics`. The IaC is in
`deploy/aws/` (`deploy.sh` / `teardown.sh` / `user-data.sh`).

## Security notes (tier-1)

- Set `OPENVIKING_TOKEN` (a bearer token). Workers must present it.
- Do NOT store model secrets / provider credentials / PII in promoted memory.
- For remote access, put it behind TLS (a reverse proxy / Caddy / ALB) — the
  service itself speaks plain HTTP by design (it's server-to-server).
- The Postgres volume holds the curated knowledge; back it up.
