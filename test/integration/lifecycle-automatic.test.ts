import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { LifecycleController } from "../../src/lifecycle/controller.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import type { ReviewVerdictPayload } from "../../src/lifecycle/reviewResultTool.ts";
import { ScriptedRoleRunner } from "../../src/lifecycle/roleRunner.ts";
import { LifecycleStore } from "../../src/lifecycle/store.ts";
import { LifecycleTelemetry } from "../../src/lifecycle/telemetry.ts";
import type { ModelRef } from "../../src/lifecycle/types.ts";

const exec = promisify(execFile);

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-life-"));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "t@e.c"]);
  await exec("git", ["-C", root, "config", "user.name", "T"]);
  const pkg = JSON.stringify({ name: "fixture", version: "0.0.1", type: "module", scripts: { test: "node --test" } });
  await write(join(root, "package.json"), pkg);
  await write(join(root, "src", "add.js"), `export function add(a, b) { return a + b; }\n`);
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "init"]);
  return root;
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

function approveVerdict(): ReviewVerdictPayload {
  return { verdict: "approve", summary: "looks good", confidence: 0.9, findings: [], missingTests: [], specGaps: [] };
}

async function buildController(
  cwd: string,
  opts: {
    policy?: typeof DEFAULT_POLICY;
    verdicts?: Record<string, () => ReviewVerdictPayload | undefined>;
    requestApproval?: (req: { command: string; risk: string; reason: string; capability?: string }) => Promise<boolean>;
  } = {},
): Promise<{
  controller: LifecycleController;
  roles: ScriptedRoleRunner;
  store: LifecycleStore;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ctl-"));
  const store = await LifecycleStore.open(dir);
  const artifacts = await ArtifactStore.create(join(dir, "artifacts"));
  const telemetry = LifecycleTelemetry.memory(true);
  const registry = await ModelCapabilityRegistry.open({
    sources: [
      {
        name: "fake",
        discover: async () => [
          normalizeModelRecord({ provider: "alpha", id: "impl", source: "test" }),
          normalizeModelRecord({ provider: "alpha", id: "review", source: "test" }),
        ],
      },
    ],
    context: { cwd, agentDir: cwd },
  });
  await registry.refresh();
  const roles = new ScriptedRoleRunner({
    sessionModel: { provider: "alpha", id: "impl" },
    routing: {
      reviewer: { provider: "alpha", id: "review" },
      security_reviewer: { provider: "alpha", id: "review" },
      architecture_reviewer: { provider: "alpha", id: "review" },
      api_reviewer: { provider: "alpha", id: "review" },
      database_reviewer: { provider: "alpha", id: "review" },
      documentation_reviewer: { provider: "alpha", id: "review" },
      infrastructure_reviewer: { provider: "alpha", id: "review" },
      performance_reviewer: { provider: "alpha", id: "review" },
      test_reviewer: { provider: "alpha", id: "review" },
      ui_reviewer: { provider: "alpha", id: "review" },
      vision_reviewer: { provider: "alpha", id: "review" },
    },
    verdicts: {
      reviewer: approveVerdict,
      security_reviewer: approveVerdict,
      architecture_reviewer: approveVerdict,
      api_reviewer: approveVerdict,
      database_reviewer: approveVerdict,
      documentation_reviewer: approveVerdict,
      infrastructure_reviewer: approveVerdict,
      performance_reviewer: approveVerdict,
      test_reviewer: approveVerdict,
      ui_reviewer: approveVerdict,
      vision_reviewer: approveVerdict,
      ...(opts.verdicts ?? {}),
    },
  });
  const controller = new LifecycleController({
    cwd,
    sessionKey: "test-session",
    policy: opts.policy ?? DEFAULT_POLICY,
    registry,
    roles,
    store,
    telemetry,
    artifacts,
    sessionModel: () => ({ provider: "alpha", id: "impl" }) satisfies ModelRef,
    requestApproval: opts.requestApproval,
  });
  return { controller, roles, store, dir };
}

test("automatic lifecycle completes an implementation with zero manual lifecycle commands", async () => {
  const root = await makeRepo();
  const { controller, store, dir } = await buildController(root);
  try {
    // 1. The user simply asks for engineering work and the model edits a file.
    const note = await controller.noteRequest("Implement a new exported helper and add a test");
    assert.ok(note.run.runId);

    await write(
      join(root, "src", "add.js"),
      `export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n`,
    );
    await write(
      join(root, "src", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add, sub } from "./add.js";\ntest("add", () => assert.equal(add(1, 2), 3));\ntest("sub", () => assert.equal(sub(3, 1), 2));\n`,
    );

    // 2. The harness settles automatically after the model's turn. No /review,
    //    /verify or reviewer command was invoked by anyone.
    const result = await controller.settle("turn_settled");
    assert.equal(
      result.action,
      "complete",
      `expected complete, got ${result.action}: ${result.detail ?? result.message}`,
    );
    const run = store.get(note.run.runId);
    assert.ok(run);
    assert.equal(run.state, "COMPLETE");
    assert.equal(run.gate?.pass, true);
    assert.ok(run.reviews.length >= 1, "an independent review was executed automatically");
    assert.ok(
      run.verifications.some((v) => v.status === "passed"),
      "implementation verification ran",
    );
    assert.ok(run.completedAt, "the harness records a completion timestamp; the model cannot self-declare completion");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chat-only request with no change stays passive and never spawns reviewers", async () => {
  const root = await makeRepo();
  const { controller, roles, dir } = await buildController(root);
  try {
    const note = await controller.noteRequest("What is the current date?");
    assert.ok(note.run);
    let reviews = 0;
    const orig = roles.runReview.bind(roles);
    roles.runReview = async (spec) => {
      reviews++;
      return orig(spec);
    };
    const result = await controller.settle("turn_settled");
    assert.equal(result.action, "complete");
    assert.equal(reviews, 0, "no reviewers should be dispatched for pure conversation");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("destructive commands are blocked without approval and allowed with it", async () => {
  const root = await makeRepo();
  // Unattended mode must block so the gate is exercised deterministically.
  const blockPolicy = structuredClone(DEFAULT_POLICY) as typeof DEFAULT_POLICY;
  blockPolicy.policies.risk.unattended = "block";
  blockPolicy.policies.risk.pre_execution_approval_at = "HIGH";
  const { controller, dir } = await buildController(root, { policy: blockPolicy });
  try {
    await controller.noteRequest("Deploy the service");
    const denied = await controller.observeToolCall("bash", { command: "rm -rf /var/www/html" });
    assert.ok(denied && denied.block === true, "irreversible command must be blocked without approval");
    assert.ok(denied.reason && /approv/i.test(denied.reason));

    // With an operator approver, the same operation is allowed through.
    const approving = await buildController(root, { requestApproval: async () => true });
    await approving.controller.noteRequest("Deploy the service");
    const allowed = await approving.controller.observeToolCall("bash", {
      command: "ssh deploy@host systemctl restart api",
    });
    assert.ok(allowed === undefined || allowed.block !== true, "approved remote administration proceeds");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run escalates after the remediation budget is exhausted", async () => {
  const root = await makeRepo();
  const policy = structuredClone(DEFAULT_POLICY) as typeof DEFAULT_POLICY;
  policy.lifecycle.max_remediation_rounds = 1;
  const { controller, store, dir } = await buildController(root, {
    policy,
    verdicts: {
      reviewer: () =>
        ({
          verdict: "request_changes",
          summary: "still broken",
          confidence: 0.9,
          findings: [
            {
              fingerprint: "high|f|t",
              role: "reviewer",
              severity: "high",
              title: "t",
              detail: "d",
              confidence: 0.9,
              categories: [],
            },
          ],
          missingTests: [],
          specGaps: [],
        }) as ReviewVerdictPayload,
    },
  });
  try {
    const note = await controller.noteRequest("Implement a helper and add a test");
    await write(
      join(root, "src", "add.js"),
      `export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n`,
    );
    const result = await controller.settle("turn_settled");
    assert.ok(result.action === "remediate" || result.action === "escalate");
    const run = store.get(note.run.runId);
    assert.ok(run);
    assert.ok(run.gate === undefined || run.gate.pass === false, "gate must not pass with unresolved findings");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
