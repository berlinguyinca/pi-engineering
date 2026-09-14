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

The service is stateless — all durable memory lives in the `openviking_pg`
Postgres volume, so you can move the container to another host (e.g. off a lab
box to AWS later) and keep the data.

## Point pi workers at it

```ts
blackhole: {
  config: {
    enabled: true,
    durable: { kind: "openviking", baseUrl: "http://<host>:8080", token: "<OPENVIKING_TOKEN>" },
  },
}
```

## Security notes (tier-1)

- Set `OPENVIKING_TOKEN` (a bearer token). Workers must present it.
- Do NOT store model secrets / provider credentials / PII in promoted memory.
- For remote access, put it behind TLS (a reverse proxy / Caddy / ALB) — the
  service itself speaks plain HTTP by design (it's server-to-server).
- The Postgres volume holds the curated knowledge; back it up.
