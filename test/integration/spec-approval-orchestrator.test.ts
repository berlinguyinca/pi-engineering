/**
 * End-to-end autonomous spec approval through the REAL EngineeringRuntime
 * wiring: runtime -> orchestrator -> specApproval hook (durable controller) ->
 * realBackends -> fake worker + real CommandVerifier over an isolated git
 * fixture repo. Proves the design slice 5 integration obligations:
 * generate -> request changes -> refine -> approve -> existing mission
 * execution, with tasks materialized ONLY from the current approval.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { MissionSpecStore } from "../../src/orchestration/missionSpecStore.ts";
import type { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  type ProtectedUserCriteria,
  SpecApprovalController,
  type SpecControllerResult,
  type SpecScopeEnvelope,
} from "../../src/orchestration/specApproval.ts";
import type { SpecWorkerModel } from "../../src/orchestration/specBackends.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

// A deterministic role router keeps this test hermetic: review evidence records
// the producing model (model/provider), which must not depend on the operator's
// installed models on the host (absent in CI).
const testRoleRouter = {
  route: async () => ({ provider: "fake", id: "fake-reviewer" }),
};

/** A fixture whose own test suite PASSES at baseline (see orchestration-runtime). */
async function greenFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const fx = await makeFixtureRepo();
  await writeFile(`${fx.root}/src/add.js`, "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  await exec("git", ["-C", fx.root, "add", "-A"]);
  await exec("git", ["-C", fx.root, "commit", "-q", "-m", "green baseline"]);
  return fx;
}

function acceptanceResults(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
    acceptanceId: match[1]!,
    status: "passed" as const,
    detail: "fake reviewer checked the criterion",
  }));
}

function specBackends(reviewVerdicts: Array<"approve" | "request_changes">) {
  let reviewIndex = 0;
  let refineCount = 0;
  const task = (acceptanceIds: string[], objective: string) => ({
    kind: "agent",
    role: "implementer",
    objective,
    mutates_repo: true,
    write_domains: ["**"],
    acceptance_ids: acceptanceIds,
    deliverables: ["implementation", "targeted-tests"],
    execution_budget_ms: 60_000,
    isolation: "worktree",
    depends_on: [],
    priority: 0,
    execution_requirements: {},
    checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
    max_attempts: 3,
    failure_policy: "retry",
  });
  return {
    author: {
      async draft(input: { protectedInputs: ProtectedUserCriteria }) {
        const acceptanceIds = input.protectedInputs.acceptance.map((a) => a.id);
        return {
          ok: true,
          draft: {
            derivedAcceptance: ["derived"],
            designSummary: "spec summary",
            testObligations: ["tests"],
            assumptions: [],
            risks: [],
            nonGoals: [],
            proposedTasks: [task(acceptanceIds, "implement the health endpoint")],
          },
          sessionId: "author-sess",
          modelId: "local/local",
        };
      },
    },
    reviewer: {
      async review(input: { acceptanceIds: string[] }) {
        const verdict = reviewVerdicts[Math.min(reviewIndex++, reviewVerdicts.length - 1)]!;
        return {
          ok: true,
          verdict,
          findings: verdict === "approve" ? [] : [{ severity: "blocking", title: "gap", detail: "detail" }],
          proposedAdjustments: [],
          uncoveredRisks: [],
          scopeViolations: [],
          acceptanceResults: input.acceptanceIds.map((acceptanceId) => ({
            acceptanceId,
            result: "covered" as const,
          })),
          summary: "ok",
          confidence: 0.9,
          sessionId: "review-sess",
          modelId: "local/reviewer",
        };
      },
    },
    refiner: {
      async refine(input: { protectedInputs: ProtectedUserCriteria }) {
        refineCount += 1;
        const acceptanceIds = input.protectedInputs.acceptance.map((a) => a.id);
        return {
          ok: true,
          draft: {
            derivedAcceptance: ["derived"],
            designSummary: `spec summary refined ${refineCount}`,
            testObligations: ["tests"],
            assumptions: [],
            risks: [],
            nonGoals: [],
            proposedTasks: [task(acceptanceIds, "implement the health endpoint")],
          },
          sessionId: "refiner-sess",
          modelId: "local/local",
        };
      },
    },
  };
}

async function openSpecApprovalRuntime(
  root: string,
  reviewVerdicts: Array<"approve" | "request_changes">,
): Promise<{ runtime: EngineeringRuntime; backends: ReturnType<typeof specBackends> }> {
  let storeRef: MissionStore | null = null;
  const authorModel: SpecWorkerModel = { id: "local/local", provider: "local" };
  const reviewerModel: SpecWorkerModel = { id: "local/reviewer", provider: "local" };
  const backends = specBackends(reviewVerdicts);
  const worker: WorkerExecutor = {
    async run(req) {
      if (req.role === "implementer") {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(req.cwd ?? root, "src"), { recursive: true });
        await writeFile(
          join(req.cwd ?? root, "src", "orchestrated.ts"),
          `// produced by the spec-approved implementer\nexport const orchestrated = true;\n`,
          "utf8",
        );
      }
      return {
        result: {
          status: "completed",
          summary: `worker ${req.role} did ${req.task}`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 100,
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
  };
  const runtime = await EngineeringRuntime.open({
    cwd: root,
    worker,
    verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
    roleRouter: testRoleRouter,
    orchestrationSpecApproval: async (input: {
      missionId: string;
      protectedInputs: ProtectedUserCriteria;
      acceptanceIds: string[];
      envelope: SpecScopeEnvelope;
    }): Promise<SpecControllerResult> => {
      const store = storeRef!;
      const specStore = new MissionSpecStore(store);
      const controller = new SpecApprovalController({
        missionId: input.missionId,
        protectedInputs: input.protectedInputs,
        acceptanceIds: input.acceptanceIds,
        envelope: input.envelope,
        store: specStore,
        author: backends.author,
        reviewer: backends.reviewer,
        refiner: backends.refiner,
        authorModel,
        reviewerModel,
      });
      return controller.run();
    },
  });
  storeRef = runtime.missionStore;
  return { runtime, backends };
}

describe("autonomous spec approval through the orchestrator", () => {
  const fixtures: Array<{ root: string; cleanup: () => Promise<void> }> = [];
  after(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  });

  it("approves the exact plan and materializes tasks from the current approval before dispatch", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const { runtime } = await openSpecApprovalRuntime(fx.root, ["approve"]);
    const store = runtime.missionStore!;
    const baseRef = await runtime.git!.headCommit();
    const result = await runtime.orchestrator!.orchestrate("Add a health endpoint", {
      repository: runtime.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(result.completed, true, result.failureReason ?? "");
    assert.ok(result.mission.status === "COMPLETE");
    const mission = store.getMission(result.mission.mission_id)!;
    const approval = store.getSpecApproval(mission.mission_id);
    assert.ok(approval, "an approval must be durably persisted");
    assert.equal(approval.actor, "policy");
    const revision = store.getSpecRevision(mission.mission_id)!;
    assert.equal(approval.semanticSpecHash, revision.semanticSpecHash);
    assert.equal(approval.planHash, revision.planHash);
    // At least one implementation task was materialized from the approved plan.
    assert.ok(store.listTasks(mission.mission_id).some((task) => task.kind === "agent"));
  });

  it("refines within budget when review requests changes, then approves and executes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const { runtime } = await openSpecApprovalRuntime(fx.root, ["request_changes", "approve"]);
    const store = runtime.missionStore!;
    const baseRef = await runtime.git!.headCommit();
    const result = await runtime.orchestrator!.orchestrate("Add a health endpoint", {
      repository: runtime.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(result.completed, true, result.failureReason ?? "");
    const mission = store.getMission(result.mission.mission_id)!;
    const revision = store.getSpecRevision(mission.mission_id)!;
    // At least one refinement occurred.
    assert.ok(revision.revisionNumber >= 2, `expected refinement, got revisionNumber=${revision.revisionNumber}`);
    assert.ok(store.getSpecApproval(mission.mission_id));
  });
});
