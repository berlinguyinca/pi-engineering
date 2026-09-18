import assert from "node:assert/strict";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { reconcileSpec } from "../../src/cav/reconcile.ts";
import type { CavStep } from "../../src/cav/types.ts";

const mk = (id: string): CavStep => ({
  id,
  phase: id.split("-")[1] ?? "00",
  step: id.split("-")[2] ?? "01",
  phaseName: "t",
  objective: "t",
  spec: `docs/specs/cav/steps/${id}.md`,
  kind: "define",
});

const BASE = {
  gitSha: "x",
  workerRunId: "r",
  gateType: "unit",
  tool: "node",
  command: "cmd",
  exitCode: 0,
};

test("a requirement is reconciled when implementation + passing evidence + VERIFIED exist", async () => {
  const steps = [mk("CAV-00-01")];
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "TESTED", { ...BASE, role: "implementer" });
  await ledger.promote("CAV-00-01", "VERIFIED", { ...BASE, role: "reviewer" });
  const r = reconcileSpec(steps, ledger, () => true);
  assert.equal(r.complete, true);
  assert.equal(r.reconciled, 1);
  assert.equal(r.gaps.length, 0);
});

test("a requirement with no implementation is a reconciliation gap", async () => {
  const steps = [mk("CAV-00-01")];
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "TESTED", { ...BASE, role: "implementer" });
  await ledger.promote("CAV-00-01", "VERIFIED", { ...BASE, role: "reviewer" });
  const r = reconcileSpec(steps, ledger, () => false);
  assert.equal(r.complete, false);
  assert.ok(r.gaps.some((g) => g.includes("no implementation")));
});

test("a requirement with failing evidence is a reconciliation gap", async () => {
  const steps = [mk("CAV-00-01")];
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "SPECIFIED", { ...BASE, role: "implementer", exitCode: 1 });
  const r = reconcileSpec(steps, ledger, () => true);
  assert.equal(r.complete, false);
  assert.ok(r.gaps.some((g) => g.includes("not passing") || g.includes("not VERIFIED")));
});

test("a requirement with no evidence at all is a gap (no evidence = no reconciliation)", async () => {
  const steps = [mk("CAV-00-01")];
  const ledger = CavEvidenceLedger.inMemory();
  const r = reconcileSpec(steps, ledger, () => true);
  assert.equal(r.complete, false);
  assert.ok(r.gaps.some((g) => g.includes("no evidence")));
});
