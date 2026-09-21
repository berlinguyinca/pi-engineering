import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { UiProfile } from "../../src/uieng/discovery.ts";
import { toMetricScore } from "../../src/uieng/evidence.ts";
import {
  GENOME_MANIFEST_FILE,
  type GenomeInjection,
  type UiGenome,
  analyzeGenomeEntropy,
  computeGenomeEntropy,
  injectGenomeContracts,
  isConstitutional,
  listGenomeFiles,
  loadGenome,
  normalizedShannonEntropy,
  relevantContracts,
  saveGenome,
  validateGenome,
} from "../../src/uieng/genome.ts";
import { assertMetricKnown } from "../../src/uieng/rubric.ts";

function sampleGenome(): UiGenome {
  return {
    version: 1,
    contracts: {
      constitution: {
        version: 1,
        approved_rule_ids: ["token-only-styles", "wcag-aa"],
        rules: [
          {
            id: "token-only-styles",
            title: "No hard-coded values",
            approved: true,
            contracts: ["colors.yaml", "spacing.yaml"],
          },
          { id: "wcag-aa", title: "WCAG AA contrast", approved: true, contracts: ["accessibility-contract.yaml"] },
          { id: "reduce-motion", title: "Respect prefers-reduced-motion", approved: false, experimental: true },
        ],
      },
      colors: {
        palette: [
          { name: "primary", value: "#0a84ff", role: "accent" },
          { name: "danger", value: "#ff375f", role: "error" },
        ],
        semantic: { accent: "primary", error: "danger" },
      },
      spacing: {
        base_unit: "4px",
        scale: [
          { name: "space-1", value: 4 },
          { name: "space-2", value: 8 },
        ],
      },
      breakpoints: {
        breakpoints: [
          { name: "sm", width: 640 },
          { name: "lg", width: 1024 },
        ],
      },
      typography: { families: ["Inter"], scale: [{ name: "text-sm", size: 14 }] },
      components: { components: [{ name: "Button", description: "Primary action", tokens: ["primary"] }] },
      terminology: { terms: [{ term: "Workspace", definition: "A project container" }] },
      "interaction-patterns": {
        patterns: [{ name: "confirm-destructive", description: "Confirm before delete", states: ["idle", "confirm"] }],
      },
      "responsive-contract": { mobile_first: true, breakpoints: ["sm", "md", "lg"] },
      "accessibility-contract": { wcag_target: "AA", contrast_aa: true, touch_minimum: 44, focus_visible: true },
      "task-catalog": {
        tasks: [
          {
            id: "create-workspace",
            title: "Create workspace",
            description: "Make one",
            steps: ["click new", "submit"],
          },
        ],
      },
      exceptions: { exceptions: [{ id: "x1", contract: "spacing.yaml", reason: "legacy", approved: false }] },
    },
  };
}

function sampleProfile(): UiProfile {
  return {
    schema_version: 1,
    kind: "ui_profile",
    id: "UP-1",
    discoveredAt: new Date().toISOString(),
    ui_present: true,
    framework: "react",
    frameworks_detected: ["react"],
    routes: [],
    components: ["Button.tsx"],
    component_count: 1,
    styling: "tailwind",
    design_system: "custom",
    tokens: { primary: "#0a84ff" },
    token_files: ["tokens.json"],
    startup: { dev: "npm run dev" },
    browser_tests: [],
    responsive_targets: ["sm", "lg"],
    design_docs: [],
  };
}

describe("uieng genome store", () => {
  it("validateGenome accepts a well-formed genome", () => {
    const result = validateGenome(sampleGenome());
    assert.equal(result.valid, true);
    assert.equal(result.contract_count, 12);
    assert.deepEqual(result.issues, []);
  });

  it("validateGenome reports issues for malformed contracts", () => {
    const genome: UiGenome = {
      version: 0,
      contracts: {
        colors: { palette: [{ name: "x" } as never], semantic: {} },
        constitution: {
          version: 1,
          approved_rule_ids: ["ghost"],
          rules: [{ id: "real", title: "t", approved: false }],
        },
      },
    };
    const result = validateGenome(genome);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("genome.version")));
    assert.ok(result.issues.some((i) => i.includes("palette swatch")));
    assert.ok(result.issues.some((i) => i.includes('unknown rule "ghost"')));
  });

  it("saveGenome + loadGenome round-trips the typed contracts as YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "uieng-genome-"));
    try {
      await saveGenome(sampleGenome(), root);
      const files = await listGenomeFiles(root);
      assert.ok(files.includes(GENOME_MANIFEST_FILE));
      assert.ok(files.includes("colors.yaml"));
      assert.ok(files.includes("constitution.yaml"));

      const manifest = await readFile(join(root, ".ui", GENOME_MANIFEST_FILE), "utf-8");
      assert.ok(manifest.includes("version: 1"));

      const loaded = await loadGenome(root);
      assert.equal(loaded.version, 1);
      assert.deepEqual(loaded.contracts.colors?.palette, sampleGenome().contracts.colors?.palette);
      assert.deepEqual(loaded.contracts.constitution?.approved_rule_ids, ["token-only-styles", "wcag-aa"]);
      assert.equal(loaded.contracts.breakpoints?.breakpoints[0]?.name, "sm");

      const dirs = await readdir(join(root, ".ui"));
      assert.ok(dirs.includes("approved-reference"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("uieng design-entropy analyzer", () => {
  it("normalizedShannonEntropy is 0 for a single/consistent value and 1 for uniform max divergence", () => {
    assert.equal(normalizedShannonEntropy({ a: 10 }), 0);
    const uniform = normalizedShannonEntropy({ a: 1, b: 1, c: 1, d: 1 });
    assert.ok(Math.abs(uniform - 1) < 1e-9, `expected ~1, got ${uniform}`);
    assert.equal(normalizedShannonEntropy({}), 0);
  });

  it("computeGenomeEntropy rewards consistent usage with a high score", () => {
    const { score } = computeGenomeEntropy({
      colorPalette: { "#0a84ff": 100 },
      spacing: { "space-2": 80 },
      typography: { "text-sm": 60 },
      radius: { "radius-md": 70 },
      patterns: { Card: 90 },
    });
    assert.equal(score, 100);
  });

  it("analyzeGenomeEntropy returns a rubric-valid AnalysisResult for design_entropy", () => {
    const result = analyzeGenomeEntropy({
      colorPalette: { "#0a84ff": 100, "#ff375f": 1, "#00c7be": 1 },
      spacing: { "space-2": 80, "space-9": 1 },
      typography: { "text-sm": 60, "text-2xl": 1 },
      radius: { "radius-md": 70 },
      patterns: { Card: 90, OneOffThing: 1 },
    });
    assert.equal(result.metricId, "design_entropy");
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.equal(assertMetricKnown(result.metricId).source, "deterministic");
    // Consumable by evidence.ts toMetricScore -> rubric scoreRecord.
    const metricScore = toMetricScore(result);
    assert.equal(metricScore.metric_id, "design_entropy");
    assert.equal(metricScore.score, result.score);
  });

  it("analyzeGenomeEntropy scores low (high entropy) when usage is divergent", () => {
    const chaotic = analyzeGenomeEntropy({
      colorPalette: { a: 1, b: 1, c: 1, d: 1, e: 1 },
      spacing: { a: 1, b: 1, c: 1, d: 1, e: 1 },
      typography: { a: 1, b: 1, c: 1, d: 1, e: 1 },
      radius: { a: 1, b: 1, c: 1, d: 1, e: 1 },
      patterns: { a: 1, b: 1, c: 1, d: 1, e: 1 },
    });
    const consistent = analyzeGenomeEntropy({
      colorPalette: { a: 100 },
      spacing: { a: 100 },
      typography: { a: 100 },
      radius: { a: 100 },
      patterns: { a: 100 },
    });
    assert.ok(chaotic.score < consistent.score, `${chaotic.score} should be < ${consistent.score}`);
  });
});

describe("uieng contract injection", () => {
  it("injects relevant contracts and marks approved rules constitutional", () => {
    const genome = sampleGenome();
    const injection = injectGenomeContracts(sampleProfile(), genome);
    assert.equal(injection.genome_version, 1);
    assert.deepEqual(injection.constitutional, ["token-only-styles", "wcag-aa"]);
    assert.deepEqual(injection.advisory, ["reduce-motion"]);
    assert.ok(injection.documents.colors);
    assert.ok(injection.documents.spacing);
    assert.ok(injection.documents["responsive-contract"]);
    assert.ok(injection.text.includes("CONSTITUTIONAL"));
    assert.ok(injection.text.includes("ADVISORY"));
    assert.ok(isConstitutional(genome, "token-only-styles"));
    assert.ok(!isConstitutional(genome, "reduce-motion"));
  });

  it("respects maxAdvisory and force options", () => {
    const injection: GenomeInjection = injectGenomeContracts(sampleProfile(), sampleGenome(), {
      maxAdvisory: 0,
      force: ["task-catalog"],
    });
    assert.deepEqual(injection.advisory, []);
    assert.ok(injection.documents["task-catalog"]);
  });

  it("surfaces no contracts when profile has no UI surface", () => {
    const profile = {
      ...sampleProfile(),
      ui_present: false,
      styling: undefined,
      design_system: undefined,
      component_count: 0,
      tokens: {},
    };
    const injection = injectGenomeContracts(profile, sampleGenome());
    assert.equal(injection.profile.ui_present, false);
    assert.deepEqual(relevantContracts(profile as UiProfile), ["terminology", "task-catalog", "exceptions"]);
  });
});
