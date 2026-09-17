import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function setup(backends: BrokerBackends) {
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
  const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
  store.transitionTask(t.task_id, "READY");
  return { store, m, t, broker: new ExecutionBroker({ store, backends }) };
}

describe("ExecutionBroker (spec 03)", () => {
  it("dispatches to the agent backend and records a successful execution", async () => {
    const { store, m, t, broker } = setup({
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    const outcome = await handle.result();
    assert.equal(outcome.exitStatus, "succeeded");
    const ex = store.listExecutions(m.mission_id)[0]!;
    assert.equal(ex.status, "SUCCEEDED");
    assert.equal(ex.backend, "agent");
  });

  it("supports cancellation via the common contract", async () => {
    let started = false;
    const { store, m, t, broker } = setup({
      agent: {
        runAgent: async ({ signal }): Promise<never> => {
          started = true;
          await new Promise<void>((_, rej) => {
            signal.addEventListener("abort", () => rej(new Error("canceled")));
          });
          throw new Error("canceled");
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    const resultP = handle.result(); // starts dispatch; not awaited yet
    assert.ok(started);
    await handle.cancel();
    const ex = store.listExecutions(m.mission_id)[0]!;
    assert.equal(ex.status, "CANCELED");
    await assert.rejects(() => resultP);
  });

  it("supports steering and records it as a task steer request", async () => {
    let steered = "";
    const { store, m, t, broker } = setup({
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
        onSteer: (s) => {
          steered = s;
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    await handle.steer("do not touch schema");
    assert.equal(steered, "do not touch schema");
    assert.equal(store.getTask(t.task_id)!.steer_requests[0], "do not touch schema");
  });

  it("maps process/validation kinds to the right backend", async () => {
    const calls: string[] = [];
    const { m, broker } = setup({
      validation: {
        runValidation: async () => {
          calls.push("validation");
          return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
        },
      },
    });
    const t = m as never;
    void t;
    // Create a validation task directly on the shared store.
    const store = (broker as unknown as { store: MissionStore }).store;
    const vt = store.createTask({
      mission_id: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate",
    });
    const handle = await broker.execute({
      taskId: vt.task_id,
      missionId: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate",
    });
    await handle.result();
    assert.deepEqual(calls, ["validation"]);
  });
});
