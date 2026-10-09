/**
 * Durable candidate/run/promotion/cleanup records live in the SHARED git common
 * directory, so every linked worktree of a repository sees every record written
 * from any other worktree. A mission must only validate (and be blocked by) the
 * records it can attribute to its own (missionId, repoId). Self-consistent
 * records of another mission or another worktree root are not its business.
 *
 * Regression: a mission started from `<repo>/.worktrees/<name>` reported one
 * blocking "Corrupt durable candidate record" finding per record written by
 * earlier missions started from the main checkout, because the candidate path
 * check derives the expected worktree path from the *current* checkout root.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { type CandidateLifecycle, GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

function repoIdFor(root: string): string {
  return `repo-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/** Same digest as GitRepo.candidateStateName, so a forged record is self-consistent. */
function candidateFileName(record: CandidateLifecycle): string {
  const parts = [
    record.candidateId,
    record.missionId,
    record.repoId,
    record.missionGeneration,
    record.candidateGeneration,
    record.repositoryGeneration,
    record.attempt,
    record.parentCandidateId ?? "",
    record.seedSha ?? "",
    record.integrationRunId ?? "",
    record.branch,
    record.path,
    record.baseSha,
    record.candidateSha,
  ];
  return `candidate.${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}.json`;
}

/** Main checkout + a nested linked worktree under `<root>/.worktrees/linked`. */
async function mainAndLinkedWorktree() {
  const fixture = await makeFixtureRepo();
  const mainRoot = await realpath(fixture.root);
  await mkdir(join(mainRoot, ".worktrees"), { recursive: true });
  const linkedPath = join(mainRoot, ".worktrees", "linked");
  await exec("git", ["-C", mainRoot, "worktree", "add", "-q", "-b", "linked-branch", linkedPath]);
  const main = (await GitRepo.open(mainRoot))!;
  const linked = (await GitRepo.open(linkedPath))!;
  assert.equal(await main.commonDir(), await linked.commonDir(), "linked worktrees share one durable state dir");
  return {
    fixture,
    main,
    linked,
    mainRepoId: repoIdFor(main.root),
    linkedRepoId: repoIdFor(linked.root),
    stateDir: join(await main.commonDir(), "pi-engineering-candidates"),
  };
}

function brokerFor(git: GitRepo, repoId: string, root: string) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "durable ownership",
    goal: "durable ownership",
    user_request: "durable ownership",
    repository: root,
    base_ref: "HEAD",
    risk_profile: "high",
    workflow_class: "engineering_review",
  });
  store.createTask({
    mission_id: mission.mission_id,
    repo_id: repoId,
    kind: "agent",
    role: "implementer",
    objective: "w",
  });
  const broker = new ExecutionBroker({ store, resolveRepository: async () => ({ repoId, root, git }), backends: {} });
  return { broker, missionId: mission.mission_id };
}

test("records written from the main checkout are not reported as corrupt from a linked worktree", async () => {
  const env = await mainAndLinkedWorktree();
  try {
    const { main, linked, mainRepoId, linkedRepoId } = env;
    assert.notEqual(mainRepoId, linkedRepoId, "repoId is bound to the checkout root, not the shared common dir");
    const base = await main.headCommit();
    // Written exactly as an earlier mission launched from the main checkout writes them.
    const candidate = await main.createCandidateWorktree(base, {
      missionId: "MSN-from-main",
      repoId: mainRepoId,
      missionGeneration: 1,
      candidateGeneration: 0,
      repositoryGeneration: 1,
      attempt: "EXC-main",
    });
    candidate.state = "integrating";
    await main.persistCandidateLifecycle(candidate);
    await main.beginIntegrationRun(candidate, "run-main", []);

    // The owning checkout still validates its records cleanly.
    const fromMain = await main.loadCandidateLifecycleInventory("MSN-from-main", mainRepoId);
    assert.equal(fromMain.records.length, 1);
    assert.deepEqual(fromMain.diagnostics, []);

    // A different mission, launched from the linked worktree, must not see them as corrupt.
    for (const inventory of [
      await linked.loadCandidateLifecycleInventory("MSN-from-linked", linkedRepoId),
      await linked.loadIntegrationRunInventory("MSN-from-linked", linkedRepoId),
      await linked.loadPromotionLifecycleInventory("MSN-from-linked", linkedRepoId),
      await linked.loadPendingBranchCleanupInventory("MSN-from-linked", linkedRepoId),
    ]) {
      assert.deepEqual(inventory.records, []);
      assert.deepEqual(inventory.diagnostics, []);
    }
    // Even the same mission id bound to the linked root does not own the main root's records.
    const sameMission = await linked.loadCandidateLifecycleInventory("MSN-from-main", linkedRepoId);
    assert.deepEqual(sameMission.diagnostics, []);

    const { broker, missionId } = brokerFor(linked, linkedRepoId, linked.root);
    assert.deepEqual(await broker.durableRepositoryDiagnostics(missionId), []);
  } finally {
    await env.fixture.cleanup();
  }
});

test("an owned candidate record with a forged path still blocks a mission launched from a linked worktree", async () => {
  const env = await mainAndLinkedWorktree();
  try {
    const { linked, linkedRepoId, stateDir } = env;
    const { broker, missionId } = brokerFor(linked, linkedRepoId, linked.root);
    const candidate = await linked.createCandidateWorktree(await linked.headCommit(), {
      missionId,
      repoId: linkedRepoId,
      missionGeneration: 1,
      candidateGeneration: 0,
      repositoryGeneration: 1,
      attempt: "EXC-owned",
    });
    assert.deepEqual(await broker.durableRepositoryDiagnostics(missionId), []);

    const original = candidateFileName(candidate);
    const forged = JSON.parse(await readFile(join(stateDir, original), "utf8")) as CandidateLifecycle;
    forged.path = join(env.main.root, "..", "somewhere-else");
    const forgedName = candidateFileName(forged);
    await writeFile(join(stateDir, forgedName), JSON.stringify(forged));

    const diagnostics = await broker.durableRepositoryDiagnostics(missionId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.file, forgedName);
    assert.equal(diagnostics[0]?.recordKind, "candidate");
    assert.match(diagnostics[0]?.reason ?? "", /candidate identity does not match/);
  } finally {
    await env.fixture.cleanup();
  }
});

test("a truly corrupt owned record still blocks, and unattributable records fail closed", async () => {
  const env = await mainAndLinkedWorktree();
  try {
    const { main, linked, linkedRepoId, mainRepoId, stateDir } = env;
    const { broker, missionId } = brokerFor(linked, linkedRepoId, linked.root);
    const candidate = await linked.createCandidateWorktree(await linked.headCommit(), {
      missionId,
      repoId: linkedRepoId,
      missionGeneration: 1,
      candidateGeneration: 0,
      repositoryGeneration: 1,
      attempt: "EXC-corrupt",
    });
    const ownName = candidateFileName(candidate);
    const own = JSON.parse(await readFile(join(stateDir, ownName), "utf8")) as Record<string, unknown>;
    // Owned payload whose content no longer hashes to its filename.
    await writeFile(join(stateDir, ownName), JSON.stringify({ ...own, candidateSha: "f".repeat(40) }));
    let diagnostics = await broker.durableRepositoryDiagnostics(missionId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.file, ownName);

    // A payload rewritten to claim a foreign owner, but whose filename does not
    // match that claim, cannot be attributed and must not be silently ignored.
    await writeFile(
      join(stateDir, ownName),
      JSON.stringify({ ...own, missionId: "MSN-someone-else", repoId: mainRepoId }),
    );
    diagnostics = await broker.durableRepositoryDiagnostics(missionId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.file, ownName);

    // An unreadable record has no provable owner either.
    await writeFile(join(stateDir, ownName), JSON.stringify(own));
    await writeFile(join(stateDir, "candidate.unreadable.json"), "{not-json");
    diagnostics = await broker.durableRepositoryDiagnostics(missionId);
    assert.deepEqual(
      diagnostics.map((d) => d.file),
      ["candidate.unreadable.json"],
    );

    // The owning mission of the main root is likewise still blocked by that file.
    const mainInventory = await main.loadCandidateLifecycleInventory("MSN-other", mainRepoId);
    assert.equal(mainInventory.diagnostics.length, 1);
    assert.ok((await readdir(stateDir)).includes(ownName), "records are never deleted or rewritten by a load");
  } finally {
    await env.fixture.cleanup();
  }
});
