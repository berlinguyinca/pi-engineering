import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvelopeDraft } from "../../src/runtime/herdr/envelope.ts";
import { LineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { TaskLineageProjector, emitWorkTaskLineage, workTaskNodeId } from "../../src/work/taskLineage.ts";
import { type WorkGraph, emptyWorkGraph } from "../../src/work/types.ts";

function rig(fail = false) {
  const drafts: EnvelopeDraft[] = [];
  const lineage = new LineageEmitter({
    sink: {
      stage: async (d) => {
        if (fail) throw new Error("outbox down");
        drafts.push(d);
      },
    },
    source: "pi-test",
  });
  return { drafts, lineage };
}

const graph = (state: "open" | "working" | "done" = "open", source: "ledger" | "mission" = "ledger"): WorkGraph => ({
  ...emptyWorkGraph(),
  tasks: [
    {
      id: "tsk_1",
      source,
      title: "do the thing",
      state,
      raw_status: state,
      verification_status: "unknown",
      parent_id: "wi_1",
      created_at: null,
      updated_at: null,
      run_ids: ["run_1"],
      session_ids: [],
    },
  ],
  runs: [
    {
      id: "run_1",
      task_id: "tsk_1",
      source,
      session_id: null,
      health: "active",
      outcome: null,
      model: "m",
      worktree: null,
      started_at: null,
      ended_at: null,
    },
  ],
});

const payloads = (d: EnvelopeDraft[], type: string) => d.filter((x) => x.event_type === type).map((x) => x.payload);

describe("work task lineage", () => {
  it("emits a task node, an attempt node and a delegation edge task -> attempt", () => {
    const { drafts, lineage } = rig();
    emitWorkTaskLineage(lineage, graph("working"));
    const task = payloads(drafts, "node.upsert").find((p) => p.node_id === "task:tsk_1") as Record<string, any>;
    assert.equal(task.state, "running");
    assert.equal(task.attrs.source, "ledger");
    assert.equal(task.attrs.parent_id, "wi_1");
    const edge = payloads(drafts, "edge.add").find((p) => p.edge_type === "delegation") as Record<string, any>;
    assert.equal(edge.from_id, "task:tsk_1");
    assert.equal(edge.to_id, "attempt:run_1");
    assert.ok(!payloads(drafts, "edge.add").some((p) => p.edge_type === "spawn"));
    assert.ok(drafts.every((d) => d.task_id === "tsk_1"));
  });

  it("keeps the same node id when a legacy Mission is projected as a task", () => {
    assert.equal(workTaskNodeId("mis_9"), "task:mis_9");
    const a = rig();
    const b = rig();
    emitWorkTaskLineage(a.lineage, graph("open", "ledger"));
    emitWorkTaskLineage(b.lineage, graph("open", "mission"));
    const ids = (d: EnvelopeDraft[]) => d.filter((x) => x.event_type === "node.upsert").map((x) => x.entity_id);
    assert.deepEqual(ids(a.drafts), ids(b.drafts));
  });

  it("emits only changes: an unchanged task adds nothing, a state change adds one upsert", () => {
    const { drafts, lineage } = rig();
    const seen = new Map<string, string>();
    emitWorkTaskLineage(lineage, graph("open"), seen);
    const first = drafts.length;
    emitWorkTaskLineage(lineage, graph("open"), seen);
    assert.equal(drafts.length, first);
    emitWorkTaskLineage(lineage, graph("done"), seen);
    assert.ok(drafts.length > first);
  });

  it("no emitter is a no-op, and an emitter that fails never throws or blocks", async () => {
    emitWorkTaskLineage(null, graph());
    const { lineage } = rig(true);
    emitWorkTaskLineage(lineage, graph());
    await lineage.idle();
    assert.ok(lineage.stats().errors > 0);
  });

  it("the projector defers, coalesces and swallows a throwing source", () => {
    const { drafts, lineage } = rig();
    let calls = 0;
    const queue: Array<() => void> = [];
    const p = new TaskLineageProjector(
      {
        graph: () => {
          calls++;
          return graph();
        },
      },
      lineage,
      (fn) => queue.push(fn),
    );
    p.scheduleSync();
    p.scheduleSync();
    assert.equal(calls, 0, "nothing runs in the caller's turn");
    assert.equal(queue.length, 1, "coalesced");
    queue[0]!();
    assert.equal(calls, 1);
    assert.ok(drafts.length > 0);
    const boom = new TaskLineageProjector(
      {
        graph: () => {
          throw new Error("ledger unreadable");
        },
      },
      lineage,
      (fn) => fn(),
    );
    assert.doesNotThrow(() => boom.scheduleSync());
    const brokenDefer = new TaskLineageProjector({ graph: () => graph() }, lineage, () => {
      throw new Error("no timers");
    });
    assert.doesNotThrow(() => brokenDefer.scheduleSync());
    assert.doesNotThrow(() => new TaskLineageProjector({ graph: () => graph() }, null).scheduleSync());
  });
});
