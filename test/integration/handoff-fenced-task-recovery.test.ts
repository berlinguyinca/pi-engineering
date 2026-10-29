/**
 * End to end through Orchestrator.orchestrate: an emergency context crossing fences the live worker through the verified
 * protocol; the worker (like a real PiWorkerExecutor) keeps running and returns later. This pins what the mission does
 * with the fenced task, and that the recovery worker that continues it is the handoff's successor.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { CONTEXT_USAGE_SUMMARY } from "../../src/workers/activity.ts";
import { sharedProcessQuarantine } from "../../src/workers/processQuarantine.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a fenced worker's task is recovered by a successor session that acknowledges the handoff", async () => {
  const fx = await makeFixtureRepo();
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ worktree, signal, onActivity, sessionId }) => {
          calls += 1;
          await mkdir(join(worktree!, "src"), { recursive: true });
          await writeFile(join(worktree!, "src", `w${calls}.js`), `export const a = ${calls};\n`);
          await git.commitAll(worktree!, `work ${calls}`);
          if (calls === 1) {
            sharedProcessQuarantine.track(signal, { pid: child.pid as number });
            onActivity?.({
              kind: "state",
              summary: CONTEXT_USAGE_SUMMARY,
              meaningfulProgress: false,
              context: { tokens: 950, window: 1000, model: "gw/test" },
            });
            // Keep running until the fence lands, then return success like a worker that did not notice.
            const end = Date.now() + 15_000;
            while (Date.now() < end && !store.listHandoffRecords().some((h) => h.sourceFencedAt)) {
              await new Promise((r) => setTimeout(r, 20));
            }
          }
          assert.ok(sessionId, "the broker names the worker session");
          return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
        },
      },
      integration: {
        runIntegration: async ({ handoffs }: { handoffs: IntegrationHandoff[] }) => {
          for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
          return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
        },
      },
    };
    const orchestrator = new Orchestrator({
      store,
      backends,
      git,
      parentSessionId: "sess-parent",
      phaseHandoff: { contextWindowForModel: () => 1000 },
      planner: async (mission) => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "build",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "worktree" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((c) => (c.acceptance_id ? [c.acceptance_id] : [])),
          deliverables: ["one"],
          max_attempts: 3,
          failure_policy: "retry" as const,
        },
      ],
    });
    const result = await orchestrator.orchestrate("build", {
      repository: fx.root,
      baseRef: await git.headCommit(),
      mutationRequested: true,
    });
    await orchestrator.settleHandoffs();
    const missionId = result.mission.mission_id;
    const records = store.listHandoffRecords(missionId);
    const tasks = store.listTasks(missionId).filter((t) => t.kind === "agent");
    const executions = store.listExecutions(missionId).filter((e) => e.backend === "agent");
    // The harness has no validation/review backends, so the mission itself cannot complete; that is not under test.
    const [fenced, successor] = executions;
    assert.equal(executions.length, 2, "the fenced attempt and exactly one retry");
    assert.equal(fenced?.status, "CANCELED");
    assert.match(fenced?.exit_status ?? "", /late_result_rejected:handoff source fenced/);
    assert.equal(successor?.status, "SUCCEEDED", "the retry (a fresh worker session) completed the work");
    assert.notEqual(successor?.session_id, fenced?.session_id);
    assert.deepEqual(
      tasks.map((t) => t.status),
      ["SUCCEEDED"],
      "the task was recovered, not failed",
    );
    assert.equal(records.length, 1, "one handoff for one crossing");
    const [record] = records;
    assert.equal(record?.state, "acknowledged");
    assert.equal(record?.predecessor.sessionId, fenced?.session_id);
    assert.equal(record?.successor?.sessionId, successor?.session_id, "the recovery worker is the handoff's successor");
    assert.ok(record?.verifiedAt && record.sourceFencedAt);
    assert.equal(alive(child.pid as number), false, "the fenced writer's registered process group is gone");
  } finally {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {}
    await fx.cleanup();
  }
});
