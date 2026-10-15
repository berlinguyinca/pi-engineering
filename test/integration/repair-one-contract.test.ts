/**
 * Repair loop contract (issue #182), against real git and the real broker with
 * scripted backends:
 *  - every open blocking finding of a round goes to ONE repair task;
 *  - only blocker/critical findings block; a "high" missing_tests finding is
 *    recorded but does not stop completion;
 *  - a failed merge is retried deterministically before any LLM repair task.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { normalizeReviewSeverity } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

interface RawFinding {
  severity: string;
  category: string;
  summary: string;
  file?: string;
  line?: number;
  recommended_action?: string;
}

interface Script {
  /** Findings the Nth review (0-based) reports; an empty list approves. */
  reviews: RawFinding[][];
  /** How many integration runs fail before one succeeds. */
  failIntegrations?: number;
  /** How a failing integration reports: "conflict" (merge) or "failed" (checks ran and failed). */
  integrationFailure?: "conflict" | "failed";
  /** Reviewer verdict per review; defaults to request_changes iff a blocking finding is reported. */
  verdicts?: Array<"approve" | "request_changes">;
}

async function harness(script: Script) {
  const fixture = await makeFixtureRepo();
  const git = (await GitRepo.open(fixture.root))!;
  const baseSha = await git.headCommit();
  const calls = { agent: 0, integration: 0, review: 0 };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ worktree }) => {
        calls.agent++;
        if (!worktree) throw new Error("worktree missing");
        await writeFile(
          join(worktree, "src", `change-${calls.agent}.ts`),
          `export const change${calls.agent} = true;\n`,
        );
        await git.commitAll(worktree, `change ${calls.agent}`);
        return { executionId: "agent", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
      },
    },
    integration: {
      candidateScoped: true,
      runIntegration: async (input) => {
        calls.integration++;
        if (calls.integration <= (script.failIntegrations ?? 0)) {
          return {
            executionId: "integration",
            exitStatus: script.integrationFailure ?? "conflict",
            summary:
              script.integrationFailure === "failed"
                ? "integrated pi-eng-orch; checks: typecheck failed"
                : "integration conflicts: could not lock ref",
            artifactRefs: [],
            usage: {},
          };
        }
        for (const [sequence, handoff] of input.handoffs.entries()) {
          const merged = await git.mergeRefInWorktree(
            input.candidate!,
            handoff.ref ?? handoff.worktree.branch,
            input.authority,
            input.candidateLifecycle,
            sequence,
            {},
            input.integrationRun,
          );
          if (!merged.merged) {
            return {
              executionId: "integration",
              exitStatus: "failed",
              summary: merged.reason ?? "merge failed",
              artifactRefs: [],
              usage: {},
            };
          }
        }
        return {
          executionId: "integration",
          exitStatus: "succeeded",
          summary: "integrated",
          artifactRefs: [],
          usage: {},
        };
      },
    },
    validation: {
      candidateScoped: true,
      runValidation: async () => ({
        executionId: "validation",
        exitStatus: "succeeded",
        summary: "valid",
        artifactRefs: [],
        usage: {},
        validationEvidence: {
          command: "test",
          profile: "test",
          exitCode: 0,
          testSummary: { passed: 1 },
          noTargets: false,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    review: {
      candidateScoped: true,
      runReview: async ({ acceptanceCriteria }) => {
        const found = script.reviews[Math.min(calls.review, script.reviews.length - 1)] ?? [];
        calls.review++;
        const blocking = found.some((f) => normalizeReviewSeverity(f.severity, f.category) === "blocking");
        return {
          executionId: "review",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings: found.map((f) => ({ ...f })),
          reviewEvidence: {
            reviewerSessionId: `review-${calls.review}`,
            model: "test",
            provider: "test",
            verdict: script.verdicts?.[calls.review - 1] ?? (blocking ? "request_changes" : "approve"),
            independenceMode: "independent",
            findings: found.map((f) => ({
              severity: normalizeReviewSeverity(f.severity, f.category),
              summary: f.summary,
              status: "open" as const,
            })),
            outputValid: true,
            accessible: true,
            acceptanceResults: (acceptanceCriteria ?? []).map((criterion) => ({
              acceptanceId: criterion.acceptanceId,
              status: "passed" as const,
              detail: "checked",
            })),
          },
        };
      },
    },
  };
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const orchestrator = new Orchestrator({
    store,
    repositoryRegistry: new RepositoryRegistry(),
    backends,
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "Add the change module",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id ? [criterion.acceptance_id] : [],
        ),
        max_attempts: 1,
        failure_policy: "block" as const,
      },
    ],
    recovery: { missionCeiling: 20, strategyMaxAttempts: 5 },
  });
  const run = () =>
    orchestrator.orchestrate(`Add the change module in ${fixture.root}`, {
      repository: fixture.root,
      baseRef: baseSha,
      mutationRequested: true,
    });
  return { fixture, store, calls, run };
}

const agentTasks = (store: MissionStore, missionId: string) =>
  store.listTasks(missionId).filter((task) => task.kind === "agent");

describe("repair loop (#182)", () => {
  it("sends three blocking findings to exactly one repair task naming all three", async () => {
    const h = await harness({
      reviews: [
        [
          { severity: "blocker", category: "correctness", summary: "off-by-one in pager", file: "src/a.ts", line: 4 },
          {
            severity: "critical",
            category: "security",
            summary: "unescaped shell argument",
            recommended_action: "quote it",
          },
          { severity: "blocker", category: "correctness", summary: "leaks file handle on error path" },
        ],
        [],
      ],
    });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      const repairs = agentTasks(h.store, missionId).filter((task) => /^Repair contract/.test(task.objective));
      assert.equal(repairs.length, 1, JSON.stringify(agentTasks(h.store, missionId).map((t) => t.objective)));
      const objective = repairs[0]!.objective;
      for (const text of ["off-by-one in pager", "unescaped shell argument", "leaks file handle on error path"]) {
        assert.ok(objective.includes(text), `contract names "${text}"`);
      }
      assert.ok(objective.includes("src/a.ts:4"));
      assert.ok(objective.includes("quote it"));
      assert.equal(h.calls.agent, 2, "the original implementer plus one repair implementer");
      const resolved = h.store
        .listFindings(missionId)
        .filter((f) => f.severity === "blocking" && f.status === "resolved");
      assert.equal(resolved.length, 3, "each finding is resolved individually after the round");
      assert.equal(result.mission.status, "COMPLETE");
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("records a high missing_tests finding without blocking completion", async () => {
    const h = await harness({
      reviews: [[{ severity: "high", category: "missing_tests", summary: "no test covers the empty page" }]],
    });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      assert.equal(result.mission.status, "COMPLETE", JSON.stringify(result.verdict));
      assert.equal(h.calls.agent, 1, "no repair round for a non-blocking finding");
      const recorded = h.store.listFindings(missionId).find((f) => f.category === "missing_tests");
      assert.ok(recorded, "the finding stays on the mission");
      assert.equal(recorded.severity, "major");
      assert.equal(recorded.status, "open");
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("retries a failed merge deterministically before creating any LLM repair task", async () => {
    const h = await harness({ reviews: [[]], failIntegrations: 1 });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      assert.equal(h.calls.integration, 2, "the merge was re-run once");
      assert.equal(h.calls.agent, 1, "no LLM task was created for the merge failure");
      assert.ok(
        !agentTasks(h.store, missionId).some((task) => /Fix the failing integration/.test(task.objective)),
        "no 'Fix the failing integration step' task",
      );
      assert.equal(result.mission.status, "COMPLETE", JSON.stringify(result.verdict));
    } finally {
      await h.fixture.cleanup();
    }
  });
  it("repairs a request_changes verdict whose findings are only non-blocking instead of dead-ending", async () => {
    const h = await harness({
      reviews: [[{ severity: "medium", category: "correctness", summary: "naming drift in the pager" }], []],
      verdicts: ["request_changes", "approve"],
    });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      const repairs = agentTasks(h.store, missionId).filter((task) => /^Repair contract/.test(task.objective));
      assert.equal(repairs.length, 1);
      assert.ok(repairs[0]!.objective.includes("naming drift in the pager"));
      assert.equal(result.mission.status, "COMPLETE", JSON.stringify(result.verdict));
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("does not complete on an approve verdict that carries an open high correctness defect", async () => {
    const h = await harness({
      reviews: [[{ severity: "high", category: "correctness", summary: "drops the last page" }]],
      verdicts: ["approve", "approve", "approve"],
    });
    try {
      const result = await h.run();
      assert.notEqual(result.mission.status, "COMPLETE");
      assert.equal(result.completed, false);
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("re-sends only the finding the next review still reports, without a duplicate row", async () => {
    const a = { severity: "blocker", category: "correctness", summary: "alpha defect" };
    const b = { severity: "blocker", category: "correctness", summary: "bravo defect" };
    const c = { severity: "blocker", category: "correctness", summary: "charlie defect" };
    const h = await harness({ reviews: [[a, b, c], [b], []] });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      const repairs = agentTasks(h.store, missionId).filter((task) => /^Repair contract/.test(task.objective));
      assert.equal(repairs.length, 2, "one contract per round");
      assert.ok(/alpha/.test(repairs[0]!.objective) && /charlie/.test(repairs[0]!.objective));
      assert.ok(/bravo/.test(repairs[1]!.objective));
      assert.ok(!/alpha|charlie/.test(repairs[1]!.objective), "fixed findings are not re-sent");
      const bravoRows = h.store.listFindings(missionId).filter((f) => f.summary === "bravo defect");
      assert.equal(bravoRows.length, 1, "the still-open finding is not duplicated");
      assert.equal(result.mission.status, "COMPLETE", JSON.stringify(result.verdict));
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("stops naming the preserved work once the deterministic merge budget is spent", async () => {
    const h = await harness({ reviews: [[]], failIntegrations: 10 });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      assert.equal(h.calls.integration, 3, "the first merge plus two deterministic retries");
      assert.equal(h.calls.agent, 1, "no LLM repair task for a merge failure");
      assert.notEqual(result.mission.status, "COMPLETE");
      const stop = h.store.listMissionStops(missionId).at(-1)!;
      assert.match(stop.reason, /integration/);
      assert.ok(
        stop.preservedWork.some((ref) => /pi-eng-orch-TSK/.test(ref)),
        `the preserved branch is named: ${JSON.stringify(stop.preservedWork)}`,
      );
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("turns an integration whose checks ran and failed into a code-repair contract", async () => {
    const h = await harness({ reviews: [[]], failIntegrations: 1, integrationFailure: "failed" });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      const repairs = agentTasks(h.store, missionId).filter((task) => task.objective !== "Add the change module");
      assert.equal(repairs.length, 1);
      assert.match(repairs[0]!.objective, /integration/i);
      assert.equal(h.calls.agent, 2);
      assert.equal(result.mission.status, "COMPLETE", JSON.stringify(result.verdict));
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("builds the contract task on the current candidate and carries the acceptance ids", async () => {
    const h = await harness({
      reviews: [[{ severity: "blocker", category: "correctness", summary: "bad edge case" }], []],
    });
    try {
      const result = await h.run();
      const missionId = result.mission.mission_id;
      const tasks = agentTasks(h.store, missionId);
      const original = tasks.find((task) => task.objective === "Add the change module")!;
      const repair = tasks.find((task) => /^Repair contract/.test(task.objective))!;
      assert.match(repair.repair_base_candidate_sha ?? "", /^[0-9a-f]{40}$/);
      assert.deepEqual(repair.acceptance_ids ?? [], original.acceptance_ids ?? []);
    } finally {
      await h.fixture.cleanup();
    }
  });
});
