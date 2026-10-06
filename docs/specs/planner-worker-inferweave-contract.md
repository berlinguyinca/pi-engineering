# Planner/Worker ↔ InferWeave client contract

Status: consumed by pi-engineering `src/plannerWorker/gateway.ts`, `roles.ts`
and `executor.ts`. Parent spec: `planner-worker-hot-model-routing.md` (§9, §10,
§15, §16, §23, Phase 3). The server half is InferWeave
`docs/specs/logical-routes.md` (branch `feat/logical-routes-hot-swap`); this
document records how pi-engineering consumes it. Where the two differ,
InferWeave's document is authoritative.

pi-engineering asks for **routes and capabilities**. InferWeave decides
which runtime serves them. Every field below is optional. A plain
OpenAI-compatible gateway, or an older InferWeave, still works: it simply
lacks the extensions, and pi-engineering falls back to its static
`routing.roles` pins.

## 1. Naming inference by need (`model` field)

| `model` | Use |
|---|---|
| A concrete model id | Unchanged behaviour. No route headers come back. |
| A logical route, e.g. `coding-implementation` | The preferred form. A role's default route name is its capability with `.` replaced by `-`. Override it with `planner_worker.roles.<role>.alias`. |
| `cap:coding.implementation?minimum_context=128000&family=qwen-27b` | Sent only when the catalogue advertises capabilities but lists no model that serves the role (for example, the model is restorable but not loaded). Capabilities and `minimum_context` are hard constraints and are never relaxed. `family` and `size_class` are preferences. |

The hint headers `x-inferweave-capabilities`, `x-inferweave-min-context` and
`x-inferweave-prefer-family` are also sent by the tool-less gateway
executor. InferWeave applies them only when the `model` name resolves to
nothing.

## 2. Catalogue (`GET /v1/models`)

- **Route rows:** `x_alias: true`, `x_backing_model`, `x_route_generation`,
  `x_capabilities`, `x_context_window`, `x_state`. Route rows have no `slots`.
- **Described models** add `x_capabilities`, `x_family`, `x_size_class`,
  `x_tools`, `x_structured_output`, `x_modalities` and `x_aliases`.
- **Context window** is read from `x_context_window`. Older gateways may send
  `ctx_per_request` or `context_length`, which are still accepted.
- **`x_state`** is `hot` or `cold` on concrete rows. `loading`, `draining` and
  `lost` appear on route rows, on candidates and on retired models
  (`draining`). Resolution never picks a row whose state is `draining`,
  `lost` or `unavailable`.

## 3. Served-route headers

These headers come only for a route or capability request:

- `X-InferWeave-Route`: the route name, or the canonical `cap:` query when a
  query or hints were used.
- `X-InferWeave-Model`
- `X-InferWeave-Route-Generation`
- `X-InferWeave-Route-Fallback`

`RouteTracker` keys on `X-InferWeave-Route`. A changed model or generation on
the same key becomes a `MODEL_TRANSITION` (`route_changed`). A request by
model name has no route headers, and that is not treated as a change.

## 4. Route table and events (hot swap without restart)

- `GET /iw/v1/routes` returns `{generation, routes:{name:{target, fallbacks,
  requires, availability, pending}}, models, retiring}`. It is read by
  `fetchRouteTable`.
- `GET /iw/v1/routes/events?after=<seq>` returns `{events, dropped, after}`.
  `RouteEventFollower` polls it at every inference boundary, before a role is
  resolved and before every request. There is no background timer.
- The first read only sets the cursor. A 404 marks the gateway as
  unsupported, and it is not polled again.

| Event | Client reaction |
|---|---|
| `MODEL_ROUTE_CHANGED`, `MODEL_FALLBACK`, `MODEL_ROUTE_RESOLVED` (with `route` and `model`) | Log `MODEL_TRANSITION` on lane `route:<name>` (`from` = `previousModel`, `reason` = kind) and re-read the catalogue. A header-observed change already logged by an event is not logged twice. |
| `MODEL_DRAINING` (except `retire_refused_still_routed`), `MODEL_UNLOADED` | Exclude the model from resolution. |
| `MODEL_READY` | Make the model eligible again. |
| `dropped > 0` | Re-read the catalogue. |

Admin endpoints (`PUT`/`DELETE /v1/admin/routes/{name}`, `POST
/v1/admin/routes/reload`) are operator tools. pi-engineering never calls them.

## 5. Refusals

The protocol body keeps `code` (for example `capacity_unavailable`,
`model_activating`, `model_not_found`). The availability value is additive:

```json
{"error": {"code": "capacity_unavailable", "x_availability": "NODE_DRAINING",
  "x_route": "coding-implementation", "x_route_generation": 7, "retry_after_ms": 4000,
  "x_fallback_candidates": [{"id": "…", "x_context_window": 131072, "x_state": "hot",
                             "x_capabilities": ["coding.implementation"]}]}}
```

The same value is also sent in the header `X-InferWeave-Error-Code: NODE_DRAINING`.

The availability code is read in this order:

1. `X-InferWeave-Error-Code` header
2. `error.x_availability`
3. `error.code` or the admission `reason`, mapped as follows:

| Value read | Code |
|---|---|
| `capacity_unavailable` | `NO_WORKERS` |
| `model_activating` | `MODEL_LOADING` |
| `queue_*`, `request_not_queueable`, `caller_hard_quota` | `CAPACITY_EXHAUSTED` |
| `routing_snapshot_expired` | `NODE_LOST` |
| `model_not_found`, `unsupported_model_capability`, … | `MODEL_UNAVAILABLE` |

If none of these matches, a bare 404 that mentions a model is treated as
`MODEL_UNAVAILABLE`.

Candidates come from `x_fallback_candidates`. The legacy `error.candidates`
is still accepted.

Reactions are bounded and never repeat forever:

| Code | Reaction |
|---|---|
| `MODEL_LOADING` | Wait `retry_after_ms` (at most 30 s per wait), up to 3 waits, then switch. |
| `CAPACITY_EXHAUSTED`, `NO_WORKERS` | Wait once, then switch. |
| `NODE_DRAINING` | Retry the same route once, then switch. |
| `MODEL_UNAVAILABLE`, `NODE_LOST` | Switch. |

To switch, the client:

1. excludes the failed model;
2. merges the candidates into the catalogue;
3. re-resolves the role, keeping planner and implementer distinct;
4. logs `MODEL_TRANSITION reason=failover:<CODE>`.
