import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeMissionModels } from "../../src/orchestration/missionModels.ts";

const pin = { provider: "gw", id: "qwen3.8-27b", set_at: "2026-10-30T00:00:00Z" };
const tasks = [
  { task_id: "T1", role: "implementer" },
  { task_id: "T2", role: "reviewer" },
] as never;

describe("mission model summary", () => {
  it("reports each agent against the pin and counts those elsewhere", () => {
    const summary = summarizeMissionModels({ operator_model_pin: pin }, tasks, [
      { workerId: "W1", taskId: "T1", model: "gw/qwen3.8-27b", state: "completed" },
      { workerId: "W2", taskId: "T2", model: "gw/deepseek_v4-flash", state: "running" },
      { workerId: "W3", taskId: "T1", model: undefined, state: "running" },
    ]);
    assert.equal(summary.pin, "gw/qwen3.8-27b");
    assert.deepEqual(
      summary.agents.map((a) => [a.workerId, a.role, a.onPin]),
      [
        ["W1", "implementer", true],
        ["W2", "reviewer", false],
        ["W3", "implementer", null],
      ],
    );
    assert.equal(summary.elsewhere, 1, "an agent that reported no model is unknown, not elsewhere");
    assert.deepEqual(
      summary.agents.map((a) => a.why),
      [null, "independent review runs on a different model than the work it reviews", null],
    );
  });

  it("an unpinned mission has no pin and nothing is elsewhere", () => {
    const summary = summarizeMissionModels({ operator_model_pin: undefined }, tasks, [
      { workerId: "W1", taskId: "T1", model: "gw/flint-40b", state: "running" },
    ]);
    assert.equal(summary.pin, null);
    assert.equal(summary.elsewhere, 0);
    assert.equal(summary.agents[0]?.onPin, null);
  });
});
