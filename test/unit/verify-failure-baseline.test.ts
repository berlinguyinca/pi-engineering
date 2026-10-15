import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { CommandVerifier, type VerifyOutcome } from "../../src/verify/Verifier.ts";
import {
  captureBaseline,
  compareToBaseline,
  failureIds,
  hashProfile,
  parseFailingTests,
} from "../../src/verify/failureBaseline.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
  return stdout.trim();
}

const PASSING = `import test from "node:test";\ntest("stays green", () => {});\n`;
const failing = (name: string) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\ntest(${JSON.stringify(name)}, () => assert.equal(1, 2));\n`;

interface Fixture {
  root: string;
  store: ArtifactStore;
  verifier: CommandVerifier;
  write(path: string, content: string): Promise<void>;
  commit(message: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function fixture(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-baseline-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-eng-baseline-art-"));
  await git(root, "init", "-q");
  const write = async (path: string, content: string) => {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  };
  await write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  for (const [path, content] of Object.entries(files)) await write(path, content);
  const commit = async (message: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", message);
    return git(root, "rev-parse", "HEAD");
  };
  await commit("base");
  return {
    root,
    store: await ArtifactStore.create(artifacts),
    verifier: new CommandVerifier(),
    write,
    commit,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(artifacts, { recursive: true, force: true });
    },
  };
}

describe("failure baseline bound to the base SHA", () => {
  it("marks a failure present at the base SHA as preExisting and not blocking", async () => {
    const f = await fixture({ "test/a.test.js": PASSING, "test/old.test.js": failing("old defect") });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store);
      assert.equal(baseline.baseSha, baseSha);
      assert.ok(
        baseline.failures.some((id) => id.includes("old defect")),
        `baseline names the failing test: ${baseline.failures.join(" | ")}`,
      );

      await f.write("src/change.js", "export const x = 1;\n");
      await f.commit("unrelated change");
      const outcome = await f.verifier.run(f.root, profile, f.store);
      assert.equal(outcome.passed, false, "the raw outcome stays honest: the suite is red");
      const verdict = compareToBaseline(baseline, outcome, baseSha);
      assert.equal(verdict.stale, false);
      assert.deepEqual(verdict.introduced, []);
      assert.ok(verdict.preExisting.some((id) => id.includes("old defect")));
      assert.equal(verdict.blocking, false);
    } finally {
      await f.cleanup();
    }
  });

  it("marks a new failing test as introduced and blocking", async () => {
    const f = await fixture({ "test/a.test.js": PASSING, "test/old.test.js": failing("old defect") });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store);

      await f.write("test/new.test.js", failing("brand new regression"));
      await f.commit("introduce a regression");
      const outcome = await f.verifier.run(f.root, profile, f.store);
      const verdict = compareToBaseline(baseline, outcome, baseSha);
      assert.ok(verdict.introduced.some((id) => id.includes("brand new regression")));
      assert.ok(verdict.preExisting.some((id) => id.includes("old defect")));
      assert.equal(verdict.blocking, true);
    } finally {
      await f.cleanup();
    }
  });

  it("yields stale and blocks when the baseline base SHA differs from the bound base", async () => {
    const f = await fixture({ "test/a.test.js": PASSING, "test/old.test.js": failing("old defect") });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store);
      const outcome = await f.verifier.run(f.root, profile, f.store);

      const movedBase = "0".repeat(40);
      const verdict = compareToBaseline(baseline, outcome, movedBase);
      assert.equal(verdict.stale, true);
      assert.equal(verdict.blocking, true);
      assert.deepEqual(verdict.preExisting, [], "a stale baseline forgives nothing");
      assert.match(verdict.reason, /stale/i);
    } finally {
      await f.cleanup();
    }
  });

  it("reports fixed failures without crediting them as blocking", async () => {
    const f = await fixture({ "test/a.test.js": PASSING, "test/old.test.js": failing("old defect") });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store);

      await f.write("test/old.test.js", PASSING.replace("stays green", "old defect"));
      await f.commit("fix the old defect");
      const outcome = await f.verifier.run(f.root, profile, f.store);
      assert.equal(outcome.passed, true);
      const verdict = compareToBaseline(baseline, outcome, baseSha);
      assert.ok(verdict.fixed.some((id) => id.includes("old defect")));
      assert.equal(verdict.blocking, false);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses to capture a baseline from a checkout that is not the base SHA, or is dirty", async () => {
    const f = await fixture({ "test/a.test.js": PASSING });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      await f.write("src/more.js", "export const y = 2;\n");
      await f.commit("move HEAD past the base");
      await assert.rejects(() => captureBaseline(f.root, baseSha, f.verifier, profile, f.store), /not at base/i);

      const head = await git(f.root, "rev-parse", "HEAD");
      await f.write("src/dirty.js", "export const z = 3;\n");
      await assert.rejects(() => captureBaseline(f.root, head, f.verifier, profile, f.store), /uncommitted/i);
    } finally {
      await f.cleanup();
    }
  });

  it("does not forgive a flaky baseline failure: it is introduced if it fails again", async () => {
    const counter = await mkdtemp(join(tmpdir(), "pi-eng-baseline-flaky-"));
    const flaky = `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
const marker = process.env.BASELINE_FLAKY_MARKER;
test("flaky once", () => {
  if (!existsSync(marker)) { writeFileSync(marker, "ran"); assert.fail("first run only"); }
});
`;
    const f = await fixture({ "test/a.test.js": PASSING, "test/flaky.test.js": flaky });
    const previous = process.env.BASELINE_FLAKY_MARKER;
    process.env.BASELINE_FLAKY_MARKER = join(counter, "marker");
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store, { runs: 2 });
      assert.ok(
        !baseline.failures.some((id) => id.includes("flaky once")),
        "a failure that did not repeat is not a pre-existing failure",
      );
      assert.ok(baseline.flaky.some((id) => id.includes("flaky once")));

      // The flake fires again after the change: it must not hide behind the baseline.
      await rm(join(counter, "marker"), { force: true });
      await f.write("src/change.js", "export const x = 1;\n");
      await f.commit("unrelated change");
      const outcome = await f.verifier.run(f.root, profile, f.store);
      const verdict = compareToBaseline(baseline, outcome, baseSha);
      assert.ok(verdict.introduced.some((id) => id.includes("flaky once")));
      assert.equal(verdict.blocking, true);
    } finally {
      if (previous === undefined) delete process.env.BASELINE_FLAKY_MARKER;
      else process.env.BASELINE_FLAKY_MARKER = previous;
      await rm(counter, { recursive: true, force: true });
      await f.cleanup();
    }
  });

  it("attaches baselineVerdict when CommandVerifier.run receives a baseline", async () => {
    const f = await fixture({ "test/a.test.js": PASSING, "test/old.test.js": failing("old defect") });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store);
      const withBaseline = await f.verifier.run(f.root, profile, f.store, { baseline, boundBaseSha: baseSha });
      assert.equal(withBaseline.baselineVerdict?.blocking, false);
      assert.ok(withBaseline.baselineVerdict?.preExisting.some((id) => id.includes("old defect")));

      const unbound = await f.verifier.run(f.root, profile, f.store, { baseline });
      assert.equal(unbound.baselineVerdict?.stale, true, "no bound base SHA means the baseline cannot be trusted");

      const plain = await f.verifier.run(f.root, profile, f.store);
      assert.equal(plain.baselineVerdict, undefined);
    } finally {
      await f.cleanup();
    }
  });

  it("treats a baseline captured for a different profile as stale", async () => {
    const f = await fixture({ "test/a.test.js": PASSING });
    try {
      const baseSha = await git(f.root, "rev-parse", "HEAD");
      const profile = await f.verifier.detect(f.root);
      const baseline = await captureBaseline(f.root, baseSha, f.verifier, profile, f.store);
      const widened = { ...profile, stages: [...profile.stages, { ...profile.stages[0]!, name: "extra" }] };
      const outcome = await f.verifier.run(f.root, widened, f.store);
      assert.notEqual(hashProfile(widened), baseline.profileHash);
      assert.equal(compareToBaseline(baseline, outcome, baseSha).stale, true);
    } finally {
      await f.cleanup();
    }
  });
});

describe("failureIds / parseFailingTests", () => {
  const stage = { name: "test", command: "node", args: ["--test"], required: true };
  const outcomeOf = (stages: Array<{ name: string; passed: boolean; failingTests?: string[] }>): VerifyOutcome => ({
    passed: stages.every((s) => s.passed),
    stages: stages.map((s) => ({
      stage: { ...stage, name: s.name },
      exitCode: s.passed ? 0 : 1,
      passed: s.passed,
      summary: {},
      artifactUri: "x",
      ...(s.failingTests ? { failingTests: s.failingTests } : {}),
    })),
    evidence: [],
    failedStage: stages.find((s) => !s.passed)?.name ?? null,
    noTargets: false,
  });

  it("names a failing stage by its parsed tests, else by the stage", () => {
    const ids = failureIds(
      outcomeOf([
        { name: "typecheck", passed: false },
        { name: "test", passed: false, failingTests: ["a > b", "c"] },
        { name: "build", passed: true },
      ]),
    );
    assert.deepEqual(ids, ["stage:typecheck", "test:test » a > b", "test:test » c"]);
  });

  it("parses TAP and spec reporter failures, skips SKIP/TODO, and strips the checkout path", () => {
    const tap = [
      "TAP version 13",
      "    not ok 1 - leaf fails",
      "not ok 1 - suite fails",
      "not ok 2 - skipped # SKIP no browser",
      "not ok 3 - todo # TODO later",
      "not ok 4 - /work/repo/test/crash.test.js",
      "ok 5 - fine",
    ].join("\n");
    assert.deepEqual(parseFailingTests(tap, "/work/repo"), ["leaf fails", "suite fails", "test/crash.test.js"]);
    const spec = ["  ✔ fine (0.4ms)", "  ✖ spec leaf (1.2ms)", "✖ failing tests:", "✖ spec leaf (1.2ms)"].join("\n");
    assert.deepEqual(parseFailingTests(spec, "/work/repo"), ["spec leaf"]);
  });
});
