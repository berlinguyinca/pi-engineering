import assert from "node:assert/strict";
import { test } from "node:test";
import { type WeekStats, accumulate, parseSession, renderTable } from "../../scripts/pi-session-report.ts";

const T0 = Date.parse("2026-10-20T12:00:00Z"); // a Tuesday; the week starts 2026-10-19
const line = (minute: number, message: Record<string, unknown>) =>
  JSON.stringify({ type: "message", timestamp: new Date(T0 + minute * 60_000).toISOString(), message });
const err = (minute: number, errorMessage: string, content: unknown[] = []) =>
  line(minute, { role: "assistant", stopReason: "error", errorMessage, content });
const user = (minute: number, text: string) => line(minute, { role: "user", content: text });
const ok = (minute: number) =>
  line(minute, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });

function report(...lines: string[]): WeekStats {
  return reportAt(undefined, ...lines);
}

function reportAt(nowMs: number | undefined, ...lines: string[]): WeekStats {
  const weeks = new Map<string, WeekStats>();
  accumulate(weeks, parseSession(lines.join("\n")), nowMs);
  assert.equal(weeks.size, 1);
  return [...weeks.values()][0]!;
}

test("a stall resumed by a typed 'retry' is counted as a person's", () => {
  const w = report(user(0, "do the work"), err(1, "Stream ended without finish_reason"), user(90, "retry"), ok(91));
  assert.equal(w.week, "2026-10-19");
  assert.equal(w.errors, 1);
  assert.equal(w.recoverableBeforeOutput, 1);
  assert.equal(w.stalls, 1);
  assert.equal(w.stallsResumedByPerson, 1);
  assert.equal(w.humanRetryMessages, 1);
});

test("a quick pi retry is not a stall; an error at the end of the log is an unresumed one", () => {
  const quick = report(user(0, "go"), err(1, "terminated"), ok(2));
  assert.equal(quick.stalls, 0);
  const dead = report(user(0, "go"), err(1, "terminated"));
  assert.equal(dead.stalls, 1);
  assert.equal(dead.stallsUnresumed, 1);
});

test("four consecutive errors count once as a spent retry budget", () => {
  const w = report(
    user(0, "go"),
    err(1, "terminated"),
    err(2, "terminated"),
    err(3, "terminated"),
    err(4, "terminated"),
    err(5, "terminated"),
    ok(6),
  );
  assert.equal(w.exhaustedRuns, 1);
  assert.equal(w.errors, 5);
});

test("errors are split into recoverable, after-output and final", () => {
  const w = report(
    user(0, "go"),
    err(1, "terminated"),
    err(2, "terminated", [{ type: "text", text: "partial" }]),
    err(3, '404: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","message":"Model x not found"}'),
    ok(4),
  );
  assert.deepEqual([w.recoverableBeforeOutput, w.afterOutput, w.final], [1, 1, 1]);
});

test("automatic recovery prompts are told apart from a person's retry", () => {
  const w = report(user(0, "go"), user(1, "[Automatic session recovery] Continue"), user(2, "please retry"), ok(3));
  assert.equal(w.automaticRecoveryPrompts, 1);
  assert.equal(w.humanRetryMessages, 1);
});

test("renderTable prints one row per week under a header", () => {
  const w = report(user(0, "go"), ok(1));
  assert.equal(renderTable([w]).split("\n").length, 3);
});

test("a stall revived by the launcher's prompt is automatic, not a person's", () => {
  const w = report(
    user(0, "go"),
    err(1, "terminated"),
    user(90, "[Automatic session recovery] Continue the existing work"),
    ok(91),
  );
  assert.equal(w.stalls, 1);
  assert.equal(w.stallsResumedAutomatically, 1);
  assert.equal(w.stallsResumedByPerson, 0);
});

test("a young trailing error is not a stall yet, and a final one never is", () => {
  const justNow = T0 + 61_000;
  assert.equal(reportAt(justNow, user(0, "go"), err(1, "terminated")).stalls, 0);
  assert.equal(reportAt(T0 + 3 * 3_600_000, user(0, "go"), err(1, "terminated")).stallsUnresumed, 1);
  const finalErr = err(
    1,
    '404: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","message":"Model x not found"}',
  );
  assert.equal(reportAt(T0 + 3 * 3_600_000, user(0, "go"), finalErr).stalls, 0);
});

test("a person's message or a long gap restarts the retry-budget streak", () => {
  const split = report(
    user(0, "go"),
    err(1, "terminated"),
    err(2, "terminated"),
    user(200, "retry"),
    err(201, "terminated"),
    err(202, "terminated"),
    ok(203),
  );
  assert.equal(split.exhaustedRuns, 0);
  const gap = report(
    user(0, "go"),
    err(1, "terminated"),
    err(2, "terminated"),
    err(300, "terminated"),
    err(301, "terminated"),
    ok(302),
  );
  assert.equal(gap.exhaustedRuns, 0);
});

test("malformed lines are skipped, and a session spanning two weeks counts in both", () => {
  const events = parseSession(
    [
      user(0, "go"),
      "{not json",
      err(1, "terminated"),
      line(9 * 24 * 60, { role: "assistant", stopReason: "stop", content: [] }),
    ].join("\n"),
  );
  assert.equal(events.length, 3);
  const weeks = new Map<string, WeekStats>();
  accumulate(weeks, events);
  assert.equal(weeks.size, 2);
  for (const w of weeks.values()) assert.equal(w.sessions, 1);
});
