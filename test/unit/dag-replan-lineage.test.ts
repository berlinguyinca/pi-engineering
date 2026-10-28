/**
 * T16 wiring: a re-planned AutoSpec DAG withdraws what the new plan dropped. The emitter is the real one writing to a
 * real envelope outbox; the assertions read the events. Reverting the withdrawal leaves the stale edges standing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ISSUE_REFS_EXTENSION, ingestAutoSpecDag } from "../../src/integrations/autospec/dagIngest.ts";
import { emitDagLineage } from "../../src/integrations/autospec/dagLineage.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";

type Rec = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("../fixtures/autospec-dag/valid.json", import.meta.url), "utf8")) as {
  mission: Rec;
  tasks: Rec[];
};
const task = (id: string, seq: number, deps: string[], refs: string[] = []): Rec => ({
  ...structuredClone(fixture.tasks[0]!),
  idempotency_key: `idem-${id}`,
  sequence: seq,
  task_id: id,
  depends_on: deps,
  affected_surfaces: [{ path: `pkg/${id}/x.ts` }],
  ...(refs.length ? { required_extensions: [ISSUE_REFS_EXTENSION], extensions: { [ISSUE_REFS_EXTENSION]: refs } } : {}),
});
const ingest = (tasks: Rec[]) => {
  const r = ingestAutoSpecDag({ mission: { ...fixture.mission, state: "PLANNED" }, tasks });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<typeof r, { ok: true }>;
};

describe("a re-planned DAG withdraws what it dropped", () => {
  it("removes dropped dependency + issue_link edges with a reason, cancels dropped tasks, keeps the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dag-replan-"));
    const store = new EnvelopeStore({ dir, source: "pi-h-00000001" });
    const lineage = createLineageEmitter({ store }, { host: "pi-h-00000001" })!;
    const v1 = ingest([
      task("t-1", 1, [], ["a/b#1"]),
      task("t-2", 2, ["t-1"], ["a/b#2"]),
      task("t-3", 3, ["t-1", "t-2"]),
    ]);
    const first = emitDagLineage(lineage, v1);
    // v2 drops t-3 entirely, the t-2 -> t-1 dependency, and t-2's issue link
    const v2 = ingest([task("t-1", 1, [], ["a/b#1"]), task("t-2", 2, [])]);
    emitDagLineage(lineage, v2, undefined, first.projection);
    await lineage.idle();
    const events = (await store.outbox.pending()).filter((e) => e.entity_type === "lineage");
    const removed = events
      .filter((e) => e.event_type === "edge.remove")
      .map((e) => e.payload as { edge_type: string; from_id: string; to_id: string; reason?: string });
    const key = (r: { edge_type: string; from_id: string; to_id: string }) => `${r.edge_type} ${r.from_id}>${r.to_id}`;
    const m = String(v2.missionId);
    const got = removed.map(key).sort();
    assert.deepEqual(
      got,
      [
        `dependency task:${m}/t-2>task:${m}/t-1`,
        `dependency task:${m}/t-3>task:${m}/t-1`,
        `dependency task:${m}/t-3>task:${m}/t-2`,
        `issue_link task:${m}/t-2>issue:github.com/a/b#2`,
      ].sort(),
    );
    for (const r of removed) assert.ok(r.reason && r.reason.length > 3, "every removal carries a reason");
    const cancelled = events
      .filter((e) => e.event_type === "node.state" && e.payload.state === "cancelled")
      .map((e) => e.payload.node_id);
    assert.deepEqual(cancelled, [`task:${m}/t-3`]);
    assert.ok(!got.some((k) => k.includes("issue:github.com/a/b#1")), "a kept link is not removed");
  });

  it("an identical re-plan and a first plan remove nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dag-replan-"));
    const store = new EnvelopeStore({ dir, source: "pi-h-00000002" });
    const lineage = createLineageEmitter({ store }, { host: "pi-h-00000002" })!;
    const v = ingest([task("t-1", 1, []), task("t-2", 2, ["t-1"])]);
    const first = emitDagLineage(lineage, v);
    emitDagLineage(lineage, v, undefined, first.projection);
    await lineage.idle();
    const events = (await store.outbox.pending()).filter((e) => e.entity_type === "lineage");
    assert.equal(events.filter((e) => e.event_type === "edge.remove").length, 0);
  });
});
