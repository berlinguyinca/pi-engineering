import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitQueryError, GitRepo } from "../../src/git/GitRepo.ts";
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

test("safety-critical Git queries throw typed errors instead of synthesizing empty state", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const injectable = repo as unknown as {
      git(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
    };
    injectable.git = async () => ({ stdout: "", stderr: "injected query failure", code: 77 });
    for (const query of [
      () => repo.captureDiff(head, head),
      () => repo.changedFiles(head, head),
      () => repo.statusPathsIn(fixture.root),
      () => repo.statusIn(fixture.root),
    ]) {
      await assert.rejects(query, (error: unknown) => {
        assert.ok(error instanceof GitQueryError);
        assert.equal(error.code, "GIT_QUERY_FAILED");
        assert.match(error.message, /injected query failure/);
        return true;
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("candidate promotion performs no mutation when its clean-status query fails", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createWorktree(base, "promotion-query-failure");
    await writeFile(join(candidate.path, "src", "promotion-query.ts"), "export const promoted = true;\n");
    await repo.commitAll(candidate.path, "candidate change");
    repo.statusIn = async () => {
      throw new GitQueryError("candidate status", ["status"], 77, "injected promotion query failure");
    };
    await assert.rejects(() => repo.promoteCandidate(candidate, base), /injected promotion query failure/);
    assert.equal(await repo.headCommit(), base);
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
        parentCandidateId: first.candidateId,
        seedSha: first.candidateSha,
      });
      assert.notEqual(second.branch, first.branch);
      assert.equal(second.parentCandidateId, first.candidateId);
      assert.equal(second.seedSha, first.candidateSha);
      assert.equal(second.candidateSha, first.candidateSha, "repair child must start from the preserved parent tip");
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

test("integration runs keep independent sequence-zero journals and freeze every handoff SHA", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const first = await repo.createWorktree(base, "run-journal-first");
    const second = await repo.createWorktree(base, "run-journal-second");
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-run-journals",
      repoId: "repo-run-journals",
      missionGeneration: 4,
      candidateGeneration: 2,
      repositoryGeneration: 8,
      attempt: "creation-execution",
    });
    try {
      await writeFile(join(first.path, "src", "first-run.ts"), "export const first = 1;\n");
      await repo.commitAll(first.path, "first run handoff");
      const frozenFirst = await repo.headCommitIn(first.path);
      const runOne = await repo.beginIntegrationRun(candidate, "integration-run-one", [first.branch]);
      await writeFile(join(first.path, "src", "future.ts"), "export const future = true;\n");
      await repo.commitAll(first.path, "future handoff mutation");
      const futureTip = await repo.headCommitIn(first.path);
      await repo.mergeRefInWorktree(candidate, first.branch, undefined, candidate, 0, {}, runOne);
      assert.equal(await repo.isAncestor(frozenFirst, candidate.candidateSha), true);
      assert.equal(
        await repo.isAncestor(futureTip, candidate.candidateSha),
        false,
        "future ref movement is not merged",
      );

      await writeFile(join(second.path, "src", "second-run.ts"), "export const second = 2;\n");
      await repo.commitAll(second.path, "second run handoff");
      const runTwo = await repo.beginIntegrationRun(candidate, "integration-run-two", [second.branch]);
      await repo.mergeRefInWorktree(candidate, second.branch, undefined, candidate, 0, {}, runTwo);

      const persisted = await repo.loadIntegrationRuns(candidate.missionId, candidate.repoId);
      assert.deepEqual(
        persisted.map((run) => [run.runId, run.merges[0]?.sequence, run.merges[0]?.state]),
        [
          ["integration-run-one", 0, "completed"],
          ["integration-run-two", 0, "completed"],
        ],
      );
      assert.equal(candidate.attempt, "creation-execution", "later runs never rewrite candidate creation identity");
    } finally {
      await repo.removeWorktree(first, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(second, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("conflict recovery journals abort intent and refuses to complete a failed abort", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const first = await repo.createWorktree(base, "abort-first");
    const conflict = await repo.createWorktree(base, "abort-conflict");
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-abort-journal",
      repoId: "repo-abort-journal",
      missionGeneration: 1,
      candidateGeneration: 1,
      repositoryGeneration: 1,
      attempt: "creator",
    });
    try {
      await writeFile(join(first.path, "src", "abort.ts"), "export const value = 'first';\n");
      await repo.commitAll(first.path, "first");
      await writeFile(join(conflict.path, "src", "abort.ts"), "export const value = 'conflict';\n");
      await repo.commitAll(conflict.path, "conflict");
      const runOne = await repo.beginIntegrationRun(candidate, "run-one", [first.branch]);
      await repo.mergeRefInWorktree(candidate, first.branch, undefined, candidate, 0, {}, runOne);
      const stableHead = candidate.candidateSha;
      const runTwo = await repo.beginIntegrationRun(candidate, "run-two", [conflict.branch]);

      await assert.rejects(
        repo.mergeRefInWorktree(
          candidate,
          conflict.branch,
          undefined,
          candidate,
          0,
          {
            abortMerge: async () => ({ stdout: "", stderr: "locked", code: 1 }),
          },
          runTwo,
        ),
        /conflict abort failed.*locked/i,
      );
      const interrupted = (await repo.loadIntegrationRuns(candidate.missionId, candidate.repoId)).find(
        (run) => run.runId === "run-two",
      );
      assert.equal(interrupted?.merges[0]?.state, "abort_intent");

      const reopened = (await GitRepo.open(fixture.root))!;
      const recoveredCandidate = (await reopened.loadCandidateLifecycles(candidate.missionId, candidate.repoId))[0]!;
      const recoveredRun = (await reopened.loadIntegrationRuns(candidate.missionId, candidate.repoId)).find(
        (run) => run.runId === "run-two",
      )!;
      const result = await reopened.mergeRefInWorktree(
        recoveredCandidate,
        conflict.branch,
        undefined,
        recoveredCandidate,
        0,
        {},
        recoveredRun,
      );
      assert.equal(result.conflict, true);
      assert.equal(await reopened.headCommitIn(candidate.path), stableHead);
      assert.equal(recoveredRun.merges[0]?.state, "completed");
    } finally {
      await repo.removeWorktree(first, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(conflict, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("restart detects a dirty conflicted merge intent and aborts it before recording conflict", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const first = await repo.createWorktree(base, "dirty-replay-first");
    const conflict = await repo.createWorktree(base, "dirty-replay-conflict");
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-dirty-replay",
      repoId: "repo-dirty-replay",
      missionGeneration: 1,
      candidateGeneration: 1,
      repositoryGeneration: 1,
      attempt: "creator",
    });
    try {
      await writeFile(join(first.path, "src", "dirty-replay.ts"), "export const value = 'first';\n");
      await repo.commitAll(first.path, "first");
      await writeFile(join(conflict.path, "src", "dirty-replay.ts"), "export const value = 'conflict';\n");
      await repo.commitAll(conflict.path, "conflict");
      const firstRun = await repo.beginIntegrationRun(candidate, "first-run", [first.branch]);
      await repo.mergeRefInWorktree(candidate, first.branch, undefined, candidate, 0, {}, firstRun);
      const stableHead = candidate.candidateSha;
      const conflictRun = await repo.beginIntegrationRun(candidate, "conflict-run", [conflict.branch]);
      await assert.rejects(
        repo.mergeRefInWorktree(
          candidate,
          conflict.branch,
          undefined,
          candidate,
          0,
          {
            afterConflict: () => {
              throw new Error("crash with MERGE_HEAD");
            },
          },
          conflictRun,
        ),
        /crash with MERGE_HEAD/,
      );

      const reopened = (await GitRepo.open(fixture.root))!;
      const durableCandidate = (await reopened.loadCandidateLifecycles(candidate.missionId, candidate.repoId))[0]!;
      const durableRun = (await reopened.loadIntegrationRuns(candidate.missionId, candidate.repoId)).find(
        (run) => run.runId === "conflict-run",
      )!;
      assert.equal(durableRun.merges[0]?.state, "intent");
      const recovered = await reopened.mergeRefInWorktree(
        durableCandidate,
        conflict.branch,
        undefined,
        durableCandidate,
        0,
        {},
        durableRun,
      );
      assert.equal(recovered.conflict, true);
      assert.equal(await reopened.headCommitIn(candidate.path), stableHead);
      assert.equal(await reopened.statusIn(candidate.path), "");
    } finally {
      await repo.removeWorktree(first, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(conflict, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("locked worktree removal fails explicitly and succeeds on authoritative retry", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const worktree = await repo.createWorktree(await repo.headCommit(), "locked-removal");
    await exec("git", ["-C", fixture.root, "worktree", "lock", worktree.path]);
    await assert.rejects(repo.removeWorktree(worktree), /worktree remove failed.*locked/i);
    assert.equal(await repo.headCommitIn(worktree.path), await repo.headCommit());
    await exec("git", ["-C", fixture.root, "worktree", "unlock", worktree.path]);
    await repo.removeWorktree(worktree);
    assert.equal(await repo.resolveCommit(worktree.branch), null);
  } finally {
    await fixture.cleanup();
  }
});

test("branch deletion failure remains retryable after the worktree has already been removed", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const worktree = await repo.createWorktree(await repo.headCommit(), "branch-delete-retry");
    await assert.rejects(
      repo.removeWorktree(
        worktree,
        { cleanupIdentity: { missionId: "MSN-cleanup", repoId: "repo-cleanup" } },
        undefined,
        {
          deleteBranch: async () => ({ stdout: "", stderr: "simulated branch lock", code: 1 }),
        },
      ),
      /branch delete failed.*simulated branch lock/i,
    );
    await assert.rejects(access(worktree.path));
    assert.ok(await repo.resolveCommit(worktree.branch), "branch-only pending cleanup must remain addressable");
    const pending = await repo.loadPendingBranchCleanups("MSN-cleanup", "repo-cleanup");
    assert.equal(pending.length, 1);
    assert.deepEqual(
      {
        missionId: pending[0]?.missionId,
        repoId: pending[0]?.repoId,
        path: pending[0]?.path,
        branch: pending[0]?.branch,
      },
      { missionId: "MSN-cleanup", repoId: "repo-cleanup", path: worktree.path, branch: worktree.branch },
    );

    await repo.removeWorktree(worktree, { cleanupIdentity: { missionId: "MSN-cleanup", repoId: "repo-cleanup" } });
    assert.equal(await repo.resolveCommit(worktree.branch), null);
    assert.deepEqual(await repo.loadPendingBranchCleanups("MSN-cleanup", "repo-cleanup"), []);
  } finally {
    await fixture.cleanup();
  }
});

test("cleanup write-ahead phases reconcile after crashes with absent worktree or branch", async () => {
  for (const crashAt of ["afterIntent", "afterWorktreeRemoved", "afterBranchDeleted"] as const) {
    const fixture = await makeFixtureRepo();
    try {
      const repo = (await GitRepo.open(fixture.root))!;
      const worktree = await repo.createWorktree(await repo.headCommit(), `cleanup-${crashAt}`);
      const identity = { missionId: `MSN-${crashAt}`, repoId: "repo-cleanup-phases" };
      await assert.rejects(
        repo.removeWorktree(worktree, { cleanupIdentity: identity }, undefined, {
          [crashAt]: () => {
            throw new Error(`crash:${crashAt}`);
          },
        }),
        new RegExp(`crash:${crashAt}`),
      );
      const pending = await repo.loadPendingBranchCleanups(identity.missionId, identity.repoId);
      assert.equal(pending.length, 1);
      assert.equal(
        pending[0]?.state,
        crashAt === "afterIntent"
          ? "intent"
          : crashAt === "afterWorktreeRemoved"
            ? "worktree_removed"
            : "branch_deleted",
      );

      const reopened = (await GitRepo.open(fixture.root))!;
      await reopened.removeWorktree(worktree, { cleanupIdentity: identity });
      assert.equal(await reopened.resolveCommit(worktree.branch), null);
      await assert.rejects(access(worktree.path));
      assert.deepEqual(await reopened.loadPendingBranchCleanups(identity.missionId, identity.repoId), []);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("cleanup inventory reports a matching journal filename with a corrupt payload identity", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    await mkdir(stateDir, { recursive: true });
    const missionId = "MSN-cleanup-payload";
    const repoId = "repo-cleanup-payload";
    const name = `cleanup.${[missionId, repoId, "branch"]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".")}.json`;
    await writeFile(
      join(stateDir, name),
      JSON.stringify({
        missionId: "MSN-forged",
        repoId,
        path: "/tmp/forged",
        branch: "branch",
        state: "intent",
        updatedAt: new Date().toISOString(),
      }),
    );

    const inventory = await repo.loadPendingBranchCleanupInventory(missionId, repoId);
    assert.deepEqual(inventory.records, []);
    assert.equal(inventory.diagnostics.length, 1);
    assert.match(inventory.diagnostics[0]?.reason ?? "", /invalid identity or phase/);
  } finally {
    await fixture.cleanup();
  }
});

test("fresh authority reconciles only a committed exact promotion intent and never advances an old base intent", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-fresh-reconcile",
      repoId: "repo-fresh-reconcile",
      missionGeneration: 2,
      candidateGeneration: 3,
      repositoryGeneration: 5,
      attempt: "origin-execution",
    });
    await writeFile(join(candidate.path, "src", "fresh-reconcile.ts"), "export const recovered = true;\n");
    await repo.commitAll(candidate.path, "fresh reconciliation candidate");
    candidate.candidateSha = await repo.headCommitIn(candidate.path);
    await repo.persistCandidateLifecycle(candidate);

    let invalidated = false;
    await assert.rejects(
      repo.promoteCandidate(
        candidate,
        base,
        {
          assertAuthoritative: () => {
            if (invalidated) throw new Error("origin authority lost before CAS");
          },
        },
        candidate,
        {
          beforeCas: () => {
            invalidated = true;
          },
        },
      ),
      /origin authority lost before CAS/,
    );
    assert.equal(await repo.headCommit(), base);
    const pending = await repo.reconcileCommittedPromotions(candidate.missionId, candidate.repoId, {
      assertAuthoritative: () => {},
    });
    assert.equal(pending[0]?.promoted, false);
    assert.match(pending[0]?.reason ?? "", /no committed compare-and-swap/i);
    assert.equal(await repo.headCommit(), base, "recovery must not execute the old intent's CAS");

    await assert.rejects(
      repo.promoteCandidate(candidate, base, undefined, candidate, {
        afterCas: () => {
          throw new Error("crash after committed CAS");
        },
      }),
      /crash after committed CAS/,
    );
    const recovered = await repo.reconcileCommittedPromotions(candidate.missionId, candidate.repoId, {
      assertAuthoritative: () => {},
    });
    assert.ok(recovered.some((result) => result.promoted && result.alreadyPromoted));
    assert.equal(await repo.headCommit(), candidate.candidateSha);
    await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
  } finally {
    await fixture.cleanup();
  }
});

test("historical promotion identity remains idempotent across CAS origin, takeover reconciliation, and final authority", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-three-generations",
      repoId: "repo-three-generations",
      missionGeneration: 4,
      candidateGeneration: 2,
      repositoryGeneration: 1,
      attempt: "creation-execution",
    });
    await writeFile(join(candidate.path, "src", "three-generations.ts"), "export const stable = true;\n");
    await repo.commitAll(candidate.path, "three generation candidate");
    candidate.candidateSha = await repo.headCommitIn(candidate.path);
    const run = await repo.beginIntegrationRun(candidate, "integration-run", []);
    run.state = "completed";
    run.candidateSha = candidate.candidateSha;
    await repo.persistIntegrationRun(run);
    candidate.integrationRunId = run.runId;
    await repo.persistCandidateLifecycle(candidate);
    const authority = (generation: number) => ({
      repositoryIdentity: { generation },
      assertAuthoritative: () => {},
    });

    await assert.rejects(
      repo.promoteCandidate(candidate, base, authority(1), candidate, {
        afterCas: () => {
          throw new Error("crash after generation-one CAS");
        },
      }),
      /generation-one CAS/,
    );
    const takeover = await repo.reconcileCommittedPromotions(candidate.missionId, candidate.repoId, authority(2));
    assert.equal(takeover[0]?.alreadyPromoted, true);
    const finalization = await repo.promoteCandidate(candidate, base, authority(3), candidate);
    assert.equal(finalization.promoted, true);
    assert.equal(finalization.alreadyPromoted, true);
    const completed = (await repo.loadPromotionLifecycles(candidate.missionId, candidate.repoId)).at(-1)!;
    assert.equal(completed.originRepositoryGeneration, 1);
    assert.equal(completed.reconciliationRepositoryGeneration, 3);
    assert.equal(completed.candidateRepositoryGeneration, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("forged candidate and promotion identities are rejected while loading durable state", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-forged-identity",
      repoId: "repo-forged-identity",
      missionGeneration: 1,
      candidateGeneration: 1,
      repositoryGeneration: 1,
      attempt: "creation-attempt",
    });
    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const candidateFile = (await readdir(stateDir)).find(
      (name) => !name.startsWith("promotion.") && !name.startsWith("run.") && !name.startsWith("cleanup."),
    )!;
    const forgedCandidate = JSON.parse(await readFile(join(stateDir, candidateFile), "utf8")) as Record<
      string,
      unknown
    >;
    forgedCandidate.candidateId = "forged-candidate-id";
    await writeFile(join(stateDir, candidateFile), JSON.stringify(forgedCandidate));
    const candidateInventory = await repo.loadCandidateLifecycleInventory(candidate.missionId, candidate.repoId);
    assert.deepEqual(candidateInventory.records, []);
    assert.equal(candidateInventory.diagnostics.length, 1);
    assert.match(candidateInventory.diagnostics[0]?.reason ?? "", /canonical.*filename|candidate identity/i);

    candidate.candidateId = [
      candidate.missionId,
      candidate.repoId,
      String(candidate.missionGeneration),
      String(candidate.candidateGeneration),
      candidate.attempt,
    ]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".");
    await repo.persistCandidateLifecycle(candidate);
    await writeFile(join(candidate.path, "src", "forged.ts"), "export const forged = false;\n");
    await repo.commitAll(candidate.path, "valid candidate");
    candidate.candidateSha = await repo.headCommitIn(candidate.path);
    const run = await repo.beginIntegrationRun(candidate, "identity-run", []);
    run.state = "completed";
    run.candidateSha = candidate.candidateSha;
    await repo.persistIntegrationRun(run);
    candidate.integrationRunId = run.runId;
    await repo.persistCandidateLifecycle(candidate);
    await repo.promoteCandidate(candidate, base, undefined, candidate);
    const completedPromotion = (await repo.loadPromotionLifecycles(candidate.missionId, candidate.repoId)).find(
      (record) => record.state === "completed",
    )!;
    assert.equal(
      completedPromotion.reconciliationRepositoryGeneration,
      completedPromotion.originRepositoryGeneration,
      "initial promotion completion must close the authority ordering",
    );
    let promotionFile = "";
    for (const name of (await readdir(stateDir)).filter((entry) => entry.startsWith("promotion."))) {
      const record = JSON.parse(await readFile(join(stateDir, name), "utf8")) as { state?: string };
      if (record.state === "completed") promotionFile = name;
    }
    assert.ok(promotionFile);
    const forgedPromotion = JSON.parse(await readFile(join(stateDir, promotionFile), "utf8")) as Record<
      string,
      unknown
    >;
    forgedPromotion.candidateRepositoryGeneration = 2;
    forgedPromotion.originRepositoryGeneration = 1;
    forgedPromotion.reconciliationRepositoryGeneration = 1;
    await writeFile(join(stateDir, promotionFile), JSON.stringify(forgedPromotion));
    const impossiblePromotion = await repo.loadPromotionLifecycleInventory(candidate.missionId, candidate.repoId);
    assert.equal(
      impossiblePromotion.records.some((record) => record.state === "completed"),
      false,
    );
    assert.equal(impossiblePromotion.diagnostics.length, 1);
    assert.match(impossiblePromotion.diagnostics[0]?.reason ?? "", /candidate.*origin.*reconciliation/i);

    forgedPromotion.candidateRepositoryGeneration = forgedPromotion.repositoryGeneration;
    forgedPromotion.originRepositoryGeneration = forgedPromotion.repositoryGeneration;
    delete forgedPromotion.reconciliationRepositoryGeneration;
    forgedPromotion.attempt = "different-attempt";
    await writeFile(join(stateDir, promotionFile), JSON.stringify(forgedPromotion));
    const mismatchedPromotion = await repo.loadPromotionLifecycleInventory(candidate.missionId, candidate.repoId);
    assert.equal(
      mismatchedPromotion.records.some((record) => record.state === "completed"),
      false,
    );
    assert.equal(mismatchedPromotion.diagnostics.length, 1);
    assert.match(
      mismatchedPromotion.diagnostics[0]?.reason ?? "",
      /(?:canonical.*(?:filename|identity)|identity.*canonical|authority ordering)/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("candidate replay rejects a self-consistent filename whose path and branch are not deterministic", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const candidate = await repo.createCandidateWorktree(await repo.headCommit(), {
      missionId: "MSN-forged-location",
      repoId: "repo-forged-location",
      missionGeneration: 2,
      candidateGeneration: 3,
      repositoryGeneration: 4,
      attempt: "attempt-location",
    });
    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const original = (await readdir(stateDir)).find((name) => name.startsWith("candidate."))!;
    const forged = JSON.parse(await readFile(join(stateDir, original), "utf8")) as typeof candidate;
    forged.path = join(fixture.root, "unrelated-worktree");
    forged.branch = "unrelated-branch";
    forged.seedSha = "0".repeat(40);
    forged.parentCandidateId = "forged-parent";
    forged.integrationRunId = "forged-run";
    const parts = [
      forged.candidateId,
      forged.missionId,
      forged.repoId,
      forged.missionGeneration,
      forged.candidateGeneration,
      forged.repositoryGeneration,
      forged.attempt,
      forged.baseSha,
      forged.candidateSha,
    ];
    const forgedName = `candidate.${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}.json`;
    await writeFile(join(stateDir, forgedName), JSON.stringify(forged));

    const inventory = await repo.loadCandidateLifecycleInventory(candidate.missionId, candidate.repoId);
    assert.ok(inventory.diagnostics.some((diagnostic) => diagnostic.file === forgedName));
    assert.ok(
      inventory.records.every((record) => record.path === candidate.path && record.branch === candidate.branch),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("integration run filename and payload identity must match before replay", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createCandidateWorktree(base, {
      missionId: "MSN-run-identity",
      repoId: "repo-run-identity",
      missionGeneration: 3,
      candidateGeneration: 4,
      repositoryGeneration: 5,
      attempt: "attempt-run",
    });
    const run = await repo.beginIntegrationRun(candidate, "run-one", []);
    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const runFile = (await readdir(stateDir)).find((name) => name.startsWith("run."))!;
    await writeFile(join(stateDir, runFile), JSON.stringify({ ...run, runId: "forged-run" }));

    const inventory = await repo.loadIntegrationRunInventory(candidate.missionId, candidate.repoId);
    assert.deepEqual(inventory.records, []);
    assert.equal(inventory.diagnostics.length, 1);
    assert.match(inventory.diagnostics[0]?.reason ?? "", /canonical.*filename/i);
  } finally {
    await fixture.cleanup();
  }
});

test("corrupt cleanup ownership fails closed before worktree or branch mutation", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const worktree = await repo.createWorktree(await repo.headCommit(), "cleanup-owned-target");
    const identity = { missionId: "MSN-cleanup-owner", repoId: "repo-cleanup-owner" };
    await assert.rejects(
      repo.removeWorktree(worktree, { cleanupIdentity: identity }, undefined, {
        afterIntent: () => {
          throw new Error("crash after cleanup intent");
        },
      }),
      /crash after cleanup intent/,
    );
    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const journal = (await readdir(stateDir)).find((name) => name.startsWith("cleanup."))!;
    const payload = JSON.parse(await readFile(join(stateDir, journal), "utf8")) as Record<string, unknown>;
    await writeFile(
      join(stateDir, journal),
      JSON.stringify({
        ...payload,
        missionId: "MSN-unrelated",
        repoId: "repo-unrelated",
        path: `${worktree.path}-unrelated`,
        branch: "unrelated-branch",
      }),
    );

    await assert.rejects(
      repo.removeWorktree(worktree, { cleanupIdentity: identity }),
      /cleanup journal.*identity|cleanup ownership/i,
    );
    assert.equal(await repo.headCommitIn(worktree.path), await repo.headCommit());
    assert.ok(await repo.resolveCommit(worktree.branch), "the owned branch must remain after fail-closed recovery");
    const inventory = await repo.loadPendingBranchCleanupInventory(identity.missionId, identity.repoId);
    assert.deepEqual(inventory.records, []);
    assert.equal(inventory.diagnostics.length, 1);
  } finally {
    await fixture.cleanup();
  }
});
