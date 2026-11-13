/**
 * A refusal while runtime maintenance drains missions is structured, and the
 * caller says so (issue #511).
 *
 * `orchestrate()` used to throw `new Error("runtime maintenance is draining
 * missions")` while `runSubmittedMission` returned
 * `{ started: false, reason: "runtime_maintenance" }`. A caller catching errors
 * generically absorbed the refused delegation as an unlabelled failure — three
 * times in one session — with no retry hint and nothing saying "delegation
 * blocked". Every throw site now raises `MissionRefusedError` carrying the
 * reason, the remaining drain window, how much is still draining, and how to
 * resume; the mission tool surfaces it as a blocked delegation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MissionLimitsConfig } from "../../src/lifecycle/policy.ts";
import {
  MISSION_REFUSAL_POLL_MS,
  MissionRefusedError,
  missionRefusalText,
} from "../../src/orchestration/missionRefusal.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";

const NO_CAP: MissionLimitsConfig = { worker_inactivity_ms: 3_600_000 };

/**
 * Set the flag the maintenance drain sets. `prepareForMaintenance` deliberately
 * refuses to fence a call that is already in flight, so a test that wants the
 * flag raised mid-call raises it the same way the drain would.
 */
function refuse(orchestrator: Orchestrator): void {
  (orchestrator as unknown as { maintenanceRequested: boolean }).maintenanceRequested = true;
}

function harness(limitsProvider?: () => Promise<MissionLimitsConfig>) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const orchestrator = new Orchestrator({
    store,
    backends: {},
    planner: async () => [],
    limitsProvider: limitsProvider ?? (async () => NO_CAP),
  });
  return { store, orchestrator };
}

test("orchestrate() refuses with a typed reason, a retry window, the drain depth and a resume hint", async () => {
  const { orchestrator } = harness();
  assert.equal((await orchestrator.prepareForMaintenance({ timeoutMs: 50 })).status, "ready");
  const error = await orchestrator.orchestrate("Add a health endpoint").catch((e: unknown) => e);
  assert.ok(error instanceof MissionRefusedError, `expected MissionRefusedError, got ${String(error)}`);
  const refusal = error as MissionRefusedError;
  assert.equal(refusal.reason, "runtime_maintenance", "same reason string the return-shaped entry points use");
  assert.ok(refusal.resumeHint.length > 0, "the caller is told how to resume");
  assert.match(refusal.resumeHint, /resume/);
  assert.ok(
    refusal.retryAfterMs >= MISSION_REFUSAL_POLL_MS,
    `retryAfterMs ${refusal.retryAfterMs} must be at least the poll floor ${MISSION_REFUSAL_POLL_MS}`,
  );
  assert.equal(refusal.draining, 0, "nothing was live when the drain settled");
  // The message stays greppable for the old phrase and adds what to do.
  assert.match(refusal.message, /^runtime maintenance is draining missions/);
  assert.match(missionRefusalText(refusal), /^delegation blocked; continuing read-only — /);
});

test("maintenance begun while orchestrate() awaits the policy refresh refuses the same way", async () => {
  const { store, orchestrator } = harness(async () => {
    // `prepareForMaintenance` will not fence a call that is itself in flight (it
    // returns busy while startingRuns > liveRuns), so the test sets the flag the
    // way the drain sets it; what is under test is the guard after the await.
    refuse(orchestrator);
    return NO_CAP;
  });
  const error = await orchestrator.orchestrate("Add a health endpoint").catch((e: unknown) => e);
  assert.ok(error instanceof MissionRefusedError, `expected MissionRefusedError, got ${String(error)}`);
  assert.equal(store.listMissions().length, 0, "the refused call started no mission");
});

test("maintenance begun while the workspace resolves refuses before any mission is created", async () => {
  const { store, orchestrator } = harness();
  // The workspace resolution is the last await before the mission row is written;
  // maintenance arriving there must still stop the mission from being created.
  (orchestrator as unknown as { workspaceResolver: unknown }).workspaceResolver = {
    resolve: async () => {
      refuse(orchestrator);
      throw new Error("resolver stopped for the test");
    },
    resolveRepository: async () => {
      refuse(orchestrator);
      throw new Error("resolver stopped for the test");
    },
  };
  const error = await orchestrator
    .orchestrate("Add a health endpoint", { repository: ".", baseRef: "", mutationRequested: true })
    .catch((e: unknown) => e);
  assert.ok(error instanceof MissionRefusedError, `expected MissionRefusedError, got ${String(error)}`);
  assert.equal(store.listMissions().length, 0, "the refused call started no mission");
});

test("endMaintenance() clears the refusal", async () => {
  const { store, orchestrator } = harness();
  assert.equal((await orchestrator.prepareForMaintenance({ timeoutMs: 10 })).status, "ready");
  await assert.rejects(() => orchestrator.orchestrate("Add a health endpoint"), MissionRefusedError);
  orchestrator.endMaintenance();
  try {
    await orchestrator.orchestrate("Add a health endpoint");
  } catch (error) {
    assert.ok(
      !(error instanceof MissionRefusedError),
      `after endMaintenance() the refusal must be gone, got ${String(error)}`,
    );
  }
  // The refused attempts created nothing; only the post-maintenance attempt may have.
  assert.ok(store.listMissions().length <= 1, "a refused orchestrate never creates a mission");
});

test("the sibling return-shaped entry point keeps its structured reason", async () => {
  const { orchestrator } = harness();
  assert.equal((await orchestrator.prepareForMaintenance({ timeoutMs: 10 })).status, "ready");
  assert.deepEqual(await orchestrator.runSubmittedMission("MSN-1"), {
    started: false,
    reason: "runtime_maintenance",
  });
});

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;

function missionTool(orchestrator: Orchestrator): Execute {
  const tools = buildCoreTools(async () => ({
    ledger: {} as never,
    artifacts: {} as never,
    broker: null,
    currentWorkItemId: () => null,
    actor: () => ({ type: "user" }),
    orchestrator,
  }));
  return tools.find((tool) => tool.name === "mission")!.execute as unknown as Execute;
}

test("the mission tool reports a refused delegation instead of failing the call", async () => {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const execute = missionTool({
    store,
    orchestrate: async () => {
      throw new MissionRefusedError("runtime_maintenance", {
        retryAfterMs: 2_500,
        resumeHint: "mission action=resume <missionId> (or /mission resume <missionId>) once maintenance ends",
        draining: 3,
      });
    },
  } as unknown as Orchestrator);
  const result = await execute("m", { request: "Add a health endpoint" }, undefined, undefined, { cwd: "/repo" });
  const text = result.content[0]!.text;
  assert.match(text, /^delegation blocked; continuing read-only — /);
  assert.match(text, /3 live run\(s\) draining/);
  assert.equal(result.details.delegationBlocked, true);
  assert.equal(result.details.reason, "runtime_maintenance");
  assert.equal(result.details.retryAfterMs, 2_500);
  assert.equal(result.details.draining, 3);
  assert.match(String(result.details.resumeHint), /resume/);
});
