/**
 * Model takeover (issue #76): when the gateway no longer serves a mission's
 * model, the worker fails with `transient:model_unavailable`. Another eligible
 * model takes over in the same execution, the switch is announced, and the
 * dead model stays excluded from routing for a TTL. Only when no other model
 * is eligible does the outcome stay model_unavailable (the task then FAILs).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoleRouterAdapter } from "../../src/capability/adapter.ts";
import type { WorkerResult } from "../../src/core/types.ts";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { type ModelRoute, realBackends } from "../../src/orchestration/realBackends.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { MODEL_UNAVAILABLE_TTL_MS, UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

const A: ModelRoute = { provider: "gw", id: "model-a" };
const B: ModelRoute = { provider: "gw", id: "model-b" };
const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** A router that ranks `pool` in order and honours `exclude`, like RoleRouter in auto mode. */
function rankedRouter(pool: ModelRoute[], seen: Array<string[]> = []): Pick<RoleRouterAdapter, "route"> {
  return {
    route: async (_role, query) => {
      const excluded = new Set((query?.exclude ?? []).map(key));
      seen.push([...excluded].sort());
      const pick = pool.find((m) => !excluded.has(key(m)));
      return pick ? { provider: pick.provider, id: pick.id } : undefined;
    },
  };
}

function workerRun(result: Partial<WorkerResult> & Pick<WorkerResult, "status" | "summary">): WorkerRun {
  return {
    result: { claims: [], evidence_refs: [], new_hypotheses: [], proposed_tasks: [], details: {}, ...result },
    usage: null,
  };
}

const notFound = workerRun({
  status: "failed",
  summary: 'Worker failed after 2 attempt(s): 404: {"code":"model_not_found"}',
  error: "transient:model_unavailable",
});

/** A gateway that 404s every model in `gone` and completes on any other. */
function gatewayWorker(gone: Set<string>, seen: WorkerRequest[]): WorkerExecutor {
  return {
    async run(req) {
      seen.push({ ...req });
      const model = req.modelOverride ? key(req.modelOverride) : "default";
      return gone.has(model) ? notFound : workerRun({ status: "completed", summary: `done on ${model}` });
    },
  };
}

function harness(pool: ModelRoute[], gone: string[]) {
  let now = 0;
  const unavailable = new UnavailableModels({ now: () => now });
  const routed: Array<string[]> = [];
  const routeModel = createRouteModel({ router: rankedRouter(pool, routed), unavailable });
  const seen: WorkerRequest[] = [];
  const backends = realBackends({
    worker: gatewayWorker(new Set(gone), seen),
    verifier: {} as never,
    artifacts: {} as never,
    git: null,
    cwd: "/repo",
    routeModel,
    onModelUnavailable: (route) => unavailable.mark(route),
  });
  return {
    backends,
    seen,
    routed,
    routeModel,
    unavailable,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("model takeover when the gateway stops serving the routed model", () => {
  it("reruns the agent on the next eligible model with a fresh session and announces the switch", async () => {
    const h = harness([A, B], [key(A)]);
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      signal: new AbortController().signal,
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(
      h.seen.map((r) => r.modelOverride && key(r.modelOverride)),
      [key(A), key(B)],
      "A failed, then B ran",
    );
    assert.notEqual(h.seen[0]!.sessionId, h.seen[1]!.sessionId, "the takeover is a fresh session");
    const announce = "model gw/model-a is no longer served — switched implementer to gw/model-b";
    assert.ok(
      activity.some((e) => e.kind === "state" && e.summary === announce),
      JSON.stringify(activity),
    );
    assert.match(outcome.summary ?? "", new RegExp(announce));
    assert.match(outcome.summary ?? "", /done on gw\/model-b/);
  });

  it("keeps the dead model out of routing until the TTL expires, then offers it again", async () => {
    const h = harness([A, B], [key(A)]);
    await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: new AbortController().signal });
    assert.deepEqual(h.unavailable.list().map(key), [key(A)], "A was marked unavailable");

    assert.deepEqual(await h.routeModel("implementer"), B, "later routing excludes A");
    assert.deepEqual(h.routed.at(-1), [key(A)]);
    h.advance(MODEL_UNAVAILABLE_TTL_MS - 1);
    assert.deepEqual(await h.routeModel("reviewer"), B, "still excluded just before the TTL");
    h.advance(1);
    assert.deepEqual(await h.routeModel("implementer"), A, "A is eligible again once the TTL expires");
    assert.deepEqual(h.unavailable.list(), []);
  });

  it("merges caller exclusions with the unavailable models", async () => {
    const h = harness([A, B, { provider: "gw", id: "model-c" }], []);
    h.unavailable.mark(A);
    assert.deepEqual(await h.routeModel("implementer", { exclude: [B] }), { provider: "gw", id: "model-c" });
    assert.deepEqual(h.routed.at(-1), [key(A), key(B)]);
  });

  it("walks past several dead models in one execution", async () => {
    const C: ModelRoute = { provider: "gw", id: "model-c" };
    const h = harness([A, B, C], [key(A), key(B)]);
    const outcome = await h.backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(
      h.seen.map((r) => r.modelOverride && key(r.modelOverride)),
      [key(A), key(B), key(C)],
    );
    assert.deepEqual(h.unavailable.list().map(key).sort(), [key(A), key(B)]);
  });

  it("with no other eligible model returns the original model_unavailable outcome", async () => {
    const h = harness([A], [key(A)]);
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      signal: new AbortController().signal,
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.error, "transient:model_unavailable");
    assert.equal(outcome.summary, notFound.result.summary);
    assert.equal(h.seen.length, 1, "no rerun without an alternative");
    assert.ok(!activity.some((e) => /switched/.test(e.summary)));
  });

  it("a failure other than model_unavailable is not a takeover", async () => {
    const seen: WorkerRequest[] = [];
    let marked = 0;
    const backends = realBackends({
      worker: {
        async run(req) {
          seen.push(req);
          return workerRun({ status: "failed", summary: "503", error: "transient:server_unavailable" });
        },
      },
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: createRouteModel({ router: rankedRouter([A, B]), unavailable: new UnavailableModels() }),
      onModelUnavailable: () => {
        marked++;
      },
    });
    const outcome = await backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.error, "transient:server_unavailable");
    assert.equal(seen.length, 1);
    assert.equal(marked, 0);
  });

  it("the reviewer takes over too, and independence is judged on the final model", async () => {
    const unavailable = new UnavailableModels();
    const session: ModelRoute = { provider: "gw", id: "session" };
    const seen: WorkerRequest[] = [];
    const gone = new Set([key(A)]);
    const backends = realBackends({
      worker: {
        async run(req) {
          seen.push({ ...req });
          if (req.modelOverride && gone.has(key(req.modelOverride))) return notFound;
          return {
            ...workerRun({ status: "completed", summary: "reviewed" }),
            structured: { verdict: "approve", findings: [], missingTests: [], specGaps: [], acceptanceResults: [] },
          };
        },
      },
      verifier: {} as never,
      artifacts: { readContentByUri: async () => undefined } as never,
      git: null,
      cwd: "/repo",
      reviewFallbackModel: session,
      routeModel: createRouteModel({ router: rankedRouter([A, B]), unavailable, reviewFallbackModel: session }),
      onModelUnavailable: (route) => unavailable.mark(route),
    });
    const activity: WorkerActivity[] = [];
    const outcome = await backends.review.runReview({
      objective: "review",
      signal: new AbortController().signal,
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(
      seen.map((r) => r.modelOverride && key(r.modelOverride)),
      [key(A), key(B)],
    );
    assert.equal(outcome.reviewEvidence?.model, B.id);
    assert.equal(outcome.reviewEvidence?.independenceMode, "independent");
    assert.equal(outcome.reviewEvidence?.reviewerSessionId, seen[1]!.sessionId);
    assert.notEqual(seen[0]!.sessionId, seen[1]!.sessionId);
    assert.ok(
      activity.some((e) => e.summary === "model gw/model-a is no longer served — switched reviewer to gw/model-b"),
    );
  });

  it("a reviewer whose only replacement is the session model reports reduced independence", async () => {
    const session: ModelRoute = { provider: "gw", id: "session" };
    const unavailable = new UnavailableModels();
    const seen: WorkerRequest[] = [];
    const backends = realBackends({
      worker: {
        async run(req) {
          seen.push({ ...req });
          if (req.modelOverride && key(req.modelOverride) === key(A)) return notFound;
          return {
            ...workerRun({ status: "completed", summary: "reviewed" }),
            structured: { verdict: "approve", findings: [], missingTests: [], specGaps: [], acceptanceResults: [] },
          };
        },
      },
      verifier: {} as never,
      artifacts: { readContentByUri: async () => undefined } as never,
      git: null,
      cwd: "/repo",
      reviewFallbackModel: session,
      routeModel: createRouteModel({ router: rankedRouter([A, session]), unavailable, reviewFallbackModel: session }),
      onModelUnavailable: (route) => unavailable.mark(route),
    });
    const outcome = await backends.review.runReview({ objective: "review", signal: new AbortController().signal });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.equal(outcome.reviewEvidence?.model, session.id);
    assert.equal(outcome.reviewEvidence?.independenceMode, "same_model_reduced");
  });
});

describe("model takeover through the mission scheduler", () => {
  function scheduled(pool: ModelRoute[], gone: string[]) {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    for (const s of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const)
      store.transitionMission(m.mission_id, s);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    const h = harness(pool, gone);
    const backends: BrokerBackends = { agent: h.backends.agent };
    const scheduler = new MissionScheduler({ store, broker: new ExecutionBroker({ store, backends }) });
    return { store, m, t, scheduler, h };
  }

  it("the task succeeds on the replacement model", async () => {
    const { store, m, t, scheduler, h } = scheduled([A, B], [key(A)]);
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.equal(h.seen.length, 2);
  });

  it("with no alternative the task FAILs with model_not_found", async () => {
    const { store, m, t, scheduler, h } = scheduled([A], [key(A)]);
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
    assert.equal(h.seen.length, 1);
    const failed = store.getTask(t.task_id) as unknown as { failure_reason?: string };
    assert.match(failed.failure_reason ?? "", /model_not_found/);
  });
});
