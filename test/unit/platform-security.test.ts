import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HIGH_RISK_ACTIONS, HighRiskApprovalGate, ProjectAuth, classifyRisk } from "../../src/platform/security.ts";

describe("ProjectAuth", () => {
  it("enforces project authorization", () => {
    const auth = new ProjectAuth();
    auth.register({ id: "agent-1", allowedProjectIds: ["PRJ-A"], capabilities: ["read", "write"] });
    assert.equal(auth.canAccess("agent-1", "PRJ-A"), true);
    assert.equal(auth.canAccess("agent-1", "PRJ-B"), false);
  });

  it("caps a child's capabilities to the run ceiling (intersection)", () => {
    const auth = new ProjectAuth();
    auth.register({ id: "agent-1", allowedProjectIds: ["PRJ-A"], capabilities: ["read", "write", "deploy"] });
    const capped = auth.effectiveCapabilities("agent-1", "PRJ-A", ["read", "write"]);
    assert.deepEqual(capped, ["read", "write"]);
  });

  it("returns no capabilities when unauthorized, even if ceiling is open", () => {
    const auth = new ProjectAuth();
    auth.register({ id: "agent-1", allowedProjectIds: ["PRJ-A"], capabilities: ["read"] });
    assert.deepEqual(auth.effectiveCapabilities("agent-1", "PRJ-B", null), []);
  });
});

describe("HighRiskApprovalGate", () => {
  it("requires approval for high-risk actions even under autonomous mode", () => {
    // `autonomous` was stored and never read, so this test could not fail —
    // it would have passed identically with the flag deleted. The gate now
    // ignores it explicitly, and this asserts against both settings so the
    // claim in the name is actually tested.
    for (const autonomous of [true, false]) {
      const gate = new HighRiskApprovalGate({ autonomous });
      assert.equal(gate.isPermitted("deploy", "OP-1"), false);
      assert.equal(gate.isPermitted("merge", "OP-1"), false);
      assert.equal(gate.isPermitted("secret_access", "OP-1"), false);
    }
  });

  it("an approval is single-use and bound to one operation", () => {
    // This test used to assert the opposite — that one `approve("deploy")`
    // cleared the gate for every future deploy — pinning the bug rather than
    // the requirement. Approval is only meaningful per operation: approving a
    // deploy must permit THAT deploy, not deploys.
    const gate = new HighRiskApprovalGate();
    gate.approve("deploy", "OP-1");
    assert.equal(gate.isPermitted("deploy", "OP-1"), true, "the approved operation may proceed");
    assert.equal(gate.isPermitted("deploy", "OP-2"), false, "a different operation may not");
    assert.equal(gate.consume("deploy", "OP-1"), true, "spending the approval succeeds once");
    assert.equal(gate.consume("deploy", "OP-1"), false, "and never again");
    assert.equal(gate.isPermitted("deploy", "OP-1"), false, "a spent approval does not linger");
  });

  it("a standing exemption is configured, not earned by approving once", () => {
    const gate = new HighRiskApprovalGate({ exempt: ["merge"] });
    assert.equal(gate.isPermitted("merge", "OP-1"), true);
    assert.equal(gate.isPermitted("deploy", "OP-1"), false);
  });

  it("covers the documented high-risk action set", () => {
    for (const action of HIGH_RISK_ACTIONS) {
      const gate = new HighRiskApprovalGate();
      assert.equal(gate.isPermitted(action, "OP-1"), false, `${action} should require approval`);
    }
  });
});

describe("classifyRisk", () => {
  it("flags secrets/deploy paths as high risk", () => {
    assert.equal(classifyRisk(["src/lib.ts"], false, false), "medium");
    assert.equal(classifyRisk(["src/lib.ts"], true, false), "high");
    assert.equal(classifyRisk(["deploy/compose.yml"], false, false), "high");
    assert.equal(classifyRisk(["db/migrations/001.sql"], false, false), "high");
  });
});
