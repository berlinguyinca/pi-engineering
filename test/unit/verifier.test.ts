import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandVerifier, tokenizeCommand } from "../../src/verify/Verifier.ts";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-"));
  for (const [p, content] of Object.entries(files)) {
    await writeFile(join(dir, p), content);
  }
  return dir;
}

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
    "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
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
