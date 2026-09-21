import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { dogfoodSelf } from "../../src/cav/dogfood.ts";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";

const REPO = resolve(import.meta.dirname, "../..");

test("acceptance system runs against Pi Engineering's own control plane (dogfood)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const port = 19200 + Math.floor(Math.random() * 300);
  const result = await dogfoodSelf({ repo: REPO, port, ledger, requirementId: "CAV-18-02" });
  assert.equal(result.healthy, true, JSON.stringify(result.blockers));
  assert.equal(result.browserPassed, true, JSON.stringify(result.blockers));
  assert.equal(result.passed, true);
  assert.equal(result.evidenceRecorded, true);
  const ev = ledger.latestEvidence("CAV-18-02");
  assert.ok(ev);
  assert.equal(ev.exit_code, 0);
  assert.equal(ev.gate_type, "dogfood");
});
