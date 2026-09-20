import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BarStore,
  buildAuditReport,
  buildBaseline,
  buildDependencyOrder,
  campaignSettlementStatus,
  classifyRequirement,
  clusterRootCauses,
  discoverRepo,
  environmentFingerprint,
  executeAudit,
  generateCampaigns,
  reconcile,
} from "../../src/bar/index.ts";

function makeReq(
  partial: Partial<Parameters<typeof classifyRequirement>[0]> = {},
): Parameters<typeof classifyRequirement>[0] {
  return {
    id: "R1",
    project: "p",
    statement: "s",
    provenance: null,
    dependencies: [],
    evidenceRequirements: [],
    state: "UNKNOWN",
    sourceMappings: [],
    runtimeMappings: [],
    tests: [],
    artifacts: [],
    verifierIdentity: null,
    createdAt: "t",
    updatedAt: "t",
    blockers: [],
    repairCampaignIds: [],
    ...partial,
  };
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bar-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("BAR store persists and reloads requirement records idempotently", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    const rec = makeReq({ id: "R1", statement: "persisted" });
    await store.upsertRequirement(rec);
    assert.equal(store.listRequirements().length, 1);

    // Reopen (simulates restart/resume) -> record survives, no duplication.
    const store2 = await BarStore.open(dir);
    assert.equal(store2.listRequirements().length, 1);
    assert.equal(store2.getRequirement("R1")?.statement, "persisted");

    // Idempotent upsert: same id updates in place, still 1 record.
    await store2.upsertRequirement(makeReq({ id: "R1", statement: "updated" }));
    assert.equal(store2.listRequirements().length, 1);
    assert.equal(store2.getRequirement("R1")?.statement, "updated");
    assert.equal(store2.getRequirement("R1")?.createdAt, rec.createdAt, "createdAt must be preserved on re-apply");
  });
});

test("BAR store persists immutable baselines and campaigns", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    const base = buildBaseline({
      project: "p",
      sourceRevision: "abc",
      requirements: [makeReq()],
      services: ["svc"],
      cavResults: [],
      findings: [],
      cwd: dir,
    });
    assert.equal(base.immutable, true);
    await store.saveBaseline(base);
    const c = generateCampaigns([{ cluster: "root", requirements: ["R1"], evidence: ["e"] }], [makeReq()], {
      auditId: base.auditId,
    })[0]!;
    await store.saveCampaign(c);
    const store2 = await BarStore.open(dir);
    assert.equal(store2.getBaseline(base.auditId)?.immutable, true);
    assert.equal(store2.getCampaign(c.id)?.status, "PLANNED");
  });
});

test("discovery deterministically collects specs/source/tests/config", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, "docs/specs"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "test"), { recursive: true });
    await mkdir(join(dir, "node_modules/x"), { recursive: true });
    await writeFile(join(dir, "docs/specs/foo.md"), "# spec");
    await writeFile(join(dir, "src/thing.ts"), "export const x = 1;");
    await writeFile(join(dir, "test/thing.test.ts"), "import { test } from 'node:test';");
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "node_modules/x/index.js"), "ignore me");
    const d = discoverRepo(dir, { maxDepth: 8 });
    assert.ok(d.specs.includes("docs/specs/foo.md"));
    assert.ok(d.sourceFiles.includes("src/thing.ts"));
    assert.ok(!d.sourceFiles.some((f) => f.includes("node_modules")));
    assert.ok(d.testFiles.includes("test/thing.test.ts"));
    assert.ok(d.configFiles.includes("package.json"));
  });
});

test("classifyRequirement: reconstructed requirements begin UNKNOWN and never self-promote", () => {
  // No evidence -> UNKNOWN.
  assert.equal(classifyRequirement(makeReq()), "UNKNOWN");
  // Source mapping only -> SOURCE_MAPPED (not VERIFIED).
  assert.equal(
    classifyRequirement(makeReq({ sourceMappings: [{ path: "a.ts", confidence: "low" }] })),
    "SOURCE_MAPPED",
  );
  // Source + runtime + tests -> IMPLEMENTED_UNVERIFIED (never VERIFIED by executor).
  assert.equal(
    classifyRequirement(
      makeReq({
        sourceMappings: [{ path: "a.ts", confidence: "low" }],
        runtimeMappings: [{ surface: "svc", confidence: "low" }],
        tests: ["a.test.ts"],
      }),
    ),
    "IMPLEMENTED_UNVERIFIED",
  );
  // Blockers win over everything.
  assert.equal(classifyRequirement(makeReq({ blockers: ["db down"] })), "BLOCKED");
});

test("negative: executor never emits VERIFIED from evidence presence (implementer cannot self-promote)", () => {
  const out = executeAudit({
    project: "p",
    sourceRevision: "s",
    discovery: {
      root: "/x",
      sourceRevision: null,
      specs: ["s.md"],
      sourceFiles: ["src/a.ts"],
      testFiles: ["t.test.ts"],
      configFiles: [],
      historicalClaims: [],
      entrypoints: [],
    },
    requirements: [
      {
        id: "R1",
        statement: "authentication works",
        provenance: { file: "s.md" },
      },
    ],
  });
  const rec = out.requirements[0]!;
  // Historical claim ("verified") is not present as evidence, so not VERIFIED.
  assert.notEqual(rec.state, "VERIFIED");
  assert.notEqual(rec.state, "FAILED");
  // With source+runtime+tests it can reach IMPLEMENTED_UNVERIFIED at most.
  const out2 = executeAudit({
    project: "p",
    sourceRevision: "s",
    discovery: {
      root: "/x",
      sourceRevision: null,
      specs: ["s.md"],
      sourceFiles: ["src/authentication.ts"],
      testFiles: ["authentication.test.ts"],
      configFiles: [],
      historicalClaims: [],
      entrypoints: ["src/authentication.ts"],
    },
    requirements: [{ id: "R2", statement: "authentication flow", provenance: { file: "s.md" } }],
  });
  assert.equal(out2.requirements[0]!.state, "IMPLEMENTED_UNVERIFIED");
});

test("explicit independent-verifier classifications promote deterministically", () => {
  const req = makeReq({ sourceMappings: [{ path: "a.ts", confidence: "high" }] });
  assert.equal(classifyRequirement(req, "VERIFIED"), "VERIFIED");
  assert.equal(classifyRequirement(req, "FAILED"), "FAILED");
  assert.equal(classifyRequirement(req, "ORPHAN"), "ORPHAN_IMPLEMENTATION");
  assert.equal(classifyRequirement(req, "OBSOLETE"), "OBSOLETE_CANDIDATE");
});

test("reconcile recomputes states and reports deltas (no VERIFIED from historical claims)", () => {
  const req = makeReq({ id: "R1", state: "SOURCE_MAPPED", sourceMappings: [{ path: "a.ts", confidence: "low" }] });
  // Reconcile with no independent classification: stays SOURCE_MAPPED, no delta.
  const r1 = reconcile({ requirements: [req] });
  assert.equal(r1.deltas.length, 0);
  // Reconcile with an independent VERIFIED classification -> delta SOURCE_MAPPED->VERIFIED.
  const r2 = reconcile({
    requirements: [req],
    classifications: [{ requirementId: "R1", classification: "VERIFIED" }],
  });
  assert.equal(r2.deltas.length, 1);
  assert.deepEqual(r2.deltas[0], { requirementId: "R1", before: "SOURCE_MAPPED", after: "VERIFIED" });
});

test("clustering groups requirements by shared source and shared blockers", () => {
  const reqs = [
    makeReq({ id: "A", sourceMappings: [{ path: "shared.ts", confidence: "low" }] }),
    makeReq({ id: "B", sourceMappings: [{ path: "shared.ts", confidence: "low" }], blockers: ["db down"] }),
    makeReq({ id: "C", blockers: ["db down"] }),
  ];
  const clusters = clusterRootCauses(reqs);
  assert.ok(clusters.some((c) => c.cluster === "shared-source:shared.ts"));
  assert.ok(clusters.some((c) => c.cluster === "shared-blocker:db down"));
});

test("dependency ordering is deterministic and reports unresolved deps", () => {
  const reqs = [
    makeReq({ id: "A", dependencies: ["B"] }),
    makeReq({ id: "B", dependencies: [] }),
    makeReq({ id: "C", dependencies: ["missing"] }),
  ];
  const { order, unresolved } = buildDependencyOrder(reqs);
  assert.deepEqual(unresolved, ["missing"]);
  // B must precede A (dependency first).
  assert.ok(order.indexOf("B") < order.indexOf("A"));
  assert.ok(order.includes("C"));
  // Deterministic: stable across runs.
  const r2 = buildDependencyOrder(reqs);
  assert.deepEqual(order, r2.order);
});

test("campaign generation carries the contract and forbids acceptance weakening", () => {
  const clusters = [{ cluster: "shared-source:src/a.ts", requirements: ["A", "B"], evidence: ["e"] }];
  const reqs = [makeReq({ id: "A" }), makeReq({ id: "B", dependencies: ["A"] })];
  const campaigns = generateCampaigns(clusters, reqs, { auditId: "AUD" });
  assert.equal(campaigns.length, 1);
  const c = campaigns[0]!;
  assert.equal(c.prohibitedAcceptanceWeakening, true);
  assert.equal(c.independentReviewRequired, true);
  assert.deepEqual(c.affectedRequirements, ["A", "B"]);
  // Dependencies exclude the affected set itself.
  assert.deepEqual(c.dependencies, []);
  // A campaign with all-verified requirements settles to DONE.
  assert.equal(
    campaignSettlementStatus(c, [makeReq({ id: "A", state: "VERIFIED" }), makeReq({ id: "B", state: "VERIFIED" })]),
    "DONE",
  );
  // A campaign with any non-verified requirement settles to REQUIRES_REVIEW.
  assert.equal(
    campaignSettlementStatus(c, [makeReq({ id: "A", state: "VERIFIED" }), makeReq({ id: "B", state: "UNKNOWN" })]),
    "REQUIRES_REVIEW",
  );
});

test("audit report counts every state and never collapses UNKNOWN into PASS", () => {
  const reqs = [
    makeReq({ id: "A", state: "VERIFIED" }),
    makeReq({ id: "B", state: "UNKNOWN" }),
    makeReq({ id: "C", state: "BLOCKED", blockers: ["x"] }),
  ];
  const base = buildBaseline({
    project: "p",
    sourceRevision: "s",
    requirements: reqs,
    services: ["s"],
    cavResults: [],
    findings: [],
    cwd: "/x",
  });
  const report = buildAuditReport({
    project: "p",
    sourceRevision: "s",
    cwd: "/x",
    requirements: reqs,
    baseline: base,
    clusters: [],
    dependencyOrder: [],
    unresolvedDependencies: [],
    campaigns: [],
    deltas: [],
    allSurfaces: ["s1", "s2"],
    coveredSurfaces: ["s1"],
  });
  assert.equal(report.verifiedCount, 1);
  assert.equal(report.verifiedDenominator, 3);
  assert.equal(report.percentVerified, 33);
  assert.equal(report.stateCounts.UNKNOWN, 1);
  assert.equal(report.stateCounts.BLOCKED, 1);
  assert.deepEqual(report.coverage.untested, ["s2"]);
  assert.match(report.nextAction, /Resolve recorded blockers/);
});

test("environment fingerprint is deterministic for same inputs", () => {
  const a = environmentFingerprint("/x");
  const b = environmentFingerprint("/x");
  assert.equal(a, b);
});
