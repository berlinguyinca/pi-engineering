/**
 * Model takeover (issue #76): when the gateway no longer serves a mission's
 * model, the worker fails with `transient:model_unavailable` (or, for a model
 * pruned from the local runtime, `unknown-model`). Another eligible model takes
 * over in the same execution, the switch is announced, and the dead model stays
 * excluded from routing for a TTL. Only when no other model is eligible does
 * the outcome stay model_unavailable (the task then FAILs).
 *
 * Routing runs on a real RoleRouter over an in-memory capability registry; only
 * the worker (the gateway) is a stub.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { RoleRouterAdapter } from "../../src/capability/adapter.ts";
import type { ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import type { WorkerResult } from "../../src/core/types.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { type ModelRecord, type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MAX_TRACKED_MISSIONS, realBackends } from "../../src/orchestration/realBackends.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { ProbeResult } from "../../src/resilience/probe.ts";
import {
  MODEL_UNAVAILABLE_TTL_MS,
  UnavailableModels,
  createRouteModel,
  followUnavailableModels,
} from "../../src/runtime/modelRouting.ts";
import { type TelemetryNotice, setTelemetrySink } from "../../src/telemetry/sink.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

const A: ModelRef = { provider: "gw", id: "model-a" };
const B: ModelRef = { provider: "gw", id: "model-b" };
const C: ModelRef = { provider: "gw", id: "model-c" };
const Z: ModelRef = { provider: "gw", id: "model-z" };
const SESSION: ModelRef = { provider: "gw", id: "session" };

class InventorySource implements ModelSource {
  readonly name = "test-inventory";
  private readonly records: ModelRecord[];
  constructor(records: ModelRecord[]) {
    this.records = records;
  }
  async discover(): Promise<ModelRecord[]> {
    return this.records;
  }
}

/**
 * A real RoleRouter over `models`. Every model is equally capable, so ranking
 * falls back to provider/model name order: model-a before model-b, and so on.
 */
async function realRouter(models: ModelRef[]): Promise<Pick<RoleRouterAdapter, "route">> {
  const records = models.map((m) =>
    normalizeModelRecord({ ...m, source: "test", toolCall: true, contextWindow: 200_000 }),
  );
  const registry = await ModelCapabilityRegistry.open({
    sources: [new InventorySource(records)],
    context: { cwd: tmpdir(), agentDir: tmpdir() },
  });
  await registry.refresh();
  const router = new RoleRouter({ registry, policy: DEFAULT_POLICY });
  return {
    route: async (role, query) => {
      const selected = (await router.select({ ...(query ?? {}), role })).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
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

const reviewed = (): WorkerRun => ({
  ...workerRun({ status: "completed", summary: "reviewed" }),
  structured: { verdict: "approve", findings: [], missingTests: [], specGaps: [], acceptanceResults: [] },
});

/**
 * A gateway that 404s every model in `gone` and completes on any other. A
 * request without a model override runs on the executor default (the session model).
 */
function gatewayWorker(
  gone: Set<string>,
  seen: WorkerRequest[],
  failure: WorkerRun = notFound,
  executorDefault: ModelRef = SESSION,
  reportsModel = false,
): WorkerExecutor {
  return {
    async run(req) {
      seen.push({ ...req });
      const ran = req.modelOverride ?? executorDefault;
      const model = modelKey(ran);
      if (gone.has(model)) {
        // A real PiWorkerExecutor names the model a failed attempt ran on.
        return reportsModel
          ? { ...failure, result: { ...failure.result, details: { model: { provider: ran.provider, id: ran.id } } } }
          : failure;
      }
      return req.role === "reviewer" ? reviewed() : workerRun({ status: "completed", summary: `done on ${model}` });
    },
  };
}

async function harness(opts: {
  pool: ModelRef[];
  gone: ModelRef[];
  failure?: WorkerRun;
  /** The session model (default SESSION). */
  session?: ModelRef;
  /** The model the executor really runs unrouted work on (default: the session model). */
  executorDefault?: ModelRef;
  /** Whether a failed attempt names the model it ran on (as PiWorkerExecutor does). */
  reportsModel?: boolean;
}) {
  const session = opts.session ?? SESSION;
  const executorDefault = opts.executorDefault ?? session;
  let now = 0;
  const unavailable = new UnavailableModels({ now: () => now });
  const routeModel = createRouteModel({
    router: await realRouter(opts.pool),
    unavailable,
    reviewFallbackModel: session,
  });
  const seen: WorkerRequest[] = [];
  const marks: Array<{ model: string; reason: string; missionId?: string; taskId?: string }> = [];
  const backends = realBackends({
    worker: gatewayWorker(new Set(opts.gone.map(modelKey)), seen, opts.failure, executorDefault, opts.reportsModel),
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: "/repo",
    routeModel,
    reviewFallbackModel: session,
    onModelUnavailable: (model, context) => {
      marks.push({ model: modelKey(model), ...context });
      unavailable.mark(model, context, { confirmed: true });
    },
    onModelServed: (model) => unavailable.clear(model),
    isModelUnavailable: (model) => unavailable.has(model),
  });
  return {
    backends,
    seen,
    marks,
    routeModel,
    unavailable,
    models: () => seen.map((r) => modelKey(r.modelOverride ?? executorDefault)),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const signal = () => new AbortController().signal;

describe("model takeover: agent workers", () => {
  it("reruns the agent on the next eligible model with a fresh session and announces the switch", async () => {
    const h = await harness({ pool: [A, B], gone: [A] });
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      missionId: "MSN-1",
      taskId: "TSK-1",
      signal: signal(),
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(B)], "A failed, then B ran");
    assert.notEqual(h.seen[0]!.sessionId, h.seen[1]!.sessionId, "the takeover is a fresh session");
    const announce = "model gw/model-a is no longer served — switched implementer to gw/model-b";
    assert.ok(
      activity.some((e) => e.kind === "state" && e.summary === announce),
      JSON.stringify(activity),
    );
    assert.match(outcome.summary ?? "", new RegExp(announce));
    assert.match(outcome.summary ?? "", /done on gw\/model-b/);
    assert.deepEqual(h.marks, [
      { model: modelKey(A), missionId: "MSN-1", taskId: "TSK-1", reason: notFound.result.summary },
    ]);
  });

  it("keeps the dead model out of routing until the TTL expires, then offers it again", async () => {
    const h = await harness({ pool: [A, B], gone: [A] });
    await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.deepEqual(h.unavailable.list().map(modelKey), [modelKey(A)], "A was marked unavailable");
    assert.deepEqual(await h.routeModel("implementer"), B, "later routing excludes A");
    h.advance(MODEL_UNAVAILABLE_TTL_MS - 1);
    assert.deepEqual(await h.routeModel("implementer"), B, "still excluded just before the TTL");
    h.advance(1);
    assert.deepEqual(await h.routeModel("implementer"), A, "A is eligible again once the TTL expires");
    assert.deepEqual(h.unavailable.list(), []);
  });

  it("merges caller exclusions with the unavailable models", async () => {
    const h = await harness({ pool: [A, B, C], gone: [] });
    h.unavailable.mark(A);
    assert.deepEqual(await h.routeModel("implementer", { exclude: [B] }), C);
  });

  it("walks past several dead models in one execution", async () => {
    const h = await harness({ pool: [A, B, C], gone: [A, B] });
    const outcome = await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(B), modelKey(C)]);
    assert.deepEqual(h.unavailable.list().map(modelKey).sort(), [modelKey(A), modelKey(B)]);
  });

  it("with no other eligible model returns the original model_unavailable outcome", async () => {
    const h = await harness({ pool: [A], gone: [A, SESSION] });
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      signal: signal(),
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.error, "transient:model_unavailable");
    assert.equal(outcome.summary, notFound.result.summary);
    assert.equal(h.seen.length, 1, "no rerun without an alternative");
    assert.ok(!activity.some((e) => /switched/.test(e.summary)));
  });

  it("a failure other than model_unavailable is not a takeover", async () => {
    const failure = workerRun({ status: "failed", summary: "503", error: "transient:server_unavailable" });
    const h = await harness({ pool: [A, B], gone: [A], failure });
    const outcome = await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.equal(outcome.error, "transient:server_unavailable");
    assert.equal(h.seen.length, 1);
    assert.deepEqual(h.marks, []);
  });

  it("a model pruned from the local runtime (unknown-model) is taken over too", async () => {
    const failure = workerRun({
      status: "failed",
      summary: "Routed model gw/model-a is not registered in this runtime.",
      error: "unknown-model",
    });
    const h = await harness({ pool: [A, B], gone: [A], failure });
    const outcome = await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(B)]);
    assert.deepEqual(h.unavailable.list().map(modelKey), [modelKey(A)]);
  });

  it("an 'invalid model name' refusal hands over but does not mark the model runtime-wide", async () => {
    const failure = workerRun({
      status: "failed",
      summary: "Worker failed after 2 attempt(s): 400: invalid model name for the multimodal route",
      error: "transient:model_unavailable",
    });
    const h = await harness({ pool: [A, B], gone: [A], failure });
    const outcome = await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(B)]);
    assert.deepEqual(h.marks, [], "request-specific: not marked");
    assert.deepEqual(h.unavailable.list(), []);
  });

  // Roles the router has no native role for keep running on the executor
  // default on their first attempt, exactly as before; the router only picks
  // the replacement once that model is gone.
  it("an investigator's first attempt runs on the executor default; only its takeover is routed", async () => {
    const h = await harness({ pool: [A, B], gone: [SESSION] });
    const outcome = await h.backends.agent.runAgent({ role: "investigator", objective: "x", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.equal(h.seen[0]!.modelOverride, undefined, "first attempt: no model override");
    assert.deepEqual(h.models(), [modelKey(SESSION), modelKey(A)]);
    assert.deepEqual(h.unavailable.list().map(modelKey), [modelKey(SESSION)]);
  });

  it("an investigator on a healthy default is never routed", async () => {
    const h = await harness({ pool: [A, B], gone: [] });
    await h.backends.agent.runAgent({ role: "investigator", objective: "x", signal: signal() });
    assert.deepEqual(
      h.seen.map((r) => r.modelOverride),
      [undefined],
    );
  });

  it("maps worker roles onto router roles only when choosing a replacement", async () => {
    const h = await harness({ pool: [A], gone: [] });
    assert.deepEqual(await h.routeModel("implementer"), A, "native roles are routed as before");
    for (const role of ["investigator", "scout", "debugger", "architecture-reviewer", "security-review"]) {
      assert.equal(await h.routeModel(role), undefined, `${role}: first attempt stays on the executor default`);
      assert.deepEqual(await h.routeModel(role, { replacement: true }), A, `${role}: replacement is routed`);
    }
  });

  it("marks the model an unrouted attempt really ran on, not the assumed session model", async () => {
    const D: ModelRef = { provider: "gw", id: "executor-default" };
    const h = await harness({ pool: [A], gone: [D], executorDefault: D, reportsModel: true });
    const outcome = await h.backends.agent.runAgent({ role: "investigator", objective: "x", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(D), modelKey(A)]);
    assert.deepEqual(h.unavailable.list().map(modelKey), [modelKey(D)], "the session model is left alone");
  });

  it("the outcome names the model the attempt ran on", async () => {
    const h = await harness({ pool: [A, B], gone: [A] });
    const outcome = await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.deepEqual(outcome.model, B);
  });

  it("the research backend takes over too, starting on the executor default", async () => {
    const h = await harness({ pool: [A, B], gone: [SESSION] });
    const outcome = await h.backends.research.runAgent({ objective: "look around", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.equal(h.seen[0]!.modelOverride, undefined);
    assert.deepEqual(h.models(), [modelKey(SESSION), modelKey(A)]);
  });

  it("forgets the producing models of old missions beyond a bound", async () => {
    const h = await harness({ pool: [A, B, Z], gone: [] });
    // Mission 0's implementer runs on A; then enough other missions to evict it.
    await h.backends.agent.runAgent({ role: "implementer", objective: "x", missionId: "MSN-0", signal: signal() });
    for (let i = 1; i <= MAX_TRACKED_MISSIONS; i++) {
      await h.backends.agent.runAgent({ role: "implementer", objective: "x", missionId: `MSN-${i}`, signal: signal() });
    }
    const recent = await h.backends.review.runReview({
      objective: "r",
      missionId: `MSN-${MAX_TRACKED_MISSIONS}`,
      signal: signal(),
    });
    assert.equal(recent.reviewEvidence?.model, B.id, "a tracked mission still avoids its producer A");
    const evicted = await h.backends.review.runReview({ objective: "r", missionId: "MSN-0", signal: signal() });
    assert.equal(evicted.reviewEvidence?.model, A.id, "the evicted mission's record is gone");
  });

  it("logs every mark with the mission, task and reason", () => {
    const notices: TelemetryNotice[] = [];
    const restore = setTelemetrySink((n) => notices.push(n));
    try {
      new UnavailableModels().mark(A, { missionId: "MSN-1", taskId: "TSK-1", reason: "404 model_not_found" });
    } finally {
      restore();
    }
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /gw\/model-a/);
    assert.match(notices[0]!.text, /MSN-1/);
    assert.match(notices[0]!.text, /TSK-1/);
    assert.match(notices[0]!.text, /404 model_not_found/);
  });
});

describe("model takeover: reviewer", () => {
  it("takes over, announces the switch, and judges independence on the final model", async () => {
    const h = await harness({ pool: [A, B], gone: [A] });
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.review.runReview({
      objective: "review",
      signal: signal(),
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(B)]);
    assert.equal(outcome.reviewEvidence?.model, B.id);
    assert.equal(outcome.reviewEvidence?.independenceMode, "independent");
    assert.equal(outcome.reviewEvidence?.reviewerSessionId, h.seen[1]!.sessionId);
    assert.notEqual(h.seen[0]!.sessionId, h.seen[1]!.sessionId);
    assert.ok(
      activity.some((e) => e.summary === "model gw/model-a is no longer served — switched reviewer to gw/model-b"),
    );
    assert.ok(
      activity.some((e) => e.kind === "execution" && e.stage === "review" && /gw\/model-b/.test(e.summary)),
      "a review-stage notice names the new reviewer model",
    );
  });

  it("falls back once to the session model when no distinct reviewer is left", async () => {
    const h = await harness({ pool: [A], gone: [A] });
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.review.runReview({
      objective: "review",
      signal: signal(),
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(SESSION)]);
    assert.equal(outcome.reviewEvidence?.model, SESSION.id);
    assert.equal(outcome.reviewEvidence?.independenceMode, "same_model_reduced");
    assert.ok(activity.some((e) => e.stage === "review" && /reduced independence/.test(e.summary)));
  });

  it("does not fall back to a session model that is itself unavailable", async () => {
    const h = await harness({ pool: [A], gone: [A, SESSION] });
    // (SESSION was confirmed gone earlier in this runtime.)
    h.unavailable.mark(SESSION);
    const outcome = await h.backends.review.runReview({ objective: "review", signal: signal() });
    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.error, "transient:model_unavailable");
    assert.deepEqual(h.models(), [modelKey(A)]);
  });

  // Separation of duties after a takeover: the session model A is removed, the
  // implementer takes over onto Z, and Z is the only model left. The review
  // may run on Z but must not be recorded as independent.
  it("a review on the implementer's takeover model is recorded as reduced independence", async () => {
    const h = await harness({ pool: [A, Z], gone: [A], session: A });
    const implemented = await h.backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      missionId: "MSN-1",
      signal: signal(),
    });
    assert.equal(implemented.exitStatus, "succeeded");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(Z)]);
    const activity: WorkerActivity[] = [];
    const outcome = await h.backends.review.runReview({
      objective: "review",
      missionId: "MSN-1",
      signal: signal(),
      onActivity: (e) => activity.push(e),
    });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.equal(h.models().at(-1), modelKey(Z));
    assert.equal(outcome.reviewEvidence?.model, Z.id);
    assert.equal(outcome.reviewEvidence?.independenceMode, "same_model_reduced");
    assert.ok(
      activity.some((e) => e.stage === "review" && /reduced independence/.test(e.summary)),
      JSON.stringify(activity),
    );
  });

  it("the reviewer avoids the implementer's takeover model when a distinct one exists", async () => {
    const h = await harness({ pool: [A, B, Z], gone: [A] });
    // The implementer takes over from A onto B, which also ranks first for review.
    await h.backends.agent.runAgent({ role: "implementer", objective: "x", missionId: "MSN-2", signal: signal() });
    assert.equal(h.models().at(-1), modelKey(B));
    const outcome = await h.backends.review.runReview({ objective: "review", missionId: "MSN-2", signal: signal() });
    assert.equal(h.models().at(-1), modelKey(Z), "the review runs on a model distinct from the implementer's");
    assert.equal(outcome.reviewEvidence?.independenceMode, "independent");
  });
});

describe("model takeover through the mission scheduler", () => {
  async function scheduled(pool: ModelRef[], gone: ModelRef[]) {
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
    const h = await harness({ pool, gone });
    const backends: BrokerBackends = { agent: h.backends.agent };
    const scheduler = new MissionScheduler({ store, broker: new ExecutionBroker({ store, backends }) });
    return { store, m, t, scheduler, h };
  }

  it("the task succeeds on the replacement model, and the mark names the mission and task", async () => {
    const { store, m, t, scheduler, h } = await scheduled([A, B], [A]);
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.deepEqual(h.models(), [modelKey(A), modelKey(B)]);
    assert.equal(h.marks[0]?.missionId, m.mission_id);
    assert.equal(h.marks[0]?.taskId, t.task_id);
  });

  it("with no alternative the task FAILs with model_not_found", async () => {
    const { store, m, t, scheduler, h } = await scheduled([A], [A, SESSION]);
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
    assert.equal(h.seen.length, 1);
    const failed = store.getTask(t.task_id) as unknown as { failure_reason?: string };
    assert.match(failed.failure_reason ?? "", /model_not_found/);
  });
});

describe("the recovery probe follows unavailable models", () => {
  const unlistedA: ProbeResult = {
    healthy: false,
    authoritative: true,
    model_unlisted: true,
    model_id: A.id,
    model_provider: A.provider,
    reason: "model model-a is not served",
  };

  it("a model reported unavailable by the scheduler gets a TTL-only mark (never confirmed)", async () => {
    let now = 0;
    const unavailable = new UnavailableModels({ now: () => now });
    const probe = followUnavailableModels({ probe: async () => unlistedA }, unavailable);
    probe.reportModelUnavailable?.(A, { missionId: "MSN-1", taskId: "TSK-1", reason: "503" });
    assert.deepEqual(unavailable.list(), [A]);
    now += MODEL_UNAVAILABLE_TTL_MS;
    await probe.probe();
    assert.equal(unavailable.has(A), false, "a 503 is heuristic: an unlisted alias is not excluded for good");
  });

  it("a model that serves an attempt again is unmarked and no longer confirmed", async () => {
    const h = await harness({ pool: [A], gone: [] });
    h.unavailable.mark(A, undefined, { confirmed: true });
    h.advance(MODEL_UNAVAILABLE_TTL_MS);
    const outcome = await h.backends.agent.runAgent({ role: "implementer", objective: "x", signal: signal() });
    assert.equal(outcome.exitStatus, "succeeded");
    h.unavailable.refreshIfConfirmed(A);
    assert.equal(h.unavailable.has(A), false, "A came back: an unlisted answer no longer re-marks it");
  });

  it("an expired mark is refreshed when the probe still finds the model unlisted", async () => {
    let now = 0;
    const unavailable = new UnavailableModels({ now: () => now });
    unavailable.mark(A, undefined, { confirmed: true });
    now += MODEL_UNAVAILABLE_TTL_MS;
    assert.equal(unavailable.has(A), false, "the TTL expired during a long pause");
    const probe = followUnavailableModels({ probe: async () => unlistedA }, unavailable);
    assert.deepEqual(await probe.probe(), unlistedA);
    assert.equal(unavailable.has(A), true, "still gone: excluded again without a 404");
  });

  it("a model never confirmed gone (an unlisted alias) is not marked by the probe", async () => {
    const unavailable = new UnavailableModels();
    const probe = followUnavailableModels({ probe: async () => unlistedA }, unavailable);
    await probe.probe();
    assert.deepEqual(unavailable.list(), []);
  });
});
