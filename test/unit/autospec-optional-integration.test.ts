import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { mergeAutoSpecLayers } from "../../src/integrations/autospec/config.ts";
import {
  collectAutoSpecGateEvidence,
  loadAutoSpecConfig,
  uiFilesOf,
} from "../../src/integrations/autospec/provider.ts";
import { mapQualityLaw, qualityLawChecklist } from "../../src/integrations/autospec/qualityLaw.ts";
import { DEFAULT_POLICY, loadPolicy } from "../../src/lifecycle/policy.ts";
import { buildCompletionReport } from "../../src/lifecycle/rolePrompts.ts";

const GLOBAL = {
  dag: { enabled: true },
  design_gate: { ui_paths: ["src/ui/**"], require_for_ui: true, rules_file: "/x/rules.yaml" },
  quality_law: { profile_file: "/x/p.json", profile_id: "web", gate_files: ["/x/g.json"] },
};
const on = (r: ReturnType<typeof mergeAutoSpecLayers>) => {
  assert.equal(r.kind, "on", JSON.stringify(r));
  return (r as Extract<typeof r, { kind: "on" }>).config;
};

describe("autospec config layers", () => {
  it("absent everywhere is OFF", () => {
    assert.deepEqual(mergeAutoSpecLayers({ global: {}, repo: {} }), { kind: "off" });
  });

  it("global sets everything", () => {
    const c = on(mergeAutoSpecLayers({ global: { raw: GLOBAL }, repo: {} }));
    assert.equal(c.dag.enabled, true);
    assert.deepEqual(c.designGate, {
      reportPath: ".autospec/reports/design-gates.json",
      rulesFile: "/x/rules.yaml",
      uiPaths: ["src/ui/**"],
      requireForUi: true,
    });
    assert.deepEqual(c.qualityLaw, { profileFile: "/x/p.json", profileId: "web", gateFiles: ["/x/g.json"] });
  });

  it("a repo layer can require the gate and add ui_paths, but cannot relax or redirect", () => {
    const c = on(
      mergeAutoSpecLayers({
        global: { raw: GLOBAL },
        repo: {
          raw: {
            dag: { enabled: true },
            design_gate: { require_for_ui: false, ui_paths: ["web/**"], report: "x.json", rules_file: "evil.yaml" },
            quality_law: { profile_file: "evil" },
          },
        },
      }),
    );
    assert.equal(c.designGate?.requireForUi, true);
    assert.deepEqual(c.designGate?.uiPaths, ["src/ui/**", "web/**"]);
    assert.equal(c.designGate?.reportPath, ".autospec/reports/design-gates.json");
    assert.equal(c.designGate?.rulesFile, "/x/rules.yaml");
    assert.equal(c.qualityLaw?.profileFile, "/x/p.json");
    assert.ok(c.notes.length >= 4);
    // A repo-only layer cannot enable DAG ingestion.
    const repoOnly = on(
      mergeAutoSpecLayers({
        global: {},
        repo: { raw: { dag: { enabled: true }, design_gate: { ui_paths: ["a/**"], require_for_ui: true } } },
      }),
    );
    assert.equal(repoOnly.dag.enabled, false);
    assert.equal(repoOnly.designGate?.requireForUi, true);
  });

  it("malformed config fails closed (never OFF)", () => {
    const bad = (raw: unknown, repo = false) =>
      mergeAutoSpecLayers(repo ? { global: {}, repo: { raw } } : { global: { raw }, repo: {} }).kind;
    assert.equal(bad("yes"), "invalid");
    assert.equal(bad({ dag: { enabled: "true" } }), "invalid");
    assert.equal(bad({ design_gate: { require_for_ui: "true", ui_paths: ["a"] } }), "invalid");
    assert.equal(bad({ design_gate: { requre_for_ui: true } }), "invalid");
    assert.equal(bad({ design_gate: { report: "../escape.json" } }), "invalid");
    assert.equal(bad({ design_gate: { report: "/abs.json" } }), "invalid");
    assert.equal(bad({ bogus: 1 }), "invalid");
    assert.equal(bad({ design_gate: { require_for_ui: true } }), "invalid", "requires ui_paths");
    assert.equal(bad({ quality_law: { required: true } }), "invalid", "required quality law is not supported");
    assert.equal(bad({ design_gate: { ui_paths: "src/**" } }, true), "invalid");
    assert.equal(mergeAutoSpecLayers({ global: { error: "EACCES" }, repo: {} }).kind, "invalid");
  });
});

describe("Constitution quality-law checklist", () => {
  // Built from quality-gate.schema.json / profile.schema.json (no gate instances exist upstream).
  const gate = (name: string, profiles: string[] = []) => ({
    name,
    purpose: `purpose of ${name}`,
    required_evidence: ["test report"],
    pass_fail_criteria: ["all green"],
    applies_to_profiles: profiles,
  });

  it("lists the profile's gates, filtered by applies_to_profiles, never as passed", () => {
    const res = mapQualityLaw({
      profile: { quality_gates: ["accessibility", "security", "undefined-gate"] },
      profileId: "web",
      gates: [gate("accessibility", ["web"]), gate("security", ["backend"]), gate("unused")],
    });
    assert.deepEqual(
      res.items.map((i) => i.name),
      ["accessibility", "undefined-gate"],
    );
    const text = qualityLawChecklist(res).join("\n");
    assert.match(text, /\[not verified\] accessibility: purpose of accessibility/);
    assert.match(text, /\[not verified\] undefined-gate \(no definition available\)/);
    assert.doesNotMatch(text, /passed/i);
  });

  it("without a profile every applicable definition is listed; malformed ones are noted, not trusted", () => {
    const res = mapQualityLaw({ gates: [gate("b"), gate("a"), { name: "broken" }] });
    assert.deepEqual(
      res.items.map((i) => i.name),
      ["a", "b"],
    );
    assert.equal(res.notes.length, 1);
    assert.deepEqual(qualityLawChecklist({ items: [], notes: [] }), []);
  });

  it("is surfaced in the finalization output only when supplied", () => {
    const args = { state: "COMPLETE", pass: true, gateBlockers: [], rounds: 1, files: 1, reports: [], models: [] };
    const plain = buildCompletionReport(args);
    assert.equal(buildCompletionReport({ ...args, extraLines: [] }), plain);
    const withLaw = buildCompletionReport({
      ...args,
      extraLines: qualityLawChecklist(mapQualityLaw({ gates: [gate("a")] })),
    });
    assert.ok(withLaw.startsWith(plain));
    assert.match(withLaw, /Quality law \(Constitution; informational, not verified\)/);
  });
});

describe("standalone: nothing loads or touches disk without autospec config", () => {
  const SRC = new URL("../../src/", import.meta.url).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("no source file outside the feature imports it statically; the harness uses a dynamic import behind the policy key", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (f.includes("/integrations/autospec/")) continue;
      const text = readFileSync(f, "utf8");
      const rel = relative(SRC, f);
      if (/^\s*(import|export)\b[^;]*from\s+["'][^"']*integrations\/autospec\//m.test(text)) offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
    const harness = readFileSync(join(SRC, "lifecycle/harness.ts"), "utf8");
    assert.match(
      harness,
      /if \(policy\.autospec !== undefined\)[\s\S]*await import\("\.\.\/integrations\/autospec\/provider\.ts"\)/,
    );
  });

  it("the default policy has no autospec key, and the feature adds no environment variable", () => {
    assert.equal("autospec" in DEFAULT_POLICY, false);
    // Only the agent-dir lookup every Pi config loader shares (PI_CODING_AGENT_DIR, HOME) may read env.
    for (const f of walk(join(SRC, "integrations/autospec"))) {
      const text = readFileSync(f, "utf8");
      assert.doesNotMatch(text, /AUTOSPEC_|PI_AUTOSPEC/, f);
      const vars = [...text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
      assert.deepEqual(
        vars.filter((v) => v !== "PI_CODING_AGENT_DIR" && v !== "HOME"),
        [],
        f,
      );
    }
  });

  it("no autospec block in either YAML layer -> off, and evidence collection touches nothing", async () => {
    const agent = mkdtempSync(join(tmpdir(), "pi-ag-agent-"));
    const repo = mkdtempSync(join(tmpdir(), "pi-ag-repo-"));
    writeFileSync(join(agent, "engineering.yaml"), "plan_review:\n  enabled: false\n");
    mkdirSync(join(repo, ".pi"));
    writeFileSync(join(repo, ".pi/engineering.yaml"), "policies:\n  review:\n    require_independent_review: true\n");
    const cfg = await loadAutoSpecConfig(repo, { agentDir: agent });
    assert.deepEqual(cfg, { kind: "off" });
    // A repo that DOES hold a design report and an unreadable cwd: off still reads nothing.
    const out = await collectAutoSpecGateEvidence(cfg, {
      cwd: "/nonexistent/never/read",
      headCommit: "x",
      files: [{ path: "src/ui/a.tsx", scope: "base" }],
    });
    assert.deepEqual(out, { items: [], checklist: [] });
    // Missing config files altogether is also off.
    assert.deepEqual(await loadAutoSpecConfig(join(repo, "nope"), { agentDir: join(agent, "nope") }), { kind: "off" });
  });

  it("loadPolicy keeps `autospec` when configured and leaves it undefined otherwise (the harness keys off it)", async () => {
    const agent = mkdtempSync(join(tmpdir(), "pi-ag-agent-"));
    const repo = mkdtempSync(join(tmpdir(), "pi-ag-repo-"));
    const without = await loadPolicy({ cwd: repo, agentDir: agent, env: {} });
    assert.equal(without.policy.autospec, undefined);
    writeFileSync(join(agent, "engineering.yaml"), "autospec:\n  design_gate:\n    ui_paths: ['a/**']\n");
    const withBlock = await loadPolicy({ cwd: repo, agentDir: agent, env: {} });
    assert.notEqual(withBlock.policy.autospec, undefined);
    assert.equal(
      withBlock.issues.some((i) => i.severity === "error"),
      false,
    );
    // A repo layer alone also surfaces it, so a repo that only tightens still loads the provider.
    const agent2 = mkdtempSync(join(tmpdir(), "pi-ag-agent-"));
    mkdirSync(join(repo, ".pi"));
    writeFileSync(join(repo, ".pi/engineering.yaml"), "autospec:\n  design_gate:\n    require_for_ui: true\n");
    assert.notEqual((await loadPolicy({ cwd: repo, agentDir: agent2, env: {} })).policy.autospec, undefined);
  });

  it("an autospec block in the YAML is picked up (global) and tightened by the repo layer", async () => {
    const agent = mkdtempSync(join(tmpdir(), "pi-ag-agent-"));
    const repo = mkdtempSync(join(tmpdir(), "pi-ag-repo-"));
    writeFileSync(join(agent, "engineering.yaml"), "autospec:\n  design_gate:\n    ui_paths: ['src/ui/**']\n");
    mkdirSync(join(repo, ".pi"));
    writeFileSync(join(repo, ".pi/engineering.yaml"), "autospec:\n  design_gate:\n    require_for_ui: true\n");
    const c = on(await loadAutoSpecConfig(repo, { agentDir: agent }));
    assert.equal(c.designGate?.requireForUi, true);
    assert.deepEqual(c.designGate?.uiPaths, ["src/ui/**"]);
  });

  it("ui_paths matching follows the same glob rules as the design-gates script", () => {
    const f = (path: string, renamed?: string) => ({ path, scope: "base" as const, ...(renamed ? { renamed } : {}) });
    const hit = (p: string, globs: string[]) => uiFilesOf([f(p)], globs).length > 0;
    assert.equal(hit("src/ui/a/b.tsx", ["src/ui/**"]), true);
    assert.equal(hit("src/core/b.tsx", ["src/ui/**"]), false);
    assert.equal(hit("web/app.css", ["**/*.css"]), true);
    assert.equal(hit("a.css", ["**/*.css"]), true);
    assert.equal(hit("src/ui/x.ts", ["src/*.ts"]), false);
    assert.equal(uiFilesOf([f("docs/old.md", "src/ui/old.tsx")], ["src/ui/**"]).length, 1, "rename source counts");
  });
});
