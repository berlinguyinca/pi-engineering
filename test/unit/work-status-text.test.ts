import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkStatus } from "../../src/work/statusText.ts";
import type { WorkGraph } from "../../src/work/types.ts";
import { emptyWorkGraph } from "../../src/work/types.ts";

const graph = (): WorkGraph => ({
  ...emptyWorkGraph(),
  tasks: [
    {
      id: "WI-1",
      source: "ledger",
      title: "Fix parser",
      state: "working",
      raw_status: "IMPLEMENTING",
      verification_status: "pending",
      parent_id: null,
      created_at: null,
      updated_at: null,
      run_ids: ["R1", "R2"],
      session_ids: [],
    },
  ],
  runs: [
    {
      id: "R1",
      task_id: "WI-1",
      source: "ledger",
      session_id: "S",
      health: "finished",
      outcome: "completed",
      model: null,
      worktree: null,
      started_at: null,
      ended_at: null,
    },
    {
      id: "R2",
      task_id: "WI-1",
      source: "ledger",
      session_id: "S",
      health: "active",
      outcome: null,
      model: null,
      worktree: null,
      started_at: null,
      ended_at: null,
    },
  ],
});

test("an empty graph says so", () => {
  assert.equal(formatWorkStatus(emptyWorkGraph()), "No tracked work yet.");
});

test("a finished run is never shown as a finished task", () => {
  const text = formatWorkStatus(graph());
  assert.match(text, /working · verify:pending · runs 1\/2 done, 1 live/);
  assert.doesNotMatch(text, /\bdone ·/);
});

test("store conflicts are surfaced, not hidden", () => {
  const g = { ...graph(), conflicts: ["task:WI-1"] };
  assert.match(formatWorkStatus(g), /WARNING: 1 id\(s\)/);
});
