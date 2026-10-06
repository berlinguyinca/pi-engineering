/**
 * Phase 1 acceptance (zero-config runtime isolation): concurrent Pi sessions
 * never fail to open the engineering runtime because another session exists.
 *
 * Real child processes, a real git repository, a real temp state dir.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { addWorktree, makeGitRepo, makeStateDir, runChildren, startChild } from "../support/childSessions.ts";

describe("concurrent sessions (per-session writers, no shared lock)", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("five sessions opened at the same instant on one worktree all initialize with unique writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-same-wt-"));
    const stateDir = await makeStateDir("same-wt-state");
    cleanup.push(root, stateDir);
    const repo = await makeGitRepo(join(root, "repo"));
    // The incident's leftover: a legacy writer lock with unreadable owner metadata.
    await mkdir(join(repo, ".pi-eng"), { recursive: true });
    await writeFile(join(repo, ".pi-eng", "orchestration.jsonl.lock"), "");

    const { reports } = await runChildren(5, () => repo, stateDir);
    for (const report of reports) assert.equal(report.ok, true, `session failed: ${report.error}`);
    const sessions = new Set(reports.map((report) => report.sessionId));
    assert.equal(sessions.size, 5, "every session has its own id");
    const worktrees = new Set(reports.map((report) => report.worktreeId));
    assert.equal(worktrees.size, 1, "all sessions resolved the same worktree");
    const eventsDir = reports[0]!.eventsDir!;
    const streams = readdirSync(eventsDir).filter((name) => name.endsWith(".jsonl"));
    assert.deepEqual(
      new Set(streams),
      new Set(reports.map((report) => `${report.sessionId}.jsonl`)),
      "exactly one stream per session",
    );

    // A later session sees the merged history of all five.
    const late = await startChild("open", repo, stateDir).report;
    assert.equal(late.ok, true, late.error);
    for (const report of reports) {
      assert.ok(late.visibleMissions?.includes(report.missionId!), `merged read includes ${report.missionId}`);
    }
  });

  it("parent-directory launches: sessions at a parent repo and at two nested repos are all isolated and healthy", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-eng-parent-"));
    const stateDir = await makeStateDir("parent-state");
    cleanup.push(parent, stateDir);
    // ~/IdeaProjects is itself a git repo in the reporter's setup; mirror that.
    await makeGitRepo(parent);
    const alpha = await makeGitRepo(join(parent, "alpha"));
    const beta = await makeGitRepo(join(parent, "beta"));
    const cwds = [parent, parent, alpha, beta, alpha, beta];
    const { reports } = await runChildren(cwds.length, (index) => cwds[index]!, stateDir);
    for (const report of reports) assert.equal(report.ok, true, `session failed: ${report.error}`);
    const byCwd = new Map<string, Set<string>>();
    reports.forEach((report, index) => {
      const set = byCwd.get(cwds[index]!) ?? new Set<string>();
      set.add(report.worktreeId!);
      byCwd.set(cwds[index]!, set);
    });
    for (const [cwd, ids] of byCwd) assert.equal(ids.size, 1, `${cwd} resolves one worktree id`);
    const distinct = new Set([...byCwd.values()].map((ids) => [...ids][0]));
    assert.equal(distinct.size, 3, "parent, alpha and beta each get their own namespace");
  });

  it("linked worktrees of one repository resolve to distinct namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-linked-"));
    const stateDir = await makeStateDir("linked-state");
    cleanup.push(root, stateDir);
    const repo = await makeGitRepo(join(root, "main"));
    const featureA = await addWorktree(repo, join(root, "feature-a"), "feature-a");
    const featureB = await addWorktree(repo, join(root, "feature-b"), "feature-b");
    const cwds = [repo, featureA, featureB, featureA, featureB, repo];
    const { reports } = await runChildren(cwds.length, (index) => cwds[index]!, stateDir);
    for (const report of reports) assert.equal(report.ok, true, `session failed: ${report.error}`);
    const ids = new Map<string, string>();
    reports.forEach((report, index) => {
      const previous = ids.get(cwds[index]!);
      if (previous) assert.equal(previous, report.worktreeId);
      ids.set(cwds[index]!, report.worktreeId!);
    });
    assert.equal(new Set(ids.values()).size, 3, "three worktrees, three namespaces");
  });
});
