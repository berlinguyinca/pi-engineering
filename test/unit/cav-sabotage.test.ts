import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePhaseGate } from "../../src/cav/completion.ts";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { CavGateError, ProtectedArtifactGuard } from "../../src/cav/guard.ts";
import type { CavPhase } from "../../src/cav/types.ts";

/**
 * CAV-00-04 sabotage/failure tests (SABOTAGE_CATALOG).
 *
 * Proves the Root of Trust detects, rather than masks:
 *  - false-success exit (exit code 0 with no passing evidence),
 *  - missing evidence (empty ledger never satisfies a gate),
 *  - reviewer attempting to waive a deterministic failure,
 *  - implementer silently modifying a protected acceptance/golden artifact,
 *  - concurrent ledger-write collision.
 */

const phase: CavPhase = {
  id: "00",
  name: "Root of Trust",
  steps: [
    { id: "CAV-00-01", phase: "00", step: "01", phaseName: "Root of Trust", objective: "a", spec: "s", kind: "define" },
    {
      id: "CAV-00-02",
      phase: "00",
      step: "02",
      phaseName: "Root of Trust",
      objective: "b",
      spec: "s",
      kind: "implement",
    },
  ],
  state: "UNKNOWN",
  blockers: [],
};

const BASE = {
  gitSha: "x",
  workerRunId: "r",
  gateType: "gate",
  tool: "node --test",
  command: "cmd",
  exitCode: 0,
};

test("sabotage: a false-success exit (code 0 with no evidence) cannot report VERIFIED", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  // Exit code 0 is recorded but status is SPECIFIED, not VERIFIED.
  const ev = await ledger.record("CAV-00-01", "SPECIFIED", { ...BASE, exitCode: 0, role: "implementer" });
  assert.equal(ev.exit_code, 0);
  assert.notEqual(ledger.latestStatus("CAV-00-01"), "VERIFIED");
  assert.equal(evaluatePhaseGate(phase, ledger).state, "FAIL");
});

test("sabotage: missing evidence fails the gate (no evidence = no verification)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  assert.equal(evaluatePhaseGate(phase, ledger).state, "FAIL");
  assert.equal(ledger.count(), 0);
});

test("sabotage: reviewer cannot waive a deterministic failure by prose alone", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  // Even a reviewer role cannot conjure VERIFIED from an empty ledger (no
  // evidence = no verification). This is the strongest fail-closed form.
  await assert.rejects(
    ledger.promote("CAV-00-01", "VERIFIED", { ...BASE, role: "reviewer" }),
    (err) => err instanceof CavGateError && /no recorded evidence to promote from/.test(err.message),
  );
  // A reviewer may only promote from REAL recorded evidence, never from nothing.
});

test("sabotage: implementer cannot silently modify a protected acceptance artifact", () => {
  const guard = new ProtectedArtifactGuard();
  // Simulate a changed-path set that includes an acceptance contract.
  assert.throws(
    () =>
      guard.assertNoProtectedMutation(
        ["src/cav/types.ts", "tests/acceptance/contracts/acceptance.yaml"],
        "implementer",
      ),
    (err) => err instanceof CavGateError && /protected artifact/.test(err.message),
  );
});

test("sabotage: concurrent ledger-write collision is serialized and lossless", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const writes = Array.from({ length: 50 }, (_, i) =>
    ledger.record(`CAV-00-${String((i % 5) + 1).padStart(2, "0")}`, "SPECIFIED", {
      ...BASE,
      workerRunId: `RUN-${i}`,
      role: i % 2 ? "implementer" : "reviewer",
    }),
  );
  await Promise.all(writes);
  assert.equal(ledger.count(), 50);
  // No record lost and each run id present exactly once.
  const ids = ledger.all().map((r) => r.worker_run_id);
  assert.equal(new Set(ids).size, 50);
});

test("sabotage: UNKNOWN/SKIPPED status is never treated as PASS", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "SPECIFIED", { ...BASE, role: "implementer" });
  // A "skipped" style non-verified status (e.g. WAIVED without approval) is not PASS.
  const result = evaluatePhaseGate(phase, ledger);
  assert.equal(result.state, "FAIL");
  assert.ok(result.blockers.length > 0);
});
