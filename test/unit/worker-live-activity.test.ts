import assert from "node:assert/strict";
import { test } from "node:test";
import { activityFromSessionEvent } from "../../src/workers/activity.ts";

test("worker activity exposes bounded tool state without arguments or secrets", () => {
  const event = activityFromSessionEvent({
    type: "tool_execution_start",
    toolName: `bash\nAuthorization: Bearer ${"s".repeat(300)}`,
    args: { command: "deploy --token super-secret" },
  });

  assert.equal(event?.kind, "tool");
  assert.equal(event?.phase, "started");
  assert.ok((event?.summary.length ?? 0) <= 160);
  assert.doesNotMatch(event?.summary ?? "", /super-secret|Bearer|\n/);
  assert.equal(JSON.stringify(event).includes("deploy"), false, "tool arguments must never enter mission activity");
});

test("worker activity ignores streaming token deltas and reports only bounded state transitions", () => {
  assert.equal(
    activityFromSessionEvent({ type: "message_update", message: { role: "assistant", content: "private reasoning" } }),
    null,
  );
  assert.deepEqual(activityFromSessionEvent({ type: "message_end", message: { role: "assistant" } }), {
    kind: "state",
    summary: "Model response received",
    meaningfulProgress: false,
  });
});

test("worker activity rejects a secret-shaped tool name", () => {
  const secret = `sk-${"a".repeat(32)}`;
  const event = activityFromSessionEvent({ type: "tool_execution_start", toolName: secret });
  assert.equal(event?.toolName, "tool");
  assert.doesNotMatch(JSON.stringify(event), /sk-/);
});
