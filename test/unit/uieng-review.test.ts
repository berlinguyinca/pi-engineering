import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REVIEWER_ROLES,
  REVIEWER_ROLE_IDS,
  assembleReviewPlan,
  buildSpec,
  clusterRootCauses,
  disagreementIndex,
  fnv1a,
  normalizeRootCause,
  rankClusters,
  reviewerRoleById,
} from "../../src/uieng/review.ts";
import type {
  ImplementationSpec,
  RootCauseCluster,
  ReviewerRole,
  ReviewerScore,
} from "../../src/uieng/review.ts";
import type { Finding } from "../../src/uieng/schemas.ts";

function finding(overrides: Partial<Finding>): Finding {
  return {
    schema_version: 1,
    kind: "finding",
    id: "FIND-X",
    score: 0.4,
    confidence: 0.9,
    severity: "medium",
    evidence: [],
    ...overrides,
  };
}

const highImpact: Finding = finding({
  id: "FIND-1",
  severity: "high",
  confidence: 0.9,
  root_cause: "Missing empty state on list views",
  affected_code: ["src/components/List.tsx"],
  effort: "low",
  risk: "low",
});
const highImpact2: Finding = finding({
  id: "FIND-2",
  severity: "critical",
  confidence: 0.8,
  root_cause: "Missing empty state on list views",
  affected_code: ["src/components/List.tsx"],
  effort: "low",
  risk: "low",
});
const other: Finding = finding({
  id: "FIND-3",
  severity: "low",
  confidence: 0.5,
  root_cause: "Inconsistent spacing tokens",
  affected_states: ["settings"],
});

describe("reviewer roles", () => {
  it("exports the five typed roles", () => {
    assert.equal(REVIEWER_ROLE_IDS.length, 5);
    assert.deepEqual([...REVIEWER_ROLE_IDS].sort(), [
      "code_critic",
      "deterministic",
      "diagnosis_architect",
      "usability_agent",
      "visual_critic",
    ]);
  });

  it("each role is partially blind (subset of evidence) and declares capabilities", () => {
    for (const role of REVIEWER_ROLES) {
      assert.ok(role.inputs.length > 0, `${role.roleId} sees at least one input`);
      assert.ok(role.requiredCapabilities.length > 0, `${role.roleId} requires capabilities`);
      assert.ok(role.independenceGroup.length > 0, `${role.roleId} has an independence group`);
      // capabilities are tokens, never model names
      for (const cap of role.requiredCapabilities) assert.ok(!/\d/.test(cap));
    }
  });

  it("roles in different independence groups exist at the full level", () => {
    const groups = new Set(REVIEWER_ROLES.map((r) => r.independenceGroup));
    assert.ok(groups.size >= 4);
  });

  it("reviewerRoleById finds and rejects", () => {
    const role: ReviewerRole = reviewerRoleById("visual_critic");
    assert.equal(role.roleId, "visual_critic");
    assert.throws(() => reviewerRoleById("nope" as never));
  });
});

describe("clusterRootCauses", () => {
  it("groups findings sharing a root cause", () => {
    const clusters = clusterRootCauses([highImpact, highImpact2, other]);
    assert.equal(clusters.length, 2);
    const empty = clusters.find((c) => c.rootCause.includes("empty state"));
    const spacing = clusters.find((c) => c.rootCause.includes("spacing"));
    assert.ok(empty);
    assert.ok(spacing);
    assert.equal(empty!.findings.length, 2);
    assert.equal(spacing!.findings.length, 1);
    assert.equal(empty!.affectedSurface, "src/components/List.tsx");
  });

  it("derives a fallback root cause when none is set", () => {
    const clusters = clusterRootCauses([finding({ root_cause: undefined, remediation: "Add validation" })]);
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0]!.rootCause.includes("add validation"));
  });

  it("normalizes root causes so equivalent causes cluster", () => {
    assert.equal(normalizeRootCause("  Missing Empty State. "), "missing empty state");
  });

  it("aggregates impact by max severity and leverage by share", () => {
    const clusters = clusterRootCauses([highImpact, highImpact2, other]);
    const empty = clusters.find((c) => c.rootCause.includes("empty state"))!;
    assert.equal(empty.impact, 1); // critical member
    assert.equal(empty.leverage, 2 / 3);
    assert.equal(empty.confidence, 0.85); // mean of 0.9, 0.8
    assert.ok(empty.expectedGain > 0 && empty.expectedGain <= 1);
    assert.equal(empty.effort, "low");
    assert.equal(empty.risk, "low");
  });

  it("handles empty input", () => {
    assert.deepEqual(clusterRootCauses([]), []);
  });
});

describe("rankClusters", () => {
  it("sorts deterministically by impact/leverage/expectedGain and penalizes risk/effort", () => {
    const cheapHighGain: RootCauseCluster = {
      rootCause: "cheap high gain",
      findings: [highImpact],
      affectedSurface: "a",
      impact: 1,
      confidence: 0.9,
      leverage: 0.9,
      expectedGain: 0.9,
      effort: "low",
      risk: "low",
    };
    const riskyLowGain: RootCauseCluster = {
      rootCause: "risky low gain",
      findings: [other],
      affectedSurface: "b",
      impact: 0.4,
      confidence: 0.5,
      leverage: 0.1,
      expectedGain: 0.04,
      effort: "high",
      risk: "high",
    };
    const ranked = rankClusters([riskyLowGain, cheapHighGain]);
    assert.equal(ranked[0]!.rootCause, "cheap high gain");
    assert.equal(ranked[1]!.rootCause, "risky low gain");
  });

  it("does not mutate the input and tie-breaks by rootCause", () => {
    const a: RootCauseCluster = {
      rootCause: "aaa",
      findings: [highImpact],
      affectedSurface: "x",
      impact: 0.5,
      confidence: 0.5,
      leverage: 0.5,
      expectedGain: 0.25,
      effort: "medium",
      risk: "medium",
    };
    const b: RootCauseCluster = {
      rootCause: "bbb",
      findings: [other],
      affectedSurface: "y",
      impact: 0.5,
      confidence: 0.5,
      leverage: 0.5,
      expectedGain: 0.25,
      effort: "medium",
      risk: "medium",
    };
    const input = [b, a];
    const ranked = rankClusters(input);
    assert.deepEqual(ranked.map((c) => c.rootCause), ["aaa", "bbb"]);
    assert.deepEqual(input.map((c) => c.rootCause), ["bbb", "aaa"]);
  });
});

describe("buildSpec", () => {
  const cluster = clusterRootCauses([highImpact, highImpact2])[0]!;

  it("produces a deterministic pure spec", () => {
    const opts = {
      evidenceRefs: ["artifact://eb1"],
      invariants: ["existing flows keep working"],
      tests: ["empty-state renders"],
      expectedMetricChanges: { empty_states: 100, visual_hierarchy: 90 },
      rollbackConditions: ["metric regression on desktop"],
      affectedFiles: ["src/components/List.tsx", "src/styles/list.css"],
    };
    const spec: ImplementationSpec = buildSpec(cluster, opts);
    assert.ok(spec.specId.startsWith("SPEC-"));
    assert.ok(spec.rootCause.includes("empty state"));
    assert.deepEqual(spec.evidenceRefs, opts.evidenceRefs);
    assert.deepEqual(spec.invariants, opts.invariants);
    assert.deepEqual(spec.tests, opts.tests);
    assert.deepEqual(spec.expectedMetricChanges, opts.expectedMetricChanges);
    assert.deepEqual(spec.rollbackConditions, opts.rollbackConditions);
    assert.deepEqual(spec.affectedFiles, opts.affectedFiles);
    assert.ok(spec.rationale.includes("2 finding(s)"));

    const spec2 = buildSpec(cluster, opts);
    assert.equal(spec.specId, spec2.specId);
  });

  it("rejects unknown metric ids", () => {
    assert.throws(() =>
      buildSpec(cluster, {
        evidenceRefs: [],
        invariants: [],
        tests: [],
        expectedMetricChanges: { not_a_metric: 100 },
        rollbackConditions: [],
        affectedFiles: [],
      }),
    );
  });

  it("fnv1a is deterministic", () => {
    assert.equal(fnv1a("hello"), fnv1a("hello"));
    assert.notEqual(fnv1a("hello"), fnv1a("hello world"));
  });
});

describe("assembleReviewPlan", () => {
  it("scales roles with impact level", () => {
    const l0 = assembleReviewPlan("L0_none");
    assert.equal(l0.roles.length, 1);
    assert.equal(l0.roles[0]!.roleId, "deterministic");

    const l1 = assembleReviewPlan("L1_micro");
    assert.deepEqual(new Set(l1.roles.map((r) => r.roleId)), new Set(["visual_critic", "deterministic"]));

    const l3 = assembleReviewPlan("L3_system_design_system");
    assert.equal(l3.roles.length, 5);
    assert.ok(l3.capabilities.length > 0);
    assert.ok(l3.independenceGroups.length >= 4);
  });

  it("capabilities are capability tokens and independence groups are distinct", () => {
    const l3 = assembleReviewPlan("L3_system_design_system");
    for (const cap of l3.capabilities) assert.ok(!/\d/.test(cap));
    const uniqueGroups = new Set(l3.independenceGroups);
    assert.equal(uniqueGroups.size, l3.independenceGroups.length);
  });
});

describe("disagreementIndex", () => {
  it("is zero for fewer than two reviews", () => {
    assert.equal(disagreementIndex([]), 0);
    assert.equal(disagreementIndex([{ roleId: "deterministic", score: 0.5 }]), 0);
  });

  it("computes mean pairwise absolute difference", () => {
    const reviews: ReviewerScore[] = [
      { roleId: "visual_critic", score: 0.2 },
      { roleId: "usability_agent", score: 0.6 },
      { roleId: "deterministic", score: 0.6 },
    ];
    // |0.2-0.6| + |0.2-0.6| + |0.6-0.6| = 0.8 / 3
    assert.equal(disagreementIndex(reviews), 0.8 / 3);
  });

  it("returns zero when all reviewers agree", () => {
    assert.equal(
      disagreementIndex([
        { roleId: "visual_critic", score: 0.8 },
        { roleId: "code_critic", score: 0.8 },
      ]),
      0,
    );
  });
});
