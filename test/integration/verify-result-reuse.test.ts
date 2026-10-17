/**
 * The full suite runs once per candidate commit (issue #185): integration
 * stores its passing result, validation of the unchanged candidate reuses it.
 * Real git repositories and the real CommandVerifier; fine-grained per-test
 * caching is issue #149 and is not covered here.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { ExecutionOutcome } from "../../src/orchestration/broker.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import {
  CommandVerifier,
  type VerificationProfile,
  type VerificationProvider,
  type VerifyOutcome,
  type VerifyRunOptions,
} from "../../src/verify/Verifier.ts";

const run = promisify(execFile);
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

class CountingVerifier implements VerificationProvider {
  readonly inner = new CommandVerifier();
  runs = 0;
  extraStage = false;
  async detect(cwd: string, opts?: { full?: boolean }): Promise<VerificationProfile> {
    const profile = await this.inner.detect(cwd, opts);
    return this.extraStage
      ? {
          ...profile,
          stages: [...profile.stages, { name: "extra", command: "node", args: ["-e", "0"], required: true }],
        }
      : profile;
  }
  run(
    cwd: string,
    profile: VerificationProfile,
    store: ArtifactStore,
    opts?: VerifyRunOptions,
  ): Promise<VerifyOutcome> {
    this.runs++;
    return this.inner.run(cwd, profile, store, opts);
  }
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-eng-reuse-"));
  const root = join(parent, "repo");
  await mkdir(join(root, "test"), { recursive: true });
  sh(root, "init", "-q", "-b", "main");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "r", private: true, scripts: { test: "node --test" } }),
  );
  await writeFile(join(root, "test", "a.test.js"), 'import test from "node:test";\ntest("a", () => {});\n');
  await writeFile(join(root, "feature.txt"), "base\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "base");
  const baseSha = sh(root, "rev-parse", "HEAD");
  sh(root, "checkout", "-q", "-b", "feature");
  await writeFile(join(root, "feature.txt"), "feature\n");
  sh(root, "commit", "-qam", "feature");
  sh(root, "checkout", "-q", "main");
  const git = await GitRepo.open(root);
  assert.ok(git);
  const verifier = new CountingVerifier();
  const artifacts = await ArtifactStore.create(join(parent, "artifacts"));
  const backends = realBackends({ worker: {} as never, verifier, artifacts, git, cwd: root });
  const integrate = async (): Promise<{ outcome: ExecutionOutcome; branch: string }> => {
    const outcome = await backends.integration.runIntegration({
      objective: "integrate",
      handoffs: [{ worktree: { path: root, branch: "feature" }, summary: "", artifacts: [] }],
      signal: new AbortController().signal,
    });
    return { outcome, branch: String(outcome.usage.integrationBranch) };
  };
  /** Validate the integration branch's tip, optionally after adding a commit. */
  const validate = async (
    branch: string,
    commit = false,
    activity: string[] = [],
    base: string | null = baseSha,
    untracked = false,
  ): Promise<ExecutionOutcome> => {
    const wt = await git.createWorktree(branch, `val-${Date.now().toString(36)}`);
    try {
      if (commit) {
        await writeFile(join(wt.path, "more.txt"), "x\n");
        sh(wt.path, "add", "-A");
        sh(wt.path, "commit", "-qm", "more");
      }
      if (untracked) await writeFile(join(wt.path, "untracked.test.js"), "// new\n");
      return await backends.validation.runValidation({
        objective: "validate",
        worktree: wt.path,
        ...(base ? { baseSha: base } : {}),
        signal: new AbortController().signal,
        onActivity: (event) => activity.push(event.summary),
      });
    } finally {
      await git.removeWorktree(wt, { keepBranch: true }).catch(() => {});
    }
  };
  return {
    root,
    baseSha,
    git,
    verifier,
    backends,
    integrate,
    validate,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

describe("verification result reuse (#185)", () => {
  it("integration then validation on the same SHA runs the suite once and records the reuse", async () => {
    const fx = await fixture();
    try {
      const { outcome, branch } = await fx.integrate();
      assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
      assert.equal(fx.verifier.runs, 1);
      const activity: string[] = [];
      const validation = await fx.validate(branch, false, activity);
      assert.equal(validation.exitStatus, "succeeded", validation.summary);
      assert.equal(fx.verifier.runs, 1, "validation reused the integration result");
      const summary = validation.validationEvidence?.testSummary as Record<string, unknown>;
      assert.equal(summary.reused, true);
      assert.equal(typeof summary.originalRunId, "string");
      assert.equal(validation.validationEvidence?.exitCode, 0);
      assert.ok(activity.some((line) => line.startsWith("verify.cache:")));
    } finally {
      await fx.cleanup();
    }
  });

  it("a changed candidate SHA runs again and is not marked reused", async () => {
    const fx = await fixture();
    try {
      const { branch } = await fx.integrate();
      const validation = await fx.validate(branch, true);
      assert.equal(fx.verifier.runs, 2);
      assert.equal((validation.validationEvidence?.testSummary as Record<string, unknown>).reused, undefined);
    } finally {
      await fx.cleanup();
    }
  });

  it("a changed verification profile invalidates the entry", async () => {
    const fx = await fixture();
    try {
      const { branch } = await fx.integrate();
      fx.verifier.extraStage = true;
      await fx.validate(branch);
      assert.equal(fx.verifier.runs, 2);
    } finally {
      await fx.cleanup();
    }
  });

  it("willReuse is true only while a matching entry exists", async () => {
    const fx = await fixture();
    try {
      const { branch } = await fx.integrate();
      const wt = await fx.git.createWorktree(branch, `peek-${Date.now().toString(36)}`);
      try {
        const peek = () =>
          fx.backends.validation.willReuse?.({ worktree: wt.path, baseSha: sh(fx.root, "rev-parse", "main") });
        assert.equal(await peek(), true);
        await writeFile(join(wt.path, "more.txt"), "x\n");
        sh(wt.path, "add", "-A");
        sh(wt.path, "commit", "-qm", "more");
        assert.equal(await peek(), false);
      } finally {
        await fx.git.removeWorktree(wt, { keepBranch: true }).catch(() => {});
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("an untracked non-ignored file at the same SHA bypasses the cache", async () => {
    const fx = await fixture();
    try {
      const { branch } = await fx.integrate();
      const validation = await fx.validate(branch, false, [], fx.baseSha, true);
      assert.equal(fx.verifier.runs, 2);
      assert.equal((validation.validationEvidence?.testSummary as Record<string, unknown>).reused, undefined);
    } finally {
      await fx.cleanup();
    }
  });

  it("a different base SHA or no base never reuses the entry", async () => {
    const fx = await fixture();
    try {
      const { branch } = await fx.integrate();
      const other = sh(fx.root, "rev-parse", "feature");
      await fx.validate(branch, false, [], other);
      assert.equal(fx.verifier.runs, 2, "different base (so a different diff) runs again");
      await fx.validate(branch, false, [], null);
      assert.equal(fx.verifier.runs, 3, "an unset base is its own key");
    } finally {
      await fx.cleanup();
    }
  });

  it("a different CI/NODE_ENV environment invalidates the entry", async () => {
    const fx = await fixture();
    const saved = process.env.NODE_ENV;
    try {
      const { branch } = await fx.integrate();
      process.env.NODE_ENV = "production-test";
      await fx.validate(branch);
      assert.equal(fx.verifier.runs, 2);
    } finally {
      if (saved === undefined) {
        delete process.env.NODE_ENV;
      } else process.env.NODE_ENV = saved;
      await fx.cleanup();
    }
  });

  it("a changed lockfile invalidates the entry", async () => {
    const fx = await fixture();
    try {
      const { branch } = await fx.integrate();
      const wt = await fx.git.createWorktree(branch, `lock-${Date.now().toString(36)}`);
      try {
        const peek = () => fx.backends.validation.willReuse?.({ worktree: wt.path, baseSha: fx.baseSha });
        assert.equal(await peek(), true);
        await writeFile(join(wt.path, "package-lock.json"), "{}\n");
        sh(wt.path, "add", "-A");
        sh(wt.path, "commit", "-qm", "lock");
        assert.equal(await peek(), false);
      } finally {
        await fx.git.removeWorktree(wt, { keepBranch: true }).catch(() => {});
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("writes prune entries beyond the bound and stale orphan files", async () => {
    const fx = await fixture();
    try {
      const dir = join(await fx.git.commonDir(), "pi-engineering-verify");
      await mkdir(dir, { recursive: true });
      const old = new Date(Date.now() - 10 * 24 * 3600_000);
      await writeFile(join(dir, "stale.json"), "{}");
      await writeFile(join(dir, "orphan.json.1.tmp"), "x");
      await utimes(join(dir, "stale.json"), old, old);
      await utimes(join(dir, "orphan.json.1.tmp"), old, old);
      await fx.integrate();
      const names = readdirSync(dir);
      assert.ok(!names.includes("stale.json"));
      assert.ok(!names.includes("orphan.json.1.tmp"));
      assert.ok(
        names.some((name) => name.endsWith(".json")),
        "the fresh entry stays",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("two processes asking for the same candidate compute once", async () => {
    const fx = await fixture();
    try {
      const marker = join(fx.root, "..", "ran.log");
      const common = await fx.git.commonDir();
      const child = () =>
        run("node", ["test/support/verifyOnceChild.ts", fx.root, common, marker], { cwd: process.cwd() });
      const [a, b] = await Promise.all([child(), child()]);
      assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
      const results = [JSON.parse(a.stdout), JSON.parse(b.stdout)] as Array<{ reused: boolean; runId: string }>;
      assert.equal(results.filter((r) => r.reused).length, 1);
      assert.equal(results[0]?.runId, results[1]?.runId);
    } finally {
      await fx.cleanup();
    }
  });
});
