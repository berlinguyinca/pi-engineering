import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { CommandVerifier, tokenizeCommand } from "../../src/verify/Verifier.ts";

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-"));
  for (const [p, content] of Object.entries(files)) {
    await writeFile(join(dir, p), content);
  }
  return dir;
}

test("detect full includes lint + test:full stages (milestone)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({
      scripts: { test: "node --test", lint: "eslint .", "test:full": "node --test --test-reporter=spec" },
    }),
  });
  try {
    const v = new CommandVerifier();
    const normal = await v.detect(dir);
    const full = await v.detect(dir, { full: true });
    assert.ok(!normal.stages.some((s) => s.name === "lint"), "normal profile must not include lint");
    assert.ok(
      full.stages.some((s) => s.name === "lint"),
      "full profile must include lint",
    );
    assert.ok(
      full.stages.some((s) => s.name === "test:full"),
      "full profile must include test:full",
    );
    // Regression (fresh-review): the full-only lint and test:full stages must be
    // REQUIRED so /verify full cannot report PASSED while they are red.
    const lint = full.stages.find((s) => s.name === "lint");
    const testFull = full.stages.find((s) => s.name === "test:full");
    assert.equal(lint?.required, true, "lint must be required in the full profile");
    assert.equal(testFull?.required, true, "test:full must be required in the full profile");
    assert.equal(full.name, "detected-full");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detect caches per-repo and invalidates when package.json changes (milestone)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  try {
    const v = new CommandVerifier();
    const p1 = await v.detect(dir);
    assert.deepEqual(
      p1.stages.map((s) => s.name),
      ["test"],
    );
    // Same content: served from cache (same object identity proves no re-read).
    assert.equal(await v.detect(dir), p1, "unchanged package.json must return the cached profile");
    // Content changed: cache invalidated, profile re-derived.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "node --check index.js" } }),
    );
    const p2 = await v.detect(dir);
    assert.notEqual(p2, p1, "changed package.json must produce a fresh profile");
    assert.ok(p2.stages.some((s) => s.name === "build"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detect reads test/build scripts from package.json", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node --test", build: "node --check index.js" } }),
  });
  try {
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const names = profile.stages.map((s) => s.name);
    assert.ok(names.includes("test"));
    assert.ok(names.includes("build"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier records passing evidence lazily (AC-010)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "..", "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    assert.ok(outcome.passed);
    assert.equal(outcome.evidence.length, 1);
    assert.equal(outcome.evidence[0]?.trust, "deterministic");
    assert.equal(outcome.evidence[0]?.status, "passed");
    assert.match(outcome.evidence[0]?.artifacts[0] ?? "", /^artifact:\/\/verify\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tokenizeCommand preserves quoted and escaped args", () => {
  assert.deepEqual(tokenizeCommand('node --test "test/a.test.js" "test/**/*.test.js"'), {
    command: "node",
    args: ["--test", "test/a.test.js", "test/**/*.test.js"],
  });
  assert.deepEqual(tokenizeCommand("node -e 'process.exit(1)'"), {
    command: "node",
    args: ["-e", "process.exit(1)"],
  });
  assert.deepEqual(tokenizeCommand('npm run --prefix "a b" test'), {
    command: "npm",
    args: ["run", "--prefix", "a b", "test"],
  });
});

test("verifier runs quoted test args instead of silently passing (regression)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: 'node --test "fail.test.js"' } }),
    "fail.test.js": 'import { test } from "node:test";\ntest("boom", () => { throw new Error("x"); });\n',
  });
  try {
    const store = await ArtifactStore.create(join(dir, "..", "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    // A naive whitespace split would run 0 tests and exit 0 (false pass).
    assert.ok(!outcome.passed, "quoted failing test must fail verification");
    assert.equal(outcome.failedStage, "test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier never reports pass with zero passing stages (review HIGH #1)", async () => {
  // Repo with no typecheck/test/build scripts -> detect falls back to a
  // NON-required 'node --check index.js' stage, and index.js does not exist, so
  // the only stage fails. This must NOT be reported as a clean pass.
  const dir = await makeProject({
    "package.json": JSON.stringify({}),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "..", "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    assert.equal(profile.stages[0]?.required, false, "fallback stage is non-required by design");
    const outcome = await v.run(dir, profile, store);
    assert.ok(!outcome.passed, "a run with zero passing stages must not pass");
    assert.equal(outcome.evidence.filter((e) => e.status === "passed").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier resolves bare local binaries from node_modules/.bin (regression: ENOENT gates)", async () => {
  // Reproduces the orchestrator bug where execFile('tsc', ...) failed with
  // ENOENT because node_modules/.bin was not on the ambient PATH when the
  // runtime is launched directly with `node` rather than via `npm`. Every
  // integration/validation gate then spuriously FAILED on empty output even
  // when the underlying tool worked. The verifier must prepend the repo's
  // local node_modules/.bin so bare binary names resolve.
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "bar-hello" } }),
  });
  const binDir = join(dir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "bar-hello");
  await writeFile(binPath, "#!/bin/sh\necho hello-from-local-bin\n");
  await chmod(binPath, 0o755);
  try {
    const store = await ArtifactStore.create(join(dir, "..", "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const stage = profile.stages.find((s) => s.name === "test");
    assert.equal(stage?.command, "bar-hello", "bare binary name must be parsed from the script");
    const outcome = await v.run(dir, profile, store);
    assert.ok(outcome.passed, "bare local binary must resolve via node_modules/.bin");
    assert.equal(outcome.failedStage, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier fails a candidate whose required test fails (AC-005)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "..", "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    assert.ok(!outcome.passed);
    assert.equal(outcome.failedStage, "test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
