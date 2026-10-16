/**
 * Issue #153: mission promotion goes through the SHA-fenced MergeQueue, built
 * by production code (EngineeringRuntime -> Orchestrator -> ExecutionBroker),
 * over a real MissionStore and real git fixture repositories.
 *
 * - review independence: same-model review is refused when a different-family
 *   reviewer was available, and promotes with exactly 1 warning when not;
 * - bounded repair: a stale-base rejection moves the mission to REPAIRING, and
 *   the third rejection leaves it BLOCKED (no fourth attempt);
 * - restart: reopening the runtime while MERGING produces exactly 1 merge commit;
 * - wiring: the queue's own states and its required-checks fence are observed,
 *   so promoting around the queue fails these tests.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import type { QueueState } from "../../src/merge/MergeQueue.ts";
import type { MissionMergeQueueOptions } from "../../src/orchestration/broker.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const execFileAsync = promisify(execFile);
const GOAL = "Add a health endpoint";

/** One fake model for every role: its family is unknown, so review is same_model_reduced. */
const singleModelRouter = { route: async () => ({ provider: "fake", id: "fake-reviewer" }) };

function acceptanceResults(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
    acceptanceId: match[1]!,
    status: "passed" as const,
    detail: "fake reviewer checked the criterion",
  }));
}

function fakeWorker(beforeReview?: () => Promise<void>): WorkerExecutor {
  return {
    async run(req: WorkerRequest) {
      if (req.role === "implementer") {
        await mkdir(join(req.cwd!, "src"), { recursive: true });
        await writeFile(join(req.cwd!, "src", "health.js"), "export const health = () => 'ok';\n", "utf8");
      }
      if (req.resultTool === "review_result") await beforeReview?.();
      return {
        result: {
          status: "completed",
          summary: `worker ${req.role} did its task`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 10,
          turns: 1,
          model: "fake",
        },
        toolCalls: 1,
        structured:
          req.resultTool === "review_result"
            ? {
                verdict: "approve",
                findings: [],
                missingTests: [],
                specGaps: [],
                acceptanceResults: acceptanceResults(req.task),
                summary: "approved",
              }
            : undefined,
      };
    },
  } as WorkerExecutor;
}

const fixtures: Array<{ cleanup: () => Promise<void> }> = [];
after(async () => {
  for (const fixture of fixtures) await fixture.cleanup();
});

/** A fixture whose own suite passes at the base, so the failure baseline is clean. */
async function greenFixture(): Promise<string> {
  const fixture = await makeFixtureRepo();
  fixtures.push(fixture);
  await writeFile(join(fixture.root, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  await git(fixture.root, "add", "-A");
  await git(fixture.root, "commit", "-q", "-m", "green baseline");
  return fixture.root;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...args])).stdout.trim();
}

function openRuntime(root: string, mergeQueue?: MissionMergeQueueOptions, beforeReview?: () => Promise<void>) {
  return EngineeringRuntime.open({
    cwd: root,
    worker: fakeWorker(beforeReview),
    verifier: new CommandVerifier(),
    roleRouter: singleModelRouter,
    ...(mergeQueue ? { mergeQueue } : {}),
  });
}

async function orchestrate(rt: EngineeringRuntime) {
  return rt.orchestrator!.orchestrate(GOAL, {
    repository: rt.cwd,
    baseRef: await rt.git!.headCommit(),
    mutationRequested: true,
  });
}

function describeRun(rt: EngineeringRuntime, missionId: string): string {
  return JSON.stringify({
    status: rt.missionStore!.getMission(missionId)?.status,
    findings: rt.missionStore!.listFindings(missionId).map((finding) => `${finding.category}: ${finding.summary}`),
  });
}

describe("mission promotion through the merge queue (issue #153)", () => {
  it("single-model review promotes with exactly 1 warning, through MERGE_QUEUED -> MERGING -> MERGED", async () => {
    const root = await greenFixture();
    const base = await git(root, "rev-parse", "HEAD");
    const observed: QueueState[] = [];
    const rt = await openRuntime(root, { onState: (_missionId, _entry, state) => observed.push(state) });
    try {
      const result = await orchestrate(rt);
      const missionId = result.mission.mission_id;
      assert.equal(result.completed, true, describeRun(rt, missionId));
      const review = rt.missionStore!.listReviewEvidence(missionId).at(-1);
      assert.equal(review?.independenceMode, "same_model_reduced", "precondition: one model reviews its own work");
      const warnings = rt.missionStore!.listFindings(missionId).filter((f) => f.category === "review_independence");
      assert.equal(warnings.length, 1, describeRun(rt, missionId));
      const head = await git(root, "rev-parse", "HEAD");
      assert.notEqual(head, base);
      assert.equal(warnings[0]?.evidence, head, "the warning names the promoted SHA");
      assert.deepEqual(rt.orchestrator!.broker.mergeQueueStates(missionId), ["MERGE_QUEUED", "MERGING", "MERGED"]);
      assert.deepEqual(observed, ["MERGE_QUEUED", "MERGING", "MERGED"]);
    } finally {
      await rt.close();
    }
  });

  it("refuses same_model_reduced review when a different-family reviewer was available", async () => {
    const root = await greenFixture();
    const base = await git(root, "rev-parse", "HEAD");
    const asked: string[] = [];
    const rt = await openRuntime(root, {
      differentFamilyReviewerAvailable: ({ reviewer }) => {
        asked.push(`${reviewer.provider}/${reviewer.model}`);
        return true;
      },
    });
    try {
      const result = await orchestrate(rt);
      const missionId = result.mission.mission_id;
      assert.equal(result.completed, false);
      assert.equal(result.mission.status, "BLOCKED", describeRun(rt, missionId));
      assert.equal(await git(root, "rev-parse", "HEAD"), base, "nothing was merged");
      assert.deepEqual(asked, ["fake/fake-reviewer"]);
      assert.ok(
        rt.missionStore!.listFindings(missionId).some((f) => /different-family reviewer was available/.test(f.summary)),
        describeRun(rt, missionId),
      );
      assert.equal(
        rt.missionStore!.listFindings(missionId).filter((f) => f.category === "review_independence").length,
        0,
      );
      assert.deepEqual(
        rt.orchestrator!.broker.mergeQueueStates(missionId),
        [],
        "a refused candidate never enters the queue",
      );
    } finally {
      await rt.close();
    }
  });

  it("a failing required check blocks the merge without bypass, and optional CI is never consulted", async () => {
    const root = await greenFixture();
    const base = await git(root, "rev-parse", "HEAD");
    const checked: string[] = [];
    const rt = await openRuntime(root, {
      requiredChecks: async (sha) => {
        checked.push(sha);
        return "fail";
      },
    });
    try {
      const result = await orchestrate(rt);
      const missionId = result.mission.mission_id;
      assert.equal(result.completed, false);
      assert.equal(await git(root, "rev-parse", "HEAD"), base, "a failing required check never merges");
      const candidateSha = rt.missionStore!.getCandidate(missionId)?.identity.candidateSha;
      assert.ok(
        checked.length > 0 && checked.every((sha) => sha === candidateSha),
        "checks are asked for the reviewed SHA",
      );
      assert.ok(!rt.orchestrator!.broker.mergeQueueStates(missionId).includes("MERGING"));
    } finally {
      await rt.close();
    }
  });

  it("a stale base moves the mission to REPAIRING twice, and the third rejection leaves it BLOCKED", async () => {
    const root = await greenFixture();
    let moved = "";
    // The target moves after review: the reviewed base is stale at promotion time.
    const moveTarget = async () => {
      if (moved) return;
      await writeFile(join(root, "UPSTREAM.md"), "landed upstream after review\n", "utf8");
      await git(root, "add", "UPSTREAM.md");
      await git(root, "commit", "-q", "-m", "upstream change");
      moved = await git(root, "rev-parse", "HEAD");
    };
    const statusAtQueue: string[] = [];
    let rt: EngineeringRuntime | undefined;
    rt = await openRuntime(
      root,
      {
        onState: (missionId, _entry, state) => {
          if (state === "MERGE_QUEUED") statusAtQueue.push(rt!.missionStore!.getMission(missionId)!.status);
        },
      },
      moveTarget,
    );
    try {
      const result = await orchestrate(rt);
      const missionId = result.mission.mission_id;
      assert.equal(result.completed, false);
      assert.equal(rt.missionStore!.getMission(missionId)?.status, "BLOCKED", describeRun(rt, missionId));
      assert.equal(await git(root, "rev-parse", "HEAD"), moved, "the stale candidate never merged");
      const rejections = rt.missionStore!.listFindings(missionId).filter((f) => f.category === "merge_queue");
      assert.equal(rejections.length, 3, describeRun(rt, missionId));
      assert.deepEqual(
        rejections.map((f) => f.severity),
        ["minor", "minor", "blocking"],
      );
      assert.ok(
        rejections.every((f) => /stale base/.test(f.summary)),
        describeRun(rt, missionId),
      );
      assert.deepEqual(rt.orchestrator!.broker.mergeQueueStates(missionId), [
        "MERGE_QUEUED",
        "MERGE_QUEUED",
        "MERGE_QUEUED",
      ]);
      assert.deepEqual(statusAtQueue.slice(1), ["REPAIRING", "REPAIRING"], "rounds 2 and 3 start from REPAIRING");
      assert.ok(rt.missionStore!.listMissionStops(missionId).length > 0, "BLOCKED carries a durable stop");
    } finally {
      await rt.close();
    }
  });

  it("reopening the runtime while MERGING finishes the promotion with exactly 1 merge commit", async () => {
    const root = await greenFixture();
    const base = await git(root, "rev-parse", "HEAD");
    // The process dies right after the promotion compare-and-swap: the merge
    // never reports back, so the mission is left in MERGING.
    let crashed!: (missionId: string) => void;
    const merging = new Promise<string>((resolve) => {
      crashed = resolve;
    });
    let mergingMission = "";
    const first = await openRuntime(root, {
      onState: (missionId, _entry, state) => {
        if (state === "MERGING") mergingMission = missionId;
      },
      decoratePrimitives: (primitives) => ({
        ...primitives,
        mergeBranch: async (...args) => {
          await primitives.mergeBranch(...args);
          crashed(mergingMission);
          return new Promise<never>(() => {});
        },
      }),
    });
    const pending = orchestrate(first);
    pending.catch(() => undefined);
    const missionId = await merging;
    assert.equal(first.orchestrator!.broker.mergeQueueStates(missionId).at(-1), "MERGING");
    const promoted = await git(root, "rev-parse", "HEAD");
    assert.notEqual(promoted, base, "the compare-and-swap committed before the crash");
    await first.close();

    const second = await openRuntime(root);
    try {
      // Opening recovers the interrupted mission; a supervisor tick drives it if not yet.
      for (let tick = 0; tick < 3 && second.missionStore!.getMission(missionId)!.status !== "COMPLETE"; tick++) {
        await second.missionSupervisor!.tick(missionId);
      }
      const mission = second.missionStore!.getMission(missionId)!;
      assert.equal(mission.status, "COMPLETE", describeRun(second, missionId));
      assert.equal(await git(root, "rev-parse", "HEAD"), promoted, "the recovered promotion is the original one");
      assert.equal(await git(root, "rev-list", "--merges", "--count", `${base}..HEAD`), "1");
      assert.deepEqual(second.orchestrator!.broker.mergeQueueStates(missionId), ["MERGED"]);
    } finally {
      await second.close();
    }
  });
});
