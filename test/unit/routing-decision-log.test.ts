/**
 * Routing decisions are durable Mission events (task.routing_decided): why a
 * worker ran on a model that is not the Mission's pin used to be transient
 * worker activity only. Covers every reason code, dedupe, replay of logs that
 * never had the event, best-effort persistence, and the dashboard `why`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkerResult } from "../../src/core/types.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { summarizeMissionModels } from "../../src/orchestration/missionModels.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { type ModelRoute, realBackends } from "../../src/orchestration/realBackends.ts";
import { ROUTING_TEXT_LIMIT, type RoutingDecision } from "../../src/orchestration/routingDecision.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";
import type { WorkerExecutor, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

const PIN: ModelRef = { provider: "gw", id: "pin" };
const OTHER: ModelRef = { provider: "gw", id: "other" };
const THIRD: ModelRef = { provider: "gw", id: "third" };

function newStore(backend = JsonlEventStore.inMemory()) {
  const store = MissionStore.open(backend);
  const m = store.createMission({
    mission_id: "MSN-r",
    title: "t",
    goal: "g",
    user_request: "u",
    repository: "r",
    base_ref: "main",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  for (const [task_id, role] of [
    ["TSK-impl", "implementer"],
    ["TSK-rev", "reviewer"],
  ] as const) {
    store.createTask({
      task_id,
      mission_id: m.mission_id,
      kind: "agent",
      role,
      objective: "o",
      mutates_repo: role === "implementer",
      isolation: "worktree",
      write_domains: ["src/**"],
    });
  }
  return { store, backend };
}

const run = (over: Partial<WorkerResult> & Pick<WorkerResult, "status" | "summary">): WorkerRun => ({
  result: { claims: [], evidence_refs: [], new_hypotheses: [], proposed_tasks: [], details: {}, ...over },
  usage: null,
});
const goneRun = run({ status: "failed", summary: "404 model_not_found", error: "transient:model_unavailable" });
const done = run({ status: "completed", summary: "done" });
const signal = () => new AbortController().signal;

function backendsFor(opts: {
  store: MissionStore;
  routeModel: (
    role: string,
    o?: { missionId?: string; replacement?: boolean; exclude?: ModelRef[] },
  ) => Promise<ModelRoute | undefined>;
  gone?: ModelRef[];
  pin?: ModelRef | null;
  record?: (d: RoutingDecision) => void;
}) {
  const worker: WorkerExecutor = {
    async run(req) {
      const ran = req.modelOverride ?? OTHER;
      return (opts.gone ?? []).some((g) => modelKey(g) === modelKey(ran)) ? goneRun : done;
    },
  };
  return realBackends({
    worker,
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: "/repo",
    routeModel: opts.routeModel as never,
    reviewFallbackModel: OTHER,
    currentOperatorPin: () => (opts.pin === null ? null : (opts.pin ?? PIN)),
    recordRoutingDecision: opts.record ?? ((d) => opts.store.recordRoutingDecision(d)),
  });
}

const dispatch = (b: ReturnType<typeof realBackends>, role = "implementer", taskId = "TSK-impl") =>
  b.agent.runAgent({ role, objective: "o", missionId: "MSN-r", taskId, signal: signal() });

const reasons = (store: MissionStore) => store.listRoutingDecisions("MSN-r").map((d) => d.reason);

describe("createRouteModel reports how it related to the pin", () => {
  const router = (refuse: boolean) =>
    ({
      route: async () => OTHER,
      select: async () => ({
        selected: refuse ? OTHER : PIN,
        rejected: refuse ? [{ model: PIN, stage: "capability", reason: "pin has no tool calling" }] : [],
      }),
    }) as never;
  const make = (extra: object, refuse = false) =>
    createRouteModel({
      router: router(refuse),
      unavailable: new UnavailableModels(),
      operatorPin: () => PIN,
      ...extra,
    });

  it("pin_honoured, pin_refused (+text), pin_excluded_held, pin_excluded_rerouted", async () => {
    assert.equal((await make({})("implementer", { missionId: "M" }))?.pinOutcome, "pin_honoured");
    const refused = await make({}, true)("implementer", { missionId: "M" });
    assert.equal(refused?.pinOutcome, "pin_refused");
    assert.equal(refused?.pinRefusal, "pin has no tool calling");
    const held = await make({ holdPin: true })("implementer", { missionId: "M", exclude: [PIN] });
    assert.equal(held?.pinOutcome, "pin_excluded_held");
    assert.equal(modelKey(held!), modelKey(PIN));
    const rerouted = await make({ holdPin: false })("implementer", { missionId: "M", exclude: [PIN] });
    assert.equal(rerouted?.pinOutcome, "pin_excluded_rerouted");
  });
});

describe("task.routing_decided", () => {
  it("records pin_honoured with mission, task, role, pin and chosen model", async () => {
    const { store } = newStore();
    await dispatch(backendsFor({ store, routeModel: async () => ({ ...PIN, pinOutcome: "pin_honoured" }) }));
    assert.deepEqual(
      store.listRoutingDecisions("MSN-r").map(({ at: _at, ...d }) => d),
      [
        {
          missionId: "MSN-r",
          taskId: "TSK-impl",
          role: "implementer",
          pin: "gw/pin",
          chosen: "gw/pin",
          reason: "pin_honoured",
        },
      ],
    );
  });

  it("records pin_refused with the router's refusal text, truncated", async () => {
    const { store } = newStore();
    const long = "x".repeat(ROUTING_TEXT_LIMIT * 3);
    await dispatch(
      backendsFor({ store, routeModel: async () => ({ ...OTHER, pinOutcome: "pin_refused", pinRefusal: long }) }),
    );
    const [d] = store.listRoutingDecisions("MSN-r");
    assert.equal(d?.reason, "pin_refused");
    assert.equal(d?.chosen, "gw/other");
    assert.equal(d?.refusal?.length, ROUTING_TEXT_LIMIT);
  });

  it("records pin_excluded_held and pin_excluded_rerouted", async () => {
    for (const reason of ["pin_excluded_held", "pin_excluded_rerouted"] as const) {
      const { store } = newStore();
      const chosen = reason === "pin_excluded_held" ? PIN : OTHER;
      await dispatch(backendsFor({ store, routeModel: async () => ({ ...chosen, pinOutcome: reason }) }));
      assert.deepEqual(reasons(store), [reason]);
    }
  });

  it("records reviewer_separation for an independent role placed off the pin", async () => {
    const { store } = newStore();
    await dispatch(
      backendsFor({ store, routeModel: async () => ({ ...OTHER, pinOutcome: "pin_excluded_rerouted" }) }),
      "reviewer",
      "TSK-rev",
    );
    assert.deepEqual(reasons(store), ["reviewer_separation"]);
    // A route with no router metadata at all is classified the same way for a reviewer.
    const second = newStore();
    await dispatch(backendsFor({ store: second.store, routeModel: async () => ({ ...OTHER }) }), "reviewer", "TSK-rev");
    assert.deepEqual(reasons(second.store), ["reviewer_separation"]);
  });

  it("records takeover_after_failure with from, to and the error class", async () => {
    const { store } = newStore();
    const b = backendsFor({
      store,
      gone: [PIN],
      routeModel: async (_role, o) =>
        o?.replacement ? { ...THIRD, pinOutcome: "pin_excluded_rerouted" } : { ...PIN, pinOutcome: "pin_honoured" },
    });
    const outcome = await dispatch(b);
    assert.equal(outcome.exitStatus, "succeeded");
    const [d] = store.listRoutingDecisions("MSN-r");
    assert.equal(d?.reason, "takeover_after_failure");
    assert.equal(d?.from, "gw/pin");
    assert.equal(d?.to, "gw/third");
    assert.equal(d?.errorClass, "transient:model_unavailable");
    assert.equal(d?.chosen, "gw/third");
  });

  it("writes one event per change: identical consecutive decisions are deduped", async () => {
    const { store, backend } = newStore();
    const b = backendsFor({ store, routeModel: async () => ({ ...PIN, pinOutcome: "pin_honoured" }) });
    await dispatch(b);
    await dispatch(b);
    await dispatch(b);
    await store.flush();
    const count = () => backend.all().filter((e) => e.type === "task.routing_decided").length;
    assert.equal(count(), 1);
    // A different task, and a changed decision on the same task, each add one.
    await dispatch(b, "implementer", "TSK-rev");
    const changed = backendsFor({
      store,
      routeModel: async () => ({ ...OTHER, pinOutcome: "pin_refused", pinRefusal: "no" }),
    });
    await dispatch(changed);
    await store.flush();
    assert.equal(count(), 3);
  });

  it("records nothing when the mission has no pin", async () => {
    const { store } = newStore();
    await dispatch(backendsFor({ store, pin: null, routeModel: async () => ({ ...OTHER }) }));
    assert.deepEqual(reasons(store), []);
  });

  it("a recording failure never fails dispatch", async () => {
    const { store } = newStore();
    const b = backendsFor({
      store,
      routeModel: async () => ({ ...PIN, pinOutcome: "pin_honoured" }),
      record: () => {
        throw new Error("disk full");
      },
    });
    assert.equal((await dispatch(b)).exitStatus, "succeeded");
  });

  it("a store whose backend rejects appends swallows the failure", async () => {
    const backend = JsonlEventStore.inMemory();
    const { store } = newStore(backend);
    const append = backend.append.bind(backend);
    backend.append = async (e) => {
      if (e.type === "task.routing_decided") throw new Error("ENOSPC");
      return append(e);
    };
    assert.doesNotThrow(() =>
      store.recordRoutingDecision({
        missionId: "MSN-r",
        taskId: "TSK-impl",
        role: "implementer",
        pin: "gw/pin",
        chosen: "gw/other",
        reason: "pin_refused",
      }),
    );
    await store.flush().catch(() => undefined);
    // An unknown mission or reason is dropped, not thrown.
    assert.equal(
      store.recordRoutingDecision({
        missionId: "nope",
        taskId: "x",
        role: "r",
        pin: null,
        chosen: null,
        reason: "pin_refused",
      }),
      false,
    );
  });

  it("replays: the latest decision is rebuilt, and a log without the event is unchanged", async () => {
    const { store, backend } = newStore();
    await store.flush();
    const before = MissionStore.fromEvents(backend.all()).stateDigest();
    store.recordRoutingDecision({
      missionId: "MSN-r",
      taskId: "TSK-impl",
      role: "implementer",
      pin: "gw/pin",
      chosen: "gw/other",
      reason: "pin_refused",
      refusal: "too small",
    });
    await store.flush();
    const replayed = MissionStore.fromEvents(backend.all());
    assert.deepEqual(replayed.listRoutingDecisions("MSN-r"), store.listRoutingDecisions("MSN-r"));
    assert.equal(replayed.stateDigest(), store.stateDigest());
    // Dedupe survives a restart: the same decision after replay writes nothing.
    const reopened = MissionStore.open(backend);
    assert.equal(
      reopened.recordRoutingDecision({
        missionId: "MSN-r",
        taskId: "TSK-impl",
        role: "implementer",
        pin: "gw/pin",
        chosen: "gw/other",
        reason: "pin_refused",
        refusal: "too small",
      }),
      false,
    );
    // Old log: dropping the new events replays to exactly the pre-feature state.
    const old = MissionStore.fromEvents(backend.all().filter((e) => e.type !== "task.routing_decided"));
    assert.equal(old.stateDigest(), before);
    assert.deepEqual(old.listRoutingDecisions("MSN-r"), []);
    assert.equal(
      replayed.getMission("MSN-r")?.revision,
      old.getMission("MSN-r")?.revision,
      "a routing decision must not advance the mission revision that fences resumption",
    );
  });
});

describe("dashboard why uses the recorded reason", () => {
  const mission = { operator_model_pin: { provider: "gw", id: "pin", set_at: "2026-10-30T00:00:00Z" } };
  const tasks = [{ task_id: "TSK-impl", role: "implementer" }] as never;
  const workers = [{ workerId: "W1", taskId: "TSK-impl", model: "gw/other", state: "running" as const }];
  const decision: RoutingDecision = {
    missionId: "MSN-r",
    taskId: "TSK-impl",
    role: "implementer",
    pin: "gw/pin",
    chosen: "gw/other",
    reason: "pin_refused",
    refusal: "pin has no tool calling",
  };

  it("fills why from the recorded decision", () => {
    const why = summarizeMissionModels(mission, tasks, workers, [decision]).agents[0]?.why;
    assert.match(why ?? "", /pin gw\/pin refused for implementer \(pin has no tool calling\)/);
  });

  it("falls back to the generic text without a decision, or when it names another model", () => {
    const generic = "the pinned model could not serve this role or was unavailable";
    assert.equal(summarizeMissionModels(mission, tasks, workers).agents[0]?.why, generic);
    assert.equal(
      summarizeMissionModels(mission, tasks, workers, [{ ...decision, chosen: "gw/elsewhere" }]).agents[0]?.why,
      generic,
    );
  });
});
