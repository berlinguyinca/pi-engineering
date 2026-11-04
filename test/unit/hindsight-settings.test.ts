import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hindsightBlackholeOption } from "../../src/blackhole/hindsight.ts";
import { DEFAULT_HINDSIGHT_SETTINGS, validateHindsightSettings } from "../../src/blackhole/hindsightSettings.ts";
import { DEFAULT_POLICY, loadHindsightSettings, validatePolicy } from "../../src/lifecycle/policy.ts";

function layout(global?: string, repo?: string) {
  const root = mkdtempSync(join(tmpdir(), "hs-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "repo");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (global !== undefined) writeFileSync(join(agentDir, "engineering.yaml"), global);
  if (repo !== undefined) writeFileSync(join(cwd, ".pi", "engineering.yaml"), repo);
  return { root, agentDir, cwd, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("defaults: memory is on with documented defaults", () => {
  const l = layout();
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.deepEqual(settings, DEFAULT_HINDSIGHT_SETTINGS);
    assert.equal(settings.enabled, true);
    assert.equal(settings.cli, "herdr-memory");
    assert.deepEqual(settings.scopes, ["project"]);
    assert.equal(settings.timeout_ms, 5000);
    assert.equal(settings.harness, "pi");
    assert.deepEqual(issues, []);
    assert.equal(hindsightBlackholeOption(l.cwd, l.agentDir)?.config.enabled, true);
  } finally {
    l.done();
  }
});

test("explicit enabled: false in YAML turns memory off (global or repository)", () => {
  const g = layout("memory:\n  hindsight:\n    enabled: false\n");
  const r = layout(undefined, "memory:\n  hindsight:\n    enabled: false\n");
  try {
    for (const l of [g, r]) {
      const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
      assert.equal(settings.enabled, false);
      assert.deepEqual(issues, []);
      assert.equal(hindsightBlackholeOption(l.cwd, l.agentDir), undefined);
    }
  } finally {
    g.done();
    r.done();
  }
});

test("an invalid value fails closed: memory is off even though it is on by default", () => {
  const l = layout("memory:\n  hindsight:\n    timeout_ms: 1\n");
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.equal(settings.enabled, false);
    assert.ok(issues.some((i) => i.path === "memory.hindsight.timeout_ms" && i.severity === "error"));
    assert.equal(hindsightBlackholeOption(l.cwd, l.agentDir), undefined);
  } finally {
    l.done();
  }
});

test("global YAML enables memory and sets every key", () => {
  const l = layout(
    "memory:\n  hindsight:\n    enabled: true\n    cli: /opt/bin/herdr-memory\n    scopes: [global, 'mission:abc']\n    timeout_ms: 1500\n    harness: pi-lab\n    failure_backoff_ms: 2000\n    unavailable_backoff_ms: 9000\n",
  );
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.deepEqual(issues, []);
    assert.deepEqual(settings, {
      enabled: true,
      cli: "/opt/bin/herdr-memory",
      scopes: ["global", "mission:abc"],
      timeout_ms: 1500,
      harness: "pi-lab",
      failure_backoff_ms: 2000,
      unavailable_backoff_ms: 9000,
    });
    const opt = hindsightBlackholeOption(l.cwd, l.agentDir);
    assert.equal(opt?.config.durable?.kind, "hindsight");
    assert.equal(opt?.config.providerTimeoutMs, 1500);
  } finally {
    l.done();
  }
});

test("repo YAML can never choose the executable", () => {
  const l = layout(
    "memory:\n  hindsight:\n    enabled: true\n    cli: /opt/bin/herdr-memory\n",
    "memory:\n  hindsight:\n    cli: ./evil.sh\n",
  );
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.equal(settings.cli, "/opt/bin/herdr-memory");
    assert.ok(issues.some((i) => i.path === "memory.hindsight.cli" && i.severity === "warning"));
  } finally {
    l.done();
  }
});

test("repo enabled: true never overrides a global enabled: false", () => {
  const l = layout(
    "memory:\n  hindsight:\n    enabled: false\n",
    "memory:\n  hindsight:\n    enabled: true\n    harness: codex\n    scopes: [global, infra]\n",
  );
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.equal(settings.enabled, false);
    assert.equal(settings.harness, "pi");
    assert.deepEqual(settings.scopes, ["project"]);
    assert.deepEqual(
      issues.filter((i) => i.severity === "error"),
      [],
    );
    assert.equal(hindsightBlackholeOption(l.cwd, l.agentDir), undefined);
  } finally {
    l.done();
  }
});

test("repo harness is ignored with a warning", () => {
  const l = layout(undefined, "memory:\n  hindsight:\n    harness: codex\n");
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.equal(settings.harness, "pi");
    assert.ok(issues.some((i) => i.path === "memory.hindsight.harness" && i.severity === "warning"));
  } finally {
    l.done();
  }
});

test("repo scopes may narrow the global scopes but never widen them", () => {
  const g = "memory:\n  hindsight:\n    scopes: [project, global]\n";
  const narrow = layout(g, "memory:\n  hindsight:\n    scopes: [global]\n");
  const widen = layout(g, "memory:\n  hindsight:\n    scopes: [project, infra]\n");
  const widenDefault = layout(undefined, "memory:\n  hindsight:\n    scopes: [project, global]\n");
  try {
    assert.deepEqual(loadHindsightSettings(narrow.cwd, narrow.agentDir).settings.scopes, ["global"]);
    const w = loadHindsightSettings(widen.cwd, widen.agentDir);
    assert.deepEqual(w.settings.scopes, ["project", "global"]);
    assert.ok(w.issues.some((i) => i.path === "memory.hindsight.scopes" && i.severity === "warning"));
    assert.deepEqual(loadHindsightSettings(widenDefault.cwd, widenDefault.agentDir).settings.scopes, ["project"]);
  } finally {
    narrow.done();
    widen.done();
    widenDefault.done();
  }
});

test("repo timeouts and backoffs are ignored with a warning; repo opt-out is honoured", () => {
  const l = layout(
    "memory:\n  hindsight:\n    timeout_ms: 1500\n",
    "memory:\n  hindsight:\n    enabled: false\n    timeout_ms: 60000\n    failure_backoff_ms: 1000\n",
  );
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.equal(settings.enabled, false);
    assert.equal(settings.timeout_ms, 1500);
    assert.equal(settings.failure_backoff_ms, 60_000);
    assert.ok(issues.some((i) => i.path === "memory.hindsight.timeout_ms" && i.severity === "warning"));
  } finally {
    l.done();
  }
});

test("a non-mapping or invalid repo layer still fails closed", () => {
  const nonMapping = layout(undefined, "memory:\n  hindsight: [1, 2]\n");
  const invalid = layout(undefined, "memory:\n  hindsight:\n    scopes: [bogus]\n");
  const unreadable = layout(undefined, "memory:\n  hindsight:\n    enabled: false\n");
  try {
    for (const l of [nonMapping, invalid]) {
      const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
      assert.equal(settings.enabled, false);
      assert.ok(issues.some((i) => i.severity === "error"));
    }
    // A repo config path that is a directory is unreadable, not absent.
    rmSync(join(unreadable.cwd, ".pi", "engineering.yaml"));
    mkdirSync(join(unreadable.cwd, ".pi", "engineering.yaml"));
    const u = loadHindsightSettings(unreadable.cwd, unreadable.agentDir);
    assert.equal(u.settings.enabled, false);
    assert.ok(u.issues.some((i) => i.severity === "error"));
  } finally {
    nonMapping.done();
    invalid.done();
    unreadable.done();
  }
});

test("invalid values fail closed (memory off) with actionable errors", () => {
  const l = layout(
    "memory:\n  hindsight:\n    enabled: true\n    timeout_ms: 5\n    scopes: [bogus]\n    harness: 'Bad Harness'\n",
  );
  try {
    const { settings, issues } = loadHindsightSettings(l.cwd, l.agentDir);
    assert.equal(settings.enabled, false);
    const paths = issues.filter((i) => i.severity === "error").map((i) => i.path);
    assert.ok(paths.includes("memory.hindsight.timeout_ms"));
    assert.ok(paths.includes("memory.hindsight.scopes"));
    assert.ok(paths.includes("memory.hindsight.harness"));
  } finally {
    l.done();
  }
});

test("validator: types, ranges and unknown keys", () => {
  const bad = validateHindsightSettings({
    ...DEFAULT_HINDSIGHT_SETTINGS,
    enabled: "yes",
    cli: "",
    timeout_ms: 70_000,
    failure_backoff_ms: 1,
    unavailable_backoff_ms: 99_999_999,
    extra: 1,
  });
  const by = new Map(bad.map((i) => [i.path, i.severity]));
  assert.equal(by.get("memory.hindsight.enabled"), "error");
  assert.equal(by.get("memory.hindsight.cli"), "error");
  assert.equal(by.get("memory.hindsight.timeout_ms"), "error");
  assert.equal(by.get("memory.hindsight.failure_backoff_ms"), "error");
  assert.equal(by.get("memory.hindsight.unavailable_backoff_ms"), "error");
  assert.equal(by.get("memory.hindsight.extra"), "warning");
  assert.deepEqual(validateHindsightSettings(DEFAULT_HINDSIGHT_SETTINGS), []);
});

test("the engineering policy carries and validates memory.hindsight", () => {
  assert.deepEqual(DEFAULT_POLICY.memory.hindsight, DEFAULT_HINDSIGHT_SETTINGS);
  const policy = structuredClone(DEFAULT_POLICY);
  policy.memory.hindsight.timeout_ms = 1;
  assert.ok(validatePolicy(policy).some((i) => i.path === "memory.hindsight.timeout_ms"));
});
