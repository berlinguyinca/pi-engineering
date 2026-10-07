/**
 * Production arming of the resilient inference layer (fault-tolerance spec
 * §20/§21/§23 + validation findings FINDING-r1JPXE / FINDING-LPiXb4).
 *
 * The core classifier/retry/fallback machinery is proven by
 * resilient-inference-integration.test.ts and resilient-inference-wiring.test.ts.
 * This suite proves the PRODUCTION seams:
 *
 *   1. An already-wrapped runtime can be RE-ARMED — the capability pool is
 *      built after the worker executor in both production constructors, so
 *      idempotence alone would leave fallback/park/status unarmed.
 *   2. MissionCapacityScheduler — the real production scheduler: capacity
 *      query against the shared health + breaker services, park/resumed
 *      through the guarded mission transition hook.
 *   3. The WAITING_FOR_INFERENCE_CAPACITY park is a DURABLE mission state
 *      (survives store close + reopen) and the resume returns to EXECUTING.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DiscoveryContext, ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { CircuitBreakerRegistry } from "../../src/inference/circuitBreaker.ts";
import { MissionCapacityScheduler } from "../../src/inference/missionCapacityScheduler.ts";
import { ModelHealthRegistry } from "../../src/inference/modelHealth.ts";
import { resilientServices } from "../../src/inference/resilientInstall.ts";
import {
  ResilientAttemptFlow,
  type ResilientStreamInstallOptions,
  createResilientStreamSimple,
  installResilientRuntime,
} from "../../src/inference/resilientStream.ts";
import { InferenceTelemetry, type InferenceTelemetryEvent } from "../../src/inference/telemetry.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import type { ModelRecord } from "../../src/lifecycle/types.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const INSTALL_HOLDER = Symbol.for("pi-engineering.resilientInference.install.holder");
const RUNTIME_WRAPPED = Symbol.for("pi-engineering.resilientInference");

function rec(
  input: Partial<Parameters<typeof normalizeModelRecord>[0]> & { provider: string; id: string },
): ModelRecord {
  return normalizeModelRecord({
    source: "test",
    toolCall: true,
    contextWindow: 200_000,
    input: ["text"],
    output: ["text"],
    priceInput: 1,
    priceOutput: 2,
    ...input,
  });
}

class StaticSource implements ModelSource {
  readonly name = "static";
  private readonly records: ModelRecord[];
  constructor(records: ModelRecord[]) {
    this.records = records;
  }
  async discover(): Promise<ModelRecord[]> {
    return this.records;
  }
}

async function makeRegistry(cwd: string, records: ModelRecord[]): Promise<ModelCapabilityRegistry> {
  const registry = await ModelCapabilityRegistry.open({
    sources: [new StaticSource(records)],
    context: { cwd, agentDir: cwd } satisfies DiscoveryContext,
  });
  await registry.refresh();
  return registry;
}

/** Minimal async-iterable stand-in for AssistantMessageEventStream. */
function createNoopStream(): AsyncIterable<unknown> & { push: (e: unknown) => void; end: (e?: unknown) => void } {
  const queue: unknown[] = [];
  let resolveNext: (() => void) | undefined;
  let done = false;
  const notify = () => {
    resolveNext?.();
    resolveNext = undefined;
  };
  return {
    push: (e) => {
      queue.push(e);
      notify();
    },
    end: (e) => {
      if (e !== undefined) queue.push(e);
      done = true;
      notify();
    },
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (queue.length === 0 && !done) {
          await new Promise<void>((r) => {
            resolveNext = r;
          });
        }
        const value = queue.shift();
        if (value === undefined) return { done: true, value: undefined };
        return { done: false, value };
      },
    }),
  };
}

/** The rendered error marker: the stream's final event (raw string end marker). */
function markerOf(events: unknown[]): string {
  const last = events.at(-1);
  if (typeof last === "string") return last;
  return (last as { error?: string } | undefined)?.error ?? "";
}

function baseInstall(overrides: Partial<ResilientStreamInstallOptions> = {}): ResilientStreamInstallOptions {
  return {
    role: "worker",
    refOf: (model) => {
      const m = model as { provider?: string; id?: string };
      return { provider: String(m?.provider ?? ""), id: String(m?.id ?? "") };
    },
    createStream: () => createNoopStream() as never,
    hold: async () => {},
    errorMessage: (model, error) => `static:${modelKey(model as ModelRef)}:${(error as Error).message}`,
    ...overrides,
  } as ResilientStreamInstallOptions;
}

// ─── 1. Re-arm of an already-wrapped runtime ────────────────────────────────

describe("re-arm of an already-wrapped runtime (spec §23 production arming)", () => {
  it("merges late-arriving registry/scheduler/status into the live install", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-eng-rearm-"));
    try {
      const registry = await makeRegistry(cwd, [rec({ provider: "armtest", id: "model-a" })]);
      const status1: string[] = [];
      const status2: string[] = [];
      const scheduler = {
        park: () => {},
        isCapacityAvailable: () => true,
      };
      const runtime = {
        streamSimple: () => {
          throw new Error("never called in this white-box test");
        },
      };

      const first = installResilientRuntime(runtime, baseInstall({ status: (line) => status1.push(line) }));
      assert.equal(first, "installed");
      const second = installResilientRuntime(
        runtime,
        baseInstall({ registry, scheduler, status: (line) => status2.push(line) }),
      );
      assert.equal(second, "already-installed");

      const holder = (runtime as unknown as Record<symbol, { current: ResilientStreamInstallOptions }>)[INSTALL_HOLDER];
      assert.ok(holder, "install holder present on the wrapped runtime");
      // The late-arriving seams are live...
      assert.equal(holder.current.registry, registry);
      assert.equal(holder.current.scheduler, scheduler);
      const late = holder.current.status as (line: string) => void;
      late("probe");
      assert.deepEqual(status2, ["probe"]);
      assert.deepEqual(status1, []);
      // ...while the runtime-bound plumbing survives the merge.
      assert.equal(typeof holder.current.createStream, "function");
      assert.equal(typeof holder.current.hold, "function");
      assert.equal(typeof holder.current.errorMessage, "function");
      assert.equal(typeof holder.current.refOf, "function");
      assert.equal((runtime as unknown as Record<symbol, boolean>)[RUNTIME_WRAPPED], true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("the wrapper reads the re-armed options per call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-eng-rearm-live-"));
    try {
      // The live holder starts WITHOUT a status sink; the re-arm adds one.
      // The error path renders the message through the LIVE options, so the
      // re-armed errorMessage marker proves per-call resolution.
      const holder = { current: baseInstall() };
      const stream = createResilientStreamSimple(
        () => {
          throw new Error("boom");
        },
        holder.current,
        () => holder.current,
      );
      const out = stream({ provider: "p", id: "m" } as never, {} as never, {} as never) as AsyncIterable<unknown>;
      const eventsBefore: unknown[] = [];
      for await (const event of out) eventsBefore.push(event);
      // The stream ends with the raw rendered message (end marker).
      const markerBefore = markerOf(eventsBefore);
      assert.ok(markerBefore.startsWith("static:"), `install-time options used before re-arm (got ${markerBefore})`);

      // Re-arm with a different errorMessage marker + status sink.
      holder.current = {
        ...holder.current,
        errorMessage: (_model, error) => ({ error: `rearmed:${(error as Error).message}` }) as never,
        status: () => {},
      };
      const out2 = stream({ provider: "p", id: "m" } as never, {} as never, {} as never) as AsyncIterable<unknown>;
      const eventsAfter: unknown[] = [];
      for await (const event of out2) eventsAfter.push(event);
      const markerAfter = markerOf(eventsAfter);
      assert.equal(markerAfter, "rearmed:boom", "re-armed options take effect on the next call");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ─── 2. Circuit-breaker gating of fallback selection ────────────────────

describe("circuit-breaker gating of fallback selection (spec §13, FINDING-e63OXY)", () => {
  it("an OPEN breaker blocks same-model retry, excludes the model from fallback, and stays live", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-eng-breaker-"));
    const provider = "breaktest";
    const a: ModelRef = { provider, id: "model-a" };
    const b: ModelRef = { provider, id: "model-b" };
    const c: ModelRef = { provider, id: "model-c" };
    const registry = await makeRegistry(cwd, [rec(a), rec(b), rec(c)]);
    const router = new RoleRouter({ registry, policy: structuredClone(DEFAULT_POLICY) });
    let t = 1_000_000;
    const health = new ModelHealthRegistry({ now: () => t });
    const breakers = new CircuitBreakerRegistry({
      now: () => t,
      failureThreshold: 3,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    const telemetry = new InferenceTelemetry();
    const events: InferenceTelemetryEvent[] = [];
    telemetry.on((e) => events.push(e));
    const flow = new ResilientAttemptFlow(
      {
        role: "worker",
        refOf: (m) => m as ModelRef,
        now: () => t,
        env: {},
        health,
        breakers,
        registry,
        router,
        telemetry,
      },
      a,
    );
    try {
      // model_activating (InferWeave reason) is model-scoped AND has a
      // same-model retry ladder (wait for activation), so the breaker gate
      // is what diverts the flow once the circuit opens — not the ladder.
      const fail = (attempt: number) =>
        flow.decide({
          attempt,
          text: "model activating",
          headers: { "x-inferweave-reason": "model_activating" },
          streamState: { finished: false, outputCommitted: false },
        });

      // Three model-scoped failures on A: the first two wait on A, the
      // third opens the circuit — and the gate must NOT wait on A a fourth
      // time.
      await fail(1);
      assert.equal(modelKey(flow.model), modelKey(a), "attempt 1: still on A");
      await fail(2);
      assert.equal(modelKey(flow.model), modelKey(a), "attempt 2: still on A");
      await fail(3);
      assert.equal(breakers.forModel(a.provider, a.id)!.getState(), "OPEN", "3rd failure opens the circuit");
      assert.notEqual(modelKey(flow.model), modelKey(a), "OPEN breaker diverts from the same model");
      assert.ok(
        events.some((e) => e.name === "inference.fallback.selected"),
        "the gate routes to the capability fallback",
      );
      assert.equal(modelKey(flow.model), modelKey(b), "fallback lands on B");
      // The tripped model is not reselected by any fallback decision.
      for (const e of events.filter((x) => x.name === "inference.fallback.selected")) {
        const to = (e.data as { fallback_model?: string }).fallback_model ?? "";
        assert.ok(!to.includes("model-a"), `fallback never reselects the tripped model (got ${to})`);
      }

      // Trip B (as another flow would), then C: with every model
      // OPEN/excluded, the fallback has no candidate → the flow waits for
      // capacity instead of selecting a dead model.
      const bBreaker = breakers.forModel(b.provider, b.id)!;
      bBreaker.recordFailure();
      bBreaker.recordFailure();
      bBreaker.recordFailure();
      await fail(4);
      assert.equal(bBreaker.getState(), "OPEN");
      assert.equal(modelKey(flow.model), modelKey(c), "fallback lands on C (A and B are OPEN)");
      const cBreaker = breakers.forModel(c.provider, c.id)!;
      cBreaker.recordFailure();
      cBreaker.recordFailure();
      cBreaker.recordFailure();
      await fail(5);
      assert.equal(modelKey(flow.model), modelKey(c), "no candidate: stays put (capacity wait)");
      assert.equal(cBreaker.getState(), "OPEN");

      // Liveness: once C's cooldown elapses, the gate re-admits a SINGLE
      // HALF_OPEN probe on the same model instead of waiting forever.
      t += 61_000;
      await fail(6);
      assert.equal(cBreaker.getState(), "HALF_OPEN", "cooldown elapsed → single probe armed");
      assert.equal(modelKey(flow.model), modelKey(c), "the probe runs on C");

      // A served probe closes the circuit.
      flow.served(c);
      assert.equal(cBreaker.getState(), "CLOSED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ─── 3. MissionCapacityScheduler (the production scheduler) ─────────────────

describe("MissionCapacityScheduler (production WAITING_FOR_INFERENCE_CAPACITY)", () => {
  it("capacity query: penalized models and OPEN breakers are excluded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-eng-capacity-"));
    const provider = "captest";
    const a: ModelRef = { provider, id: "model-a" };
    const b: ModelRef = { provider, id: "model-b" };
    const c: ModelRef = { provider, id: "model-c" };
    const registry = await makeRegistry(cwd, [rec(a), rec(b), rec(c)]);
    const scheduler = new MissionCapacityScheduler({ registry: () => registry });
    const services = resilientServices();
    let breaker!: ReturnType<typeof services.breakers.forModel>;
    try {
      assert.equal(scheduler.isCapacityAvailable(), true, "all healthy → capacity");

      services.health.penalize(a, "model_unavailable", { reason: "test" });
      assert.equal(scheduler.isCapacityAvailable(), true, "b/c still healthy → capacity");

      services.health.penalize(b, "model_unavailable", { reason: "test" });
      breaker = services.breakers.forModel(c.provider, c.id);
      for (let i = 0; i < 5; i += 1) breaker.recordFailure();
      assert.equal(breaker.getState(), "OPEN", "breaker tripped past the threshold");
      assert.equal(scheduler.isCapacityAvailable(), false, "every model penalized or OPEN → no capacity");

      services.health.clear(a);
      services.health.clear(b);
      breaker.recordSuccess();
      assert.equal(breaker.getState(), "CLOSED");
      assert.equal(scheduler.isCapacityAvailable(), true, "cleared → capacity again");
    } finally {
      services.health.clear(a);
      services.health.clear(b);
      breaker.recordSuccess();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("no registry → no capacity (fail closed)", () => {
    const scheduler = new MissionCapacityScheduler({});
    assert.equal(scheduler.isCapacityAvailable(), false);
  });

  it("park/resumed drive the guarded mission transition hook", () => {
    const transitions: Array<[string, string]> = [];
    const scheduler = new MissionCapacityScheduler({
      transitionMission: (missionId, state) => {
        transitions.push([missionId, state]);
      },
    });
    const untilMs = Date.now() + 60_000;
    scheduler.park({ missionId: "MSN-cap", role: "implementer", reason: "no_workers", untilMs });
    scheduler.resumed({ missionId: "MSN-cap", role: "implementer", waitedMs: 42_500 });
    assert.deepEqual(transitions, [
      ["MSN-cap", "WAITING_FOR_CAPACITY"],
      ["MSN-cap", "EXECUTING"],
    ]);

    // No missionId (interactive call): no transition, never a throw.
    scheduler.park({ role: "worker", reason: "queue_timeout", untilMs });
    scheduler.resumed({ role: "worker", waitedMs: 1000 });
    assert.equal(transitions.length, 2);
  });
});

// ─── 4. Durable WAITING_FOR_CAPACITY mission state ──────────────────────────

function createMission(store: MissionStore, missionId: string, repository = "/tmp/repo") {
  return store.createMission({
    mission_id: missionId,
    title: "capacity park proof",
    goal: "wait for inference capacity without failing",
    user_request: "wait for inference capacity without failing",
    repository,
    base_ref: "base-sha",
    risk_profile: "low",
    workflow_class: "engineering_review",
  });
}

function transitionToExecuting(store: MissionStore, missionId: string): void {
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(missionId, status, "system");
  }
}

describe("durable WAITING_FOR_INFERENCE_CAPACITY park (spec §20/§21)", () => {
  it("park persists as the real mission state and survives a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-eng-capacity-park-"));
    const eventFile = join(directory, "orchestration.jsonl");
    let storeRef: MissionStore;
    const scheduler = new MissionCapacityScheduler({
      transitionMission: (missionId, state) => {
        try {
          storeRef.transitionMission(missionId, state, "system");
        } catch {
          /* guarded — the orchestrator owns the state */
        }
      },
    });
    try {
      const backend = await JsonlEventStore.open(eventFile);
      storeRef = MissionStore.open(backend);
      const mission = createMission(storeRef, "MSN-capacity-park");
      transitionToExecuting(storeRef, mission.mission_id);
      scheduler.park({
        missionId: mission.mission_id,
        role: "implementer",
        reason: "no_workers",
        untilMs: Date.now() + 3_600_000,
      });
      assert.equal(storeRef.getMission(mission.mission_id)?.status, "WAITING_FOR_CAPACITY");
      await storeRef.flush();
      backend.close();

      // Restart: reopen the same durable store.
      const reopened = await JsonlEventStore.open(eventFile);
      const restored = MissionStore.open(reopened);
      storeRef = restored; // the scheduler's hook targets the live store
      try {
        assert.equal(
          restored.getMission("MSN-capacity-park")?.status,
          "WAITING_FOR_CAPACITY",
          "parked state survives a process restart",
        );
        scheduler.resumed({ missionId: "MSN-capacity-park", role: "implementer", waitedMs: 60_000 });
        assert.equal(restored.getMission("MSN-capacity-park")?.status, "EXECUTING");
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
