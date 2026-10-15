/**
 * Integration and validation judge a candidate by the failures it introduces
 * (issue #200): the base SHA is verified once, its failures are inherited, and
 * an integration run whose checks failed is a code defect, not a merge conflict.
 * Real git repositories and the real CommandVerifier throughout.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { ExecutionOutcome } from "../../src/orchestration/broker.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { FailureClassifier, classifyGateFailure } from "../../src/orchestration/recovery.ts";
import {
  CommandVerifier,
  type VerificationProfile,
  type VerificationProvider,
  type VerifyOutcome,
  type VerifyRunOptions,
} from "../../src/verify/Verifier.ts";

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const passing = (name: string) => `import test from "node:test";\ntest(${JSON.stringify(name)}, () => {});\n`;
const failing = (name: string) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\ntest(${JSON.stringify(name)}, () => assert.equal(1, 2));\n`;

/** The real verifier, counting how many runs happened on a baseline worktree. */
class CountingVerifier implements VerificationProvider {
  readonly inner = new CommandVerifier();
  baseRuns = 0;
  allRuns = 0;
  detect(cwd: string, opts?: { full?: boolean }): Promise<VerificationProfile> {
    return this.inner.detect(cwd, opts);
  }
  run(
    cwd: string,
    profile: VerificationProfile,
    store: ArtifactStore,
    opts?: VerifyRunOptions,
  ): Promise<VerifyOutcome> {
    this.allRuns++;
    if (cwd.includes("pi-eng-baseline-")) this.baseRuns++;
    return this.inner.run(cwd, profile, store, opts);
  }
}

interface Fixture {
  root: string;
  git: GitRepo;
  baseSha: string;
  verifier: CountingVerifier;
  backends: ReturnType<typeof realBackends>;
  write(path: string, content: string): Promise<void>;
  branch(name: string, files: Record<string, string>): Promise<string>;
  cleanup(): Promise<void>;
}

async function fixture(files: Record<string, string>, testScript = "node --test"): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "pi-eng-wire-"));
  const root = join(parent, "repo");
  await mkdir(root);
  sh(root, "init", "-q", "-b", "main");
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("package.json", JSON.stringify({ name: "wire", private: true, scripts: { test: testScript } }));
  for (const [path, content] of Object.entries(files)) await write(path, content);
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "base");
  const baseSha = sh(root, "rev-parse", "HEAD");
  const git = await GitRepo.open(root);
  assert.ok(git);
  const verifier = new CountingVerifier();
  const artifacts = await ArtifactStore.create(join(parent, "artifacts"));
  const backends = realBackends({ worker: {} as never, verifier, artifacts, git, cwd: root });
  return {
    root,
    git,
    baseSha,
    verifier,
    backends,
    write,
    async branch(name, change) {
      sh(root, "checkout", "-q", "-b", name, baseSha);
      for (const [path, content] of Object.entries(change)) await write(path, content);
      sh(root, "add", "-A");
      sh(root, "commit", "-q", "-m", name);
      sh(root, "checkout", "-q", "main");
      return name;
    },
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

const integrate = (fx: Fixture, branches: string[]): Promise<ExecutionOutcome> =>
  fx.backends.integration.runIntegration({
    objective: "integrate",
    handoffs: branches.map((branch) => ({ worktree: { path: fx.root, branch }, summary: "", artifacts: [] })),
    signal: new AbortController().signal,
  });

const validate = async (fx: Fixture, branch: string): Promise<ExecutionOutcome> => {
  const wt = await fx.git.createWorktree(fx.baseSha, `cand-${branch}-${Date.now().toString(36)}`);
  try {
    sh(wt.path, "merge", "-q", "--no-edit", branch);
    return await fx.backends.validation.runValidation({
      objective: "validate",
      worktree: wt.path,
      baseSha: fx.baseSha,
      signal: new AbortController().signal,
    });
  } finally {
    await fx.git.removeWorktree(wt).catch(() => {});
  }
};

const RED = { "test/old.test.js": failing("old failure"), "test/ok.test.js": passing("stays green") };

describe("failure baseline wired into integration and validation (#200)", () => {
  it("a repo red on main: a correct change passes with the inherited failures as a warning", async () => {
    const fx = await fixture(RED);
    try {
      const good = await fx.branch("good", {
        "src/x.js": "export const x = 1;\n",
        "test/x.test.js": passing("x works"),
      });
      const integration = await integrate(fx, [good]);
      assert.equal(integration.exitStatus, "succeeded", integration.summary);
      assert.deepEqual(integration.inheritedFailures?.length, 1);
      assert.match(integration.inheritedFailures?.[0] ?? "", /old failure/);
      assert.ok(integration.warnings?.some((w) => /inherited from base/.test(w)));
      assert.match(integration.summary, /checks: pass; warning: .*inherited/);

      const validation = await validate(fx, good);
      assert.equal(validation.exitStatus, "succeeded", validation.summary);
      assert.equal(validation.validationEvidence?.exitCode, 0);
      assert.match(validation.inheritedFailures?.[0] ?? "", /old failure/);
      assert.ok(validation.warnings?.some((w) => /inherited from base/.test(w)));
    } finally {
      await fx.cleanup();
    }
  });

  it("a stage that fails without test names is inherited per stage", async () => {
    const fx = await fixture({}, 'node -e "process.exit(3)"');
    try {
      const good = await fx.branch("good", { "src/x.js": "export const x = 1;\n" });
      const integration = await integrate(fx, [good]);
      assert.equal(integration.exitStatus, "succeeded", integration.summary);
      assert.deepEqual(integration.inheritedFailures, ["stage:test"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("a NEW failure on top of a red baseline fails and the failure list excludes the inherited ones", async () => {
    const fx = await fixture(RED);
    try {
      const bad = await fx.branch("bad", { "test/new.test.js": failing("new failure") });
      const integration = await integrate(fx, [bad]);
      assert.equal(integration.exitStatus, "failed");
      assert.equal(integration.checksFailed, true);
      assert.deepEqual(integration.inheritedFailures?.length, 1);
      assert.match(integration.inheritedFailures?.[0] ?? "", /old failure/);
      const validation = await validate(fx, bad);
      assert.equal(validation.exitStatus, "failed");
      assert.notEqual(validation.validationEvidence?.exitCode, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("verifies the base once per base SHA across integration, validation and a repair round", async () => {
    const fx = await fixture(RED);
    try {
      const good = await fx.branch("good", { "src/x.js": "export const x = 1;\n" });
      await integrate(fx, [good]);
      assert.equal(fx.verifier.baseRuns, 1);
      await validate(fx, good);
      const repair = await fx.branch("repair", { "src/y.js": "export const y = 1;\n" });
      await integrate(fx, [good, repair]);
      await validate(fx, repair);
      assert.equal(fx.verifier.baseRuns, 1, "the baseline is computed once per base SHA");
      const cacheDir = join(await fx.git.commonDir(), "pi-engineering-baselines");
      assert.equal(readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length, 1);
      assert.equal(
        readdirSync(join(fx.root, "..")).filter((d) => d.includes("pi-eng-baseline")).length,
        0,
        "the temporary base worktree is removed",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("integration checks that ran and failed are VALIDATION_FAILED (code repair); a real conflict stays MERGE_CONFLICT", async () => {
    const classifier = new FailureClassifier();
    const evidenceOf = (outcome: ExecutionOutcome) => ({ missionId: "MSN-1", summary: outcome.summary });
    const fx = await fixture({ "src/a.js": "export const a = 0;\n", "test/ok.test.js": passing("green") });
    try {
      const bad = await fx.branch("bad", { "test/new.test.js": failing("new failure") });
      const failed = await integrate(fx, [bad]);
      assert.equal(failed.exitStatus, "failed");
      const checks = classifyGateFailure(classifier, "integration", evidenceOf(failed), failed);
      assert.equal(checks.category, "VALIDATION_FAILED");

      const left = await fx.branch("left", { "src/a.js": "export const a = 1;\n" });
      const right = await fx.branch("right", { "src/a.js": "export const a = 2;\n" });
      const conflicted = await integrate(fx, [left, right]);
      assert.equal(conflicted.exitStatus, "conflict");
      const conflict = classifyGateFailure(classifier, "integration", evidenceOf(conflicted), conflicted);
      assert.equal(conflict.category, "MERGE_CONFLICT");
    } finally {
      await fx.cleanup();
    }
  });

  it("falls back to today's behaviour with a warning when the base commit is unavailable", async () => {
    const fx = await fixture(RED);
    try {
      const good = await fx.branch("good", { "src/x.js": "export const x = 1;\n" });
      const wt = await fx.git.createWorktree(fx.baseSha, `cand-gone-${Date.now().toString(36)}`);
      try {
        sh(wt.path, "merge", "-q", "--no-edit", good);
        const out = await fx.backends.validation.runValidation({
          objective: "validate",
          worktree: wt.path,
          baseSha: "0".repeat(40),
          signal: new AbortController().signal,
        });
        assert.equal(out.exitStatus, "failed");
        assert.ok(
          out.warnings?.some((w) => /failure baseline unavailable/.test(w)),
          String(out.warnings),
        );
        assert.equal(out.inheritedFailures, undefined);
        assert.equal(existsSync(wt.path), true);
      } finally {
        await fx.git.removeWorktree(wt).catch(() => {});
      }
    } finally {
      await fx.cleanup();
    }
  });
});
