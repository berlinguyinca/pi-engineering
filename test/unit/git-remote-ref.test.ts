import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";

const exec = promisify(execFile);

/** Every test talks to real git processes; none may hang the suite. */
const T = { timeout: 30_000 };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 20_000 });
  return stdout.trim();
}

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function cloneOf(base: string, origin: string, name: string): Promise<GitRepo> {
  const work = join(base, name);
  await exec("git", ["clone", "--quiet", origin, work], { timeout: 20_000 });
  const repo = await GitRepo.open(work);
  assert.ok(repo);
  return repo;
}

/** A clone + shared bare origin, exactly how two hosts would share a repo. */
async function fixtureWithOrigin(): Promise<{ repo: GitRepo; origin: string; work: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), "pieng-remote-ref-"));
  tempDirs.push(base);
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  await exec("git", ["init", "--bare", "--quiet", origin]);
  await exec("git", ["init", "--quiet", work]);
  await git(work, "config", "user.email", "t@example.com");
  await git(work, "config", "user.name", "Tester");
  await writeFile(join(work, "README.md"), "seed\n");
  await git(work, "add", "README.md");
  await git(work, "commit", "-m", "seed");
  await git(work, "remote", "add", "origin", origin);
  await git(work, "push", "--quiet", "-u", "origin", "HEAD");
  const repo = await GitRepo.open(work);
  assert.ok(repo);
  return { repo, origin, work, base };
}

async function originSha(origin: string, ref: string): Promise<string | null> {
  const out = await git(origin, "for-each-ref", "--format=%(objectname)", ref);
  return out.length > 0 ? out : null;
}

describe("GitRepo remote-ref primitives", () => {
  it("detects the presence of a remote origin", T, async () => {
    const { repo } = await fixtureWithOrigin();
    assert.equal(await repo.hasRemoteOrigin(), true);
    const baseDir = await mkdtemp(join(tmpdir(), "pieng-no-origin-"));
    tempDirs.push(baseDir);
    await exec("git", ["init", "--quiet", baseDir]);
    const local = await GitRepo.open(baseDir);
    assert.ok(local);
    assert.equal(await local.hasRemoteOrigin(), false);
  });

  it("reads an absent ref as null", T, async () => {
    const { repo } = await fixtureWithOrigin();
    assert.equal(await repo.readRemoteRef("refs/lanes/deadbeef"), null);
  });

  it("round-trips payloads byte-for-byte through the stdin plumbing", T, async () => {
    const { repo } = await fixtureWithOrigin();
    const payloads = [
      "",
      "no trailing newline",
      '{\n  "claims": ["a", "b"]\n}\n\n',
      "unicode ✓ — ü 漢字\ttab\r\nCRLF",
      "x".repeat(512 * 1024),
    ];
    for (const [i, payload] of payloads.entries()) {
      const ref = `refs/lanes/stdin-${i}`;
      const pushed = await repo.casPushRef(ref, payload, null);
      assert.equal(pushed.ok, true);
      const read = await repo.readRemoteRef(ref);
      assert.ok(read);
      assert.equal(read.content, payload);
      assert.equal(read.sha, pushed.remoteSha);
    }
  });

  it("creates a ref when none exists and reads it back", T, async () => {
    const { repo, origin } = await fixtureWithOrigin();
    const pushed = await repo.casPushRef("refs/lanes/aaa", '{"version":1,"claims":[]}', null);
    assert.equal(pushed.ok, true);
    assert.equal(await originSha(origin, "refs/lanes/aaa"), pushed.remoteSha);
    const read = await repo.readRemoteRef("refs/lanes/aaa");
    assert.ok(read);
    assert.equal(read.content, '{"version":1,"claims":[]}');
    assert.equal(read.sha, pushed.remoteSha);
  });

  it("treats expectedSha=null as 'must be absent': an existing ref is not overwritten", T, async () => {
    const { repo, origin } = await fixtureWithOrigin();
    const first = await repo.casPushRef("refs/lanes/absent", "v1", null);
    assert.equal(first.ok, true);
    const again = await repo.casPushRef("refs/lanes/absent", "v2", null);
    assert.deepEqual(again, { ok: false, remoteSha: first.remoteSha });
    assert.equal(await originSha(origin, "refs/lanes/absent"), first.remoteSha);
    assert.equal((await repo.readRemoteRef("refs/lanes/absent"))?.content, "v1");
  });

  it("updates with the observed sha and rejects a stale expected sha without clobbering", T, async () => {
    const { repo } = await fixtureWithOrigin();
    const first = await repo.casPushRef("refs/lanes/bbb", "v1", null);
    assert.equal(first.ok, true);
    const stale = await repo.casPushRef("refs/lanes/bbb", "v3", "0".repeat(40));
    assert.equal(stale.ok, false);
    assert.equal(stale.remoteSha, first.remoteSha);
    const read = await repo.readRemoteRef("refs/lanes/bbb");
    assert.equal(read?.content, "v1");
    const updated = await repo.casPushRef("refs/lanes/bbb", "v2", first.remoteSha);
    assert.equal(updated.ok, true);
    assert.equal((await repo.readRemoteRef("refs/lanes/bbb"))?.content, "v2");
  });

  it("reports a lost race (not an error) when the expected ref was deleted meanwhile", T, async () => {
    const { repo, origin } = await fixtureWithOrigin();
    const first = await repo.casPushRef("refs/lanes/gone", "v1", null);
    assert.ok(first.remoteSha);
    await git(origin, "update-ref", "-d", "refs/lanes/gone");
    assert.deepEqual(await repo.casPushRef("refs/lanes/gone", "v2", first.remoteSha), { ok: false, remoteSha: null });
  });

  it("loses the race for the slower of two read-then-push writers (CAS)", T, async () => {
    const { repo } = await fixtureWithOrigin();
    await repo.casPushRef("refs/lanes/ccc", "v1", null);
    const observed = await repo.readRemoteRef("refs/lanes/ccc");
    assert.ok(observed);
    const won = await repo.casPushRef("refs/lanes/ccc", "vA", observed.sha);
    assert.equal(won.ok, true);
    const lost = await repo.casPushRef("refs/lanes/ccc", "vB", observed.sha);
    assert.deepEqual(lost, { ok: false, remoteSha: won.remoteSha });
    assert.equal((await repo.readRemoteRef("refs/lanes/ccc"))?.content, "vA");
  });

  it("lets exactly one of several concurrent hosts win an update race", T, async () => {
    const { repo, origin, base } = await fixtureWithOrigin();
    const seed = await repo.casPushRef("refs/lanes/race", "v0", null);
    assert.ok(seed.remoteSha);
    const hosts = await Promise.all([0, 1, 2, 3].map((i) => cloneOf(base, origin, `host-${i}`)));
    const results = await Promise.all(
      hosts.map((h, i) => h.casPushRef("refs/lanes/race", `host-${i}`, seed.remoteSha)),
    );
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const winnerSha = winners[0]?.remoteSha;
    assert.equal(await originSha(origin, "refs/lanes/race"), winnerSha);
    for (const loser of results.filter((r) => !r.ok)) assert.equal(loser.remoteSha, winnerSha);
    const winnerIdx = results.findIndex((r) => r.ok);
    assert.equal((await repo.readRemoteRef("refs/lanes/race"))?.content, `host-${winnerIdx}`);
  });

  it("lets exactly one of several concurrent hosts create an absent ref", T, async () => {
    const { origin, base } = await fixtureWithOrigin();
    const hosts = await Promise.all([0, 1, 2].map((i) => cloneOf(base, origin, `creator-${i}`)));
    const results = await Promise.all(hosts.map((h, i) => h.casPushRef("refs/lanes/new", `c-${i}`, null)));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    for (const loser of results.filter((r) => !r.ok)) assert.equal(loser.remoteSha, winners[0]?.remoteSha);
  });

  it("serves concurrent readers on one repo without interference or leftover temp refs", T, async () => {
    const { repo, work } = await fixtureWithOrigin();
    const a = await repo.casPushRef("refs/lanes/r1", "one", null);
    const b = await repo.casPushRef("refs/lanes/r2", "two", null);
    const reads = await Promise.all(
      Array.from({ length: 12 }, (_, i) => repo.readRemoteRef(i % 2 === 0 ? "refs/lanes/r1" : "refs/lanes/r2")),
    );
    for (const [i, read] of reads.entries()) {
      assert.deepEqual(read, i % 2 === 0 ? { sha: a.remoteSha, content: "one" } : { sha: b.remoteSha, content: "two" });
    }
    assert.equal(await git(work, "for-each-ref", "refs/pieng-lane-tmp"), "");
  });

  it("cleans up its temp ref when the remote ref has no lane payload", T, async () => {
    const { repo, work } = await fixtureWithOrigin();
    await git(work, "push", "--quiet", "origin", "HEAD:refs/lanes/not-a-lane");
    await assert.rejects(repo.readRemoteRef("refs/lanes/not-a-lane"));
    assert.equal(await git(work, "for-each-ref", "refs/pieng-lane-tmp"), "");
  });

  it("throws (not a lost race) when origin is unreachable", T, async () => {
    const { repo, work, base } = await fixtureWithOrigin();
    await git(work, "remote", "set-url", "origin", join(base, "does-not-exist.git"));
    await assert.rejects(repo.readRemoteRef("refs/lanes/x"));
    await assert.rejects(repo.casPushRef("refs/lanes/x", "v1", null));
    await assert.rejects(repo.casPushRef("refs/lanes/x", "v1", "0".repeat(40)));
  });

  it("throws with the remote's stderr when a push is refused while the ref is unchanged", T, async () => {
    const { repo, origin } = await fixtureWithOrigin();
    const first = await repo.casPushRef("refs/lanes/hooked", "v1", null);
    const hook = join(origin, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'policy says no' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await assert.rejects(repo.casPushRef("refs/lanes/hooked", "v2", first.remoteSha), /policy says no/);
    await assert.rejects(repo.casPushRef("refs/lanes/fresh", "v1", null), /policy says no/);
    assert.equal(await originSha(origin, "refs/lanes/hooked"), first.remoteSha);
  });
});
