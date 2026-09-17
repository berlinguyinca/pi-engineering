import assert from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { kindFromName, planChecks } from "../../src/lifecycle/verification.ts";

async function tempRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-verify-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

test("kindFromName maps script names to check kinds", () => {
  assert.equal(kindFromName("test"), "test");
  assert.equal(kindFromName("typecheck"), "typecheck");
  assert.equal(kindFromName("lint:fix"), "lint");
  assert.equal(kindFromName("build"), "build");
  assert.equal(kindFromName("anything-else"), "custom");
});

test("planChecks reads package scripts, CI workflows, AGENTS.md and Makefile", async () => {
  const root = await tempRepo({
    "package.json": JSON.stringify({
      name: "x",
      scripts: { test: "node --test", typecheck: "tsc --noEmit", "lint:fix": "biome check" },
    }),
    ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n      - run: npm run build\n",
    "AGENTS.md": "## Verification\n- npm test\n- npm run build\n",
    Makefile: "test:\n\tnpm test\nlint:\n\tnpm run lint\n",
  });
  try {
    const specs = await planChecks({ cwd: root, policy: DEFAULT_POLICY, categories: ["feature"] });
    const names = specs.map((s) => `${s.kind}:${s.name}`).sort();
    assert.ok(names.includes("test:test"), "package test script discovered");
    assert.ok(names.includes("typecheck:typecheck"), "package typecheck script discovered");
    assert.ok(
      names.some((n) => n.startsWith("lint:")),
      "lint discovered from package or Makefile",
    );
    assert.ok(
      specs.some((s) => s.origin.includes("ci.yml")),
      "CI workflow commands discovered",
    );
    assert.ok(
      specs.some((s) => s.origin === "AGENTS.md"),
      "AGENTS.md commands discovered",
    );
    assert.ok(
      specs.some((s) => s.origin === "Makefile"),
      "Makefile targets discovered",
    );
    // No dangerous commands.
    assert.ok(specs.every((s) => !s.command || !/rm -rf|:\(\)/.test(s.command)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a required kind with no declared command is recorded not_applicable, never silently passed", async () => {
  const root = await tempRepo({ "package.json": JSON.stringify({ name: "x", scripts: {} }) });
  try {
    const specs = await planChecks({ cwd: root, policy: DEFAULT_POLICY, categories: ["feature"] });
    const testCheck = specs.find((s) => s.kind === "test");
    assert.ok(testCheck);
    assert.equal(testCheck.required, true);
    assert.equal(testCheck.command, undefined);
    assert.ok(/no test command declared/.test(testCheck.reason ?? ""));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
