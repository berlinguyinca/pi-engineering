import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AuditScope, defineScope, filterDiscovery, isInScope, sourceRevision } from "../../src/bar/index.ts";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bar-scope-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Build a minimal repo fixture with an in-scope surface and an excluded dep dir. */
async function seedRepo(root: string): Promise<void> {
  await mkdir(join(root, "src/cav"), { recursive: true });
  await mkdir(join(root, "src/ledger"), { recursive: true });
  await mkdir(join(root, "docs/specs/bar/steps"), { recursive: true });
  await mkdir(join(root, "node_modules/dep"), { recursive: true });
  await writeFile(join(root, "src/cav/gate.ts"), "export const gate = 1;\n");
  await writeFile(join(root, "src/cav/gate.test.ts"), "import { test } from 'node:test';\n");
  await writeFile(join(root, "src/ledger/store.ts"), "export const store = 1;\n");
  await writeFile(join(root, "node_modules/dep/index.js"), "export default 1;\n");
  await writeFile(join(root, "docs/specs/bar/MASTER.md"), "# Master\n");
  await writeFile(join(root, "docs/specs/bar/ROADMAP.md"), "# Roadmap\n");
  await writeFile(join(root, "docs/specs/bar/steps/000-bootstrap-dogfood-define-scope-and-inputs.md"), "# BAR-000\n");
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
}

test("BAR-000 defineScope defines machine-readable in-scope surfaces with inputs and provenance", async () => {
  await withTmp(async (root) => {
    await seedRepo(root);
    const scope = defineScope(root, {
      includeDirs: ["src/cav", "src/ledger", "docs/specs"],
      includeFiles: ["package.json"],
    });

    assert.ok(scope.scopeId.startsWith("BARSCOPE-"));
    assert.equal(scope.immutable, true);
    assert.deepEqual(scope.surfaces, ["src/cav", "src/ledger", "docs/specs"]);

    // In-scope source retained.
    assert.ok(scope.inputs.sourceFiles.includes("src/cav/gate.ts"));
    assert.ok(scope.inputs.sourceFiles.includes("src/ledger/store.ts"));
    // In-scope test retained.
    assert.ok(scope.inputs.testFiles.includes("src/cav/gate.test.ts"));
    // In-scope specs retained.
    assert.ok(scope.inputs.specs.some((s) => s.startsWith("docs/specs/")));
    // Root-level include file retained as an input.
    assert.ok(scope.inputs.configFiles.includes("package.json"));
    // node_modules is always excluded.
    assert.ok(!scope.inputs.sourceFiles.some((f) => f.startsWith("node_modules/")));
    // Environment fingerprint + provenance are recorded.
    assert.match(scope.environment.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(scope.provenance.length, 3);
    assert.ok(scope.provenance.every((p) => p.hash !== "MISSING"));
  });
});

test("BAR-000 sourceRevision resolves HEAD in a git repo and null outside one", async () => {
  await withTmp(async (root) => {
    await writeFile(join(root, "a.ts"), "export = 1;\n");
    assert.equal(sourceRevision(root), null, "non-git dir has no revision");

    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.name", "t"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "add", "a.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    const rev = sourceRevision(root);
    assert.ok(rev !== null && /^[0-9a-f]{40}$/.test(rev), `expected 40-hex revision, got ${rev}`);
  });
});

test("filterDiscovery keeps in-scope entries and drops out-of-scope ones", async () => {
  const discovery = {
    root: "/r",
    sourceRevision: null,
    specs: ["docs/specs/a.md", "vendor/specs/b.md"],
    sourceFiles: ["src/cav/gate.ts", "other/lib.ts"],
    testFiles: ["src/cav/gate.test.ts", "other/lib.test.ts"],
    configFiles: ["package.json", "vendor/config.json"],
    historicalClaims: ["docs/status.md"],
    entrypoints: ["src/cav/index.ts", "other/cli.ts"],
  };
  const filtered = filterDiscovery(discovery, ["src/cav", "docs/specs"], ["package.json"]);
  assert.deepEqual(filtered.sourceFiles, ["src/cav/gate.ts"]);
  assert.deepEqual(filtered.testFiles, ["src/cav/gate.test.ts"]);
  assert.deepEqual(filtered.specs, ["docs/specs/a.md"]);
  assert.deepEqual(filtered.configFiles, ["package.json"]);
  assert.deepEqual(filtered.entrypoints, ["src/cav/index.ts"]);
});

test("isInScope is exact about surfaces and include files", () => {
  assert.equal(isInScope("src/cav/gate.ts", ["src/cav"], []), true);
  assert.equal(isInScope("src/cav", ["src/cav"], []), true);
  // A sibling directory must NOT leak into scope.
  assert.equal(isInScope("src/cavalry/gate.ts", ["src/cav"], []), false);
  assert.equal(isInScope("other/x.ts", ["src/cav"], []), false);
  assert.equal(isInScope("package.json", [], ["package.json"]), true);
});

test("negative: defineScope rejects an empty include set (nothing to audit)", async () => {
  await withTmp(async (root) => {
    await seedRepo(root);
    assert.throws(() => defineScope(root, { includeDirs: [] }), /includeDirs must contain at least one/);
  });
});

test("negative: defineScope rejects a non-existent include dir (scope must be derived from reality)", async () => {
  await withTmp(async (root) => {
    await seedRepo(root);
    assert.throws(() => defineScope(root, { includeDirs: ["src/cav", "src/does-not-exist"] }), /does not exist/);
  });
});
