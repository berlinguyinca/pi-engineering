import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { noTargetsTestRequirement } from "../../src/orchestration/testRequirement.ts";
import { type TournamentEntry, challengerMayDisplace, selectionCompare } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier, NO_TARGETS_WARNING } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A docs-only git repo: no package.json, Makefile, Cargo.toml or pytest config. */
async function docsRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-notargets-repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  await writeFile(join(root, "README.md"), "# docs\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const idleWorker: WorkerExecutor = {
  async run() {
    throw new Error("no worker expected");
  },
};

describe("a repository with no verification targets", () => {
  it("Verifier passes with a non-blocking warning", async () => {
    const { root, cleanup } = await docsRepo();
    try {
      const verifier = new CommandVerifier();
      const store = await ArtifactStore.create(join(root, ".artifacts"));
      const outcome = await verifier.run(root, await verifier.detect(root), store);
      assert.equal(outcome.passed, true);
      assert.equal(outcome.noTargets, true);
      assert.equal(outcome.stages.length, 0);
      assert.equal(outcome.failedStage, null);
      assert.deepEqual(outcome.warnings, [NO_TARGETS_WARNING]);
    } finally {
      await cleanup();
    }
  });

  it("a Makefile without a test target still counts as no targets and passes", async () => {
    const { root, cleanup } = await docsRepo();
    try {
      await writeFile(join(root, "Makefile"), "docs:\n\t@echo docs\n");
      const verifier = new CommandVerifier();
      const store = await ArtifactStore.create(join(root, ".artifacts"));
      const outcome = await verifier.run(root, await verifier.detect(root), store);
      assert.equal(outcome.passed, true);
      assert.equal(outcome.noTargets, true);
    } finally {
      await cleanup();
    }
  });

  it("integration and validation of a docs-only candidate succeed with the warning", async () => {
    const { root, cleanup } = await docsRepo();
    try {
      git(root, "checkout", "-q", "-b", "worker-docs");
      await writeFile(join(root, "GUIDE.md"), "more docs\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "docs");
      git(root, "checkout", "-q", "main");
      const backends = realBackends({
        worker: idleWorker,
        verifier: new CommandVerifier(),
        artifacts: await ArtifactStore.create(join(root, ".artifacts")),
        git: (await GitRepo.open(root))!,
        cwd: root,
      });
      const integration = await backends.integration.runIntegration({
        objective: "merge docs",
        signal: new AbortController().signal,
        handoffs: [{ worktree: { path: root, branch: "worker-docs" }, summary: "docs", artifacts: [] }],
      });
      assert.equal(integration.exitStatus, "succeeded", integration.summary);
      assert.match(integration.summary, /checks: pass/);
      assert.match(integration.summary, /no verification targets detected; nothing to run/);
      assert.equal(integration.error, undefined);
      assert.equal(integration.noTargets, true);
      assert.deepEqual(integration.warnings, [NO_TARGETS_WARNING]);

      const validation = await backends.validation.runValidation({
        objective: "validate",
        signal: new AbortController().signal,
      });
      assert.equal(validation.exitStatus, "succeeded", validation.summary);
      assert.match(validation.summary, /no verification targets detected; nothing to run/);
      assert.equal(validation.validationEvidence?.noTargets, true, "evidence stays honest: nothing was verified");
      assert.deepEqual(validation.validationEvidence?.testSummary.warnings, [NO_TARGETS_WARNING]);
      assert.deepEqual(validation.validationEvidence?.testSummary.stages, []);
    } finally {
      await cleanup();
    }
  });

  it("an acceptance criterion requiring tests still fails when no targets exist", async () => {
    const { root, cleanup } = await docsRepo();
    try {
      git(root, "checkout", "-q", "-b", "worker-docs");
      await writeFile(join(root, "GUIDE.md"), "more docs\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "docs");
      git(root, "checkout", "-q", "main");
      const backends = realBackends({
        worker: idleWorker,
        verifier: new CommandVerifier(),
        artifacts: await ArtifactStore.create(join(root, ".artifacts")),
        git: (await GitRepo.open(root))!,
        cwd: root,
      });
      const testRequirement = noTargetsTestRequirement([
        { acceptance_id: "AC-docs", criterion: "The guide documents the flag" },
        { acceptance_id: "AC-tests", criterion: "Add unit tests covering the parser" },
        { criterion: "Write regression tests for the loader" },
      ]);
      const integration = await backends.integration.runIntegration({
        objective: "merge",
        signal: new AbortController().signal,
        testRequirement,
        handoffs: [{ worktree: { path: root, branch: "worker-docs" }, summary: "docs", artifacts: [] }],
      });
      assert.equal(integration.exitStatus, "failed");
      assert.match(integration.error ?? "", /acceptance AC-tests.* requires tests/);
      assert.match(integration.error ?? "", /"Write regression tests for the loader"/, "ID-less criteria count");
      assert.doesNotMatch(integration.error ?? "", /AC-docs/);

      const validation = await backends.validation.runValidation({
        objective: "validate",
        signal: new AbortController().signal,
        testRequirement,
      });
      assert.equal(validation.exitStatus, "failed");
      assert.match(validation.error ?? "", /acceptance AC-tests.* requires tests/);
      assert.equal(validation.validationEvidence?.noTargets, true);
    } finally {
      await cleanup();
    }
  });
  it("targets present and a failing check still fails integration and validation", async () => {
    const { root, cleanup } = await docsRepo();
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "x", private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "passing suite");
      git(root, "checkout", "-q", "-b", "worker-change");
      // The worker breaks the suite: a failure the base did not have still fails.
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "x", private: true, scripts: { test: 'node -e "process.exit(1)"' } }),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "notes");
      git(root, "checkout", "-q", "main");
      const backends = realBackends({
        worker: idleWorker,
        verifier: new CommandVerifier(),
        artifacts: await ArtifactStore.create(join(root, ".artifacts")),
        git: (await GitRepo.open(root))!,
        cwd: root,
      });
      const integration = await backends.integration.runIntegration({
        objective: "merge",
        signal: new AbortController().signal,
        handoffs: [{ worktree: { path: root, branch: "worker-change" }, summary: "n", artifacts: [] }],
      });
      assert.equal(integration.exitStatus, "failed");
      assert.match(integration.error ?? "", /verification failed at stage/);
      assert.equal(integration.noTargets, false);
      git(root, "checkout", "-q", "worker-change");
      const validation = await backends.validation.runValidation({
        objective: "validate",
        signal: new AbortController().signal,
      });
      assert.equal(validation.exitStatus, "failed");
      assert.equal(validation.validationEvidence?.noTargets, false);
      assert.notEqual(validation.validationEvidence?.exitCode, 0);
    } finally {
      await cleanup();
    }
  });
});

describe("test-requirement detection", () => {
  const requires = (criterion: string) => noTargetsTestRequirement([{ acceptance_id: "AC", criterion }]) !== undefined;
  for (const criterion of [
    "All new and existing tests pass",
    "Existing unit tests still pass",
    "Regression tests pass",
    "integration tests pass",
    "The guide documents the flag",
  ]) {
    it(`does not require tests: ${criterion}`, () => assert.equal(requires(criterion), false));
  }
  for (const criterion of [
    "Add unit tests for X",
    "write regression tests",
    "Create targeted tests for the loader",
    "Add tests that still pass on CI",
    "Tests are added for X",
    "New tests cover X",
  ]) {
    it(`requires tests: ${criterion}`, () => assert.equal(requires(criterion), true));
  }
});

describe("tournament selection with zero-evidence candidates", () => {
  const entry = (id: string, noTargets: boolean, files: number): TournamentEntry =>
    ({
      candidate: { id, changed_files: new Array(files).fill("f") },
      outcome: { passed: true, noTargets, stages: [], evidence: [], failedStage: null },
      findings: [],
      reviewCompleted: true,
      winner: false,
    }) as unknown as TournamentEntry;
  for (const strategy of ["stable", "changes", "findings"] as const) {
    it(`${strategy}: a candidate with real checks outranks a no-targets one`, () => {
      const zero = entry("A-first-and-smallest", true, 0);
      const real = entry("Z-last-and-largest", false, 9);
      const sorted = [zero, real].sort((a, b) => selectionCompare(a, b, strategy));
      assert.equal(sorted[0], real);
    });
  }

  it("a real-check lead is never displaced by a no-targets runner-up", () => {
    assert.equal(challengerMayDisplace(entry("A", false, 1), entry("B", true, 1)), false);
    assert.equal(challengerMayDisplace(entry("A", true, 1), entry("B", false, 1)), false);
    assert.equal(challengerMayDisplace(entry("A", false, 1), entry("B", false, 1)), true);
    assert.equal(challengerMayDisplace(entry("A", true, 1), entry("B", true, 1)), true);
  });
});
