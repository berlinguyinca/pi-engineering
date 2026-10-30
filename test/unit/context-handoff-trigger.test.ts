import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT_THRESHOLDS } from "../../src/context/thresholds.ts";
import { ContextHandoffTrigger } from "../../src/orchestration/contextHandoffTrigger.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import type { Mission } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildContinuityConfig } from "../../src/runtime/continuityWiring.ts";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { CONTEXT_USAGE_SUMMARY, QUOTA_EXHAUSTED_SUMMARY, sanitizeWorkerActivity } from "../../src/workers/activity.ts";

const SHA = "d".repeat(40);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeTrigger(
  opts: {
    sha?: () => string | undefined;
    catalogue?: { id: string; eligible: boolean }[];
    checkpoint?: () => boolean | Promise<boolean>;
    sameModelRef?: (model: string) => { ref: string } | { reason: string };
  } = {},
) {
  const records: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let checkpointRequests = 0;
  const trigger = new ContextHandoffTrigger({
    thresholdsFor: () => DEFAULT_CONTEXT_THRESHOLDS,
    requestCheckpoint: async () => {
      checkpointRequests++;
      return opts.checkpoint ? await opts.checkpoint() : true;
    },
    latestCheckpointSha: () => (opts.sha ? opts.sha() : SHA),
    addHandoff: (record) => {
      records.push(record);
      return record as unknown as HandoffRecord;
    },
    endpoint: () => ({ sessionId: "sess-1", generation: 0 }),
    report: (_m, line) => lines.push(line),
    ...(opts.catalogue ? { catalogue: () => opts.catalogue! } : {}),
    ...(opts.sameModelRef ? { sameModelRef: opts.sameModelRef } : {}),
  });
  return { trigger, records, lines, checkpoints: () => checkpointRequests };
}
const obs = (tokens: number) => ({
  missionId: "m-1",
  taskId: "t-1",
  executionId: "e-1",
  model: "gw/test",
  tokens,
  window: 1000,
});

describe("ContextHandoffTrigger", () => {
  it("preferred waits for a safe point, then fires exactly once however often it is polled", async () => {
    const t = fakeTrigger();
    for (let i = 0; i < 10; i++) await t.trigger.observe(obs(850));
    assert.equal(t.records.length, 0, "not at a safe point yet");
    assert.equal(t.checkpoints(), 0);
    for (let i = 0; i < 10; i++) await t.trigger.safePoint("e-1");
    for (let i = 0; i < 10; i++) await t.trigger.observe(obs(860));
    assert.equal(t.records.length, 1);
    assert.equal(t.checkpoints(), 1, "one checkpoint request per crossing");
    const r = t.records[0]!;
    assert.equal(r.kind, "context");
    assert.equal(r.cause, "context_pressure");
    assert.equal(r.checkpointSha, SHA);
    assert.equal(r.state, "prepared");
  });

  it("emergency checkpoints immediately, once, and is not followed by a redundant preferred handoff", async () => {
    const t = fakeTrigger();
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 1, "no safe point needed");
    await t.trigger.observe(obs(960));
    await t.trigger.safePoint("e-1");
    assert.equal(t.records.length, 1);
  });

  it("preferred then emergency are two distinct crossings", async () => {
    const t = fakeTrigger();
    await t.trigger.observe(obs(850));
    await t.trigger.safePoint("e-1");
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 2);
  });

  it("without a durable checkpoint SHA no record is written and the next opportunity retries", async () => {
    const box: { sha?: string } = {};
    const t = fakeTrigger({ sha: () => box.sha });
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 0);
    assert.match(t.lines.join("\n"), /deferred: no durable checkpoint/);
    box.sha = SHA;
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 1);
    assert.equal(t.records[0]!.checkpointSha, SHA);
  });

  it("a failed checkpoint request never hands off at a stale earlier checkpoint, and is retried", async () => {
    const box = { ok: false };
    const t = fakeTrigger({ checkpoint: () => box.ok });
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 0);
    assert.match(t.lines.join("\n"), /checkpoint request not confirmed/);
    box.ok = true;
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 1);
  });

  it("a throwing dependency is contained and the crossing stays armed", async () => {
    const box = { boom: true };
    const t = fakeTrigger({
      checkpoint: () => {
        if (box.boom) throw new Error("disk gone");
        return true;
      },
    });
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 0);
    assert.match(t.lines.join("\n"), /handoff failed: disk gone/);
    box.boom = false;
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 1);
  });

  it("forget() re-arms a finished execution id", async () => {
    const t = fakeTrigger();
    await t.trigger.observe(obs(950));
    t.trigger.forget("e-1");
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 2);
  });

  it("quota is a distinct cause: recovery handoff, cause quota_exhausted, once", async () => {
    const t = fakeTrigger({
      catalogue: [
        { id: "gw/test", eligible: true },
        { id: "gw/alt", eligible: true },
      ],
    });
    const input = {
      missionId: "m-1",
      taskId: "t-1",
      executionId: "e-1",
      model: "gw/test",
      failureClass: "quota" as const,
    };
    assert.equal(await t.trigger.quotaExhausted(input), "switch_model");
    assert.equal(await t.trigger.quotaExhausted(input), "already_handled");
    assert.equal(t.records.length, 1);
    assert.equal(t.records[0]!.kind, "recovery");
    assert.equal(t.records[0]!.cause, "quota_exhausted");
    assert.equal(t.records[0]!.checkpointSha, SHA);
    assert.match(t.lines.join("\n"), /gw\/alt/);
  });

  it("quota without an alternate pauses; without a checkpoint it records nothing", async () => {
    const paused = fakeTrigger();
    assert.equal(
      await paused.trigger.quotaExhausted({
        missionId: "m-1",
        taskId: "t-1",
        executionId: "e-1",
        model: "gw/test",
        failureClass: "quota",
      }),
      "pause",
    );
    assert.equal(paused.records.length, 1);
    const none = fakeTrigger({ sha: () => undefined });
    assert.equal(
      await none.trigger.quotaExhausted({
        missionId: "m-1",
        taskId: "t-1",
        executionId: "e-1",
        model: "gw/test",
        failureClass: "quota",
      }),
      "fail",
    );
    assert.equal(none.records.length, 0);
  });
});

describe("a context handoff keeps the predecessor's model", () => {
  it("records fromModel and a toModel equal to the routable ref the resolver returns", async () => {
    const asked: string[] = [];
    const t = fakeTrigger({
      sameModelRef: (m) => {
        asked.push(m);
        return { ref: `gw/${m}` };
      },
    });
    await t.trigger.observe({ ...obs(950), model: "test" });
    assert.equal(t.records.length, 1);
    assert.equal(t.records[0]!.cause, "context_pressure");
    assert.equal(t.records[0]!.fromModel, "test");
    assert.equal(t.records[0]!.toModel, "gw/test");
    assert.deepEqual(asked, ["test"]);
    assert.ok(!t.lines.some((l) => /not pinned/.test(l)));
  });

  it("a model that cannot be pinned still hands off, without toModel, and says why once", async () => {
    const t = fakeTrigger({ sameModelRef: () => ({ reason: "the gateway marked it unavailable" }) });
    await t.trigger.observe(obs(950));
    await t.trigger.observe(obs(960));
    assert.equal(t.records.length, 1);
    assert.equal(t.records[0]!.fromModel, "gw/test");
    assert.equal("toModel" in t.records[0]!, false);
    assert.equal(
      t.lines.filter((l) => /successor not pinned to gw\/test \(the gateway marked it unavailable\)/.test(l)).length,
      1,
    );
  });

  it("without a resolver only a model already reported as provider/id is pinned", async () => {
    const qualified = fakeTrigger();
    await qualified.trigger.observe(obs(950));
    assert.equal(qualified.records[0]!.toModel, "gw/test");
    const bare = fakeTrigger();
    await bare.trigger.observe({ ...obs(950), model: "bare" });
    assert.equal("toModel" in bare.records[0]!, false, "a bare id is never guessed into a provider");
    assert.ok(bare.lines.some((l) => /not reported as provider\/id/.test(l)));
  });

  it("an unknown serving model is not pinned", async () => {
    const t = fakeTrigger();
    await t.trigger.observe({ ...obs(950), model: "" });
    assert.equal("toModel" in t.records[0]!, false);
    assert.ok(t.lines.some((l) => /serving model is unknown/.test(l)));
  });

  it("a deferred handoff (no durable checkpoint) writes no record and no 'not pinned' line", async () => {
    const t = fakeTrigger({ sha: () => undefined, sameModelRef: () => ({ reason: "gone" }) });
    await t.trigger.observe(obs(950));
    assert.equal(t.records.length, 0);
    assert.ok(!t.lines.some((l) => /not pinned/.test(l)));
  });

  it("the quota path is unchanged: its toModel is still the configured fallback, not the predecessor", async () => {
    const t = fakeTrigger({
      catalogue: [{ id: "gw/fallback", eligible: true }],
      sameModelRef: () => ({ ref: "gw/test" }),
    });
    await t.trigger.quotaExhausted({
      missionId: "m-1",
      taskId: "t-1",
      executionId: "e-1",
      model: "gw/test",
      failureClass: "quota",
      role: "implementer",
    });
    assert.equal(t.records[0]!.cause, "quota_exhausted");
    assert.equal(t.records[0]!.toModel, "gw/fallback");
  });
});

describe("worker activity carries the signals as numbers only", () => {
  it("context usage passes the sanitizer; garbage does not", () => {
    const ok = sanitizeWorkerActivity({
      kind: "state",
      summary: CONTEXT_USAGE_SUMMARY,
      meaningfulProgress: false,
      context: { tokens: 800, window: 1000, model: "gw/test" },
    });
    assert.deepEqual(ok?.context, { tokens: 800, window: 1000, model: "gw/test" });
    for (const context of [
      { tokens: -1, window: 1000, model: "m" },
      { tokens: 5, window: 0, model: "m" },
      { tokens: 5, window: 10, model: "bad model\nwith newline" },
      undefined,
    ]) {
      assert.equal(
        sanitizeWorkerActivity({
          kind: "state",
          summary: CONTEXT_USAGE_SUMMARY,
          meaningfulProgress: false,
          context,
        } as never),
        null,
      );
    }
  });

  it("quota failure passes the sanitizer only as 'quota'", () => {
    assert.equal(
      sanitizeWorkerActivity({
        kind: "state",
        summary: QUOTA_EXHAUSTED_SUMMARY,
        meaningfulProgress: false,
        inferenceFailure: "quota",
      })?.inferenceFailure,
      "quota",
    );
    assert.equal(
      sanitizeWorkerActivity({ kind: "state", summary: QUOTA_EXHAUSTED_SUMMARY, meaningfulProgress: false } as never),
      null,
    );
  });
});

// ── orchestrator wiring: real MissionStore, real Orchestrator, activity events in ─────────────────────────────

function harness() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "Ctx",
    goal: "g",
    user_request: "g",
    repository: "repo",
    base_ref: "main",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const task = store.createTask({ mission_id: mission.mission_id, kind: "agent", role: "implementer", objective: "o" });
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: mission.mission_id,
    backend: "agent",
    model: "gw/test",
  });
  store.checkpointTask({
    checkpointId: "cp-1",
    executionId: execution.execution_id,
    missionId: mission.mission_id,
    taskId: task.task_id,
    repoId: "repo",
    baseSha: "b".repeat(40),
    candidateSha: SHA,
    branch: null,
    worktree: null,
    committedChanges: [],
    preservedUncommittedChanges: [],
    completedDeliverables: [],
    remainingDeliverables: [],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: [],
    artifactHashes: [],
    workerId: null,
    sessionId: null,
    model: "gw/test",
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: new Date().toISOString(),
  });
  const orchestrator = new Orchestrator({
    store,
    backends: {},
    planner: async () => [],
    parentSessionId: "sess-pre",
    phaseHandoff: {},
  });
  // No live execution in a unit harness: stand in for the broker's confirmed-checkpoint answer.
  const broker = (orchestrator as unknown as { broker: { requestCheckpoint: (id: string) => Promise<boolean> } })
    .broker;
  const checkpoint = { confirm: true };
  broker.requestCheckpoint = async () => checkpoint.confirm;
  const ids = { missionId: mission.mission_id, taskId: task.task_id, executionId: execution.execution_id };
  const activity = (event: Record<string, unknown>) =>
    (orchestrator as unknown as { observeWorkerActivity: (e: unknown) => void }).observeWorkerActivity({
      meaningfulProgress: false,
      summary: "x",
      ...ids,
      ...event,
    });
  const context = (tokens: number) =>
    activity({ kind: "state", summary: CONTEXT_USAGE_SUMMARY, context: { tokens, window: 1000, model: "gw/test" } });
  const setPhase = (phase: string) =>
    (orchestrator as unknown as { phase: (m: Mission, p: string) => void }).phase.call(orchestrator, mission, phase);
  return { store, mission, activity, context, setPhase, ids, checkpoint };
}

describe("Orchestrator continuity wiring", () => {
  it("preferred: nothing until a checkpoint boundary, then one context handoff; polls and phase boundaries do not repeat it", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.context(850);
    await flush();
    assert.equal(h.store.listHandoffRecords(h.mission.mission_id).length, 0);
    h.activity({ kind: "checkpoint", summary: "Checkpoint progress recorded", meaningfulProgress: true });
    await flush();
    for (let i = 0; i < 5; i++) {
      h.context(870);
      h.activity({ kind: "checkpoint", summary: "Checkpoint progress recorded", meaningfulProgress: true });
    }
    h.setPhase("classified");
    h.setPhase("executing");
    await flush();
    const records = h.store.listHandoffRecords(h.mission.mission_id).filter((r) => r.kind === "context");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.cause, "context_pressure");
    assert.equal(records[0]!.checkpointSha, SHA);
    assert.deepEqual(records[0]!.predecessor, { sessionId: "sess-pre", generation: 0 });
  });

  it("an unconfirmed checkpoint (broker has no live channel) records nothing", async () => {
    const h = harness();
    h.checkpoint.confirm = false;
    h.context(950);
    await flush();
    assert.equal(h.store.listHandoffRecords(h.mission.mission_id).length, 0);
  });

  it("emergency acts at once, once", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.context(950);
    await flush();
    const records = h.store.listHandoffRecords(h.mission.mission_id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, "context");
    assert.equal(records[0]!.cause, "context_pressure");
  });

  it("a below-threshold session never hands off", async () => {
    const h = harness();
    h.context(600);
    h.activity({ kind: "checkpoint", summary: "Checkpoint progress recorded", meaningfulProgress: true });
    await flush();
    assert.equal(h.store.listHandoffRecords(h.mission.mission_id).length, 0);
  });

  it("quota exhaustion writes a recovery handoff with its own cause", async () => {
    const h = harness();
    h.activity({ kind: "state", summary: QUOTA_EXHAUSTED_SUMMARY, inferenceFailure: "quota" });
    h.activity({ kind: "state", summary: QUOTA_EXHAUSTED_SUMMARY, inferenceFailure: "quota" });
    await flush();
    const records = h.store.listHandoffRecords(h.mission.mission_id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, "recovery");
    assert.equal(records[0]!.cause, "quota_exhausted");
  });

  it("an Orchestrator without phaseHandoff does nothing (default off preserved)", async () => {
    const h = harness();
    const plain = new Orchestrator({ store: h.store, backends: {}, planner: async () => [] });
    (plain as unknown as { observeWorkerActivity: (e: unknown) => void }).observeWorkerActivity({
      kind: "state",
      summary: CONTEXT_USAGE_SUMMARY,
      meaningfulProgress: false,
      context: { tokens: 990, window: 1000, model: "gw/test" },
      ...h.ids,
    });
    await flush();
    assert.equal(h.store.listHandoffRecords(h.mission.mission_id).length, 0);
  });
});

describe("buildContinuityConfig (EngineeringRuntime wiring)", () => {
  it("resolves windows from the registry and thresholds from YAML, per model and per provider", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cw-"));
    try {
      writeFileSync(
        join(dir, "engineering.yaml"),
        "context_thresholds:\n  runtimes:\n    gw: { preferred: 0.75 }\n  models:\n    special: { soft: 0.5, preferred: 0.6, emergency: 0.7 }\nquota_fallbacks:\n  roles:\n    implementer: [special, nowindow, gw/test]\n",
      );
      const cfg = await buildContinuityConfig({
        agentDir: dir,
        models: async () => [
          { provider: "gw", id: "test", contextWindow: 262144 },
          { provider: "gw", id: "special", contextWindow: 100000 },
          { provider: "other", id: "nowindow" },
        ],
        isModelUnavailable: (m) => m.id === "nowindow",
      });
      assert.equal(cfg.contextWindowForModel?.("test"), 262144);
      assert.equal(cfg.contextWindowForModel?.("gw/test"), 262144);
      assert.equal(cfg.contextWindowForModel?.("nowindow"), null);
      assert.deepEqual(cfg.thresholdsForModel?.("gw/test"), { soft: 0.7, preferred: 0.75, emergency: 0.9 });
      assert.deepEqual(cfg.thresholdsForModel?.("special"), { soft: 0.5, preferred: 0.6, emergency: 0.7 });
      assert.deepEqual(cfg.thresholdsForModel?.(null), DEFAULT_CONTEXT_THRESHOLDS);
      assert.equal(cfg.threshold, 0.7);
      assert.deepEqual(
        cfg.quotaCatalogue?.("implementer").map((m) => [m.id, m.eligible]),
        [
          ["special", true],
          ["nowindow", false],
          ["gw/test", true],
        ],
        "only the operator's ordered list, never the whole registry; unavailable models are ineligible",
      );
      assert.deepEqual(cfg.quotaCatalogue?.("reviewer"), [], "no list for the role and no default: none configured");
      // An id that is not in the registry is a config error: fail-closed, the whole block is dropped and logged.
      writeFileSync(
        join(dir, "engineering.yaml"),
        "quota_fallbacks:\n  roles:\n    implementer: [special, unlisted]\n",
      );
      const logs: string[] = [];
      const closed = await buildContinuityConfig({
        agentDir: dir,
        models: async () => [{ provider: "gw", id: "special", contextWindow: 100000 }],
        log: (l) => logs.push(l),
      });
      assert.deepEqual(closed.quotaCatalogue?.("implementer"), []);
      assert.ok(logs.some((l) => /\[quota-fallbacks\] ERROR .*unlisted/.test(l)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable registry means no windows, not a crash", async () => {
    const cfg = await buildContinuityConfig({
      agentDir: "/nonexistent-agent-dir",
      models: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(cfg.contextWindowForModel?.("anything"), null);
  });
});

describe("buildContinuityConfig sameModelRef", () => {
  const build = (models: () => Promise<{ provider: string; id: string }[]>, unavailable: string[] = []) =>
    buildContinuityConfig({
      agentDir: "/nonexistent-agent-dir",
      models,
      isModelUnavailable: (m) => unavailable.includes(`${m.provider}/${m.id}`),
    });

  it("qualifies a bare id and keeps a provider/id as it is", async () => {
    const cfg = await build(async () => [{ provider: "gw", id: "a" }]);
    assert.deepEqual(cfg.sameModelRef?.("a"), { ref: "gw/a" });
    assert.deepEqual(cfg.sameModelRef?.("gw/a"), { ref: "gw/a" });
  });

  it("refuses a model the runtime marked unavailable", async () => {
    const cfg = await build(async () => [{ provider: "gw", id: "a" }], ["gw/a"]);
    assert.deepEqual(cfg.sameModelRef?.("gw/a"), { reason: "the gateway marked it unavailable" });
  });

  it("refuses a model missing from a readable registry, qualified or not", async () => {
    const cfg = await build(async () => [{ provider: "gw", id: "a" }]);
    assert.deepEqual(cfg.sameModelRef?.("b"), { reason: "not in the model registry" });
    assert.deepEqual(cfg.sameModelRef?.("gw/b"), { reason: "not in the model registry" });
  });

  it("with an unreadable registry pins only an explicit provider/id, never a bare id", async () => {
    const cfg = await build(async () => {
      throw new Error("boom");
    });
    assert.deepEqual(cfg.sameModelRef?.("gw/a"), { ref: "gw/a" });
    assert.deepEqual(cfg.sameModelRef?.("a"), { reason: "the model registry is unreadable" });
  });
});
