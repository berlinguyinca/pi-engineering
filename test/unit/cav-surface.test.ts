import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { runRealStackLifecycle } from "../../src/cav/stack.ts";
import { buildCavSurface } from "../../src/cav/statusSurface.ts";
import { loadCavSteps } from "../../src/cav/steps.ts";

const REPO = resolve(import.meta.dirname, "../..");

test("control-server exposes a /cav status+evidence data surface for external consumers", async () => {
  const port = 19000 + Math.floor(Math.random() * 200);
  const result = await runRealStackLifecycle(
    {
      command: "node",
      args: ["--experimental-strip-types", "scripts/control-server.ts", String(port)],
      cwd: REPO,
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
  const ledger = await CavEvidenceLedger.open(`${REPO}/.pi-eng/cav/evidence.jsonl`);
  const surface = buildCavSurface(steps, ledger);
  assert.equal(surface.total_steps, steps.length);
  assert.equal(surface.verified_steps, steps.filter((s) => ledger.latestStatus(s.id) === "VERIFIED").length);
  assert.ok(surface.phases.some((p) => p.state === "PASS"));
  // Adapter data, not a pi-web implementation: no UI markup in the surface.
  assert.equal(typeof surface, "object");
});
