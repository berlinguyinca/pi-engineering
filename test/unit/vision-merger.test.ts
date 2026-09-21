import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DesignContractMerger,
  UNIFIED_CONTRACT_SCHEMA_VERSION,
  detectConflicts,
  renderContractMarkdown,
} from "../../src/vision/merger.ts";
import type { ReferencePrecedence } from "../../src/vision/merger.ts";
import { validateDesignObservation } from "../../src/vision/observation.ts";
import type { DesignObservation } from "../../src/vision/observation.ts";
import { VisionObservationStore, buildTraceability } from "../../src/vision/store.ts";

function obs(
  reference: string,
  opts: { tablet?: string[]; components?: string[]; navigation?: string[] } = {},
): DesignObservation {
  return {
    assetId: `asset-${reference}`,
    reference,
    summary: `Summary for ${reference}`,
    layouts: [`layout of ${reference}`],
    components: opts.components ?? ["card component"],
    navigation: opts.navigation ?? ["top bar"],
    responsiveBehavior: {
      desktop: ["full sidebar visible on desktop"],
      tablet: opts.tablet ?? ["sidebar visible on tablet"],
      mobile: ["hamburger menu on mobile"],
    },
    visualHierarchy: ["header prominent"],
    interactionPatterns: ["click-to-expand"],
    reusablePatterns: ["shared card"],
    implementationConstraints: ["no external fonts"],
    accessibilityNotes: ["keyboard navigable"],
    unknowns: [],
    confidence: { overall: 0.85, layout: 0.8, typography: 0.7 },
  };
}

test("merger: canonical sidebar persists-vs-collapses tablet conflict is detected", () => {
  const a = obs("A", { tablet: ["sidebar persists on tablet"] });
  const b = obs("B", { tablet: ["sidebar collapses on tablet"] });
  const conflicts = detectConflicts([a, b]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.topic, "responsive tablet");
  assert.ok(conflicts[0]?.detail.includes("sidebar"));
  assert.ok(conflicts[0]?.detail.includes("persists"));
  assert.ok(conflicts[0]?.detail.includes("collapses"));
});

test("merger: consistent tablet statements produce no conflict", () => {
  const a = obs("A", { tablet: ["sidebar persists on tablet"] });
  const b = obs("B", { tablet: ["sidebar visible on tablet"] });
  assert.equal(detectConflicts([a, b]).length, 0);
});

test("merger: responsive-authority precedence resolves the tablet conflict", () => {
  const a = obs("A", { tablet: ["sidebar persists on tablet"] });
  const b = obs("B", { tablet: ["sidebar collapses on tablet"] });
  const precedence: ReferencePrecedence[] = [{ id: "B", role: "responsive-authority" }];
  const contract = new DesignContractMerger().merge([a, b], precedence);
  assert.equal(contract.conflicts.length, 0);
  const tablet = contract.sections.find((s) => s.title === "Tablet Rules");
  assert.ok(tablet);
  assert.ok(tablet.items.some((i) => i.includes("collapses") && i.includes("[from: B]")));
  assert.ok(!tablet.items.some((i) => i.includes("persists")));
});

test("merger: unresolved conflict remains listed", () => {
  const a = obs("A", { tablet: ["sidebar persists on tablet"] });
  const b = obs("B", { tablet: ["sidebar collapses on tablet"] });
  const contract = new DesignContractMerger().merge([a, b]);
  assert.equal(contract.conflicts.length, 1);
  assert.equal(contract.schemaVersion, UNIFIED_CONTRACT_SCHEMA_VERSION);
});

test("merger: sections dedupe identical items and tag provenance", () => {
  const a = obs("A", { components: ["card component"] });
  const b = obs("B", { components: ["card component", "data table"] });
  const contract = new DesignContractMerger().merge([a, b]);
  const reusable = contract.sections.find((s) => s.title === "Reusable Components");
  assert.ok(reusable);
  const tagged = reusable.items.filter((i) => i.includes("card component"));
  // Deduped: same raw item from two references yields two distinct provenance-tagged entries.
  assert.equal(tagged.filter((i) => i.includes("[from: A]")).length, 1);
  assert.equal(tagged.filter((i) => i.includes("[from: B]")).length, 1);
  assert.ok(reusable.items.some((i) => i.includes("data table") && i.includes("[from: B]")));
});

test("merger: markdown render contains expected headings and conflict list", () => {
  const a = obs("A", { tablet: ["sidebar persists on tablet"] });
  const b = obs("B", { tablet: ["sidebar collapses on tablet"] });
  const md = renderContractMarkdown(new DesignContractMerger().merge([a, b]));
  assert.ok(md.startsWith("# Unified Design Contract"));
  assert.ok(md.includes("## Tablet Rules"));
  assert.ok(md.includes("## Navigation Behavior"));
  assert.ok(md.includes("## Conflicts"));
  assert.ok(md.includes("responsive tablet"));
});

test("store: save/load round-trip, has(), and markdown file", () => {
  const root = mkdtempSync(join(tmpdir(), "vision-store-"));
  try {
    const store = new VisionObservationStore(root);
    const observation = obs("A");
    const md = "# A\n\nbody\n";
    store.save("A", observation, md);
    assert.equal(store.has("A"), true);
    assert.equal(store.has("missing"), false);
    const loaded = store.load("A");
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, "DesignObservation/v1");
    assert.deepEqual(loaded.observation, observation);
    assert.equal(validateDesignObservation(loaded.observation).length, 0);
    const mdPath = store.analysisMdPath("A");
    assert.ok(join(root, "A.analysis.json") === store.analysisJsonPath("A"));
    assert.ok(mdPath.endsWith(`${join("A.analysis.md")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store: invalid file returns null from load/has", () => {
  const root = mkdtempSync(join(tmpdir(), "vision-store-invalid-"));
  try {
    const store = new VisionObservationStore(root);
    const jsonPath = store.analysisJsonPath("bad");
    writeFileSync(
      jsonPath,
      JSON.stringify({ schemaVersion: "DesignObservation/v1", observation: { nope: true } }),
      "utf8",
    );
    assert.equal(store.load("bad"), null);
    assert.equal(store.has("bad"), false);
    // Missing file also returns null.
    assert.equal(store.load("absent"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store: default root is the analysis directory", () => {
  const store = new VisionObservationStore();
  assert.equal(store.root, "docs/specs/aims-console/design/analysis");
});

test("traceability: requirements derived with provenance from each observation", () => {
  const a = obs("A", { components: ["card component"], navigation: ["top bar"] });
  const b = obs("B", { components: ["card component", "data table"], navigation: [] });
  const records = buildTraceability([a, b]);
  const card = records.find((r) => r.requirement === "card component");
  assert.ok(card);
  assert.deepEqual(card.sources.map((s) => s.reference).sort(), ["A", "B"]);
  assert.ok(card.sources.every((s) => s.region === "components"));
  const nav = records.find((r) => r.requirement === "top bar");
  assert.ok(nav);
  assert.deepEqual(nav.sources, [{ reference: "A", region: "navigation" }]);
  const table = records.find((r) => r.requirement === "data table");
  assert.ok(table);
  assert.deepEqual(table.sources, [{ reference: "B", region: "components" }]);
});
