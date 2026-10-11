import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import {
  LaneBackendMisconfiguredError,
  LaneBlockedError,
  LaneIndexCorruptError,
  laneKeyFor,
} from "../../src/orchestration/lanes.ts";
import { GitRefLaneCoordinator } from "../../src/orchestration/lanesGit.ts";

const exec = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** One shared bare origin + two clones ("hostA", "hostB"), each with a GitRepo. */
async function twoHostFixture(leaseMs = 100, backend: "auto" | "git" = "auto") {
  const base = await mkdtemp(join(tmpdir(), "pieng-lanes-git-"));
  tempDirs.push(base);
  const origin = join(base, "origin.git");
  await exec("git", ["init", "--bare", origin]);
  // hostA seeds the origin; hostB is a fresh clone of it (shared history, the
  // realistic two-host setup — avoids divergent branch pushes).
  const workA = join(base, "hostA");
  await exec("git", ["init", workA]);
  await git(workA, "config", "user.email", "hostA@example.com");
  await git(workA, "config", "user.name", "hostA");
  await writeFile(join(workA, "README.md"), "hostA\n");
  await git(workA, "add", "README.md");
  await git(workA, "commit", "-m", "seed hostA");
  await git(workA, "remote", "add", "origin", origin);
  await git(workA, "push", "-u", "origin", "HEAD");
  const workB = join(base, "hostB");
  await git(base, "clone", "-q", origin, "hostB");
  await git(workB, "config", "user.email", "hostB@example.com");
  await git(workB, "config", "user.name", "hostB");
  const hosts: Record<string, GitRepo> = {};
  const coordinators: Record<string, GitRefLaneCoordinator> = {};
  for (const [name, work] of [
    ["hostA", workA],
    ["hostB", workB],
  ] as const) {
    const repo = await GitRepo.open(work);
    assert.ok(repo);
    hosts[name] = repo;
  }
  for (const name of ["hostA", "hostB"] as const) {
    coordinators[name] = new GitRefLaneCoordinator({
      config: { backend, leaseMs, maxRepoWriters: 4 },
      openRepo: async () => hosts[name],
      now: () => 1_000,
    });
  }
  return { origin, hosts, coordinators };
}

const input = (host: string, task: string) => ({
  repoId: "repo:/shared",
  domains: ["src/a"],
  ownerId: `${host}/owner`,
  missionId: "MSN-1",
  taskId: task,
});

describe("GitRefLaneCoordinator", () => {
  it("grants disjoint domains across hosts and both see each other's claims", async () => {
    const { coordinators } = await twoHostFixture();
    const a = await coordinators.hostA.acquire({ ...input("hostA", "TSK-1"), domains: ["src/a"] });
    assert.equal(a.taskId, "TSK-1");
    const b = await coordinators.hostB.acquire({ ...input("hostB", "TSK-2"), domains: ["src/b"] });
    assert.equal(b.taskId, "TSK-2");
    const claimsA = await coordinators.hostA.listClaims("repo:/shared");
    const claimsB = await coordinators.hostB.listClaims("repo:/shared");
    assert.equal(claimsA.length, 2);
    assert.deepEqual(claimsB.map((c) => c.taskId).sort(), ["TSK-1", "TSK-2"]);
  });

  it("rejects an overlapping domain across hosts, naming the blocker's owner", async () => {
    const { coordinators } = await twoHostFixture();
    await coordinators.hostA.acquire(input("hostA", "TSK-1"));
    await assert.rejects(
      coordinators.hostB.acquire({ ...input("hostB", "TSK-2"), domains: ["src/a/nested/**"] }),
      (error: unknown) => {
        assert.ok(error instanceof LaneBlockedError);
        assert.equal(error.blockingClaims[0]?.ownerId, "hostA/owner");
        return true;
      },
    );
  });

  it("preserves both claims under CAS contention (no lost update)", async () => {
    const { coordinators } = await twoHostFixture();
    const a = await coordinators.hostA.acquire({ ...input("hostA", "TSK-1"), domains: ["src/a"] });
    const b = await coordinators.hostB.acquire({ ...input("hostB", "TSK-2"), domains: ["src/b"] });
    await coordinators.hostA.release(a);
    const c = await coordinators.hostB.acquire({ ...input("hostB", "TSK-3"), domains: ["src/c"] });
    assert.ok(c.taskId);
    const claims = await coordinators.hostA.listClaims("repo:/shared");
    assert.deepEqual(claims.map((x) => x.taskId).sort(), ["TSK-2", "TSK-3"]);
    assert.equal(b.taskId, "TSK-2");
  });

  it("takes over a stale lease and emits lane.stale_taken naming the dead owner", async () => {
    let now = 1_000;
    const base = await mkdtemp(join(tmpdir(), "pieng-lanes-git-takeover-"));
    tempDirs.push(base);
    const origin = join(base, "origin.git");
    await exec("git", ["init", "--bare", origin]);
    const workA = join(base, "a");
    await exec("git", ["init", workA]);
    await git(workA, "config", "user.email", "a@e.com");
    await git(workA, "config", "user.name", "a");
    await writeFile(join(workA, "f"), "a");
    await git(workA, "add", "f");
    await git(workA, "commit", "-m", "a");
    await git(workA, "remote", "add", "origin", origin);
    await git(workA, "push", "-u", "origin", "HEAD");
    const workB = join(base, "b");
    await git(base, "clone", "-q", origin, workB);
    await git(workB, "config", "user.email", "b@e.com");
    await git(workB, "config", "user.name", "b");
    const events: Array<[string, string, Record<string, unknown>]> = [];
    const coordA = new GitRefLaneCoordinator({
      config: { backend: "auto", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => GitRepo.open(workA),
      now: () => now,
    });
    const coordB = new GitRefLaneCoordinator({
      config: { backend: "auto", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => GitRepo.open(workB),
      now: () => now,
      onLaneEvent: (kind, missionId, payload) => events.push([kind, missionId, payload]),
    });
    const aLease = await coordA.acquire(input("hostA", "TSK-1"));
    // Advance past the lease; hostB takes over the overlapping domain.
    now = 1_101;
    const bLease = await coordB.acquire({ ...input("hostB", "TSK-2"), domains: ["src/a"] });
    assert.equal(bLease.taskId, "TSK-2");
    assert.ok(bLease.fence > aLease.fence);
    const claims = await coordB.listClaims("repo:/shared");
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.taskId, "TSK-2");
    assert.ok(events.some(([kind, , payload]) => kind === "lane.stale_taken" && payload.owner_id === "hostA/owner"));
  });

  it("returns null from renew after the claim was taken over, without clobbering the new claim", async () => {
    let now = 1_000;
    const base = await mkdtemp(join(tmpdir(), "pieng-lanes-git-renew-"));
    tempDirs.push(base);
    const origin = join(base, "origin.git");
    await exec("git", ["init", "--bare", origin]);
    const workA = join(base, "a");
    await exec("git", ["init", workA]);
    await git(workA, "config", "user.email", "a@e.com");
    await git(workA, "config", "user.name", "a");
    await writeFile(join(workA, "f"), "a");
    await git(workA, "add", "f");
    await git(workA, "commit", "-m", "a");
    await git(workA, "remote", "add", "origin", origin);
    await git(workA, "push", "-u", "origin", "HEAD");
    const workB = join(base, "b");
    await git(base, "clone", "-q", origin, workB);
    await git(workB, "config", "user.email", "b@e.com");
    await git(workB, "config", "user.name", "b");
    const coordA = new GitRefLaneCoordinator({
      config: { backend: "auto", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => GitRepo.open(workA),
      now: () => now,
    });
    const coordB = new GitRefLaneCoordinator({
      config: { backend: "auto", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => GitRepo.open(workB),
      now: () => now,
    });
    const aLease = await coordA.acquire(input("hostA", "TSK-1"));
    now = 1_101;
    await coordB.acquire({ ...input("hostB", "TSK-2"), domains: ["src/a"] });
    assert.equal(await coordA.renew(aLease), null);
    const claims = await coordB.listClaims("repo:/shared");
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.taskId, "TSK-2");
  });

  it("fails closed on a corrupt lane index without overwriting it", async () => {
    const base = await mkdtemp(join(tmpdir(), "pieng-lanes-git-corrupt-"));
    tempDirs.push(base);
    const origin = join(base, "origin.git");
    await exec("git", ["init", "--bare", origin]);
    const workA = join(base, "a");
    await exec("git", ["init", workA]);
    await git(workA, "config", "user.email", "a@e.com");
    await git(workA, "config", "user.name", "a");
    await writeFile(join(workA, "f"), "a");
    await git(workA, "add", "f");
    await git(workA, "commit", "-m", "a");
    await git(workA, "remote", "add", "origin", origin);
    await git(workA, "push", "-u", "origin", "HEAD");
    const repo = await GitRepo.open(workA);
    assert.ok(repo);
    // Write a corrupt index directly via the CAS primitive.
    const key = laneKeyFor("repo:/corrupt");
    await repo.casPushRef(key, "this is not json", null);
    const coord = new GitRefLaneCoordinator({
      config: { backend: "auto", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => repo,
      now: () => 1_000,
    });
    await assert.rejects(
      coord.acquire({ repoId: "repo:/corrupt", domains: ["src/a"], ownerId: "o", missionId: "MSN", taskId: "T" }),
      LaneIndexCorruptError,
    );
    // The corrupt content is untouched.
    const read = await repo.readRemoteRef(key);
    assert.equal(read?.content, "this is not json");
  });

  it("delegates an origin-less repo to in-memory under auto, but refuses under git", async () => {
    const base = await mkdtemp(join(tmpdir(), "pieng-lanes-git-noorigin-"));
    tempDirs.push(base);
    await exec("git", ["init", base]);
    await git(base, "config", "user.email", "x@e.com");
    await git(base, "config", "user.name", "x");
    const repo = await GitRepo.open(base);
    assert.ok(repo);
    const auto = new GitRefLaneCoordinator({
      config: { backend: "auto", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => repo,
      now: () => 1_000,
    });
    const lease = await auto.acquire({
      repoId: "repo:/local",
      domains: ["src/a"],
      ownerId: "o",
      missionId: "MSN",
      taskId: "T",
    });
    assert.equal(lease.taskId, "T");
    const strict = new GitRefLaneCoordinator({
      config: { backend: "git", leaseMs: 100, maxRepoWriters: 4 },
      openRepo: async () => repo,
      now: () => 1_000,
    });
    await assert.rejects(
      strict.acquire({ repoId: "repo:/local", domains: ["src/a"], ownerId: "o", missionId: "MSN", taskId: "T" }),
      LaneBackendMisconfiguredError,
    );
  });
});
