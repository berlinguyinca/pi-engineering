import assert from "node:assert/strict";
import { test } from "node:test";
import { DefectLedger } from "../../src/cav/defect.ts";

test("a defect opens from a failing gate and lists as open", () => {
  const ledger = new DefectLedger();
  const d = ledger.open("CAV-00-01", "gate failed", "unit gate exited 1", ["EVID-1"], "implementer");
  assert.equal(d.status, "open");
  assert.deepEqual(d.failing_evidence, ["EVID-1"]);
  assert.equal(ledger.openDefects().length, 1);
});

test("a defect closes ONLY with a passing rerun evidence id (no prose closure)", () => {
  const ledger = new DefectLedger();
  const d = ledger.open("CAV-00-01", "gate failed", "unit gate exited 1", ["EVID-1"], "implementer");
  ledger.markInProgress(d.defect_id);
  assert.equal(ledger.get(d.defect_id)!.status, "in_progress");
  const closed = ledger.close(d.defect_id, "EVID-2");
  assert.equal(closed.status, "closed");
  assert.equal(closed.closing_evidence, "EVID-2");
  assert.ok(closed.closed_at);
  assert.equal(ledger.openDefects().length, 0);
});

test("closing without evidence fails closed", () => {
  const ledger = new DefectLedger();
  const d = ledger.open("CAV-00-01", "gate failed", "desc", ["EVID-1"], "implementer");
  assert.throws(() => ledger.close(d.defect_id, ""), /closing evidence required/);
  assert.equal(ledger.get(d.defect_id)!.status, "open");
});

test("defect ledger lists by status and counts", () => {
  const ledger = new DefectLedger();
  ledger.open("CAV-00-01", "a", "x", [], "implementer");
  const d2 = ledger.open("CAV-00-02", "b", "y", [], "implementer");
  ledger.close(d2.defect_id, "EVID-9");
  assert.equal(ledger.list("open").length, 1);
  assert.equal(ledger.list("closed").length, 1);
  assert.equal(ledger.count(), 2);
});
