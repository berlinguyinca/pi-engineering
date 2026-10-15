import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
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

      const validation = await backends.validation.runValidation({
        objective: "validate",
        signal: new AbortController().signal,
      });
      assert.equal(validation.exitStatus, "succeeded", validation.summary);
      assert.match(validation.summary, /no verification targets detected; nothing to run/);
      assert.equal(validation.validationEvidence?.exitCode, 0);
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
      const acceptanceCriteria = [
        { acceptanceId: "AC-docs", criterion: "The guide documents the flag" },
        { acceptanceId: "AC-tests", criterion: "Add unit tests covering the parser" },
      ];
      const integration = await backends.integration.runIntegration({
        objective: "merge",
        signal: new AbortController().signal,
        acceptanceCriteria,
        handoffs: [{ worktree: { path: root, branch: "worker-docs" }, summary: "docs", artifacts: [] }],
      });
      assert.equal(integration.exitStatus, "failed");
      assert.match(integration.error ?? "", /acceptance AC-tests requires tests/);
      assert.doesNotMatch(integration.error ?? "", /AC-docs/);

      const validation = await backends.validation.runValidation({
        objective: "validate",
        signal: new AbortController().signal,
        acceptanceCriteria,
      });
      assert.equal(validation.exitStatus, "failed");
      assert.match(validation.error ?? "", /acceptance AC-tests requires tests/);
      assert.equal(validation.validationEvidence?.noTargets, true);
      assert.notEqual(validation.validationEvidence?.exitCode, 0);
    } finally {
      await cleanup();
    }
  });
});
