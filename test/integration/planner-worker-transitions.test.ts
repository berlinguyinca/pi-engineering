import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { planTransition } from "../../src/plannerWorker/compatibility.ts";
import {
  RouteEventFollower,
  RouteTracker,
  availabilityFromText,
  capabilityQuery,
  chatCompletion,
  decideAvailability,
  fetchCatalog,
  fetchRouteTable,
  parseAvailabilityError,
} from "../../src/plannerWorker/gateway.ts";
import { assessSessionSwitch } from "../../src/plannerWorker/sessionSwitch.ts";
import { TransitionLog, readTransitions } from "../../src/plannerWorker/transitions.ts";
import { type GatewayServer, inferweaveRefusal, startGatewayServer } from "../support/gatewayServer.ts";

const servers: GatewayServer[] = [];
const dirs: string[] = [];
after(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const m128 = {
  id: "m128",
  contextWindow: 128_000,
  modalities: ["text"],
  tools: true,
  structuredOutput: true,
  capabilities: [],
};
const m64 = {
  id: "m64",
  contextWindow: 64_000,
  modalities: ["text"],
  tools: true,
  structuredOutput: true,
  capabilities: [],
};
const m256 = {
  id: "m256",
  contextWindow: 256_000,
  modalities: ["text"],
  tools: true,
  structuredOutput: true,
  capabilities: [],
};

test("context compatibility yields the four outcomes in preference order", () => {
  // 91k tokens do not fit a 64k model; another compatible model is preferred.
  const other = planTransition(m64, { contextTokens: 91_000, canCompact: true }, [m64, m256]);
  assert.equal(other.outcome, "other_model");
  assert.equal(other.outcome === "other_model" ? other.model.id : "", "m256");
  // No alternative: compact to fit.
  const compact = planTransition(m64, { contextTokens: 91_000, canCompact: true }, [m64]);
  assert.equal(compact.outcome, "compact");
  assert.equal(compact.outcome === "compact" ? compact.targetTokens : 0, 64_000 - 4_096);
  // Cannot compact: a task-specific handoff.
  const handoff = planTransition(m64, { contextTokens: 91_000, handoffTokens: 3_000 }, []);
  assert.equal(handoff.outcome, "handoff");
  // Nothing fits: reject.
  const reject = planTransition(m64, { contextTokens: 91_000 }, []);
  assert.equal(reject.outcome, "reject");
  // Hard incompatibilities reject regardless of size.
  const vision = planTransition(m128, { contextTokens: 1_000, modalities: ["image"] }, []);
  assert.equal(vision.outcome, "reject");
  assert.match(vision.outcome === "reject" ? vision.reasons.join() : "", /lacks image/);
  const noTools = planTransition({ ...m128, tools: false }, { contextTokens: 10, needsTools: true }, [m256]);
  assert.equal(noTools.outcome, "other_model");
  // Planner -> worker: a handoff even when the whole context would fit.
  const pw = planTransition(m128, { contextTokens: 30_000, handoffTokens: 2_000, preferHandoff: true }, []);
  assert.deepEqual(pw, { outcome: "switch", model: m128, context: "handoff", notes: [] });
});

test("a live session switch to a smaller model asks for compaction", () => {
  const plan = assessSessionSwitch({
    next: { id: "small", provider: "gw", contextWindow: 64_000 },
    contextTokens: 91_000,
  });
  assert.equal(plan.outcome, "compact");
  const ok = assessSessionSwitch({
    next: { id: "big", provider: "gw", contextWindow: 262_144 },
    contextTokens: 91_000,
  });
  assert.equal(ok.outcome, "switch");
});

test("availability metadata from a real gateway response is classified and bounded", async () => {
  const server = await startGatewayServer({
    respond: (_req, i) => {
      // The shape InferWeave sends (docs/specs/logical-routes.md §4): the protocol
      // `code` is unchanged; availability is additive.
      if (i === 0) {
        return inferweaveRefusal({
          code: "capacity_unavailable",
          availability: "NODE_DRAINING",
          route: "coding-implementation",
          routeGeneration: 7,
          candidates: [
            { id: "other-impl", x_capabilities: ["coding.implementation"], x_context_window: 131072, x_state: "hot" },
          ],
        });
      }
      if (i === 1)
        return inferweaveRefusal({ code: "model_activating", availability: "MODEL_LOADING", retryAfterMs: 1500 });
      // Older gateways: the admission payload, a bare 404 and a legacy error.code/candidates body.
      if (i === 2) {
        return {
          status: 503,
          body: { type: "inference_admission", reason: "model_loading", message: "loading", retry_after_ms: 1500 },
        };
      }
      if (i === 3) {
        return {
          status: 503,
          body: {
            error: {
              code: "MODEL_UNAVAILABLE",
              message: "gone",
              candidates: [{ id: "legacy", ctx_per_request: 65536 }],
            },
          },
        };
      }
      if (i === 4) return { status: 503, body: { error: { code: "capacity_unavailable", message: "busy" } } };
      return { status: 404, body: { error: { message: "model ghost not found" } } };
    },
  });
  servers.push(server);
  const conn = { baseUrl: server.baseUrl };
  const outcomes = [];
  for (let i = 0; i < 6; i++)
    outcomes.push(await chatCompletion(conn, { model: "coding-implementation", system: "s", user: "u" }));
  const parsed = outcomes.map((o) => {
    assert.equal(o.ok, false);
    if (o.ok) return null;
    const e = o.error as { body: unknown; headers: Record<string, string> };
    return parseAvailabilityError(o.status, e.body, e.headers);
  });
  assert.equal(parsed[0]?.code, "NODE_DRAINING", "x_availability wins over the protocol code");
  assert.equal(parsed[0]?.candidates[0]?.id, "other-impl");
  assert.equal(parsed[0]?.candidates[0]?.contextWindow, 131072);
  assert.equal(parsed[0]?.route, "coding-implementation");
  assert.equal(parsed[0]?.routeGeneration, 7);
  assert.equal(parsed[1]?.code, "MODEL_LOADING");
  assert.equal(parsed[1]?.retryAfterMs, 1500);
  assert.equal(parsed[2]?.code, "MODEL_LOADING");
  assert.equal(parsed[3]?.code, "MODEL_UNAVAILABLE");
  assert.equal(parsed[3]?.candidates[0]?.contextWindow, 65536);
  assert.equal(parsed[4]?.code, "NO_WORKERS");
  assert.equal(parsed[5]?.code, "MODEL_UNAVAILABLE");
  // The header alone is enough.
  assert.equal(parseAvailabilityError(503, {}, { "X-InferWeave-Error-Code": "NODE_LOST" })?.code, "NODE_LOST");
  assert.equal(parseAvailabilityError(500, { error: { message: "boom" } }), null);
  assert.equal(availabilityFromText("upstream said NODE_LOST"), "NODE_LOST");
  assert.equal(availabilityFromText("404 model_not_found"), "MODEL_UNAVAILABLE");

  // Never retry an unavailable model forever.
  assert.deepEqual(decideAvailability("MODEL_UNAVAILABLE", 0), { action: "switch" });
  assert.deepEqual(decideAvailability("MODEL_LOADING", 0, 1500), { action: "wait", ms: 1500 });
  assert.deepEqual(decideAvailability("MODEL_LOADING", 3, 1500), { action: "switch" });
  assert.deepEqual(decideAvailability("NODE_DRAINING", 0), { action: "retry_same" });
  assert.deepEqual(decideAvailability("CAPACITY_EXHAUSTED", 1), { action: "switch" });
});

test("route changes behind a logical alias are observed between requests and logged as transitions", async () => {
  const server = await startGatewayServer({
    models: [
      { id: "impl-v1", x_capabilities: ["coding.implementation"], x_context_window: 131072, x_state: "hot" },
      { id: "impl-v2", x_capabilities: ["coding.implementation"], x_context_window: 262144, x_state: "hot" },
    ],
    routes: { "coding-implementation": "impl-v1" },
    respond: () => ({ content: "ok" }),
  });
  servers.push(server);
  const conn = { baseUrl: server.baseUrl };
  const catalog = await fetchCatalog(conn);
  const alias = catalog.find((m) => m.id === "coding-implementation");
  assert.equal(alias?.alias, true);
  assert.equal(alias?.backing, "impl-v1");
  assert.equal(alias?.contextWindow, 131072, "x_context_window is the context field");

  const dir = await mkdtemp(join(tmpdir(), "pw-trans-"));
  dirs.push(dir);
  const log = new TransitionLog({ path: join(dir, "transitions.jsonl") });
  const tracker = new RouteTracker();
  const req = { model: "coding-implementation", system: "s", user: "u" };
  const first = await chatCompletion(conn, req);
  assert.ok(first.ok);
  assert.deepEqual(first.served, {
    requested: "coding-implementation",
    model: "impl-v1",
    alias: "coding-implementation",
    generation: 1,
    fallback: false,
  });
  assert.equal(tracker.observe(first.served), null);
  log.record({
    lane: "t1",
    to: first.served.model,
    reason: "implementation",
    task: "t1",
    role: "implementer",
    context: "handoff",
  });

  // A request by model name gets no route headers at all.
  const byName = await chatCompletion(conn, { ...req, model: "impl-v1" });
  assert.ok(byName.ok);
  assert.deepEqual(byName.served, { requested: "impl-v1", model: "impl-v1" });
  assert.equal(tracker.observe(byName.served), null);

  // The gateway swaps the backing model between requests; the client does not restart.
  server.rebind("coding-implementation", "impl-v2");
  const second = await chatCompletion(conn, req);
  assert.ok(second.ok);
  const change = tracker.observe(second.served);
  assert.deepEqual(change, {
    alias: "coding-implementation",
    from: "impl-v1",
    to: "impl-v2",
    fromGeneration: 1,
    toGeneration: 2,
  });
  log.record({
    lane: "t1",
    to: second.served.model,
    reason: "route_changed",
    task: "t1",
    role: "implementer",
    context: "direct",
  });
  // Same model again: no event.
  assert.equal(
    log.record({ lane: "t1", to: "impl-v2", reason: "retry", task: "t1", role: "implementer", context: "direct" }),
    null,
  );

  await log.flush();
  const persisted = await readTransitions(join(dir, "transitions.jsonl"));
  assert.deepEqual(
    persisted.map((e) => [e.from, e.to, e.reason]),
    [
      [null, "impl-v1", "implementation"],
      ["impl-v1", "impl-v2", "route_changed"],
    ],
  );
});

test("route events are followed incrementally; a plain gateway without the endpoint is tolerated", async () => {
  const server = await startGatewayServer({
    models: [{ id: "impl-v1", x_capabilities: ["coding.implementation"], x_context_window: 131072 }],
    routes: { "coding-implementation": "impl-v1" },
    respond: () => ({ content: "ok" }),
  });
  servers.push(server);
  const follower = new RouteEventFollower({ baseUrl: server.baseUrl });
  assert.deepEqual(await follower.poll(), { events: [], dropped: 0 });
  server.rebind("coding-implementation", "impl-v2");
  server.emit({ kind: "MODEL_DRAINING", model: "impl-v1", reason: "retired" });
  const batch = await follower.poll();
  assert.deepEqual(
    batch.events.map((e) => [e.kind, e.route ?? null, e.model ?? null, e.previousModel ?? null, e.generation]),
    [
      ["MODEL_ROUTE_CHANGED", "coding-implementation", "impl-v2", "impl-v1", 2],
      ["MODEL_DRAINING", null, "impl-v1", null, 2],
    ],
  );
  assert.deepEqual((await follower.poll()).events, [], "only new events are returned");
  const table = await fetchRouteTable({ baseUrl: server.baseUrl });
  assert.equal(table?.generation, 2);
  assert.equal(table?.routes["coding-implementation"]?.target, "impl-v2");

  const plain = await startGatewayServer({ models: [{ id: "m" }], respond: () => ({ content: "ok" }) });
  servers.push(plain);
  const none = new RouteEventFollower({ baseUrl: plain.baseUrl });
  assert.deepEqual(await none.poll(), { events: [], dropped: 0 });
  assert.equal(none.supported, false);
  assert.equal(await fetchRouteTable({ baseUrl: plain.baseUrl }), null);
});

test("capability queries use the InferWeave grammar", () => {
  assert.equal(
    capabilityQuery({
      capabilities: ["coding", "tool_use"],
      minimumContext: 128000,
      family: "qwen",
      sizeClass: "medium",
    }),
    "cap:coding,tool_use?minimum_context=128000&family=qwen&size_class=medium",
  );
  assert.equal(capabilityQuery({ capabilities: ["coding.implementation"] }), "cap:coding.implementation");
  assert.equal(capabilityQuery({ capabilities: ["Bad Name"] }), null);
});
