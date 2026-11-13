/** T03: a planner failure falls back to the envelope-clamped single task, or blocks when nothing safe is left. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PlannerTransientError, planMission } from "../../src/orchestration/missionPlanner.ts";
import type { MissionPlanInput, PlannerRunOutput } from "../../src/orchestration/missionPlanner.ts";
import type { PlanTaskInput } from "../../src/orchestration/orchestrator.ts";

const GOAL = "Split the exporter under src/api, the settings page under src/ui and docs/usage.md.";
const ENV = { goal: GOAL, mutates: true, mode: "on" as const, acceptanceIds: ["AC-1"] };
const ENVELOPE = { writableDomains: ["src/**", "vendor/**"], readOnlyPrefixes: ["vendor"] };
const CLAMPED = "clamped write_domains: /etc/**, ../escape/**, vendor/**, .git/**";
const TASK = {
  objective: "ship it",
  mutates_repo: true,
  write_domains: ["src/**", "/etc/**", "../escape/**", "vendor/**", ".git/**"],
  checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
  max_attempts: 3,
  failure_policy: "retry",
} as PlanTaskInput;
const INPUT: MissionPlanInput = { ...ENV, ...ENVELOPE, single: () => TASK, runPlanner: async () => "" };
// Planner text claiming "**" plus an absolute path, and a well-formed plan whose only domain is read-only.
const GREEDY = '{"contracts":[{"task_id":"a","objective":"x","write":["**","/etc/passwd"]}]}';
const DENIED = '{"contracts":[{"task_id":"a","objective":"x","scope":{"allowed":["vendor/**"]},"acceptance":["y"]}]}';

const plannerOf = (outputs: Array<PlannerRunOutput | Error>, calls = { n: 0 }) => ({
  calls,
  runPlanner: async (): Promise<PlannerRunOutput> => {
    const output = outputs[Math.min(calls.n++, outputs.length - 1)] ?? new Error("no output");
    if (output instanceof Error) throw output;
    return output;
  },
});
const notCalled = async (task: string): Promise<PlannerRunOutput> => Promise.reject(new Error(`planner ran: ${task}`));

test("every planner failure falls back to the clamped single task, carrying acceptance and budget", async () => {
  const transient = plannerOf([new PlannerTransientError("gateway 503")]);
  const hard = plannerOf([new Error("gateway exploded")]);
  const cases = [
    transient,
    hard,
    plannerOf(["sorry, no JSON"]),
    plannerOf([{ summary: "no plan", details: { contracts: [] } }]),
    plannerOf([GREEDY]),
    plannerOf([DENIED]),
  ];
  for (const run of cases) {
    const planned = await planMission({ ...INPUT, ...run });
    assert.equal(planned.tasks.length, 1);
    assert.deepEqual(planned.tasks[0]?.write_domains, ["src/**"], "only envelope-legal domains survive");
    assert.deepEqual(planned.tasks[0]?.acceptance_ids, ["AC-1"], "the mission's acceptance is carried");
    assert.deepEqual([planned.tasks[0]?.max_attempts, planned.tasks[0]?.failure_policy], [3, "retry"]);
    assert.deepEqual(planned.tasks[0]?.checkpoint_policy, { activity_milestone: 5, before_deadline_ms: 30_000 });
    assert.ok((planned.fallbackReason ?? "").includes(CLAMPED), planned.fallbackReason);
    assert.doesNotMatch(JSON.stringify(planned.tasks), /passwd/, "planner text never reaches the task");
  }
  assert.equal(transient.calls.n, 2, "a transient failure is retried exactly once");
  assert.equal(hard.calls.n, 1, "a hard failure is not retried");
});

test("a mutating mission with no safe domain blocks with zero tasks and a visible reason", async () => {
  for (const domains of [["vendor/**"], []]) {
    const r = await planMission({ ...INPUT, single: () => ({ ...TASK, write_domains: domains }) });
    assert.deepEqual(r.tasks, [], domains.join(","));
    assert.match(r.fallbackReason ?? "", /mission blocked/);
    assert.equal(r.clarification, undefined, "a block is not a clarification question");
  }
});

test("the non-mutating and planner-off paths are untouched", async () => {
  const single: () => PlanTaskInput = () => ({ ...TASK, mutates_repo: false, write_domains: [], isolation: "none" });
  const off = await planMission({ ...INPUT, mutates: true, mode: "off", single, runPlanner: notCalled });
  const read = await planMission({ ...INPUT, mutates: false, single, runPlanner: notCalled });
  assert.deepEqual([off, read], [{ tasks: [single()] }, { tasks: [single()] }]);
});
