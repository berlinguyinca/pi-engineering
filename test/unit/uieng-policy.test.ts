import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  METRIC_GROUPS,
  METRIC_GROUP_IDS,
  UI_IMPACT_LEVELS,
  type UiImpactLevel,
  autoAttach,
  classifyChange,
  derivedEvaluation,
  gateFailed,
  rankLevel,
} from "../../src/uieng/policy.ts";
import { METRIC_IDS } from "../../src/uieng/rubric.ts";
import type { Finding, UiProfile } from "../../src/uieng/schemas.ts";

function finding(overrides: Partial<Finding>): Finding {
  return {
    schema_version: 1,
    kind: "finding",
    id: "FIND-1",
    score: 0.4,
    confidence: 0.9,
    severity: "high",
    evidence: [],
    ...overrides,
  };
}

const profile: UiProfile = {
  schema_version: 1,
  kind: "ui_profile",
  id: "UP-ABC123",
  discoveredAt: "2026-01-01T00:00:00.000Z",
  ui_present: true,
  framework: "react",
  frameworks_detected: ["react"],
  routes: ["src/app/page.tsx"],
  components: ["src/components/Button.tsx"],
  component_count: 1,
  startup: {},
  token_files: [],
  browser_tests: [],
  responsive_targets: [],
  design_docs: [],
};

describe("classifyChange", () => {
  it("empty diff is L0_none", () => {
    assert.equal(classifyChange([], profile), "L0_none");
  });

  it("a standalone component tweak is L1_micro", () => {
    assert.equal(classifyChange(["src/components/Button.tsx"], profile), "L1_micro");
  });

  it("a page/workflow change is L2_feature_workflow", () => {
    assert.equal(classifyChange(["src/app/settings/page.tsx"], profile), "L2_feature_workflow");
    assert.equal(classifyChange(["src/features/checkout/checkout.tsx"], profile), "L2_feature_workflow");
  });

  it("a design-system/token/css change is L3_system_design_system", () => {
    assert.equal(classifyChange(["src/design-system/tokens.json"], profile), "L3_system_design_system");
    assert.equal(classifyChange(["src/styles/theme.css"], profile), "L3_system_design_system");
    assert.equal(classifyChange(["tailwind.config.ts"], profile), "L3_system_design_system");
  });

  it("backend/API change is UI-impacting when a UI profile exists", () => {
    assert.equal(classifyChange(["src/api/users.ts"], profile), "L2_feature_workflow");
    assert.equal(classifyChange(["server/controllers/order.ts"], profile), "L2_feature_workflow");
    assert.equal(classifyChange(["src/auth/redirect.ts"], profile), "L2_feature_workflow");
  });

  it("backend change with no UI surface is L0_none", () => {
    const noUi: UiProfile = { ...profile, ui_present: false };
    assert.equal(classifyChange(["src/api/users.ts"], noUi), "L0_none");
  });

  it("highest level wins for mixed diffs", () => {
    assert.equal(
      classifyChange(["src/components/Button.tsx", "src/design-system/tokens.json"], profile),
      "L3_system_design_system",
    );
  });

  it("levels have consistent ordering", () => {
    assert.equal(UI_IMPACT_LEVELS.length, 4);
    assert.equal(rankLevel("L0_none"), 0);
    assert.equal(rankLevel("L3_system_design_system"), 3);
  });
});

describe("metric groups", () => {
  it("every group references known rubric metric ids", () => {
    const known = new Set(METRIC_IDS);
    for (const g of METRIC_GROUP_IDS) {
      for (const m of METRIC_GROUPS[g]) assert.ok(known.has(m), `unknown metric ${m} in group ${g}`);
    }
  });

  it("every rubric metric is covered by at least one group", () => {
    const covered = new Set(Object.values(METRIC_GROUPS).flat());
    for (const m of METRIC_IDS) {
      assert.ok(covered.has(m), `metric ${m} not covered by any group`);
    }
  });
});

describe("derivedEvaluation", () => {
  it("L0_none yields no gate", () => {
    const plan = derivedEvaluation({ level: "L0_none" });
    assert.equal(plan.required, false);
    assert.deepEqual(plan.metric_groups, []);
    assert.deepEqual(plan.viewports, []);
  });

  it("L1_micro is a visual/responsive smoke on mobile+desktop", () => {
    const plan = derivedEvaluation({ level: "L1_micro" });
    assert.equal(plan.required, true);
    assert.deepEqual(plan.browser_tests, ["smoke"]);
    assert.deepEqual(plan.viewports, ["mobile", "desktop"]);
    assert.ok(plan.metric_groups.includes("visual"));
    assert.ok(plan.metric_groups.includes("responsive"));
    assert.ok(plan.metric_ids.length > 0);
  });

  it("L2_feature_workflow adds workflow + accessibility", () => {
    const plan = derivedEvaluation({ level: "L2_feature_workflow" });
    assert.ok(plan.metric_groups.includes("interaction_workflow"));
    assert.ok(plan.metric_groups.includes("accessibility"));
    assert.ok(plan.browser_tests.includes("workflow"));
    assert.deepEqual(plan.viewports, ["mobile", "tablet", "desktop"]);
  });

  it("L3_system_design_system is the full pass across all viewports", () => {
    const plan = derivedEvaluation({ level: "L3_system_design_system" });
    assert.deepEqual(plan.metric_groups, [...METRIC_GROUP_IDS]);
    assert.deepEqual(plan.viewports, ["mobile", "tablet", "desktop", "ultrawide"]);
    assert.ok(plan.browser_tests.includes("visual_regression"));
    assert.ok(plan.browser_tests.includes("performance"));
    assert.equal(plan.metric_ids.length, new Set(plan.metric_ids).size);
  });
});

describe("gateFailed", () => {
  it("L0 never fails", () => {
    const r = gateFailed("L0_none", [finding({ severity: "critical" })]);
    assert.equal(r.failed, false);
    assert.deepEqual(r.remediation, []);
  });

  it("passes when no finding reaches the severity floor", () => {
    const r = gateFailed("L2_feature_workflow", [finding({ severity: "low" }), finding({ severity: "medium" })]);
    assert.equal(r.failed, false);
  });

  it("fails and auto-creates remediation when findings are severe", () => {
    const r = gateFailed("L2_feature_workflow", [
      finding({ severity: "high", remediation: "Fix contrast" }),
      finding({ severity: "critical" }),
    ]);
    assert.equal(r.failed, true);
    assert.equal(r.remediation.length, 2);
    assert.equal(r.remediation[0]?.summary, "Fix contrast");
  });

  it("respects the maxRemediation budget", () => {
    const r = gateFailed("L3_system_design_system", [finding({ severity: "high" }), finding({ severity: "high" })], {
      maxRemediation: 1,
    });
    assert.equal(r.failed, true);
    assert.equal(r.remediation.length, 1);
  });

  it("respects the minSeverity budget", () => {
    const r = gateFailed("L2_feature_workflow", [finding({ severity: "medium", remediation: "tweak" })], {
      minSeverity: "medium",
    });
    assert.equal(r.failed, true);
    assert.equal(r.remediation[0]?.summary, "tweak");
  });
});

describe("autoAttach", () => {
  it("attaches for UI-impacting changes deterministically", () => {
    const a = autoAttach(["src/components/Button.tsx"], profile);
    assert.equal(a.attach, true);
    assert.equal(a.level, "L1_micro");
    assert.equal(a.plan.required, true);
    const b = autoAttach(["src/components/Button.tsx"], profile);
    assert.deepEqual(a, b);
  });

  it("does not attach for non-UI changes", () => {
    const a = autoAttach(["src/core/ids.ts"], profile);
    assert.equal(a.attach, false);
    assert.equal(a.level, "L0_none");
  });

  it("is pure: same inputs produce identical output", () => {
    const inputs: [string[], UiProfile | undefined] = [["src/app/page.tsx"], profile];
    assert.deepEqual(autoAttach(...inputs), autoAttach(...inputs));
  });
});

describe("level type sanity", () => {
  it("all level strings are valid", () => {
    const levels: readonly UiImpactLevel[] = ["L0_none", "L1_micro", "L2_feature_workflow", "L3_system_design_system"];
    assert.deepEqual(levels, UI_IMPACT_LEVELS);
  });
});
