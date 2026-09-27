import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);
const fileLockModule = pathToFileURL(
  fileURLToPath(new URL("../../src/platform/eventstore/fileLock.ts", import.meta.url)),
).href;

test("git repo detection and head commit", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = await GitRepo.open(fixture.root);
    assert.ok(repo);
    const head = await repo.headCommit();
    assert.match(head, /^[0-9a-f]{40}$/);
    const branch = await repo.currentBranch();
    assert.ok(branch === "master" || branch === "main");
  } finally {
    await fixture.cleanup();
  }
});

test("worktree isolation creates an isolated candidate branch (INV-004)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const branch = "pi-eng-isolation-test";
    const wt = await repo.createWorktree(head, branch);
    try {
      assert.ok(wt.path);
      // Make a change in the worktree and commit it.
      await writeFile(join(wt.path, "src", "add.js"), "export const add = (a,b) => a+b;\n");
      await repo.commitAll(wt.path, "test change");
      const newHead = await repo.headCommitIn(wt.path);
      const diff = await repo.captureDiff(head, newHead);
      assert.ok(diff.includes("add.js"));
      const files = await repo.changedFiles(head, newHead);
      assert.ok(files.includes("src/add.js"));
    } finally {
      await repo.removeWorktree(wt);
    }
    // The branch ref still exists (lineage preserved) even though worktree is gone.
    const repo2 = (await GitRepo.open(fixture.root))!;
    const branches = await repo2.status();
    assert.ok(typeof branches === "string");
  } finally {
    await fixture.cleanup();
  }
});

test("worktrees are created OUTSIDE the repo tree, even when opened from a subdir (review MED #3)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    // Open the repo from a subdirectory, as a user might when running /engineer
    // from <repo>/src.
    const subdirRepo = (await GitRepo.open(join(fixture.root, "src")))!;
    const head = await subdirRepo.headCommit();
    const wt = await subdirRepo.createWorktree(head, "pi-eng-subdir-test");
    try {
      assert.ok(wt.path, "worktree should be created");
      // The worktree must be a sibling of the repo root, NOT inside it (it must
      // not appear as an untracked directory in the main working tree).
      assert.ok(
        !wt.path.startsWith(`${fixture.root}/`),
        `worktree ${wt.path} must not live inside the repo root ${fixture.root}`,
      );
    } finally {
      await subdirRepo.removeWorktree(wt);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: clean repo at HEAD is fresh (empty)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    assert.deepEqual(await repo.changedPathsSince(head, ["src/"]), []);
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: uncommitted in-scope change is stale, out-of-scope is fresh", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    await writeFile(join(fixture.root, "src", "add.js"), "export function add(a,b){return a+b;}\n");
    assert.ok((await repo.changedPathsSince(head, ["src/"])).length > 0, "in-scope change must be stale");
    assert.deepEqual(await repo.changedPathsSince(head, ["src/ledger/"]), [], "out-of-scope must be fresh");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: committed change is detected", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    await writeFile(join(fixture.root, "src", "add.js"), "export function add(a,b){return a+b;}\n");
    await exec("git", ["-C", fixture.root, "add", "-A"]);
    await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "change"]);
    assert.ok((await repo.changedPathsSince(head, ["src/"])).length > 0, "committed change must be stale");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: empty commit is never fresh (fail-safe)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const changed = await repo.changedPathsSince("", ["src/"]);
    assert.ok(changed.length > 0, "empty/placeholder commit must be stale, never fresh");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: unknown commit (git error) is stale (fail-safe)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const changed = await repo.changedPathsSince("0000000000000000000000000000000000000000", ["src/"]);
    assert.ok(changed.length > 0, "unknown commit (git error) must be stale, never fresh");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: glob pathspec matches a new test file", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(fixture.root, "test", "unit"), { recursive: true });
    await writeFile(join(fixture.root, "test", "unit", "roadmap-x.test.ts"), "export const x = 1;\n");
    assert.ok((await repo.changedPathsSince(head, ["test/unit/roadmap*"])).length > 0, "glob must match new file");
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `EngineeringRuntime.createCandidateWorktree` asserts that worktree creation
 * is safe to run concurrently (tournament legs and parallel DAG waves create
 * candidates at the same time). This pins that contract: distinct paths, all
 * usable. It does NOT reproduce the rare `.git/worktrees/…/HEAD` failure seen
 * once under full-suite load — that mechanism is still unidentified.
 */
test("concurrent worktree creation yields distinct usable worktrees", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const branches = ["pi-eng-race-a", "pi-eng-race-b", "pi-eng-race-c", "pi-eng-race-d"];
    const worktrees = await Promise.all(branches.map((branch) => repo.createWorktree(head, branch)));
    try {
      assert.equal(new Set(worktrees.map((w) => w.path)).size, branches.length, "each candidate gets its own path");
      for (const wt of worktrees) assert.equal(await repo.headCommitIn(wt.path), head);
    } finally {
      for (const wt of worktrees) await repo.removeWorktree(wt).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a conflicting second handoff mutates only the preserved integration candidate", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const incumbentStatus = await repo.status();
    const first = await repo.createWorktree(base, "handoff-first");
    const second = await repo.createWorktree(base, "handoff-second");
    const candidate = await repo.createWorktree(base, "integration-candidate");
    try {
      await writeFile(join(first.path, "src", "add.js"), "export const value = 'first';\n");
      await repo.commitAll(first.path, "first handoff");
      await writeFile(join(second.path, "src", "add.js"), "export const value = 'second';\n");
      await repo.commitAll(second.path, "second handoff");

      assert.equal((await repo.mergeRefInWorktree(candidate, first.branch)).merged, true);
      const conflict = await repo.mergeRefInWorktree(candidate, second.branch);

      assert.equal(conflict.conflict, true);
      assert.equal(await repo.headCommit(), base, "incumbent HEAD must not move");
      assert.equal(await repo.status(), incumbentStatus, "incumbent index/tree must remain untouched");
      assert.ok(await repo.resolveCommit(candidate.branch), "candidate ref must remain inspectable");
      assert.notEqual(await repo.headCommitIn(candidate.path), base, "successful first handoff remains on candidate");
    } finally {
      await repo.removeWorktree(first, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(second, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("candidate promotion refuses incumbent divergence without touching index or tree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createWorktree(base, "promotion-candidate");
    try {
      await writeFile(join(candidate.path, "src", "candidate.js"), "export const candidate = true;\n");
      await repo.commitAll(candidate.path, "candidate");
      await writeFile(join(fixture.root, "src", "incumbent.js"), "export const incumbent = true;\n");
      await exec("git", ["-C", fixture.root, "add", "-A"]);
      await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "incumbent diverged"]);
      const diverged = await repo.headCommit();

      const promoted = await repo.promoteCandidate(candidate, base);

      assert.equal(promoted.promoted, false);
      assert.match(promoted.reason ?? "", /diverged/i);
      assert.equal(await repo.headCommit(), diverged);
      assert.equal(await repo.status(), "");
      assert.ok(await repo.resolveCommit(candidate.branch));
    } finally {
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("candidate promotion refuses an untracked path collision without overwriting it", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createWorktree(base, "untracked-collision-candidate");
    try {
      await writeFile(join(candidate.path, "collision.ts"), "candidate\n");
      await repo.commitAll(candidate.path, "candidate collision");
      await writeFile(join(fixture.root, "collision.ts"), "incumbent untracked\n");

      const promoted = await repo.promoteCandidate(candidate, base);

      assert.equal(promoted.promoted, false);
      assert.match(promoted.reason ?? "", /clean|untracked/i);
      assert.equal(await repo.headCommit(), base);
      assert.equal(
        await (await import("node:fs/promises")).readFile(join(fixture.root, "collision.ts"), "utf8"),
        "incumbent untracked\n",
      );
    } finally {
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("candidate promotion is idempotent when restart observes candidate HEAD", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-restart",
      repoId: "repo-restart",
      missionGeneration: 4,
      candidateGeneration: 0,
      repositoryGeneration: 4,
      attempt: "attempt-1",
    });
    try {
      await writeFile(join(candidate.path, "src", "promoted.js"), "export const promoted = true;\n");
      await repo.commitAll(candidate.path, "candidate promoted");
      const first = await repo.promoteCandidate(candidate, base, undefined, candidate);
      const reopened = (await GitRepo.open(fixture.root))!;
      const reconciled = await reopened.promoteCandidate(candidate, base, undefined, candidate);

      assert.equal(first.promoted, true);
      assert.equal(reconciled.promoted, true);
      assert.equal(reconciled.alreadyPromoted, true);
      assert.equal(await reopened.headCommit(), first.candidateSha);
      const stateDir = join(await reopened.commonDir(), "pi-engineering-candidates");
      const promotionRecords = (await (await import("node:fs/promises")).readdir(stateDir)).filter((name) =>
        name.startsWith("promotion."),
      );
      const records = await Promise.all(
        promotionRecords.map(
          async (name) =>
            JSON.parse(await (await import("node:fs/promises")).readFile(join(stateDir, name), "utf8")) as {
              candidateSha: string;
              state: string;
            },
        ),
      );
      assert.ok(
        records.some((record) => record.candidateSha === first.candidateSha && record.state === "completed"),
        "restart reconciliation must durably complete the candidate-SHA-keyed promotion record",
      );
    } finally {
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("candidate lifecycle preserves an earlier attempt and remounts its exact persisted SHA after restart", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const first = await repo.createCandidateWorktree(base, {
      missionId: "MSN-preserve",
      repoId: "repo-preserve",
      missionGeneration: 9,
      candidateGeneration: 0,
      repositoryGeneration: 9,
      attempt: "attempt-1",
    });
    let second: Awaited<ReturnType<GitRepo["createCandidateWorktree"]>> | undefined;
    try {
      await writeFile(join(first.path, "src", "preserved.js"), "export const preserved = true;\n");
      await repo.commitAll(first.path, "preserved candidate");
      first.candidateSha = await repo.headCommitIn(first.path);
      first.state = "preserved";
      first.updatedAt = new Date().toISOString();
      await repo.persistCandidateLifecycle(first);

      await assert.rejects(
        repo.createCandidateWorktree(base, {
          missionId: "MSN-preserve",
          repoId: "repo-preserve",
          missionGeneration: 9,
          candidateGeneration: 0,
          repositoryGeneration: 9,
          attempt: "attempt-1",
        }),
        /preserved candidate attempt already exists/i,
      );
      assert.equal(
        await repo.resolveCommit(first.branch),
        first.candidateSha,
        "same-attempt retry must preserve its ref",
      );

      second = await repo.createCandidateWorktree(base, {
        missionId: "MSN-preserve",
        repoId: "repo-preserve",
        missionGeneration: 9,
        candidateGeneration: 0,
        repositoryGeneration: 10,
        attempt: "attempt-2",
      });
      assert.notEqual(second.branch, first.branch);
      assert.equal(await repo.resolveCommit(first.branch), first.candidateSha, "retry must not delete preserved ref");

      await repo.removeWorktree(first, { keepBranch: true });
      const reopened = (await GitRepo.open(fixture.root))!;
      const persisted = (await reopened.loadCandidateLifecycles("MSN-preserve", "repo-preserve")).find(
        (record) => record.attempt === "attempt-1",
      );
      assert.ok(persisted);
      assert.ok(await reopened.reconcileCandidateWorktree(persisted));
      assert.equal(await reopened.headCommitIn(persisted.path), first.candidateSha);
    } finally {
      await repo.removeWorktree(first, { keepBranch: true }).catch(() => {});
      if (second) await repo.removeWorktree(second, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("promotion crash boundaries reconcile only from the exact durable intent", async () => {
  for (const crashAt of ["afterCas", "afterReset", "afterCandidateState", "afterCompletion"] as const) {
    const fixture = await makeFixtureRepo();
    try {
      const repo = (await GitRepo.open(fixture.root))!;
      const base = await repo.headCommit();
      const candidate = await repo.createCandidateWorktree(base, {
        missionId: `MSN-crash-${crashAt}`,
        repoId: "repo-crash",
        missionGeneration: 7,
        candidateGeneration: 3,
        repositoryGeneration: 11,
        attempt: `EX-${crashAt}`,
      });
      await writeFile(join(candidate.path, "src", `crash-${crashAt}.js`), "export const recovered = true;\n");
      await repo.commitAll(candidate.path, `candidate ${crashAt}`);
      candidate.candidateSha = await repo.headCommitIn(candidate.path);
      await repo.persistCandidateLifecycle(candidate);

      await assert.rejects(
        repo.promoteCandidate(candidate, base, undefined, candidate, {
          [crashAt]: () => {
            throw new Error(`crash:${crashAt}`);
          },
        }),
        new RegExp(`crash:${crashAt}`),
      );

      const reopened = (await GitRepo.open(fixture.root))!;
      const identity = {
        missionId: candidate.missionId,
        repoId: candidate.repoId,
        missionGeneration: candidate.missionGeneration,
        candidateGeneration: candidate.candidateGeneration,
        repositoryGeneration: candidate.repositoryGeneration,
        attempt: candidate.attempt,
        baseSha: candidate.baseSha,
        candidateSha: candidate.candidateSha,
      };
      if (crashAt === "afterCas") {
        await assert.rejects(
          reopened.reconcilePromotion(identity, {
            assertAuthoritative: () => {
              throw new Error("stale recovery authority");
            },
          }),
          /stale recovery authority/,
        );
        assert.equal(await reopened.headCommit(), candidate.candidateSha, "committed CAS must not be rolled back");
      }
      const recovered = await reopened.reconcilePromotion(identity);
      assert.equal(recovered.promoted, true, crashAt);
      assert.equal(recovered.alreadyPromoted, true, crashAt);
      assert.equal(await reopened.headCommit(), candidate.candidateSha);
      const records = await reopened.loadPromotionLifecycles(candidate.missionId, candidate.repoId);
      assert.equal(records.at(-1)?.state, "completed");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("HEAD at a candidate SHA is not treated as promoted without its exact durable intent", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-no-intent",
      repoId: "repo-no-intent",
      missionGeneration: 2,
      candidateGeneration: 4,
      repositoryGeneration: 8,
      attempt: "EX-no-intent",
    });
    await writeFile(join(candidate.path, "src", "no-intent.js"), "export const noIntent = true;\n");
    await repo.commitAll(candidate.path, "candidate without promotion intent");
    candidate.candidateSha = await repo.headCommitIn(candidate.path);
    await repo.persistCandidateLifecycle(candidate);
    await exec("git", ["-C", fixture.root, "update-ref", "HEAD", candidate.candidateSha, base]);

    const result = await repo.promoteCandidate(candidate, base, undefined, candidate);

    assert.equal(result.promoted, false);
    assert.match(result.reason ?? "", /exact durable promotion intent/i);
  } finally {
    await fixture.cleanup();
  }
});

test("a crash after a candidate merge advances the ref once and journal replay does not merge twice", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const handoff = await repo.createWorktree(base, "journal-handoff");
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-merge-journal",
      repoId: "repo-merge-journal",
      missionGeneration: 5,
      candidateGeneration: 6,
      repositoryGeneration: 9,
      attempt: "EX-merge-journal",
    });
    try {
      await writeFile(join(handoff.path, "src", "journal.js"), "export const journal = true;\n");
      await repo.commitAll(handoff.path, "journal handoff");
      await assert.rejects(
        repo.mergeRefInWorktree(candidate, handoff.branch, undefined, candidate, 0, {
          afterMutation: () => {
            throw new Error("crash:after-merge");
          },
        }),
        /crash:after-merge/,
      );
      const advanced = await repo.headCommitIn(candidate.path);

      const reopened = (await GitRepo.open(fixture.root))!;
      const persisted = (await reopened.loadCandidateLifecycles(candidate.missionId, candidate.repoId)).find(
        (record) => record.attempt === candidate.attempt,
      );
      assert.ok(persisted);
      const replayed = await reopened.mergeRefInWorktree(persisted, handoff.branch, undefined, persisted, 0);

      assert.equal(replayed.merged, true);
      assert.equal(await reopened.headCommitIn(candidate.path), advanced);
      assert.equal(persisted.merges?.[0]?.state, "completed");
      assert.equal(persisted.merges?.[0]?.afterSha, advanced);
    } finally {
      await repo.removeWorktree(handoff, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("an interrupted candidate check remains an intent and is durably completed after restart", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-check-journal",
      repoId: "repo-check-journal",
      missionGeneration: 3,
      candidateGeneration: 2,
      repositoryGeneration: 7,
      attempt: "EX-check-journal",
    });
    await repo.beginCandidateCheck(candidate, "integration-verifier");

    const reopened = (await GitRepo.open(fixture.root))!;
    const persisted = (await reopened.loadCandidateLifecycles(candidate.missionId, candidate.repoId)).find(
      (record) => record.attempt === candidate.attempt,
    );
    assert.equal(persisted?.checks?.[0]?.state, "intent");
    await reopened.beginCandidateCheck(persisted!, "integration-verifier");
    await reopened.completeCandidateCheck(persisted!, "integration-verifier", true);

    const completed = (await reopened.loadCandidateLifecycles(candidate.missionId, candidate.repoId)).find(
      (record) => record.attempt === candidate.attempt,
    );
    assert.equal(completed?.checks?.[0]?.state, "completed");
    assert.equal(completed?.checks?.[0]?.passed, true);
    await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
  } finally {
    await fixture.cleanup();
  }
});

test("promotion uses the tokenized exclusive lock across child-process acquisition races", async () => {
  const fixture = await makeFixtureRepo();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createWorktree(base, "promotion-lock-race");
    await writeFile(join(candidate.path, "src", "lock-race.js"), "export const lockRace = true;\n");
    await repo.commitAll(candidate.path, "promotion lock race candidate");
    const lockFile = join(await repo.commonDir(), "pi-engineering-promotion");
    const script = `
      import { ExclusiveFileLock } from ${JSON.stringify(fileLockModule)};
      const lock = await ExclusiveFileLock.acquire(${JSON.stringify(lockFile)});
      process.stdout.write("READY\\n");
      process.on("message", (message) => {
        if (message === "close") {
          lock.release();
          process.exit(0);
        }
      });
    `;
    child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      child!.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child!.stdout!.on("data", (chunk) => {
        if (String(chunk).includes("READY")) resolve();
      });
      child!.once("exit", (code) => reject(new Error(`lock owner exited early (${code}): ${stderr}`)));
    });

    const blocked = await repo.promoteCandidate(candidate, base);

    assert.equal(blocked.promoted, false);
    assert.match(blocked.reason ?? "", /critical section.*held/i);
    child.send("close");
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child = undefined;
    const acquiredAfterRelease = await repo.promoteCandidate(candidate, base);
    assert.equal(acquiredAfterRelease.promoted, true);
    await repo.removeWorktree(candidate, { keepBranch: true });
  } finally {
    child?.kill("SIGKILL");
    await fixture.cleanup();
  }
});
