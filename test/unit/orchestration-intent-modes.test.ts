import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IntentRouter } from "../../src/orchestration/intentRouter.ts";
import {
  type AutospecFlags,
  type ExecutionMode,
  chooseBackend,
  chooseMode,
  readAutospecFlags,
} from "../../src/orchestration/missionMode.ts";

const OFF: AutospecFlags = { enabled: false, managedEnabled: false, autoClassify: false };

const FIXTURES = [
  "Explain this function",
  "Fix login",
  "Implement OAuth",
  "Add a health endpoint",
  "Review my changes",
  "Implement the whole feature end to end across the services, open a PR and merge it autonomously",
  "Use autospec to ship the migration",
  "Run this as a mission",
  "Hello",
];

describe("readAutospecFlags (R-MODE)", () => {
  it("is all off for an empty env", () => {
    assert.deepEqual(readAutospecFlags({}), OFF);
  });

  it("parses only 1 and true as on", () => {
    const table: Array<[string | undefined, boolean]> = [
      ["1", true],
      ["true", true],
      ["TRUE", true],
      [" true ", true],
      ["0", false],
      ["false", false],
      ["yes", false],
      ["on", false],
      ["", false],
      [undefined, false],
    ];
    for (const [raw, want] of table) {
      assert.equal(readAutospecFlags({ PI_AUTOSPEC_ENABLED: raw }).enabled, want, `ENABLED=${raw}`);
      assert.equal(readAutospecFlags({ PI_AUTOSPEC_MANAGED_ENABLED: raw }).managedEnabled, want);
      assert.equal(readAutospecFlags({ PI_AUTOSPEC_AUTO_CLASSIFY: raw }).autoClassify, want);
    }
  });

  it("reads each flag independently", () => {
    assert.deepEqual(readAutospecFlags({ PI_AUTOSPEC_MANAGED_ENABLED: "1" }), {
      enabled: false,
      managedEnabled: true,
      autoClassify: false,
    });
  });
});

describe("chooseMode (R-MODE)", () => {
  it("returns local for every fixture and every requested mode with all flags unset", () => {
    for (const text of FIXTURES) {
      assert.equal(chooseMode(text, OFF), "local", text);
      for (const requested of ["local", "autospec", "mission"] as ExecutionMode[]) {
        assert.equal(chooseMode(text, OFF, requested), "local", `${text} requested=${requested}`);
      }
    }
  });

  it("does not let the managed or auto-classify flags select a mode without PI_AUTOSPEC_ENABLED", () => {
    for (const flags of [
      { enabled: false, managedEnabled: true, autoClassify: false },
      { enabled: false, managedEnabled: false, autoClassify: true },
      { enabled: false, managedEnabled: true, autoClassify: true },
    ]) {
      for (const text of FIXTURES) {
        assert.equal(chooseMode(text, flags), "local", text);
        assert.equal(chooseMode(text, flags, "autospec"), "local", text);
      }
    }
  });

  it("honors an explicit request only when PI_AUTOSPEC_ENABLED is set", () => {
    const on: AutospecFlags = { enabled: true, managedEnabled: false, autoClassify: false };
    assert.equal(chooseMode("Fix login", on, "autospec"), "autospec");
    assert.equal(chooseMode("Fix login", on, "mission"), "mission");
    assert.equal(chooseMode("Fix login", on, "local"), "local");
  });

  it("never auto-selects without PI_AUTOSPEC_AUTO_CLASSIFY, even when enabled", () => {
    const on: AutospecFlags = { enabled: true, managedEnabled: true, autoClassify: false };
    for (const text of FIXTURES) assert.equal(chooseMode(text, on), "local", text);
  });

  it("auto-classifies a delivery request to autospec, and only that, when all conditions hold", () => {
    const on: AutospecFlags = { enabled: true, managedEnabled: false, autoClassify: true };
    const big = "Implement the whole feature end to end across the services, open a PR and merge it autonomously";
    assert.equal(chooseMode(big, on), "autospec");
    // Small, conversational and review requests stay local.
    for (const text of ["Explain this function", "Hello", "Review my changes", "Fix login"]) {
      assert.equal(chooseMode(text, on), "local", text);
    }
    // Auto classification never proposes the mission mode.
    for (const text of FIXTURES) assert.notEqual(chooseMode(text, on), "mission", text);
  });

  it("lets an explicit local request override auto classification", () => {
    const on: AutospecFlags = { enabled: true, managedEnabled: true, autoClassify: true };
    assert.equal(
      chooseMode("Implement end to end across the services and merge it autonomously", on, "local"),
      "local",
    );
  });
});

describe("chooseBackend (R-MODE)", () => {
  const managed: AutospecFlags = { enabled: true, managedEnabled: true, autoClassify: false };
  const unmanaged: AutospecFlags = { enabled: true, managedEnabled: false, autoClassify: false };

  it("selects the managed backend only for autospec mode with PI_AUTOSPEC_MANAGED_ENABLED", () => {
    assert.equal(chooseBackend("autospec", managed), "autospec-managed");
    assert.equal(chooseBackend("autospec", unmanaged), "pi-local");
    assert.equal(chooseBackend("autospec", OFF), "pi-local");
    assert.equal(chooseBackend("local", managed), "pi-local");
    assert.equal(chooseBackend("mission", managed), "pi-local");
  });

  it("honors an explicit pi-local backend request and refuses an ungated managed one", () => {
    assert.equal(chooseBackend("autospec", managed, "pi-local"), "pi-local");
    assert.equal(chooseBackend("autospec", unmanaged, "autospec-managed"), "pi-local");
    assert.equal(chooseBackend("autospec", managed, "autospec-managed"), "autospec-managed");
  });
});

describe("IntentRouter mode (R-MODE)", () => {
  it("reports local with no env", () => {
    const r = new IntentRouter().route({ request: "Implement OAuth" });
    assert.equal(r.mode, "local");
    assert.equal(r.suggested_workflow, "engineering_review");
  });

  it("reports local when the flags are present but off", () => {
    const r = new IntentRouter().route({ request: "Implement OAuth", env: { PI_AUTOSPEC_ENABLED: "0" } });
    assert.equal(r.mode, "local");
  });

  it("does not change the workflow output when a mode is selected", () => {
    const router = new IntentRouter();
    const plain = router.route({ request: "Implement OAuth" });
    const moded = router.route({
      request: "Implement OAuth",
      env: { PI_AUTOSPEC_ENABLED: "1" },
      requestedMode: "autospec",
    });
    assert.equal(moded.mode, "autospec");
    const { mode: _a, ...plainRest } = plain;
    const { mode: _b, ...modedRest } = moded;
    assert.deepEqual(modedRest, plainRest);
  });
});
