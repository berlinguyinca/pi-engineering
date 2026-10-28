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
import type { AutoSpecConfigResult } from "../../src/integrations/autospec/config.ts";
import { collectAutoSpecGateEvidence } from "../../src/integrations/autospec/provider.ts";
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
    extraGateEvidence?: ConstructorParameters<typeof LifecycleController>[0]["extraGateEvidence"];
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
    ...(opts.extraGateEvidence ? { extraGateEvidence: opts.extraGateEvidence } : {}),
  });
  return { controller, roles, store, dir };
}

const cfg = (requireForUi: boolean): AutoSpecConfigResult => ({
  kind: "on",
  config: {
    dag: { enabled: false },
    designGate: {
      reportPath: ".autospec/reports/design-gates.json",
      rulesFile: null,
      attestationKeyFile: null,
      uiPaths: ["src/ui/**"],
      requireForUi,
    },
    qualityLaw: null,
    notes: [],
  },
});
const evidence = (c: AutoSpecConfigResult) => (ctx: Parameters<typeof collectAutoSpecGateEvidence>[1]) =>
  collectAutoSpecGateEvidence(c, ctx);

async function uiChange(root: string, controller: LifecycleController) {
  await controller.noteRequest("Implement a new exported helper and add a test");
  await write(join(root, "src", "ui", "button.js"), "export const label = 'ok';\n");
  await write(
    join(root, "src", "ui", "button.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert";\nimport { label } from "./button.js";\ntest("label", () => assert.equal(label, "ok"));\n`,
  );
  return controller.settle("turn_settled");
}

test("standalone: no evidence provider -> a UI change completes exactly as before", async () => {
  const root = await makeRepo();
  const { controller, dir } = await buildController(root);
  try {
    const result = await uiChange(root, controller);
    assert.equal(result.action, "complete", result.detail ?? result.message);
    assert.doesNotMatch(result.message ?? "", /Design gate/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("required design gate: a UI change with no report cannot complete (not run is not a pass)", async () => {
  const root = await makeRepo();
  const { controller, store, dir } = await buildController(root, { extraGateEvidence: evidence(cfg(true)) });
  try {
    const result = await uiChange(root, controller);
    assert.notEqual(result.action, "complete");
    const run = [...store.list()][0];
    const item = run?.gate?.items.find((i) => i.key === "design_gate");
    assert.equal(item?.status, "skipped");
    assert.equal(item?.required, true);
    assert.ok(run?.gate?.blockers.some((b) => b.startsWith("design_gate")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("required design gate is not applicable when no UI file changed", async () => {
  const root = await makeRepo();
  const { controller, store, dir } = await buildController(root, { extraGateEvidence: evidence(cfg(true)) });
  try {
    await controller.noteRequest("Implement a new exported helper and add a test");
    await write(join(root, "src", "add.js"), "export function add(a, b) { return a + b; }\nexport const k = 1;\n");
    await write(join(root, "src", "add.test.js"), `import { test } from "node:test";\ntest("k", () => {});\n`);
    const result = await controller.settle("turn_settled");
    assert.equal(result.action, "complete", result.detail ?? result.message);
    const run = [...store.list()][0];
    assert.equal(run?.gate?.items.find((i) => i.key === "design_gate")?.status, "not_applicable");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("optional design gate never blocks, but the finalization output says it was not run", async () => {
  const root = await makeRepo();
  const { controller, dir } = await buildController(root, { extraGateEvidence: evidence(cfg(false)) });
  try {
    const result = await uiChange(root, controller);
    assert.equal(result.action, "complete", result.detail ?? result.message);
    assert.match(result.message ?? "", /Design gate: not run/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("an evidence provider that throws fails closed", async () => {
  const root = await makeRepo();
  const { controller, dir } = await buildController(root, {
    extraGateEvidence: async () => {
      throw new Error("boom");
    },
  });
  try {
    const result = await uiChange(root, controller);
    assert.notEqual(result.action, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
