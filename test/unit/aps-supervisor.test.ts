/**
 * APS Phase 1 — AgentProgressSupervisor: detect-only loop-candidate emission
 * into the existing telemetry/event bus, dedupe, reset-on-progress, and the
 * hard constraint that it never throws into (or acts on) the observed run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallNormalizer, semanticFingerprint } from "../../src/aps/fingerprint.ts";
import { AGENT_LOOP_CANDIDATE_EVENT, AgentProgressSupervisor } from "../../src/aps/supervisor.ts";
import type { AgentAction } from "../../src/aps/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { TelemetryNotice } from "../../src/telemetry/sink.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";

const normalizer = new ToolCallNormalizer({ rootPrefix: "/home/u/proj" });
let iteration = 0;

function makeAction(
  tool: string,
  args: Record<string, unknown>,
  result: string,
  over: Partial<AgentAction> = {},
): AgentAction {
  iteration += 1;
  const norm = normalizer.normalize({ name: tool, arguments: args });
  return {
    role: "implementer",
    iteration,
    tool,
    normalizedArguments: norm.arguments,
    toolResultSummary: result,
    contentFingerprint: semanticFingerprint(
      { tool, normalizedArguments: norm.arguments, toolResultSummary: result },
      normalizer,
    ),
    phase: "execute",
    sessionId: "sess-1",
    runId: "run-1",
    workItemId: "WI-1",
    ...over,
  };
}

const READ_X = () => makeAction("read_file", { path: "src/x.ts" }, "content v1");
const READ_Y = () => makeAction("read_file", { path: "src/y.ts" }, "content ok");

interface Harness {
  supervisor: AgentProgressSupervisor;
  store: JsonlEventStore;
  inProcess: unknown[];
  notices: TelemetryNotice[];
}

function setup(): Harness {
  const store = JsonlEventStore.inMemory();
  const inProcess: unknown[] = [];
  const notices: TelemetryNotice[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n));
  test.after(uninstall);
  const supervisor = new AgentProgressSupervisor({
    eventStore: store,
    onEvent: (event) => inProcess.push(event),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { supervisor, store, inProcess, notices };
}

test("no event below threshold", async () => {
  const { supervisor, store, inProcess, notices } = setup();
  assert.deepEqual(await supervisor.observe(READ_X()), { loop_candidate: false, emitted: false });
  assert.deepEqual(await supervisor.observe(READ_X()), { loop_candidate: false, emitted: false });
  assert.equal(store.count(), 0, "nothing persisted below threshold");
  assert.equal(inProcess.length, 0);
  assert.equal(notices.length, 0);
});

test("emits a structured agent.loop_candidate event on loop detection", async () => {
  const { supervisor, store, inProcess, notices } = setup();
  await supervisor.observe(READ_X());
  await supervisor.observe(READ_X());
  const third = await supervisor.observe(READ_X());
  assert.equal(third.loop_candidate, true);
  assert.equal(third.emitted, true);

  assert.equal(supervisor.emittedEvents.length, 1);
  const event = supervisor.emittedEvents[0]!;
  assert.equal(event.type, AGENT_LOOP_CANDIDATE_EVENT);
  assert.equal(event.type, "agent.loop_candidate");
  assert.equal(event.sessionId, "sess-1");
  assert.equal(event.runId, "run-1");
  assert.equal(event.workItemId, "WI-1");
  assert.equal(event.role, "implementer");
  assert.equal(event.phase, "execute");
  assert.equal(event.reason, "repeated_call");
  assert.equal(event.family, "READ_FILE");
  assert.equal(event.target, "src/x.ts");
  assert.match(event.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(event.metrics.repeatedCalls, 3);
  assert.equal(event.timestamp, "2026-01-01T00:00:00.000Z");

  // In-process subscriber got the same event.
  assert.equal(inProcess.length, 1);
  assert.equal((inProcess[0] as { type: string }).type, "agent.loop_candidate");

  // The existing telemetry bus (global sink) got the structured notice.
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.level, "warning");
  assert.equal((notices[0]!.detail as { type: string })?.type, "agent.loop_candidate");

  // The existing event store got a persistent StoredEvent of the same type.
  assert.equal(store.count(), 1);
  const stored = store.all()[0]!;
  assert.equal(stored.type, "agent.loop_candidate");
  assert.equal(stored.run_id, "run-1");
  assert.equal(stored.worker_id, "sess-1");
  assert.equal(stored.event_id, event.event_id);
  assert.equal((stored.payload as { reason: string }).reason, "repeated_call");
  assert.equal((stored.payload as { family: string }).family, "READ_FILE");
});

test("dedupes the same loop; re-emits after progress resumes", async () => {
  const { supervisor, store } = setup();
  await supervisor.observe(READ_X());
  await supervisor.observe(READ_X());
  assert.equal((await supervisor.observe(READ_X())).emitted, true);
  const fourth = await supervisor.observe(READ_X());
  assert.equal(fourth.loop_candidate, true, "still a loop candidate");
  assert.equal(fourth.emitted, false, "same loop already reported");
  assert.equal(store.count(), 1, "no duplicate persisted event");

  // Progress: a different action clears the reported marker.
  assert.equal((await supervisor.observe(READ_Y())).loop_candidate, false);
  const again = await supervisor.observe(READ_X());
  assert.equal(again.loop_candidate, true);
  assert.equal(again.emitted, true, "re-emitted after progress");
  assert.equal(store.count(), 2);
});

test("separate sessions are tracked independently", async () => {
  const { supervisor, store } = setup();
  const other = (a: AgentAction): AgentAction => ({ ...a, sessionId: "sess-2", iteration: a.iteration + 100 });
  for (let i = 0; i < 3; i++) await supervisor.observe(READ_X());
  assert.equal(store.count(), 1);
  for (let i = 0; i < 3; i++) await supervisor.observe(other(READ_X()));
  assert.equal(store.count(), 2, "each session reports its own loop");
  assert.equal(supervisor.emittedEvents[1]!.sessionId, "sess-2");
});

test("detect-only: never mutates the action and never throws into the run", async () => {
  const { supervisor } = setup();
  const action = READ_X();
  const before = structuredClone(action);
  await supervisor.observe(action);
  assert.deepEqual(action, before, "observed action must not be mutated");
});

test("a failing event store degrades gracefully (detection keeps working)", async () => {
  const failing = {
    append: async () => {
      throw new Error("disk on fire");
    },
    appendAll: async () => {},
    all: () => [],
    get: () => undefined,
    count: () => 0,
  };
  const notices: TelemetryNotice[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n));
  test.after(uninstall);
  const supervisor = new AgentProgressSupervisor({ eventStore: failing, now: () => "t" });
  for (let i = 0; i < 3; i++) {
    await supervisor.observe(READ_X()); // must not throw
  }
  assert.equal(supervisor.emittedEvents.length, 1, "event still recorded in-process");
  assert.equal(notices.length, 1, "telemetry notice still emitted");
});
