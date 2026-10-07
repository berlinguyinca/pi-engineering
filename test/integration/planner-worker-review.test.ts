import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseTaskContract } from "../../src/plannerWorker/contract.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { buildHandoff } from "../../src/plannerWorker/handoff.ts";
import { runPlanner } from "../../src/plannerWorker/planner.ts";
import {
  MAX_CORRECTION_CHANGES,
  MAX_CORRECTION_ISSUES,
  blockedEvidence,
  buildCorrectionContract,
  normalizeVerdict,
  reviewPlanFor,
  runBatchReview,
  runReview,
  scopeViolations,
} from "../../src/plannerWorker/review.ts";
import type { MissionBrief, TaskContract } from "../../src/plannerWorker/types.ts";
import { type GatewayServer, startGatewayServer } from "../support/gatewayServer.ts";

const servers: GatewayServer[] = [];
const dirs: string[] = [];
after(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const brief: MissionBrief = {
  mission_id: "M2",
  summary: "Add refresh-token rotation.",
  architectural_context: [],
  acceptance_criteria: [],
  constraints: [],
};

function contract(id: string, risk: "low" | "medium" | "high" = "medium"): TaskContract {
  const r = parseTaskContract({
    task_id: id,
    objective: `objective ${id}`,
    scope: { allowed: ["src/auth/**"], forbidden: ["src/auth/legacy/**"] },
    acceptance: ["works"],
    verification: ["npm test"],
    risk,
  });
  assert.ok(r.ok);
  return r.contract;
}

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pw-review-"));
  dirs.push(d);
  return d;
}

test("normalizeVerdict accepts the structured shape and the lifecycle review_result shape", () => {
  assert.deepEqual(
    normalizeVerdict({ status: "replan", issues: ["contract contradicts API"], contract_violation: true }),
    {
      status: "replan",
      issues: [{ severity: "major", summary: "contract contradicts API" }],
      required_changes: [],
      contract_violation: true,
    },
  );
  const legacy = normalizeVerdict({
    verdict: "request_changes",
    findings: [{ severity: "critical", title: "SQL injection" }],
  });
  assert.equal(legacy?.status, "needs_fix");
  assert.equal(legacy?.issues[0]?.severity, "blocking");
  assert.equal(normalizeVerdict({ status: "maybe" }), null);
});

test("buildCorrectionContract is bounded, prioritises serious issues and never widens scope", () => {
  const c = contract("auth-3");
  const correction = buildCorrectionContract({
    contract: c,
    attempt: 2,
    verdict: {
      status: "needs_fix",
      issues: [
        ...Array.from({ length: 10 }, (_, i) => ({ severity: "minor" as const, summary: `nit ${i}` })),
        { severity: "blocking", summary: "expired tokens accepted" },
        { severity: "major", summary: "rotation not persisted" },
      ],
      required_changes: Array.from({ length: 12 }, (_, i) => `change ${i}`),
      contract_violation: false,
    },
    failedVerification: [
      { command: "npm test", exit_code: 1, passed: false, output_tail: "\nFAIL refresh.test\n", duration_ms: 3 },
    ],
    outOfScope: ["src/other.ts"],
  });
  assert.ok(correction.required_changes.length <= MAX_CORRECTION_CHANGES);
  assert.ok(correction.issues.length <= MAX_CORRECTION_ISSUES);
  assert.equal(correction.issues[0]?.severity, "blocking");
  assert.ok(correction.issues.every((i) => i.severity !== "minor"));
  assert.match(correction.required_changes.join("\n"), /revert every change outside scope/);
  assert.match(correction.required_changes.join("\n"), /make `npm test` exit 0 \(currently: FAIL refresh.test\)/);
  assert.deepEqual(correction.scope, c.scope);
  assert.doesNotMatch(correction.objective, /fix the review comments/i);
});

test("scope violations and BLOCKED evidence are detected deterministically", () => {
  const c = contract("auth-1");
  assert.deepEqual(scopeViolations(["src/auth/a.ts", "src/auth/legacy/x.ts", "README.md"], c.scope), [
    "src/auth/legacy/x.ts",
    "README.md",
  ]);
  const base = { claims: [], evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
  const blocked = {
    result: {
      ...base,
      status: "blocked" as const,
      summary: "x",
      details: { evidence: "the API has no refresh endpoint at all" },
    },
    usage: null,
  };
  assert.equal(blockedEvidence(blocked), "the API has no refresh endpoint at all");
  const noEvidence = { result: { ...base, status: "blocked" as const, summary: "no", details: {} }, usage: null };
  assert.equal(blockedEvidence(noEvidence), null);
});

test("review frequency follows contract risk", () => {
  assert.deepEqual(reviewPlanFor("low"), { preReview: false, review: "batch" });
  assert.deepEqual(reviewPlanFor("medium"), { preReview: false, review: "immediate" });
  assert.deepEqual(reviewPlanFor("high"), { preReview: true, review: "immediate" });
});

test("runReview and runBatchReview read structured verdicts over a real gateway; garbage becomes a blocking needs_fix", async () => {
  const server = await startGatewayServer({
    respond: (req) => {
      if (req.user.startsWith("BATCH REVIEW")) {
        return {
          content: JSON.stringify({
            reviews: [
              { task_id: "low-1", status: "pass", issues: [], required_changes: [] },
              { task_id: "low-2", status: "needs_fix", issues: [{ severity: "major", summary: "missing edge case" }] },
            ],
          }),
        };
      }
      if (req.user.includes("PRE-IMPLEMENTATION")) return { content: "I am not sure." };
      return {
        content: JSON.stringify({ status: "pass", issues: [], required_changes: [], contract_violation: false }),
      };
    },
  });
  servers.push(server);
  const cwd = await tmp();
  const worker = new GatewayChatWorkerExecutor({ baseUrl: server.baseUrl, defaultModel: "coding-review" });
  const plan = { decisions: [], architectural_context: [] };
  const handoff = (c: TaskContract) =>
    buildHandoff({
      kind: "worker_to_reviewer",
      brief,
      plan,
      contract: c,
      from: "implementer",
      to: "reviewer",
      workerOutcome: { summary: "done", changed_files: ["src/auth/a.ts"], diff: "+x", verification: [] },
    });
  const post = await runReview({ worker, handoff: handoff(contract("m-1")), cwd });
  assert.equal(post.verdict.status, "pass");
  assert.equal(post.valid, true);

  const pre = await runReview({ worker, handoff: handoff(contract("h-1", "high")), cwd, mode: "pre" });
  assert.equal(pre.valid, false);
  assert.equal(pre.verdict.status, "needs_fix");

  const batch = await runBatchReview({
    worker,
    handoffs: [handoff(contract("low-1", "low")), handoff(contract("low-2", "low")), handoff(contract("low-3", "low"))],
    cwd,
  });
  assert.equal(batch.verdicts.get("low-1")?.status, "pass");
  assert.equal(batch.verdicts.get("low-2")?.status, "needs_fix");
  assert.equal(batch.verdicts.get("low-3")?.issues[0]?.summary, "reviewer returned no structured verdict");
});

test("replanning on BLOCKED+evidence revises only unpassed contracts and may depend on passed ones", async () => {
  const server = await startGatewayServer({
    respond: () => ({
      content: JSON.stringify({
        contracts: [
          {
            task_id: "auth-3b",
            objective: "Add the refresh endpoint first",
            depends_on: ["auth-1"],
            scope: { allowed: ["src/auth/**"] },
            acceptance: ["endpoint exists"],
            verification: ["npm test"],
          },
        ],
      }),
    }),
  });
  servers.push(server);
  const cwd = await tmp();
  const worker = new GatewayChatWorkerExecutor({ baseUrl: server.baseUrl, defaultModel: "coding-planning" });
  const r = await runPlanner({
    worker,
    brief,
    cwd,
    replan: {
      passed: ["auth-1"],
      remaining: [contract("auth-3")],
      blocked: { task_id: "auth-3", evidence: "there is no refresh endpoint to rotate tokens on" },
    },
  });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  assert.deepEqual(r.plan.contracts[0]?.depends_on, ["auth-1"]);
  assert.match(server.requests[0]?.system ?? "", /An implementer reported that a contract is impossible/);
  assert.match(server.requests[0]?.user ?? "", /no refresh endpoint/);
});
