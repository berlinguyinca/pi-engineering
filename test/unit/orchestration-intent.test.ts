import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IntentRouter, classifyIntent, workflowForIntent } from "../../src/orchestration/intentRouter.ts";
import type { WorkflowClass } from "../../src/orchestration/types.ts";

// Mirrors the extension's auto-invocation threshold (spec 06): engineering or
// engineering_review intent must auto-invoke the mission pipeline, while
// conversation/research/investigation alone does not.
const WORKFLOW_ORDER: WorkflowClass[] = [
  "conversation",
  "research",
  "investigation",
  "engineering",
  "review",
  "engineering_review",
  "security_sensitive",
];
const workflowRank = (w: WorkflowClass) => WORKFLOW_ORDER.indexOf(w);
const AUTO_INVOKE_THRESHOLD = workflowRank("engineering");
function shouldAutoInvoke(prompt: string): boolean {
  return workflowRank(workflowForIntent(classifyIntent(prompt).intent)) >= AUTO_INVOKE_THRESHOLD;
}
import {
  deriveRequiredGates,
  mutationFactFromChangedFiles,
  pathMatchesPattern,
} from "../../src/orchestration/policies.ts";

describe("intent router (spec 01)", () => {
  it("routes normal-language requests to workflows without slash commands", () => {
    const router = new IntentRouter();
    const cases: Array<[string, string[]]> = [
      ["Explain this function", ["explain"]],
      ["Find where auth happens", ["research"]],
      ["Why is login failing?", ["investigate"]],
      ["Fix login", ["fix"]],
      ["Implement OAuth", ["implement"]],
      ["Add a health endpoint", ["implement"]],
      ["Review my changes", ["review"]],
      ["Is this ready?", ["review", "validate"]],
    ];
    for (const [req, expected] of cases) {
      const r = router.route({ request: req });
      for (const e of expected) assert.ok(r.intent.includes(e as never), `${req} should include ${e}, got ${r.intent}`);
    }
  });

  it("suggested workflow matches the spec's required-behavior table", () => {
    const router = new IntentRouter();
    assert.equal(router.route({ request: "Explain this function" }).suggested_workflow, "conversation");
    assert.equal(router.route({ request: "Find where auth happens" }).suggested_workflow, "research");
    assert.equal(router.route({ request: "Why is login failing?" }).suggested_workflow, "investigation");
    assert.equal(router.route({ request: "Fix login" }).suggested_workflow, "engineering_review");
    assert.equal(router.route({ request: "Implement OAuth" }).suggested_workflow, "engineering_review");
    assert.equal(router.route({ request: "Review my changes" }).suggested_workflow, "review");
    assert.ok(router.route({ request: "Implement OAuth" }).risk_hints.includes("auth"));
  });

  it("Stage B deterministic policy upgrades investigation when mutation occurs", () => {
    const router = new IntentRouter();
    // Before mutation: investigation.
    const before = router.route({ request: "Find out why login fails" });
    assert.equal(before.suggested_workflow, "investigation");
    // After a source mutation fact: escalate to engineering_review.
    const after = router.route({
      request: "Find out why login fails",
      changedFiles: ["src/auth/service.ts", "src/api/login.ts"],
    });
    // Auth-sensitive source mutation escalates at least to engineering_review
    // (and may go further to security_sensitive).
    assert.ok(["engineering_review", "security_sensitive"].includes(after.suggested_workflow));
    assert.notEqual(after.suggested_workflow, "investigation");
    assert.equal(after.escalated, true);
    assert.ok(after.risk_hints.includes("auth"));
  });

  it("a mutation request escalates even with no files yet", () => {
    const router = new IntentRouter();
    const r = router.route({ request: "Why is login failing", mutationRequested: true });
    assert.equal(r.suggested_workflow, "engineering_review");
    assert.equal(r.escalated, true);
  });

  it("risk classification is deterministic", () => {
    const router = new IntentRouter();
    assert.equal(router.risk({ request: "fix a typo in README" }), "low");
    assert.equal(router.risk({ request: "Implement OAuth login with credentials" }), "critical");
    assert.equal(router.risk({ request: "Add database migration for new schema" }), "medium");
  });
});

describe("policy engine (spec 00 §6, spec 01 §Stage B)", () => {
  it("auto-invocation triggers only for engineering/review intent (spec 06)", () => {
    const invoke: string[] = [];
    const notInvoke: string[] = [];
    for (const p of [
      "Add a health endpoint",
      "Fix login",
      "Implement OAuth",
      "Review my changes",
      "Refactor the scheduler",
    ]) {
      if (shouldAutoInvoke(p)) invoke.push(p);
      else notInvoke.push(p);
    }
    for (const p of ["Explain this function", "Why is login failing?", "Hello", "Find where auth happens"]) {
      if (shouldAutoInvoke(p)) invoke.push(p);
      else notInvoke.push(p);
    }
    assert.deepEqual(notInvoke, ["Explain this function", "Why is login failing?", "Hello", "Find where auth happens"]);
    assert.ok(invoke.includes("Add a health endpoint"));
    assert.ok(invoke.includes("Fix login"));
    assert.ok(invoke.includes("Implement OAuth"));
    assert.ok(invoke.includes("Review my changes"));
  });

  it("path matching supports ** and *", () => {
    assert.ok(pathMatchesPattern("src/auth/service.ts", "**/auth/**"));
    assert.ok(pathMatchesPattern("src/web/login/Login.tsx", "src/web/login/**"));
    assert.ok(pathMatchesPattern("package.json", "package.json"));
    assert.ok(pathMatchesPattern("test/auth.test.ts", "**/*.test.ts"));
    assert.ok(!pathMatchesPattern("src/auth/service.ts", "src/other/**"));
  });

  it("source mutation requires validation + independent review", () => {
    const { gates } = deriveRequiredGates(mutationFactFromChangedFiles(["src/server/api.ts"]));
    assert.ok(gates.includes("validation"));
    assert.ok(gates.includes("independent_review"));
  });

  it("auth mutation requires security review", () => {
    const { gates } = deriveRequiredGates(mutationFactFromChangedFiles(["src/auth/service.ts"]));
    assert.ok(gates.includes("security_review"));
    assert.ok(gates.includes("validation"));
    assert.ok(gates.includes("independent_review"));
  });

  it("schema mutation requires migration validation", () => {
    const { gates } = deriveRequiredGates(mutationFactFromChangedFiles(["src/migrations/0001.sql"]));
    assert.ok(gates.includes("migration_validation"));
  });

  it("dependency mutation requires dependency validation", () => {
    const { gates } = deriveRequiredGates(mutationFactFromChangedFiles(["package.json", "package-lock.json"]));
    assert.ok(gates.includes("dependency_validation"));
  });
});

describe("workflowForIntent", () => {
  it("maps intents to classes", () => {
    assert.equal(workflowForIntent(["implement"]), "engineering_review");
    assert.equal(workflowForIntent(["fix"]), "engineering_review");
    assert.equal(workflowForIntent(["security-review"]), "security_sensitive");
    assert.equal(workflowForIntent(["explain"]), "conversation");
    assert.equal(workflowForIntent(["research"]), "research");
    assert.equal(workflowForIntent(["release"]), "engineering_review");
  });
});
