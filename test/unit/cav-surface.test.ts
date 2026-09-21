import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
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
  const steps = loadCavSteps(`${REPO}/docs/specs/cav/steps`);
  // Seed a full deterministic surface (every step VERIFIED) in a temp ledger so
  // the test does not depend on the gitignored runtime evidence file.
  const dir = await mkdtemp(join(tmpdir(), "cav-surface-"));
  const evidenceFile = join(dir, "evidence.jsonl");
  const ledger = await CavEvidenceLedger.open(evidenceFile);
  try {
    for (const step of steps) {
      await ledger.record(step.id, "VERIFIED", {
        gitSha: "test",
        role: "verifier",
        workerRunId: "control-server",
        gateType: "e2e",
        tool: "node:test",
        command: "control-server /cav",
        exitCode: 0,
      });
    }
    const result = await runRealStackLifecycle(
      {
        command: "node",
        args: ["--experimental-strip-types", "scripts/control-server.ts", String(port)],
        cwd: REPO,
        env: { PI_CAV_EVIDENCE_FILE: evidenceFile },
        healthUrl: `http://127.0.0.1:${port}/health`,
        startupTimeoutMs: 15000,
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
        assert.equal(surface.total_steps, steps.length);
        assert.equal(surface.verified_steps, steps.length);
        assert.equal(surface.phases.length, groupPhases(steps).length);
        assert.ok(surface.phases.every((p) => p.state === "PASS"));
        assert.ok(Array.isArray(surface.evidence));
      },
    );
    assert.equal(result.healthy, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCavSurface produces a machine-readable surface from steps + ledger", async () => {
  const steps = loadCavSteps(`${REPO}/docs/specs/cav/steps`);
  // Deterministic: seed one full phase VERIFIED in a memory-only ledger instead
  // of depending on the gitignored runtime evidence file (.pi-eng/), which is
  // absent on a fresh checkout and would make this test non-reproducible.
  const ledger = CavEvidenceLedger.inMemory();
  const phases = groupPhases(steps);
  assert.ok(phases.length >= 20);
  const first = phases[0]!;
  for (const step of first.steps) {
    await ledger.record(step.id, "VERIFIED", {
      gitSha: "test",
      role: "verifier",
      workerRunId: "unit",
      gateType: "unit",
      tool: "node:test",
      command: "unit",
      exitCode: 0,
    });
  }
  const surface = buildCavSurface(steps, ledger);
  assert.equal(surface.total_steps, steps.length);
  assert.equal(surface.verified_steps, steps.filter((s) => ledger.latestStatus(s.id) === "VERIFIED").length);
  assert.equal(surface.verified_steps, first.steps.length);
  assert.ok(surface.phases.some((p) => p.state === "PASS"));
  // Adapter data, not a pi-web implementation: no UI markup in the surface.
  assert.equal(typeof surface, "object");
});
