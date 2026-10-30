import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveAttention } from "../../src/orchestration/observability/attention.ts";
import type { RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import { presenceRank, projectPresence } from "../../src/status/presence.ts";

/**
 * Health says whether a mission is moving; it does not say why the operator
 * should look now. These tests pin attention as a separate, deterministic
 * judgement: the same facts always produce the same severity and the same
 * evidence, and the evidence is a fact (a count, an age, a deadline), never a
 * sentence the model wrote about itself.
 */

const T0 = Date.parse("2026-10-27T12:00:00.000Z");

/** A complete event: presence renders every field, so a partial one is not a fixture. */
function event(overrides: Partial<RuntimeMissionActivityEvent> = {}): RuntimeMissionActivityEvent {
  return {
    observedAt: new Date(T0).toISOString(),
    missionId: "MSN-1",
    title: "Work",
    phase: "implement",
    state: "EXECUTING",
    health: "active",
    approximatePercent: 40,
    acceptanceCoverage: { completed: 4, total: 10, approximatePercent: 40 },
    workflowProgress: { completed: 4, total: 10, approximatePercent: 40 },
    summary: "reading src/a.ts",
    activeWorkers: 1,
    waitingWorkers: 0,
    failedWorkers: 0,
    lastMeaningfulProgressAt: new Date(T0 - 10_000).toISOString(),
    lastHeartbeatAt: new Date(T0 - 5_000).toISOString(),
    action: "reading src/a.ts",
    reason: "",
    recovery: { attempt: 0, maxAttempts: 3 },
    nextAction: "",
    nextActionAt: null,
    owner: null,
    repository: null,
    task: null,
    preservedWork: [],
    ...overrides,
  };
}

function base(overrides: Partial<Parameters<typeof deriveAttention>[0]> = {}) {
  return {
    state: "EXECUTING",
    health: "active" as const,
    lastMeaningfulProgressAt: new Date(T0 - 10_000).toISOString(),
    lastHeartbeatAt: new Date(T0 - 5_000).toISOString(),
    recovery: { attempt: 0, maxAttempts: 3 },
    now: T0,
    ...overrides,
  };
}

test("the operator being the next actor outranks everything else", () => {
  const attention = deriveAttention(
    base({
      state: "NEEDS_ATTENTION",
      reason: "resume is unauthorized for this runtime",
      // A loop is present too, and still loses.
      loopSignals: [{ kind: "repeated_tool_call", detail: "read src/a.ts", count: 9 }],
    }),
  );

  assert.equal(attention?.severity, "critical");
  assert.equal(attention?.evidence[0]?.kind, "operator_action_required");
  assert.match(attention!.reason, /resume is unauthorized/);
});

/** The case health cannot express: an active mission that is going nowhere. */
test("a loop is high attention even while health stays active", () => {
  const attention = deriveAttention(
    base({
      loopSignals: [
        { kind: "repeated_file_read", detail: "src/a.ts", count: 6 },
        { kind: "repeated_tool_call", detail: "bash npm test", count: 9 },
      ],
    }),
  );

  assert.equal(attention?.severity, "high");
  assert.equal(attention?.evidence[0]?.kind, "loop");
  assert.match(attention!.reason, /repeated tool call ×9/, "the strongest counter is the one surfaced");
});

test("a pause the operator made is reported as theirs, not as a fault", () => {
  const attention = deriveAttention(base({ operatorPausedAt: new Date(T0 - 90_000).toISOString() }));

  assert.equal(attention?.severity, "medium");
  assert.equal(attention?.evidence[0]?.kind, "operator_paused");
  assert.match(attention!.reason, /paused by you 1m ago/);
});

test("exhausted recovery and failing tests are listed together, strongest first", () => {
  const attention = deriveAttention(
    base({ state: "RECOVERING", recovery: { attempt: 3, maxAttempts: 3 }, tests: { failed: 4 } }),
  );

  assert.equal(attention?.severity, "high");
  assert.deepEqual(
    attention?.evidence.map((entry) => entry.kind),
    ["recovery_exhausted", "tests_failing"],
  );
});

test("a capacity park past its strategy budget reports wait progress, not exhausted recovery", () => {
  const attention = deriveAttention(
    base({
      state: "BLOCKED",
      health: "blocked",
      recovery: { attempt: 195, maxAttempts: 8 },
      recoveryAction: "PROBE_AND_BACKOFF",
      failureCategory: "PROVIDER_TRANSIENT",
      nextActionAt: new Date(T0 + 120_000).toISOString(),
      waitingSince: new Date(T0 - 3_600_000).toISOString(),
    }),
  );

  assert.equal(attention?.severity, "high");
  assert.equal(attention?.evidence[0]?.kind, "capacity_wait");
  assert.ok(!attention!.evidence.some((entry) => entry.kind === "recovery_exhausted"));
  assert.doesNotMatch(attention!.reason, /did not restore progress|of 8/);
  assert.match(attention!.reason, /waiting for capacity/);
  assert.match(attention!.reason, /probe 195/);
  assert.match(attention!.reason, /parked 1h 0m/);
  assert.doesNotMatch(attention!.reason, /waiting.*waiting/);
  assert.match(attention!.reason, /next probe in 2m/);
  assert.match(attention!.reason, /resumes once the gateway health probe succeeds/);
});

const capped = (overrides: Partial<Parameters<typeof deriveAttention>[0]>) =>
  deriveAttention(
    base({
      state: "BLOCKED",
      health: "blocked",
      recovery: { attempt: 9, maxAttempts: 8 },
      recoveryAction: "PROBE_AND_BACKOFF",
      ...overrides,
    }),
  );

test("a probe due now says so instead of 'in 0s'; a past nextActionAt is due now", () => {
  const past = capped({ failureCategory: "PROVIDER_TRANSIENT", nextActionAt: new Date(T0 - 5_000).toISOString() });
  assert.match(past!.reason, /next probe due now/);
  assert.doesNotMatch(past!.reason, /in 0s/);
});

test("a missing nextActionAt or waitingSince omits those parts without breaking the wording", () => {
  const attention = capped({ failureCategory: "PROVIDER_TRANSIENT" });
  assert.equal(attention?.evidence[0]?.kind, "capacity_wait");
  assert.equal(attention?.evidence[0]?.at, undefined);
  assert.equal(
    attention?.reason,
    "waiting for capacity: probe 9; resumes once the gateway health probe succeeds, unless paused or stopped",
  );
});

test("only transient provider failures are called a capacity wait", () => {
  const attention = capped({ failureCategory: "PROVIDER_TRANSIENT" });
  assert.match(attention!.reason, /^waiting for capacity: probe 9; /);
  assert.doesNotMatch(attention!.reason, /automatically/);
  assert.match(attention!.reason, /resumes once the gateway health probe succeeds, unless paused or stopped$/);
});

test("a permanent provider failure is not promised to resume automatically", () => {
  const attention = capped({ failureCategory: "PROVIDER_PERMANENT" });
  assert.doesNotMatch(attention!.reason, /capacity|automatically/);
  assert.match(attention!.reason, /operator action/);
});

test("orphaned execution and unavailable evidence name the gateway probe they actually wait on", () => {
  for (const failureCategory of [undefined, "ORPHANED_EXECUTION", "EVIDENCE_UNAVAILABLE"] as const) {
    const attention = capped({ failureCategory });
    assert.equal(attention?.evidence[0]?.kind, "capacity_wait");
    assert.doesNotMatch(attention!.reason, /capacity|blocking condition/, String(failureCategory));
    assert.match(
      attention!.reason,
      /^waiting: probe 9; resumes once the gateway health probe succeeds, unless paused or stopped$/,
    );
  }
});

test("a disk suspension park does not claim disk space is checked", () => {
  const attention = capped({ failureCategory: "DISK_SUSPENDED" });
  assert.equal(
    attention?.reason,
    "waiting: probe 9; resumes once the gateway health probe succeeds (disk space is not checked), unless paused or stopped",
  );
});

test("a parking wait is not described as resuming when the operator paused or the mission is terminal", () => {
  const paused = capped({
    failureCategory: "PROVIDER_TRANSIENT",
    operatorPausedAt: new Date(T0 - 60_000).toISOString(),
  });
  assert.equal(paused?.evidence[0]?.kind, "operator_paused");
  assert.doesNotMatch(paused!.reason, /resumes/);

  const canceled = capped({ state: "CANCELED", failureCategory: "PROVIDER_TRANSIENT" });
  assert.ok(!canceled?.evidence.some((entry) => entry.kind === "capacity_wait"));
  assert.doesNotMatch(canceled?.reason ?? "", /resumes/);

  const failed = capped({ state: "FAILED", reason: "gateway down", failureCategory: "PROVIDER_TRANSIENT" });
  assert.equal(failed?.evidence[0]?.kind, "failure");
  assert.ok(!failed!.evidence.some((entry) => entry.kind === "capacity_wait"));
  assert.doesNotMatch(failed!.reason, /resumes/);
});

test("durable write failures are worded as storage recovery, not capacity", () => {
  const attention = capped({ recoveryAction: "PAUSE_FOR_PERSISTENCE", failureCategory: "PERSISTENCE_FAILURE" });
  assert.equal(attention?.evidence[0]?.kind, "capacity_wait");
  assert.match(
    attention!.reason,
    /^durable writes failing: probe 9; resumes once storage recovers, unless paused or stopped$/,
  );
});

test("an undefined recoveryAction or a non-wait action at the cap stays recovery_exhausted", () => {
  for (const recoveryAction of [undefined, "CREATE_REPAIR_TASKS"]) {
    const attention = capped({ recoveryAction });
    assert.equal(attention?.evidence[0]?.kind, "recovery_exhausted", String(recoveryAction));
    assert.equal(attention?.reason, "recovery attempt 9 of 8 did not restore progress");
  }
});

test("a real STOP at the cap keeps the attempt N of M recovery_exhausted wording", () => {
  const attention = deriveAttention(
    base({ state: "BLOCKED", health: "blocked", recovery: { attempt: 3, maxAttempts: 3 }, recoveryAction: "STOP" }),
  );

  assert.equal(attention?.evidence[0]?.kind, "recovery_exhausted");
  assert.equal(attention?.reason, "recovery attempt 3 of 3 did not restore progress");
});

test("a wait the runtime is handling itself informs without interrupting", () => {
  const attention = deriveAttention(base({ health: "waiting", waitingReason: "inferweave_admission" }));

  assert.equal(attention?.severity, "info");
  assert.match(attention!.reason, /waiting on inferweave admission/);
});

test("a wait past its deadline is worth interrupting for", () => {
  const attention = deriveAttention(
    base({
      health: "waiting",
      waitingReason: "human_approval",
      waitingSince: new Date(T0 - 40 * 60_000).toISOString(),
      waitingDeadlineMs: 30 * 60_000,
    }),
  );

  assert.equal(attention?.severity, "medium");
  assert.equal(attention?.evidence[0]?.kind, "waiting_deadline");
  assert.match(attention!.reason, /past its deadline/);
});

/** A running mission with neither heartbeat nor progress is not "healthy". */
test("no proof of life is stated, not hidden behind an active label", () => {
  const attention = deriveAttention(base({ lastMeaningfulProgressAt: null, lastHeartbeatAt: undefined }));

  assert.equal(attention?.severity, "medium");
  assert.equal(attention?.evidence[0]?.kind, "no_proof_of_life");
});

test("a mission with nothing to say produces no attention", () => {
  assert.equal(deriveAttention(base()), null);
  assert.equal(deriveAttention(base({ state: "COMPLETE", health: "complete" })), null);
});

test("attention raises a mission's presence rank but never demotes one", () => {
  const running = event();
  const looped = event({
    missionId: "MSN-loop",
    attention: {
      severity: "high",
      reason: "repeated tool call ×9 — bash npm test",
      evidence: [{ kind: "loop", detail: "repeated tool call ×9" }],
    },
  });
  const needsYou = event({
    missionId: "MSN-you",
    state: "NEEDS_ATTENTION",
    attention: {
      severity: "critical",
      reason: "waiting for you",
      evidence: [{ kind: "operator_action_required", detail: "waiting for you" }],
    },
  });

  assert.ok(presenceRank(looped) < presenceRank(running), "a looping mission outranks one merely running");
  assert.equal(presenceRank(needsYou), 0, "the operator still comes first");
  assert.equal(presenceRank(event({ state: "NEEDS_ATTENTION" })), 0, "no attention, same rank as before");
});

test("the working line leads with the evidence when there is any", () => {
  const looped = event({
    missionId: "MSN-loop",
    title: "Payment retries",
    action: "working on it",
    summary: "working on it",
    reason: "working on it",
    attention: {
      severity: "high",
      reason: "repeated tool call ×9 — bash npm test",
      evidence: [{ kind: "loop", detail: "repeated tool call ×9" }],
    },
  });

  const view = projectPresence([looped], 4, T0);
  assert.match(view.workingLine ?? "", /repeated tool call ×9/, "the line says why to look");
  assert.doesNotMatch(view.workingLine ?? "", /working on it/, "self-narration is not evidence");
  assert.equal(view.rows[0]?.attentionReason, "repeated tool call ×9 — bash npm test");
});
