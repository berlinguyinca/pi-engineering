import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { CandidateLifecycle, IntegrationRunRecord } from "../../src/git/GitRepo.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

// Concurrent persists of the SAME record/target from the SAME process used to
// share one `<target>.<pid>.tmp` temp name. The first rename consumed the temp
// file and the second threw `ENOENT`, failing the whole integration step. Each
// persist call now uses a unique temp name (randomUUID), so concurrent calls for
// the same target must all succeed and leave a valid JSON journal on disk.

const sha = (c: string): string => c.repeat(40);
const updatedAt = new Date().toISOString();

interface PrivatePersists {
  persistPendingBranchCleanup(record: Record<string, unknown>, guard?: unknown): Promise<void>;
  persistPromotionLifecycle(record: Record<string, unknown>, guard?: unknown): Promise<void>;
}

test("concurrent persists of the same candidate record never ENOENT and leave valid JSON", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const record: CandidateLifecycle = {
      candidateId: "cand-1",
      missionId: "MSN-1",
      repoId: "repo-1",
      missionGeneration: 1,
      candidateGeneration: 1,
      repositoryGeneration: 1,
      attempt: "attempt-1",
      branch: "branch",
      path: join(fixture.root, "cand"),
      baseSha: sha("a"),
      candidateSha: sha("b"),
      state: "integrating",
      updatedAt,
    };

    await Promise.all(Array.from({ length: 64 }, () => repo.persistCandidateLifecycle(record)));

    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const journals = (await readdir(stateDir)).filter((n) => n.startsWith("candidate.") && n.endsWith(".json"));
    assert.ok(journals.length >= 1, "a candidate journal must exist");
    for (const name of journals) {
      const parsed = JSON.parse(await readFile(join(stateDir, name), "utf8")) as Record<string, unknown>;
      assert.equal(parsed.candidateId, "cand-1");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent integration-run persists of the same record never ENOENT", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const record: IntegrationRunRecord = {
      candidateId: "cand-1",
      runId: "run-1",
      missionId: "MSN-1",
      repoId: "repo-1",
      missionGeneration: 1,
      candidateGeneration: 1,
      startingCandidateSha: sha("a"),
      candidateSha: sha("b"),
      state: "running",
      merges: [],
      checks: [],
      updatedAt,
    };

    await Promise.all(Array.from({ length: 64 }, () => repo.persistIntegrationRun(record)));

    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const journals = (await readdir(stateDir)).filter((n) => n.startsWith("run.") && n.endsWith(".json"));
    assert.ok(journals.length >= 1, "an integration-run journal must exist");
    for (const name of journals) {
      const parsed = JSON.parse(await readFile(join(stateDir, name), "utf8")) as Record<string, unknown>;
      assert.equal(parsed.runId, "run-1");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent promotion and cleanup persists of the same record never ENOENT", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const privateRepo = repo as unknown as PrivatePersists;
    const promotion = {
      candidateId: "cand-1",
      missionId: "MSN-1",
      repoId: "repo-1",
      missionGeneration: 1,
      candidateGeneration: 1,
      repositoryGeneration: 1,
      candidateRepositoryGeneration: 1,
      originRepositoryGeneration: 1,
      attempt: "attempt-1",
      integrationRunId: "run-1",
      candidateSha: sha("b"),
      baseSha: sha("a"),
      state: "intent",
      updatedAt,
    };
    const cleanup = {
      missionId: "MSN-1",
      repoId: "repo-1",
      path: join(fixture.root, "cand"),
      branch: "branch",
      state: "intent",
      updatedAt,
    };

    await Promise.all([
      ...Array.from({ length: 32 }, () => privateRepo.persistPromotionLifecycle(promotion)),
      ...Array.from({ length: 32 }, () => privateRepo.persistPendingBranchCleanup(cleanup)),
    ]);

    const stateDir = join(await repo.commonDir(), "pi-engineering-candidates");
    const names = await readdir(stateDir);
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const parsed = JSON.parse(await readFile(join(stateDir, name), "utf8")) as Record<string, unknown>;
      assert.ok(parsed && typeof parsed === "object", "each journal must parse as JSON");
    }
  } finally {
    await fixture.cleanup();
  }
});
