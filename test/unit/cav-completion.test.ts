import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePhaseGate, firstNonVerifiedStep } from "../../src/cav/completion.ts";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import type { CavPhase } from "../../src/cav/types.ts";

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

test("phase gate FAILs unless every step is VERIFIED", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const result = evaluatePhaseGate(phase, ledger);
  assert.equal(result.state, "FAIL");
  assert.equal(result.verifiedSteps, 0);
  assert.ok(result.blockers.some((b) => b.startsWith("CAV-00-01")));
});

test("phase gate PASSes only when all steps are VERIFIED", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  for (const s of phase.steps) {
    await ledger.record(s.id, "TESTED", { ...BASE, role: "implementer" });
    await ledger.promote(s.id, "VERIFIED", { ...BASE, role: "reviewer" });
  }
  const result = evaluatePhaseGate(phase, ledger);
  assert.equal(result.state, "PASS");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.verifiedSteps, 2);
});

test("UNKNOWN and non-VERIFIED statuses block the gate (UNKNOWN is not PASS)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "IMPLEMENTED", { ...BASE, role: "implementer" });
  await ledger.record("CAV-00-02", "SPECIFIED", { ...BASE, role: "implementer" });
  const result = evaluatePhaseGate(phase, ledger);
  assert.equal(result.state, "FAIL");
  assert.ok(result.blockers.some((b) => b.includes("IMPLEMENTED (not VERIFIED)")));
  assert.ok(result.blockers.some((b) => b.includes("SPECIFIED (not VERIFIED)")));
});

test("WAIVED steps count as satisfied only via explicit waiver", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const result = evaluatePhaseGate(phase, ledger, { waive: (id) => id === "CAV-00-02" });
  assert.equal(result.state, "FAIL");
  assert.deepEqual(result.waivers, ["CAV-00-02"]);
  assert.ok(result.blockers.some((b) => b.startsWith("CAV-00-01")));
});

test("firstNonVerifiedStep returns first in numeric order", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-02", "VERIFIED", { ...BASE, role: "reviewer" });
  const first = firstNonVerifiedStep(phase.steps, (id) => ledger.latestStatus(id) === "VERIFIED");
  assert.equal(first!.id, "CAV-00-01");
});
