import assert from "node:assert/strict";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { CavGateError, ProtectedArtifactGuard } from "../../src/cav/guard.ts";

const BASE = {
  gitSha: "abc123",
  workerRunId: "RUN-1",
  gateType: "unit",
  tool: "node --test",
  command: "node --test cav-evidence.test.ts",
  exitCode: 0,
};

test("implementer cannot promote its own requirement to VERIFIED (fails closed)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "IMPLEMENTED", { ...BASE, role: "implementer" });
  await assert.rejects(
    ledger.promote("CAV-00-01", "VERIFIED", { ...BASE, role: "implementer" }),
    (err) => err instanceof CavGateError && /cannot write VERIFIED/.test(err.message),
  );
  // The ledger must NOT show VERIFIED for the implementer's own work.
  assert.notEqual(ledger.latestStatus("CAV-00-01"), "VERIFIED");
});

test("an allowed promoter role can verify a step after implementer evidence", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-02", "TESTED", { ...BASE, role: "implementer" });
  const ev = await ledger.promote("CAV-00-02", "VERIFIED", { ...BASE, role: "reviewer" });
  assert.equal(ev.status, "VERIFIED");
  assert.equal(ledger.latestStatus("CAV-00-02"), "VERIFIED");
});

test("non-forward promotions are rejected", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-03", "VERIFIED", { ...BASE, role: "reviewer" });
  await assert.rejects(
    ledger.promote("CAV-00-03", "IMPLEMENTED", { ...BASE, role: "reviewer" }),
    (err) => err instanceof CavGateError && /not forward progress/.test(err.message),
  );
});

test("only reviewer roles can write INDEPENDENTLY_REVIEWED", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-04", "IMPLEMENTED", { ...BASE, role: "implementer" });
  await assert.rejects(
    ledger.promote("CAV-00-04", "INDEPENDENTLY_REVIEWED", { ...BASE, role: "implementer" }),
    (err) => err instanceof CavGateError && /INDEPENDENTLY_REVIEWED/.test(err.message),
  );
  const ev = await ledger.promote("CAV-00-04", "INDEPENDENTLY_REVIEWED", { ...BASE, role: "reviewer" });
  assert.equal(ev.status, "INDEPENDENTLY_REVIEWED");
});

test("protected artifact guard fails closed on silent mutation", () => {
  const guard = new ProtectedArtifactGuard();
  assert.ok(guard.isProtected("docs/specs/cav/MASTER.md"));
  assert.ok(guard.isProtected("tests/cav/golden/hero.png"));
  assert.ok(guard.isProtected("tests/cav/fixtures/sabotage.ts"));
  assert.ok(guard.isProtected("tests/acceptance/contracts/acceptance.yaml"));
  assert.ok(guard.isProtected("design/reference/palette.svg"));
  assert.ok(!guard.isProtected("src/cav/types.ts"));
  assert.ok(!guard.isProtected("test/unit/cav-evidence.test.ts"));
  assert.throws(
    () => guard.assertNoProtectedMutation(["src/cav/types.ts", "docs/specs/cav/ROADMAP.md"], "implementer"),
    (err) => err instanceof CavGateError && /protected artifact/.test(err.message),
  );
});

test("UNKNOWN status never satisfies a required gate", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  assert.equal(ledger.latestStatus("CAV-99-99"), undefined);
});
