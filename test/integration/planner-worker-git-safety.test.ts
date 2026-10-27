import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { testHooks as safeGitHooks } from "../../src/git/safeGit.ts";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
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

for (const status of ["failed", "completed", "aborted"]) {
  test(`cleanup preserves ignored output in retired ${status} workspaces`, async () => {
    const fixture = await makeFixtureRepo();
    const repo = (await GitRepo.open(fixture.root))!;
    const worktree = await repo.createWorktree(await repo.headCommit(), "retired-ignored-output");
    await writeFile(join(worktree.path, ".gitignore"), "recover.txt\n");
    await exec("git", ["-C", worktree.path, "add", ".gitignore"]);
    await exec("git", ["-C", worktree.path, "commit", "-qm", "ignore recovery artifact"]);
    const output = join(worktree.path, "recover.txt");
    await writeFile(output, "retired output\n");
    const executor: any = new PlannerWorkerExecutor({
      repoRoot: fixture.root,
      stateDir: join(fixture.root, ".pi-eng", "retired"),
    } as any);
    executor.repo = repo;
    executor.status = status;
    executor.retired.push(worktree);
    try {
      assert.equal((await exec("git", ["-C", worktree.path, "status", "--porcelain"])).stdout, "");
      await executor.cleanup();
      assert.equal(await readFile(output, "utf8"), "retired output\n");
      await exec("git", ["-C", fixture.root, "rev-parse", "--verify", `refs/heads/${worktree.branch}`]);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("replanning durably fences retired artifacts before cleanup or resume can replace them", async () => {
  const fixture = await makeFixtureRepo();
  const repo = (await GitRepo.open(fixture.root))!;
  const base = await repo.headCommit();
  const integration = await repo.createWorktree(base, "pi-eng-pw-Retired");
  const worktree = await repo.createWorktree(base, "pi-eng-pw-Retired-task");
  const stateDir = join(fixture.root, ".pi-eng", "retired-recovery");
  await mkdir(stateDir, { recursive: true });
  const opts: any = {
    repoRoot: fixture.root,
    stateDir,
    resolver: new RoleResolver({ provider: "default" }),
  };
  const executor: any = new PlannerWorkerExecutor(opts);
  const contract = {
    task_id: "task",
    objective: "replace blocked work",
    depends_on: [],
    scope: { allowed: ["src/**"] },
    acceptance: ["done"],
    verification: ["true"],
    risk: "medium",
  };
  executor.repo = repo;
  executor.brief = { mission_id: "Retired", summary: "recover retired work" };
  executor.integration = integration;
  executor.baseCommit = base;
  executor.roleWorker = () => ({
    run: async () => ({
      result: {
        status: "completed",
        summary: JSON.stringify({ contracts: [contract], decisions: [], architectural_context: [] }),
      },
    }),
  });
  const runtime = {
    worktree,
    baseCommit: base,
    state: {
      contract: { ...contract, task_id: "task" },
      status: "blocked",
      attempt: 1,
      blocked_reason: "evidence: blocked",
      changed_files: [],
      history: [],
      worktree: worktree.path,
    },
  };
  executor.contracts.set("task", runtime);
  await writeFile(join(worktree.path, ".gitignore"), "recover.txt\n");
  await exec("git", ["-C", worktree.path, "add", ".gitignore"]);
  await exec("git", ["-C", worktree.path, "commit", "-qm", "ignore recovery artifact"]);
  const output = join(worktree.path, "recover.txt");
  await writeFile(output, "recover after restart\n");
  try {
    // A failed durable write must stop retirement before dropping the only
    // contract record or launching a replacement with a colliding identity.
    await mkdir(join(stateDir, "state.json"));
    await assert.rejects(() => executor.replan(runtime), /EISDIR|ENOTEMPTY/);
    assert.equal(executor.contracts.get("task"), runtime);
    assert.equal(await readFile(output, "utf8"), "recover after restart\n");
    // Retry from the original persisted/in-memory contract after storage returns.
    executor.retired.length = 0;
    executor.replans = 0;
    await rm(join(stateDir, "state.json"), { recursive: true });
    assert.equal(await executor.replan(runtime), true);
    const saved = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
    assert.ok(saved.unharvested_worktrees?.includes(worktree.path), "retirement persists a recovery fence immediately");
    assert.deepEqual(saved.retired_worktrees, [{ ...worktree, base_commit: base }]);
    // Older checkpoints may lack the retired inventory. The existing branch
    // itself must still stop a replacement from force-removing its workspace.
    const legacyStateDir = join(stateDir, "legacy-checkpoint");
    await mkdir(legacyStateDir, { recursive: true });
    const legacy: any = new PlannerWorkerExecutor({ ...opts, stateDir: legacyStateDir });
    legacy.repo = repo;
    legacy.brief = executor.brief;
    legacy.integration = integration;
    legacy.attempt = async () => "done";
    legacy.addContract(contract);
    const legacyReplacement = legacy.contracts.get("task");
    legacy.setStatus(legacyReplacement, "ready", "dependencies satisfied");
    await legacy.executeContract(legacyReplacement);
    assert.equal(legacyReplacement.state.status, "failed");
    assert.equal(await readFile(output, "utf8"), "recover after restart\n");
    const replacement = executor.contracts.get("task");
    executor.setStatus(replacement, "ready", "dependencies satisfied");
    await executor.executeContract(replacement);
    assert.equal(replacement.state.status, "failed");
    assert.match(replacement.state.blocked_reason ?? replacement.state.history.at(-1)?.note ?? "", /preserv|recover/i);
    assert.equal(await readFile(output, "utf8"), "recover after restart\n");
    await executor.persist();
    await assert.rejects(() => new PlannerWorkerExecutor(opts).resume(), /preserv.*recover/i);
    assert.equal(await readFile(output, "utf8"), "recover after restart\n");
    // A missing directory cannot silently clear the durable fence and allow a
    // same-id replacement branch to overwrite the preserved commit history.
    await exec("git", ["-C", fixture.root, "worktree", "remove", "--force", worktree.path]);
    await assert.rejects(() => new PlannerWorkerExecutor(opts).resume(), /preserv.*recover/i);
    // Deliberate recovery keeps the commits elsewhere, then removes both
    // original identities as documented; no state-file surgery is needed.
    await exec("git", ["-C", fixture.root, "branch", "recovered-output", worktree.branch]);
    await exec("git", ["-C", fixture.root, "branch", "-D", worktree.branch]);
    const recovered: any = new PlannerWorkerExecutor(opts);
    let resumed = false;
    recovered.proceed = async () => {
      resumed = true;
      return recovered.report();
    };
    await recovered.resume();
    assert.equal(resumed, true, "explicit recovery allows resume to reach execution again");
  } finally {
    await fixture.cleanup();
  }
});

test("cleanup still removes clean fully harvested passed workspaces", async () => {
  const fixture = await makeFixtureRepo();
  const repo = (await GitRepo.open(fixture.root))!;
  const worktree = await repo.createWorktree(await repo.headCommit(), "harvested-passed");
  const executor: any = new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir: join(fixture.root, ".pi-eng", "passed"),
  } as any);
  executor.repo = repo;
  executor.status = "completed";
  executor.contracts.set("task", { worktree, state: { status: "passed" } });
  try {
    await executor.cleanup();
    await assert.rejects(() => access(worktree.path), { code: "ENOENT" });
    await assert.rejects(() =>
      exec("git", ["-C", fixture.root, "rev-parse", "--verify", `refs/heads/${worktree.branch}`]),
    );
  } finally {
    await fixture.cleanup();
  }
});
