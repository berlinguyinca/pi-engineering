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
    const gate = new HighRiskApprovalGate({ autonomous: true });
    assert.equal(gate.isPermitted("deploy"), false);
    assert.equal(gate.isPermitted("merge"), false);
    assert.equal(gate.isPermitted("secret_access"), false);
  });

  it("explicit approval clears the gate", () => {
    const gate = new HighRiskApprovalGate({ autonomous: true });
    gate.approve("deploy");
    assert.equal(gate.isPermitted("deploy"), true);
  });

  it("covers the documented high-risk action set", () => {
    for (const action of HIGH_RISK_ACTIONS) {
      const gate = new HighRiskApprovalGate();
      assert.equal(gate.isPermitted(action), false, `${action} should require approval`);
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
