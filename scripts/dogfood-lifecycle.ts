import { execFile } from "node:child_process";
/**
 * Dogfood the automatic engineering lifecycle end-to-end without a live model.
 *
 * Uses a scripted role runner so the full implement -> verify -> independent
 * review -> gate -> complete pipeline is exercised deterministically in CI. The
 * controller is driven headlessly: no `/review`, `/verify`, `/engineering` or
 * reviewer command is invoked by anyone — the harness owns completion.
 *
 *   node scripts/dogfood-lifecycle.ts            # deterministic fake models
 *   node scripts/dogfood-lifecycle.ts --real     # real models (metabolomics)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ArtifactStore } from "../src/artifacts/ArtifactStore.ts";
import { normalizeModelRecord } from "../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../src/capability/registry.ts";
import { LifecycleController } from "../src/lifecycle/controller.ts";
import { DEFAULT_POLICY } from "../src/lifecycle/policy.ts";
import { PiRoleRunner } from "../src/lifecycle/roleRunner.ts";
import type { ReviewOutcome, RoleRunner, RoleSpec } from "../src/lifecycle/roleRunner.ts";
import { LifecycleStore } from "../src/lifecycle/store.ts";
import { LifecycleTelemetry } from "../src/lifecycle/telemetry.ts";
import { summarizeMetrics } from "../src/lifecycle/telemetry.ts";
import type { ModelRef, ReviewReport, RoutingDecision } from "../src/lifecycle/types.ts";
import type { WorkerRun } from "../src/workers/WorkerExecutor.ts";

const exec = promisify(execFile);
const real = process.argv.includes("--real");

async function write(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

function fakeDecision(role: string): RoutingDecision {
  return {
    role: role as never,
    selected: { provider: "alpha", id: "fake" },
    candidates: [{ provider: "alpha", id: "fake" }],
    rejected: [],
    rationale: ["scripted deterministic dogfood model"],
    overrideApplied: false,
    fallbackOf: undefined,
    requester: { provider: "alpha", id: "session" },
    decidedAt: new Date().toISOString(),
  };
}

/** A deterministic role runner that always approves and reports no findings. */
class ScriptedRunner implements RoleRunner {
  sessionModel(): ModelRef | undefined {
    return { provider: "alpha", id: "session" };
  }
  async runReview(spec: RoleSpec): Promise<ReviewOutcome> {
    const report: ReviewReport = {
      role: spec.role,
      model: { provider: "alpha", id: "review" },
      round: spec.round,
      durationMs: 1,
      verdict: "approve",
      summary: "scripted approval",
      confidence: 1,
      findings: [],
      missingTests: [],
      specGaps: [],
    };
    return { role: spec.role, decision: fakeDecision(spec.role), report };
  }
  async runWorker(spec: RoleSpec): Promise<{ role: string; decision: RoutingDecision; run: WorkerRun }> {
    return {
      role: spec.role,
      decision: fakeDecision(spec.role),
      run: {
        result: {
          status: "completed",
          summary: "scripted",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: null,
      } as WorkerRun,
    };
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-dogfood-"));
  const persist = await mkdtemp(join(tmpdir(), "pi-eng-dogfood-state-"));
  console.log("repo :", root);

  // Seed a fixture git repo with a passing test script.
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "t@e.c"]);
  await exec("git", ["-C", root, "config", "user.name", "T"]);
  await write(
    join(root, "package.json"),
    JSON.stringify({ name: "dogfood", version: "0.0.1", type: "module", scripts: { test: "node --test" } }),
  );
  await write(join(root, "src", "math.js"), `export function add(a, b) { return a + b; }\n`);
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "init"]);

  const store = await LifecycleStore.open(persist);
  const artifacts = await ArtifactStore.create(join(persist, "artifacts"));
  const telemetry = LifecycleTelemetry.memory(true);

  let registry: ModelCapabilityRegistry;
  let roles: RoleRunner;
  if (real) {
    // Real-model mode uses live discovery; this path requires a configured
    // provider (e.g. `metabolomics`) and a real worker executor.
    const { PiModelRuntimeSource, AgentModelsFileSource } = await import("../src/capability/discovery.ts");
    const { PiWorkerExecutor } = await import("../src/workers/PiWorkerExecutor.ts");
    const { RoleRouter } = await import("../src/capability/router.ts");
    const executor = new PiWorkerExecutor({});
    const modelRuntime = await executor.runtime();
    registry = await ModelCapabilityRegistry.open({
      sources: [new PiModelRuntimeSource(modelRuntime), new AgentModelsFileSource()],
      context: { cwd: root, agentDir: root },
    });
    await registry.refresh();
    const router = new RoleRouter({ registry, policy: DEFAULT_POLICY });
    roles = new PiRoleRunner({ registry, router, executor, artifacts, cwd: root });
  } else {
    registry = await ModelCapabilityRegistry.open({
      sources: [
        {
          name: "fake",
          discover: async () => [
            normalizeModelRecord({ provider: "alpha", id: "impl", source: "test" }),
            normalizeModelRecord({ provider: "alpha", id: "review", source: "test" }),
            normalizeModelRecord({ provider: "alpha", id: "session", source: "test" }),
          ],
        },
      ],
      context: { cwd: root, agentDir: root },
    });
    await registry.refresh();
    roles = new ScriptedRunner();
  }

  const controller = new LifecycleController({
    cwd: root,
    sessionKey: "dogfood",
    policy: DEFAULT_POLICY,
    registry,
    roles,
    store,
    telemetry,
    artifacts,
    sessionModel: () => ({ provider: "alpha", id: "session" }),
  });

  // 1. The user asks for engineering work; the model edits the repo.
  const note = await controller.noteRequest("Add a clamp(value, min, max) helper to src/math.js and export it");
  await write(
    join(root, "src", "math.js"),
    `export function add(a, b) { return a + b; }\nexport function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }\n`,
  );

  // 2. The harness settles automatically. No lifecycle command was invoked.
  const result = await controller.settle("turn_settled");
  const run = store.get(note.run.runId);

  console.log("\n================ LIFECYCLE DOGFOOD ================");
  console.log("action  :", result.action);
  console.log("run     :", run?.runId);
  console.log("state   :", run?.state);
  console.log(
    "gate    :",
    run?.gate?.pass ?? "n/a",
    run?.gate ? `(${run.gate.items.map((i) => `${i.key}=${i.status}`).join(", ")})` : "",
  );
  console.log("reviews :", run?.reviews.length ?? 0);
  console.log("verify  :", run?.verifications.map((v) => `${v.stage}:${v.status}`).join(", ") ?? "none");
  console.log("completed:", run?.completedAt ? "yes" : "no");

  const metrics = summarizeMetrics(telemetry.recent(1000));
  console.log("\ntelemetry:", JSON.stringify(metrics));

  const ok = result.action === "complete" && run?.state === "COMPLETE" && run.gate?.pass === true;
  console.log("\nDOGFOOD", ok ? "PASS" : "FAIL");

  await rm(root, { recursive: true, force: true });
  await rm(persist, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

await main();
