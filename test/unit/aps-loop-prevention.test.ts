/**
 * APS Phase 3 — loop PREVENTION (first enforcement).
 *
 * Only a SUSTAINED run of identical semantic fingerprints with no state change
 * (`no_progress_turns` reaching the prevention threshold) is preventable.
 * Legitimate repeats (polling, pagination, retries that change inputs or
 * results) change the fingerprint and are NEVER prevented. Prevention is
 * disable-able, and fires at most once per loop run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallNormalizer, semanticFingerprint } from "../../src/aps/fingerprint.ts";
import { AGENT_LOOP_PREVENTED_EVENT, AgentProgressSupervisor } from "../../src/aps/supervisor.ts";
import type { AgentAction, AgentLoopPreventedEvent, LoopPreventionOptions } from "../../src/aps/types.ts";

const normalizer = new ToolCallNormalizer({ rootPrefix: "/home/u/proj" });
let iteration = 0;

function makeAction(tool: string, args: Record<string, unknown>, result: string): AgentAction {
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
  };
}

/** Same intent + target + result, repeatedly — a true loop. */
const LOOP_X = () => makeAction("read_file", { path: "src/x.ts" }, "content v1");
let retrySeq = 0;
/** Same call, but the result ADVANCES each time — a legitimate retry/poll. */
const RETRY_CHANGED = () => makeAction("read_file", { path: "src/x.ts" }, `content v${++retrySeq}`);
/** Different target — progress. */
const READ_Y = () => makeAction("read_file", { path: "src/y.ts" }, "content ok");

interface Harness {
  supervisor: AgentProgressSupervisor;
  prevented: AgentLoopPreventedEvent[];
  observe: (a: AgentAction) => Promise<void>;
}

function harness(prevention?: LoopPreventionOptions): Harness {
  const prevented: AgentLoopPreventedEvent[] = [];
  const supervisor = new AgentProgressSupervisor({
    prevention,
    onPrevented: (e) => prevented.push(e),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return {
    supervisor,
    prevented,
    observe: (a) => supervisor.observe(a).then(() => undefined),
  };
}

test("a sustained identical no-progress run is prevented exactly once", async () => {
  const h = harness();
  // noProgressTurns counts identical CONSECUTIVE pairs; default threshold 4 =>
  // five identical actions trigger prevention.
  for (let i = 0; i < 5; i++) await h.observe(LOOP_X());
  assert.equal(h.prevented.length, 1, "prevention fires exactly once");
  const ev = h.prevented[0]!;
  assert.equal(ev.type, "agent.loop_prevented");
  assert.equal(ev.prevented, true);
  assert.equal(ev.reason, "no_progress_turns");
  assert.equal(ev.metrics.noProgressTurns, 4);
  assert.equal(ev.family, "READ_FILE");
  assert.equal(ev.role, "implementer");
  assert.equal(ev.sessionId, "sess-1");
  assert.equal(ev.tool, "read_file");
  // Continues repeating => still only one prevention.
  await h.observe(LOOP_X());
  assert.equal(h.prevented.length, 1);
});

test("a progressing stream is never prevented", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    await h.observe(i % 2 === 0 ? LOOP_X() : READ_Y());
  }
  assert.equal(h.prevented.length, 0);
});

test("a repeated tool with a CHANGED result (legitimate retry/poll) is never prevented", async () => {
  const h = harness();
  // Same tool+args, but the result advances each time -> fingerprint changes ->
  // not a no-progress loop.
  for (let i = 0; i < 10; i++) await h.observe(RETRY_CHANGED());
  assert.equal(h.prevented.length, 0);
});

test("a changed target resets the no-progress run and is never prevented", async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) await h.observe(LOOP_X()); // approaching threshold
  await h.observe(READ_Y()); // progress resets
  for (let i = 0; i < 4; i++) await h.observe(LOOP_X());
  assert.equal(h.prevented.length, 0);
});

test("prevention can be disabled (detection only)", async () => {
  const h = harness({ enabled: false });
  for (let i = 0; i < 10; i++) await h.observe(LOOP_X());
  assert.equal(h.prevented.length, 0);
  // Detection (loop_candidate) still fires; only enforcement is off.
  assert.ok(h.supervisor.emittedEvents.some((e) => e.type === AGENT_LOOP_PREVENTED_EVENT) === false);
});

test("a lower noProgressTurns threshold prevents earlier", async () => {
  const h = harness({ noProgressTurns: 2 });
  // noProgressTurns=2 => three identical actions.
  for (let i = 0; i < 3; i++) await h.observe(LOOP_X());
  assert.equal(h.prevented.length, 1);
  assert.equal(h.prevented[0]!.metrics.noProgressTurns, 2);
});

// --- No-mutation stall (thrashing) prevention ---

/** A DISTINCT read each call (different path) — thrashing, not a tight loop. */
function makeDistinctReads(n: number): AgentAction[] {
  const out: AgentAction[] = [];
  for (let i = 0; i < n; i++) out.push(makeAction("read", { path: `src/file-${i}.ts` }, `content ${i}`));
  return out;
}
/** A write — the artifact-progress signal that resets the stall run. */
const WRITE_ACTION = () => makeAction("write", { path: "src/out.ts" }, "wrote 12 lines");
/** Build an action with a custom role (for role-awareness tests). */
function makeRoleAction(role: string, tool: string, args: Record<string, unknown>, result: string): AgentAction {
  iteration += 1;
  const norm = normalizer.normalize({ name: tool, arguments: args });
  return {
    role,
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
  };
}

/**
 * Thrashing: the same FEW targets, cycled, with no write. The output differs
 * each pass so the identical-fingerprint signal stays silent - only the stall,
 * read together with target diversity, can see it.
 */
function makeCycledReads(n: number, targets = 3): AgentAction[] {
  const out: AgentAction[] = [];
  for (let i = 0; i < n; i++) {
    out.push(makeAction("read", { path: `src/cycle-${i % targets}.ts` }, `pass ${i}`));
  }
  return out;
}

test("an artifact role cycling FEW targets with no write is prevented (no_mutation_stall)", async () => {
  const h = harness(); // default noMutationStall = 40, diversity ceiling 6
  for (const a of makeCycledReads(45)) await h.observe(a);
  assert.equal(h.prevented.length, 1, "prevention fires exactly once");
  const ev = h.prevented[0]!;
  assert.equal(ev.type, "agent.loop_prevented");
  assert.equal(ev.reason, "no_mutation_stall");
  assert.equal(ev.metrics.noMutationStall, 40);
  assert.equal(ev.metrics.noMutationStallDistinct, 3, "the cycle kept returning to 3 targets");
  assert.equal(ev.role, "implementer");
});

test("an artifact role reading MANY distinct files is investigating, not thrashing", async () => {
  const h = harness(); // default noMutationStall = 40
  for (const a of makeDistinctReads(60)) await h.observe(a);
  assert.equal(h.prevented.length, 0, "the stall requires LOW target diversity, not merely a long read-only run");
});

test("an analysis role (reviewer) never triggers the stall signal, even with many reads", async () => {
  const h = harness();
  for (let i = 0; i < 60; i++) {
    await h.observe(makeRoleAction("reviewer", "read", { path: `src/file-${i}.ts` }, `content ${i}`));
  }
  assert.equal(h.prevented.length, 0, "reviewers never write, so the stall signal does not apply");
});

test("a write resets the no-mutation stall run (progress)", async () => {
  const h = harness();
  for (const a of makeCycledReads(39)) await h.observe(a);
  await h.observe(WRITE_ACTION()); // progress: resets the stall run
  for (const a of makeCycledReads(39)) await h.observe(a);
  assert.equal(h.prevented.length, 0, "the write broke the stall run twice");
});

test("below the stall threshold, an artifact role is never prevented", async () => {
  const h = harness(); // default noMutationStall = 40
  for (const a of makeCycledReads(39)) await h.observe(a);
  assert.equal(h.prevented.length, 0, "39 < 40: legitimate exploration is not prevented");
});

test("the stall signal can be disabled (0) while tight-loop prevention stays on", async () => {
  const h = harness({ noMutationStall: 0 });
  for (const a of makeCycledReads(60)) await h.observe(a);
  assert.equal(h.prevented.length, 0, "noMutationStall=0 disables the stall signal");
});
