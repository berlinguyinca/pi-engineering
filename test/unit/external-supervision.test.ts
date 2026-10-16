import assert from "node:assert/strict";
import { test } from "node:test";
import { supervisorAdmitsMission } from "../../src/orchestration/externalSupervision.ts";

test("supervisorAdmitsMission refuses an external mission still in NEW", () => {
  assert.equal(supervisorAdmitsMission({ mission_id: "MSN-ext-abc", status: "NEW" }), false);
});

test("supervisorAdmitsMission admits external missions that have moved past NEW", () => {
  assert.equal(supervisorAdmitsMission({ mission_id: "MSN-ext-abc", status: "CLASSIFYING" }), true);
  assert.equal(supervisorAdmitsMission({ mission_id: "MSN-ext-abc", status: "RUNNING" }), true);
  assert.equal(supervisorAdmitsMission({ mission_id: "MSN-ext-abc", status: "BLOCKED" }), true);
  assert.equal(supervisorAdmitsMission({ mission_id: "MSN-ext-abc", status: "COMPLETE" }), true);
});

test("supervisorAdmitsMission admits non-external missions in NEW", () => {
  assert.equal(supervisorAdmitsMission({ mission_id: "MSN-abc123", status: "NEW" }), true);
});
