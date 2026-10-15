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

test("records from a different root or legacy records validate by content integrity, not path recomputation", async () => {
  const env = await mainAndLinkedWorktree();
  try {
    const { main, mainRepoId, stateDir } = env;
    const candidate = await main.createCandidateWorktree(await main.headCommit(), {
      missionId: "MSN-root",
      repoId: mainRepoId,
      missionGeneration: 1,
      candidateGeneration: 0,
      repositoryGeneration: 1,
      attempt: "EXC-root",
    });
    const name = candidateFileName(candidate);
    const stored = JSON.parse(await readFile(join(stateDir, name), "utf8")) as CandidateLifecycle;
    assert.equal(stored.rootHash, createHash("sha256").update(main.root).digest("hex"));
    assert.equal((await main.loadCandidateLifecycleInventory("MSN-root", mainRepoId)).records.length, 1);

    // Another install wrote the record: different rootHash and a path this root would never derive.
    const other = { ...stored, rootHash: "0".repeat(64), path: join(main.root, "..", `pi-eng-zz9-${stored.branch}`) };
    const otherName = candidateFileName(other);
    await writeFile(join(stateDir, otherName), JSON.stringify(other));
    // Legacy record: no rootHash at all.
    const { rootHash: _drop, ...legacyBase } = stored;
    const legacyAttempt = "EXC-legacy";
    const legacyBranch = `pi-eng-candidate-${[stored.missionId, stored.repoId, stored.missionGeneration, stored.candidateGeneration, legacyAttempt].join("-").replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const legacy = {
      ...legacyBase,
      attempt: legacyAttempt,
      branch: legacyBranch,
      path: join(main.root, "..", `pi-eng-legacy1-${legacyBranch}`),
      candidateId: [stored.missionId, stored.repoId, "1", "0", legacyAttempt]
        .map((part) => Buffer.from(part).toString("base64url"))
        .join("."),
    } as CandidateLifecycle;
    const legacyName = candidateFileName(legacy);
    await writeFile(join(stateDir, legacyName), JSON.stringify(legacy));

    const inventory = await main.loadCandidateLifecycleInventory("MSN-root", mainRepoId);
    assert.deepEqual(inventory.diagnostics, []);
    assert.equal(inventory.records.length, 2, "same candidateId from two writers dedupes; legacy stays distinct");
    assert.deepEqual((await readdir(stateDir)).includes("quarantine"), false);
  } finally {
    await env.fixture.cleanup();
  }
});

test("a same-root record with a forged path is quarantined with a reason and does not block", async () => {
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
    const forged = JSON.parse(
      await readFile(join(stateDir, candidateFileName(candidate)), "utf8"),
    ) as CandidateLifecycle;
    forged.path = join(env.main.root, "..", "somewhere-else");
    const forgedName = candidateFileName(forged);
    await writeFile(join(stateDir, forgedName), JSON.stringify(forged));

    const diagnostics = await broker.durableRepositoryDiagnostics(missionId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.file, forgedName);
    assert.match(diagnostics[0]?.reason ?? "", /candidate identity does not match/);
    assert.equal(diagnostics[0]?.quarantinedTo, `quarantine/${forgedName}`);
    assert.notEqual(diagnostics[0]?.blocking, true);
    assert.ok(!(await readdir(stateDir)).includes(forgedName));
    assert.ok((await readdir(join(stateDir, "quarantine"))).includes(forgedName));
    assert.match(
      await readFile(join(stateDir, "quarantine", `${forgedName}.reason.txt`), "utf8"),
      /canonical filename/,
    );
    assert.deepEqual(await broker.durableRepositoryDiagnostics(missionId), []);
  } finally {
    await env.fixture.cleanup();
  }
});

test("an unparseable record is quarantined and blocks only when it names this mission", async () => {
  const env = await mainAndLinkedWorktree();
  try {
    const { linked, linkedRepoId, stateDir } = env;
    const { broker, missionId } = brokerFor(linked, linkedRepoId, linked.root);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "candidate.unreadable.json"), "{not-json");
    let diagnostics = await broker.durableRepositoryDiagnostics(missionId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.blocking, false);
    assert.equal(diagnostics[0]?.quarantinedTo, undefined, "an unattributable file is not this mission's to move");
    assert.ok((await readdir(stateDir)).includes("candidate.unreadable.json"));

    await writeFile(join(stateDir, "candidate.mine.json"), `{"missionId":"${missionId}", truncated`);
    diagnostics = (await broker.durableRepositoryDiagnostics(missionId)).filter(
      (d) => d.file === "candidate.mine.json",
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.blocking, true);
    assert.ok((await readdir(join(stateDir, "quarantine"))).includes("candidate.mine.json"));
  } finally {
    await env.fixture.cleanup();
  }
});

test("a forged other-root path is quarantined, and a persist from another root does not re-stamp the record", async () => {
  const env = await mainAndLinkedWorktree();
  try {
    const { main, linked, mainRepoId, linkedRepoId, stateDir } = env;
    const candidate = await main.createCandidateWorktree(await main.headCommit(), {
      missionId: "MSN-restamp",
      repoId: mainRepoId,
      missionGeneration: 1,
      candidateGeneration: 0,
      repositoryGeneration: 1,
      attempt: "EXC-restamp",
    });
    const name = candidateFileName(candidate);
    const stored = JSON.parse(await readFile(join(stateDir, name), "utf8")) as CandidateLifecycle;

    // Legacy record (no rootHash) written by the main root, adopted and updated from the linked root.
    const { rootHash: _drop, ...legacy } = stored;
    await writeFile(join(stateDir, name), JSON.stringify(legacy));
    const loaded = (await linked.loadCandidateLifecycleInventory("MSN-restamp", mainRepoId)).records;
    assert.equal(loaded.length, 1);
    const updated = { ...loaded[0]!, state: "preserved" as const };
    await linked.persistCandidateLifecycle(updated);
    assert.equal(updated.rootHash, undefined, "a foreign path must not be stamped with this root");
    const again = await linked.loadCandidateLifecycleInventory("MSN-restamp", mainRepoId);
    assert.deepEqual(again.diagnostics, []);
    assert.equal(again.records.length, 1);
    assert.ok(!(await readdir(stateDir)).includes("quarantine"));

    // A forged absolute path outside the pi-eng sibling namespace is quarantined.
    const forged = { ...legacy, rootHash: "1".repeat(64), path: "/etc/forged" } as CandidateLifecycle;
    const forgedName = candidateFileName(forged);
    await writeFile(join(stateDir, forgedName), JSON.stringify(forged));
    const inventory = await main.loadCandidateLifecycleInventory("MSN-restamp", mainRepoId);
    assert.equal(inventory.diagnostics.length, 1);
    assert.equal(inventory.diagnostics[0]?.quarantinedTo, `quarantine/${forgedName}`);
    const reason = await readFile(join(stateDir, "quarantine", `${forgedName}.reason.txt`), "utf8");
    assert.match(reason, /\/etc\/forged/);
    assert.equal(linkedRepoId === mainRepoId, false);

    // Worktree-shaped name, but not beside this repo and not listed by git.
    const elsewhere = {
      ...legacy,
      rootHash: "2".repeat(64),
      path: `/tmp/x/pi-eng-abc-${stored.branch}`,
    } as CandidateLifecycle;
    const elsewhereName = candidateFileName(elsewhere);
    await writeFile(join(stateDir, elsewhereName), JSON.stringify(elsewhere));
    const second = await main.loadCandidateLifecycleInventory("MSN-restamp", mainRepoId);
    assert.equal(second.diagnostics.length, 1);
    assert.equal(second.diagnostics[0]?.quarantinedTo, `quarantine/${elsewhereName}`);
  } finally {
    await env.fixture.cleanup();
  }
});
