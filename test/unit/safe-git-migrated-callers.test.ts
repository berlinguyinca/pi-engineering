/**
 * T16 H5: the callers that used to run raw git on worker-writable state (GitRepo, worktreeJanitor, changeObserver,
 * postMerge, workerResultTool) must not execute planted fsmonitor / filter / textconv / gpg / hook payloads.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { sweepWorktrees } from "../../src/git/worktreeJanitor.ts";
import { captureChangeSnapshot } from "../../src/lifecycle/changeObserver.ts";
import { gitPostMerge } from "../../src/merge/postMerge.ts";
import { gitHead, gitRunner, sshCommandConfigured, trackedChanges } from "../../src/runtime/host/sourceWatch.ts";
import { hasNoChangesVsBase } from "../../src/workers/workerResultTool.ts";

const CLEAN_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cmd: string, cwd: string) =>
  execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...CLEAN_ENV }, stdio: "pipe" }).toString();

let root: string;
let primary: string;
let linked: string;
let marks: string;
let janitorWt: string;
let repo: GitRepo;
const seen = () => readdirSync(marks).sort();
const reset = () => {
  for (const n of readdirSync(marks)) rmSync(join(marks, n), { force: true });
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), "safe-git-callers-"));
  marks = join(root, "MARK");
  mkdirSync(marks);
  primary = join(root, "primary");
  linked = join(root, "linked");
  sh(
    "git init -q -b main primary && cd primary && git config user.name t && git config user.email t@t && echo a > f.txt && git add . && git commit -qm init && git worktree add -q -b work ../linked HEAD",
    root,
  );
  repo = (await GitRepo.open(primary)) as GitRepo;
  assert.ok(repo);
  janitorWt = join(root, `${repo.worktreeNamespacePrefix()}stale`);
  sh(`git worktree add -q -b pi-eng-candidate-AAA-1-x ${janitorWt} HEAD`, primary);
  const fake = join(root, "fake");
  writeFileSync(fake, `#!/bin/sh\ntouch ${marks}/gpg\nexit 1\n`);
  chmodSync(fake, 0o755);
  const M = marks;
  // planted as a worker would: from inside a linked worktree
  sh(
    [
      `git config core.fsmonitor "sh -c 'touch ${M}/fsmonitor' --"`,
      `git config filter.x.clean "sh -c 'touch ${M}/filter-clean; cat'"`,
      `git config filter.x.smudge "sh -c 'touch ${M}/filter-smudge; cat'"`,
      `git config diff.x.textconv "sh -c 'touch ${M}/textconv; cat \\"\\$1\\"' --"`,
      `git config diff.x.command "sh -c 'touch ${M}/diff-external' --"`,
      "git config commit.gpgsign true",
      `git config gpg.program ${fake}`,
      `CD=$(git rev-parse --git-common-dir); mkdir -p $CD/info $CD/hooks`,
      "printf '* filter=x diff=x\\n' >> $CD/info/attributes",
      `for h in pre-commit prepare-commit-msg commit-msg post-commit post-checkout post-index-change reference-transaction; do printf '#!/bin/sh\\ntouch ${M}/hook-%s\\n' $h > $CD/hooks/$h; chmod +x $CD/hooks/$h; done`,
    ].join("\n"),
    linked,
  );
  writeFileSync(join(linked, "f.txt"), "dirty\n");
  writeFileSync(join(linked, "new.txt"), "n\n");
  writeFileSync(join(janitorWt, "f.txt"), "dirty-janitor\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("migrated callers run none of the planted payloads", () => {
  it("control: raw git in the same repository does run them", () => {
    reset();
    sh("git status --porcelain || true; git diff HEAD >/dev/null || true", linked);
    assert.ok(seen().includes("filter-clean"), seen().join(","));
    reset();
  });

  it("GitRepo status / isClean / statusIn / diffStats", async () => {
    reset();
    await repo.isClean();
    await repo.status();
    await repo.statusIn(linked).catch(() => {});
    await repo.diffStats().catch(() => {});
    assert.deepEqual(seen(), []);
  });

  it("GitRepo worktree creation does not run a smudge filter", async () => {
    reset();
    const base = sh("git rev-parse HEAD", primary).trim();
    await repo.createWorktree(base, "pi-eng-candidate-BBB-2-y").catch(() => {});
    assert.deepEqual(seen(), []);
  });

  it("captureChangeSnapshot on the worker's worktree", async () => {
    reset();
    const snap = await captureChangeSnapshot({ cwd: linked });
    assert.ok(snap.isGit);
    assert.deepEqual(seen(), []);
  });

  it("hasNoChangesVsBase on the worker's worktree", async () => {
    reset();
    assert.equal(await hasNoChangesVsBase(linked, "HEAD"), false);
    assert.deepEqual(seen(), []);
  });

  it("postMerge revert branch (commit + gpg + hooks + filters)", async () => {
    reset();
    sh(
      "git checkout -q -b feature && echo z > z.txt && git add z.txt && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --no-verify -m z",
      primary,
    );
    const merged = sh("git rev-parse HEAD", primary).trim();
    sh("git checkout -q main", primary);
    const base = sh("git rev-parse HEAD", primary).trim();
    reset();
    const r = await gitPostMerge(primary).createRevertBranch({ branch: "revert-z", mergedSha: merged, base });
    assert.ok(r.ok || r.reason, "the revert either succeeds or reports why");
    assert.deepEqual(seen(), []);
  });

  it("worktree janitor preserves dirty work without running hooks, gpg or filters", async () => {
    reset();
    const report = await sweepWorktrees({
      repo,
      minAgeMs: 0,
      maxIdleMs: 0,
      ownerLiveness: () => "terminal",
    });
    assert.ok(
      report.reclaimed.some((r) => basename(r.path) === basename(janitorWt)),
      JSON.stringify(report),
    );
    assert.deepEqual(seen(), []);
  });

  it("source watcher (gitHead, trackedChanges, gitRunner, sshCommandConfigured) on the watched checkout", async () => {
    reset();
    sh(`git config core.sshCommand 'sh -c "touch ${marks}/ssh"' --`, primary);
    assert.match((await gitHead(linked)) ?? "", /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(await trackedChanges(linked)));
    const run = await gitRunner(linked)(["status", "--porcelain", "--untracked-files=no"]);
    assert.equal(run.code, 0, run.stderr);
    const fetch = await gitRunner(primary)(["fetch", "--dry-run"]);
    assert.ok(fetch.code === 0 || fetch.code === 128, fetch.stderr);
    assert.equal(sshCommandConfigured(linked), false, "a repository-local core.sshCommand is not the operator's");
    assert.deepEqual(seen(), []);
  });
});
