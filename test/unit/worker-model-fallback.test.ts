import assert from "node:assert";
import { test } from "node:test";
import type { Model, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

function model(id: string): Model<any> {
  return { id, provider: "test" } as Model<any>;
}

/** A ModelRuntime stub exposing only what resolveModel consumes. */
function stubRuntime(registered: Model<any>[], available: Model<any>[]) {
  return {
    getModel(provider: string, id: string) {
      return registered.find((m) => m.provider === provider && m.id === id);
    },
    async getAvailable() {
      return available;
    },
  } as unknown as Pick<ModelRuntime, "getModel" | "getAvailable">;
}

function req(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    role: "implementer",
    task: "do the thing",
    tools: [],
    cwd: "/tmp",
    ...overrides,
  } as WorkerRequest;
}

test("resolveModel: a resolvable routed override wins", async () => {
  const executor = new PiWorkerExecutor({ agentDir: "/tmp/nowhere" } as never);
  const routed = model("routed");
  const stub = stubRuntime([routed, model("default")], [model("default")]);
  const out = await executor.resolveModel(
    req({ modelOverride: { provider: "test", id: "routed" } }),
    stub,
  );
  assert.equal(out.model, routed);
  assert.equal(out.degradedFrom, undefined);
});

test("resolveModel: an unresolvable override degrades to the construction-time default", async () => {
  const def = model("default");
  const executor = new PiWorkerExecutor({
    agentDir: "/tmp/nowhere",
    model: def,
  } as never);
  const stub = stubRuntime([def], [def]);
  const out = await executor.resolveModel(
    req({ modelOverride: { provider: "test", id: "ghost" } }),
    stub,
  );
  assert.equal(out.model, def);
  assert.equal(out.degradedFrom, "test/ghost");
});

test("resolveModel: an unresolvable override degrades to the first available model", async () => {
  const executor = new PiWorkerExecutor({ agentDir: "/tmp/nowhere" } as never);
  const first = model("first-available");
  const stub = stubRuntime([], [first, model("second")]);
  const out = await executor.resolveModel(
    req({ modelOverride: { provider: "test", id: "ghost" } }),
    stub,
  );
  assert.equal(out.model, first);
  assert.equal(out.degradedFrom, "test/ghost");
});

test("resolveModel: without an override the default model is used", async () => {
  const def = model("default");
  const executor = new PiWorkerExecutor({
    agentDir: "/tmp/nowhere",
    model: def,
  } as never);
  const stub = stubRuntime([], [model("other")]);
  const out = await executor.resolveModel(req(), stub);
  assert.equal(out.model, def);
  assert.equal(out.degradedFrom, undefined);
});

test("resolveModel: no override and no default falls back to the first available model", async () => {
  const executor = new PiWorkerExecutor({ agentDir: "/tmp/nowhere" } as never);
  const first = model("first-available");
  const stub = stubRuntime([], [first]);
  const out = await executor.resolveModel(req(), stub);
  assert.equal(out.model, first);
  assert.equal(out.degradedFrom, undefined);
});

test("resolveModel: nothing anywhere yields no model (caller fails with no-model)", async () => {
  const executor = new PiWorkerExecutor({ agentDir: "/tmp/nowhere" } as never);
  const stub = stubRuntime([], []);
  const out = await executor.resolveModel(
    req({ modelOverride: { provider: "test", id: "ghost" } }),
    stub,
  );
  assert.equal(out.model, undefined);
  assert.equal(out.degradedFrom, "test/ghost");
});
