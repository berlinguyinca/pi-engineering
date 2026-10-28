/**
 * APS Phase 3 — the no-mutation stall must mean THRASHING, not investigating.
 *
 * The stall signal used to prevent on COUNT alone: an implementer that read 40
 * DIFFERENT files (the normal shape of investigating an unfamiliar codebase, and
 * something that leaves no trace on disk for the counter to see) was aborted,
 * recovered, escalated and finally parked exactly like an implementer repeating
 * one grep 40 times. The signal now additionally requires the trailing run to be
 * LOW-DIVERSITY in its targets, and the notice states the numbers that fired so
 * an operator can tell thrashing from investigating and tune the knob.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallNormalizer, semanticFingerprint } from "../../src/aps/fingerprint.ts";
import { ProgressEvaluator } from "../../src/aps/progress.ts";
import { AgentProgressSupervisor, describeLoopTrigger } from "../../src/aps/supervisor.ts";
import {
  type AgentAction,
  type AgentLoopPreventedEvent,
  DEFAULT_LOOP_PREVENTION,
  type LoopPreventionOptions,
} from "../../src/aps/types.ts";

const normalizer = new ToolCallNormalizer({ rootPrefix: "/home/u/proj" });
let iteration = 0;

function makeAction(tool: string, args: Record<string, unknown>, result: string, role = "implementer"): AgentAction {
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

/** Investigating: each action reads a DIFFERENT file and returns fresh output. */
const investigate = (i: number, role = "implementer") =>
  makeAction("read_file", { path: `src/module_${i}.ts` }, `body of module ${i}`, role);

/**
 * Thrashing: the same handful of targets, cycled. The result ADVANCES each pass
 * so the identical-fingerprint signal stays quiet — only the stall can see it.
 */
const CYCLE_TARGETS = ["src/columns.py", "src/rows.py", "src/grid.py"];
let cyclePass = 0;
const thrash = () => {
  const target = CYCLE_TARGETS[cyclePass % CYCLE_TARGETS.length]!;
  const body = `grep hits in ${target}, pass ${cyclePass}`;
  cyclePass += 1;
  return makeAction("bash", { command: `grep -rin "case|when" ${target}` }, body);
};

interface Harness {
  supervisor: AgentProgressSupervisor;
  prevented: AgentLoopPreventedEvent[];
  notices: string[];
  observe: (a: AgentAction) => Promise<void>;
}

function harness(prevention: LoopPreventionOptions): Harness {
  const prevented: AgentLoopPreventedEvent[] = [];
  const notices: string[] = [];
  const supervisor = new AgentProgressSupervisor({
    historySize: 200,
    prevention,
    onPrevented: (e) => prevented.push(e),
    emitNotice: (e) =>
      notices.push(
        `APS: loop candidate in session ${e.sessionId}: ${e.family} ${e.target || "(no target)"} (${e.reason})${describeLoopTrigger(e, { ...DEFAULT_LOOP_PREVENTION, ...prevention })}`,
      ),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return {
    supervisor,
    prevented,
    notices,
    observe: (a) => supervisor.observe(a).then(() => undefined),
  };
}

test("a long run over MANY distinct targets is investigating, not thrashing", async () => {
  const h = harness({ noMutationStall: 40 });
  for (let i = 0; i < 60; i++) await h.observe(investigate(i));
  assert.equal(h.prevented.length, 0, "varied investigation never prevents");
  assert.equal(h.notices.length, 0, "and never warns");
});

test("the stall still counts varied reads, so the signal stays observable", () => {
  const evaluator = new ProgressEvaluator({ historySize: 200 });
  for (let i = 0; i < 60; i++) evaluator.record(investigate(i));
  const vector = evaluator.vector();
  assert.equal(vector.noMutationStall, 60, "the run is still counted");
  assert.equal(vector.noMutationStallDistinct, 60, "one distinct target per action");
});

test("a long run over FEW distinct targets is thrashing and still prevents", async () => {
  const h = harness({ noMutationStall: 40 });
  for (let i = 0; i < 45; i++) await h.observe(thrash());
  assert.equal(h.prevented.length, 1, "low-diversity thrash prevents exactly once");
  const ev = h.prevented[0]!;
  assert.equal(ev.reason, "no_mutation_stall");
  assert.equal(ev.metrics.noMutationStall, 40);
  assert.equal(ev.metrics.noMutationStallDistinct, 3, "the cycle kept returning to 3 targets");
  assert.equal(ev.metrics.noProgressTurns, 0, "the identical-fingerprint signal saw none of this");
});

test("the prevention notice names the numbers that fired and the knob to turn", async () => {
  const h = harness({ noMutationStall: 40 });
  for (let i = 0; i < 41; i++) await h.observe(thrash());
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!, /no_mutation_stall/);
  assert.match(h.notices[0]!, /40\/40 non-mutating actions over 3 distinct target/);
  assert.match(h.notices[0]!, /prevention\.noMutationStall \/ prevention\.noMutationStallDiversity/);
});

test("noMutationStallDiversity: 0 restores the count-only rule", async () => {
  const h = harness({ noMutationStall: 40, noMutationStallDiversity: 0 });
  for (let i = 100; i < 160; i++) await h.observe(investigate(i));
  assert.equal(h.prevented.length, 1, "an operator can still opt out of the diversity gate");
  assert.equal(h.prevented[0]!.reason, "no_mutation_stall");
});

test("a diversity ceiling can be raised, not only removed", async () => {
  const h = harness({ noMutationStall: 40, noMutationStallDiversity: 12 });
  for (let i = 200; i < 260; i++) {
    // 8 distinct targets, cycled: below a ceiling of 12, above the default of 6.
    await h.observe(investigate(200 + (i % 8)));
  }
  assert.equal(h.prevented.length, 1, "a wider cycle still counts as thrash when told to");
});

test("a write resets the stall, so 30 reads + write + 30 reads is not a stall", async () => {
  const h = harness({ noMutationStall: 40 });
  for (let i = 300; i < 330; i++) await h.observe(investigate(i));
  await h.observe(makeAction("write", { path: "src/new.ts" }, "wrote 12 lines"));
  for (let i = 330; i < 360; i++) await h.observe(investigate(i));
  assert.equal(h.prevented.length, 0);
});

test("analysis roles are never stalled on reads", async () => {
  const h = harness({ noMutationStall: 40 });
  for (let i = 400; i < 480; i++) await h.observe(investigate(i, "reviewer"));
  assert.equal(h.prevented.length, 0, "a reviewer reads by definition");
});
