# Planner/Worker ↔ InferWeave client contract

Status: consumed by pi-engineering `src/plannerWorker/gateway.ts` and `roles.ts`.
Parent spec: `planner-worker-hot-model-routing.md` (§9, §10, §15, §16, Phase 3).

pi-engineering requests **capabilities and logical routes**; InferWeave decides
which runtime serves them. Every field below is optional. A plain
OpenAI-compatible gateway that sends none of it still works, because
pi-engineering then falls back to its static `routing.roles` pins.

## 1. Logical routes (aliases) on `GET /v1/models`

A logical route is listed as an ordinary model row, so every OpenAI client,
including Pi's provider model list, can address it by `id`:

```json
{ "id": "coding-implementation", "object": "model",
  "x_alias": true,
  "x_backing_model": "<concrete model id currently bound>",
  "x_route_generation": 7,
  "x_capabilities": ["coding.implementation"],
  "ctx_per_request": 131072, "x_state": "hot" }
```

A concrete model row may carry the following extensions:

| Field | Meaning |
|---|---|
| `x_aliases` | Logical routes this model currently serves. |
| `x_capabilities` | Capability tags, for example `coding.planning`, `coding.analysis`, `coding.implementation`, `coding.review`, `coding.debugging`, `coding.escalation`. |
| `x_family`, `x_size_class` | Opaque family and size tags, matched against `preferred_family`. |
| `ctx_per_request` | Per-request context window. Existing field. |
| `x_modalities` | For example `["text", "image"]`. |
| `x_tools`, `x_structured_output` | Booleans. |
| `x_state` | One of `hot`, `warm`, `ready`, `cold`, `loading`, `draining`, `unavailable`, `lost`. |
| `x_load` | Load from 0 to 1. |

Each role's default alias is its capability name with `.` replaced by `-`.
For example, `coding.planning` becomes `coding-planning`. The alias can be
overridden in `.pi/engineering.yaml` under `planner_worker.roles.<role>.alias`.

pi-engineering never sends the words planner, worker, reviewer or mission.

## 2. Capability hints on `POST /v1/chat/completions`

When pi-engineering talks to the gateway directly, it sends these headers.
Unknown headers must be ignored.

```
x-inferweave-capabilities: coding.implementation
x-inferweave-min-context: 128000
x-inferweave-prefer-family: <family tag>
```

The request's `model` field is the alias, or a concrete id when no alias exists.

## 3. Served-route identity (route changes)

Response headers on every completion. Streaming requests send them on the
initial response.

```
x-inferweave-route: coding-implementation       # alias requested, if any
x-inferweave-model: <concrete model that served>
x-inferweave-route-generation: 8                # bumps on every rebinding
```

A route swap happens only at a request boundary. Requests already in flight
stay pinned to their runtime. pi-engineering compares the served model and
generation with those of the previous request on the same alias. A change is
recorded as `MODEL_TRANSITION reason=route_changed`, and pi-engineering
re-checks context compatibility. No client restart is involved.

## 4. Availability errors

The gateway responds with HTTP 429 or 503 (404 for an unknown model) and this
body:

```json
{ "error": { "code": "MODEL_LOADING", "message": "...", "retry_after_ms": 4000,
             "candidates": [ { "id": "...", "x_capabilities": ["coding.implementation"],
                               "ctx_per_request": 131072, "x_state": "hot" } ] } }
```

`code` is one of `NO_WORKERS`, `MODEL_UNAVAILABLE`, `MODEL_LOADING`,
`CAPACITY_EXHAUSTED`, `NODE_DRAINING`, `NODE_LOST`. The same code can also be
sent in the `x-inferweave-error-code` header. The existing admission payload
(`type: "inference_admission"`, `reason: model_loading | capacity_unavailable
| worker_saturated | …`) is accepted as well. Its reasons are mapped onto the
codes above.

`candidates` uses the same row shape as `/v1/models`.

| Code | Client reaction (bounded, never infinite) |
|---|---|
| `MODEL_LOADING` | Wait `retry_after_ms` (capped at 30 s) up to 3 times, then switch. |
| `CAPACITY_EXHAUSTED`, `NO_WORKERS` | Wait once, then switch. |
| `NODE_DRAINING` | Retry the same alias once (the route moves), then switch. |
| `MODEL_UNAVAILABLE`, `NODE_LOST` | Switch immediately. |

"Switch" means the client excludes the failed model, merges `candidates` into
the catalogue, re-resolves the role (keeping planner and implementer
distinct), and records `MODEL_TRANSITION reason=failover:<CODE>`.

## 5. What the InferWeave side must satisfy

1. List aliases as model rows with `x_alias`, `x_backing_model` and
   `x_route_generation`.
2. Send the three served-route headers on completions.
3. Bump `x_route_generation` on every rebinding. Never move an in-flight
   request.
4. Return availability errors in the shape above, with `candidates` when it can.
5. Advertise `x_capabilities` and `x_state` on concrete models.
