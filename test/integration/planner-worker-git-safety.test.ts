import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { testHooks as safeGitHooks } from "../../src/git/safeGit.ts";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

for (const failure of ["add", "status", "head", "diff", "names"] as const) {
  test(`failed planner-worker ${failure} preserves its output instead of treating failed git as an empty diff`, async () => {
    const fixture = await makeFixtureRepo();
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const worktree = await repo.createWorktree(base, `harvest-${failure}`);
    const output = join(worktree.path, "src", "unharvested.txt");
    await writeFile(output, "recover this worker output\n");
    const runtime: any = {
      worktree,
      baseCommit: failure === "diff" ? "missing-base-commit" : base,
      lastHead: base,
      state: { contract: { task_id: "harvest" }, attempt: 1, status: "running", changed_files: [] },
    };
    const executor: any = new PlannerWorkerExecutor({
      repoRoot: fixture.root,
      stateDir: join(fixture.root, ".pi-eng", "state"),
    } as any);
    executor.contracts.set("harvest", runtime);
    let indexLock: string | undefined;
    const previousHook = safeGitHooks.afterPlan;
    const blocker = join(fixture.root, ".git", "query-blocker");
    try {
      if (failure === "add") {
        const gitDir = (await exec("git", ["-C", worktree.path, "rev-parse", "--absolute-git-dir"])).stdout.trim();
        indexLock = join(gitDir, "index.lock");
        await writeFile(indexLock, "another index writer\n");
      }
      // Plant the refusal after the preceding command has prepared its safe
      // snapshot, so the next query refuses during its repository scan.
      const stage = { status: 1, head: 4, names: 6 }[failure as "status" | "head" | "names"];
      if (stage) {
        let calls = 0;
        safeGitHooks.afterPlan = async () => {
          calls++;
          if (calls === stage) await link(join(fixture.root, ".git", "config"), blocker);
        };
      }
      const command = failure === "head" ? "rev-parse" : failure === "names" ? "diff" : failure;
      await assert.rejects(() => executor.commitAttempt(runtime), new RegExp(`git ${command}.*failed`, "i"));
      safeGitHooks.afterPlan = previousHook;
      await rm(blocker, { force: true });
      await executor.cleanup();
      assert.equal(await readFile(output, "utf8"), "recover this worker output\n");
      const branch = await exec("git", ["-C", fixture.root, "rev-parse", "--verify", `refs/heads/${worktree.branch}`]);
      assert.ok(branch.stdout.trim(), "unharvested work remains reachable by its branch");
    } finally {
      safeGitHooks.afterPlan = previousHook;
      await rm(blocker, { force: true });
      if (indexLock) await rm(indexLock, { force: true });
      await access(worktree.path)
        .then(() => repo.removeWorktree(worktree))
        .catch(() => {});
      await fixture.cleanup();
    }
  });
}

test("cleanup preserves dirty worker output even when execution fails before harvesting", async () => {
  const fixture = await makeFixtureRepo();
  const repo = (await GitRepo.open(fixture.root))!;
  const worktree = await repo.createWorktree(await repo.headCommit(), "failed-before-harvest");
  const output = join(worktree.path, "src", "pending.txt");
  await writeFile(output, "pending output\n");
  const executor: any = new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir: join(fixture.root, ".pi-eng", "state"),
  } as any);
  executor.contracts.set("pending", { worktree, state: { status: "failed" } });
  try {
    await executor.cleanup();
    assert.equal(await readFile(output, "utf8"), "pending output\n");
  } finally {
    await access(worktree.path)
      .then(() => repo.removeWorktree(worktree))
      .catch(() => {});
    await fixture.cleanup();
  }
});

test("failed workspaces retain ignored output as well as committed branches", async () => {
  const fixture = await makeFixtureRepo();
  const repo = (await GitRepo.open(fixture.root))!;
  const worktree = await repo.createWorktree(await repo.headCommit(), "failed-ignored-output");
  await writeFile(join(worktree.path, ".gitignore"), "ignored-output.txt\n");
  await exec("git", ["-C", worktree.path, "add", ".gitignore"]);
  await exec("git", ["-C", worktree.path, "commit", "-qm", "ignore generated output"]);
  const output = join(worktree.path, "ignored-output.txt");
  await writeFile(output, "still recoverable\n");
  const executor: any = new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir: join(fixture.root, ".pi-eng", "state"),
  } as any);
  executor.status = "failed";
  executor.contracts.set("pending", { worktree, state: { status: "failed" } });
  try {
    assert.equal((await exec("git", ["-C", worktree.path, "status", "--porcelain"])).stdout, "");
    await executor.cleanup();
    assert.equal(await readFile(output, "utf8"), "still recoverable\n");
  } finally {
    await repo.removeWorktree(worktree).catch(() => {});
    await fixture.cleanup();
  }
});

for (const kind of ["dirty worker", "committed failed harvest", "dirty integration"] as const) {
  test(`a fresh resume cannot erase ${kind} retained for recovery`, async () => {
    const fixture = await makeFixtureRepo();
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const integration = await repo.createWorktree(base, "pi-eng-pw-Recovery");
    const worktree = await repo.createWorktree(base, "pi-eng-pw-Recovery-task");
    const stateDir = join(fixture.root, ".pi-eng", "resume-safety");
    await mkdir(stateDir, { recursive: true });
    const opts: any = { repoRoot: fixture.root, stateDir, resolver: { refresh: async () => {} } };
    const executor: any = new PlannerWorkerExecutor(opts);
    const contract = {
      task_id: "task",
      objective: "recover",
      depends_on: [],
      scope: { allowed: ["src/**"], forbidden: [] },
      acceptance: [],
      verification: [],
      risk: "medium",
    };
    const runtime: any = {
      worktree,
      baseCommit: kind === "committed failed harvest" ? "missing-base" : base,
      lastHead: base,
      state: { contract, status: "running", attempt: 1, changed_files: [], history: [], worktree: worktree.path },
    };
    executor.brief = {
      mission_id: "Recovery",
      summary: "preserve output",
      architectural_context: [],
      acceptance_criteria: [],
      constraints: [],
    };
    executor.integration = integration;
    executor.baseCommit = base;
    executor.plan = { contracts: [contract], decisions: [], architectural_context: [] };
    executor.contracts.set("task", runtime);
    const output =
      kind === "dirty integration"
        ? join(integration.path, "src", "index.ts")
        : join(worktree.path, "src", "pending.txt");
    await writeFile(output, "preserve across resume\n");
    if (kind === "dirty integration") {
      await exec("git", ["-C", integration.path, "add", "src/index.ts"]);
    }
    try {
      if (kind === "committed failed harvest")
        await assert.rejects(() => executor.commitAttempt(runtime), /git diff failed/);
      await executor.persist();
      const fresh: any = new PlannerWorkerExecutor(opts);
      const error = await fresh.resume().then(
        () => null,
        (failure: Error) => failure,
      );
      assert.equal(await readFile(output, "utf8"), "preserve across resume\n");
      assert.ok(error instanceof Error, "resume must stop before replacing preserved work");
      assert.match(error.message, /preserv|recover/i);
    } finally {
      await repo.removeWorktree(worktree).catch(() => {});
      await repo.removeWorktree(integration).catch(() => {});
      await fixture.cleanup();
    }
  });
}
