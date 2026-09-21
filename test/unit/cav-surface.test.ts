import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { runRealStackLifecycle } from "../../src/cav/stack.ts";
import { buildCavSurface } from "../../src/cav/statusSurface.ts";
import { groupPhases, loadCavSteps } from "../../src/cav/steps.ts";

const REPO = resolve(import.meta.dirname, "../..");

const BASE_EVIDENCE = {
  gitSha: "test-sha",
  workerRunId: "RUN-test",
  gateType: "unit",
  tool: "node",
  command: "cav-surface.test.ts",
  exitCode: 0,
};

/**
 * Seed a fresh evidence ledger with VERIFIED evidence for the given steps so a
 * surface built from it is non-trivial. Deterministic: the ledger is created
 * (or cleared) from scratch, so the test does not depend on pre-populated
 * `.pi-eng` durable state that a fresh checkout / CI does not have.
 */
async function seedVerified(steps: ReturnType<typeof loadCavSteps>, file?: string): Promise<CavEvidenceLedger> {
  const ledger = file ? await CavEvidenceLedger.open(file) : CavEvidenceLedger.inMemory();
  ledger.clear();
  for (const step of steps) {
    // record() accepts VERIFIED directly; role-gating only applies to promote().
    await ledger.record(step.id, "VERIFIED", { ...BASE_EVIDENCE, role: "reviewer" });
  }
  return ledger;
}

test("control-server exposes a /cav status+evidence data surface for external consumers", async () => {
  const port = 19000 + Math.floor(Math.random() * 200);
  const evidenceFile = join(tmpdir(), `cav-surface-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const steps = loadCavSteps(`${REPO}/docs/specs/cav/steps`);
  await seedVerified(steps, evidenceFile);
  const result = await runRealStackLifecycle(
    {
      command: "node",
      args: ["--experimental-strip-types", "scripts/control-server.ts", String(port)],
      cwd: REPO,
      healthUrl: `http://127.0.0.1:${port}/health`,
      startupTimeoutMs: 15000,
      env: { PI_CAV_EVIDENCE_FILE: evidenceFile },
    },
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/cav`);
      assert.equal(res.status, 200);
      const surface = (await res.json()) as {
        total_steps: number;
        verified_steps: number;
        phases: Array<{ id: string; state: string }>;
        evidence: unknown[];
      };
      assert.ok(surface.total_steps >= 120, `total_steps=${surface.total_steps}`);
      assert.ok(surface.verified_steps >= 85, `verified=${surface.verified_steps}`);
      assert.ok(surface.phases.length >= 20);
      assert.ok(Array.isArray(surface.evidence));
    },
  );
  assert.equal(result.healthy, true);
});

test("buildCavSurface produces a machine-readable surface from steps + ledger", async () => {
  const steps = loadCavSteps(`${REPO}/docs/specs/cav/steps`);
  const phases = groupPhases(steps);
  const firstPhase = phases[0]!;
  const ledger = CavEvidenceLedger.inMemory();
  for (const step of firstPhase.steps) {
    await ledger.record(step.id, "VERIFIED", { ...BASE_EVIDENCE, role: "reviewer" });
  }
  const surface = buildCavSurface(steps, ledger);
  assert.equal(surface.total_steps, steps.length);
  assert.equal(surface.verified_steps, steps.filter((s) => ledger.latestStatus(s.id) === "VERIFIED").length);
  assert.ok(surface.verified_steps >= firstPhase.steps.length);
  assert.ok(surface.phases.some((p) => p.state === "PASS"));
  // Adapter data, not a pi-web implementation: no UI markup in the surface.
  assert.equal(typeof surface, "object");
});
