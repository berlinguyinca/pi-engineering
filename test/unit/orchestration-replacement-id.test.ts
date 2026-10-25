/**
 * #420: replacement-task ids must stay bounded across recovery generations.
 *
 * Recovery re-feeds its own replacements: if a replacement id embeds the FULL
 * failed-task id (the old `${recoveryId}-TSK-${failed.task_id}-${index}` form),
 * every generation appends ~22 chars, and the git branch/worktree names derived
 * from the id (`pi-eng-orch-<taskId>`) eventually exceed the filesystem path
 * limit — a transient first failure becomes a permanent mission kill. The
 * bounded helper keeps parentage in the durable supersession lineage instead.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replacementTaskId } from "../../src/orchestration/orchestrator.ts";

/** The branch/worktree name the broker derives from a task id. */
const branchName = (taskId: string): string => `pi-eng-orch-${taskId}`;

// Linux ext4 caps a single path COMPONENT at 255 bytes; keep real headroom.
const COMPONENT_LIMIT = 255;
const SAFE_LIMIT = 120;

describe("replacement task ids (#420)", () => {
  it("is deterministic for a given (recoveryId, failedTaskId, index)", () => {
    const a = replacementTaskId("RCV-aaaa", "TSK-xyz", 1);
    const b = replacementTaskId("RCV-aaaa", "TSK-xyz", 1);
    assert.equal(a, b, "replay must reproduce the same id");
    assert.notEqual(a, replacementTaskId("RCV-aaaa", "TSK-xyz", 2), "index distinguishes siblings");
    assert.notEqual(a, replacementTaskId("RCV-bbbb", "TSK-xyz", 1), "recoveryId distinguishes decisions");
    assert.notEqual(a, replacementTaskId("RCV-aaaa", "TSK-abc", 1), "failed-task hash distinguishes parents");
  });

  it("stays bounded and unique across 50 chained recovery generations", () => {
    let taskId = "TSK-original";
    const seen = new Set<string>();
    for (let generation = 1; generation <= 50; generation += 1) {
      // Each generation plans a fresh recovery decision and one replacement.
      const recoveryId = `RCV-gen${String(generation).padStart(3, "0")}`;
      taskId = replacementTaskId(recoveryId, taskId, 1);
      seen.add(taskId);
      assert.ok(
        taskId.length <= SAFE_LIMIT,
        `generation ${generation} id exceeds ${SAFE_LIMIT}: ${taskId.length} (${taskId})`,
      );
      assert.ok(
        branchName(taskId).length < COMPONENT_LIMIT,
        `generation ${generation} branch exceeds path component limit: ${branchName(taskId).length}`,
      );
    }
    assert.equal(seen.size, 50, "every generation's id is unique");
  });

  it("does not embed the parent task id", () => {
    const parent = "TSK-eKAqBL";
    const child = replacementTaskId("RCV-1111", parent, 1);
    assert.ok(!child.includes(parent), `child id must not embed the parent: ${child}`);
    // ...and the digest is a stable, collision-resistant stand-in.
    assert.equal(child, replacementTaskId("RCV-1111", parent, 1));
  });
});
