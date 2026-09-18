import assert from "node:assert/strict";
import { test } from "node:test";
import { guardNoFalseComplete } from "../../src/cav/completion.ts";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import type { CavPhase, CavStep } from "../../src/cav/types.ts";

const mk = (id: string): CavStep => ({
  id,
  phase: id.split("-")[1] ?? "00",
  step: id.split("-")[2] ?? "01",
  phaseName: "t",
  objective: "t",
  spec: `docs/specs/cav/steps/${id}.md`,
  kind: "define",
});
const phase: CavPhase = { id: "22", name: "t", steps: [mk("CAV-22-02"), mk("CAV-22-03")], state: "FAIL", blockers: [] };
const BASE = {
  gitSha: "x",
  workerRunId: "r",
  gateType: "unit",
  tool: "node",
  command: "cmd",
  exitCode: 0,
};

test("COMPLETE is refused when a step is not VERIFIED (UNKNOWN)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-22-02", "TESTED", { ...BASE, role: "implementer" });
  const check = guardNoFalseComplete(phase, ledger);
  assert.equal(check.safe, false);
  assert.ok(check.blockers.some((b) => b.includes("not VERIFIED")));
});

test("COMPLETE is refused when VERIFIED has no passing evidence", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-22-02", "VERIFIED", { ...BASE, role: "reviewer", exitCode: 1 });
  await ledger.record("CAV-22-03", "VERIFIED", { ...BASE, role: "reviewer", exitCode: 1 });
  const check = guardNoFalseComplete(phase, ledger);
  assert.equal(check.safe, false);
  assert.ok(check.blockers.some((b) => b.includes("no passing evidence")));
});

test("COMPLETE is allowed only when every step is VERIFIED with passing evidence", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  for (const id of ["CAV-22-02", "CAV-22-03"]) {
    await ledger.record(id, "TESTED", { ...BASE, role: "implementer" });
    await ledger.record(id, "VERIFIED", { ...BASE, role: "reviewer" });
  }
  const check = guardNoFalseComplete(phase, ledger);
  assert.equal(check.safe, true, JSON.stringify(check.blockers));
  assert.deepEqual(check.blockers, []);
});

test("an authorized waiver permits COMPLETE only for the waived step", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-22-02", "VERIFIED", { ...BASE, role: "reviewer" });
  const check = guardNoFalseComplete(phase, ledger, { waive: (id) => id === "CAV-22-03" });
  assert.equal(check.safe, true);
});
