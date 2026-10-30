/**
 * Data-loss wave 2B: ownership markers, non-destructive worktree/branch cleanup,
 * non-overwriting rotation, torn-tail quarantine. Real git, real files.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { GitRepo, shortHash } from "../../src/git/GitRepo.ts";
import { CliForkGit } from "../../src/git/forkGit.ts";
import { readOwnerMarker } from "../../src/git/ownerMarker.ts";
import { gitPostMerge } from "../../src/merge/postMerge.ts";
import { JsonlEventStore, repairTornTail } from "../../src/platform/eventstore/jsonl.ts";
import { emitRuntimeEvent, setRuntimeEventLog } from "../../src/runtime/isolation/runtimeEvents.ts";
import { restoreCheckpoint } from "../../src/runtime/migrations/framework.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { subtractBaselineFailures } from "../../src/verify/baselineSubtraction.ts";
import { TranscriptWriter } from "../../src/workers/transcriptStore.ts";

const exec = promisify(execFile);
const g = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec("git", ["-C", cwd, ...args])).stdout.trim();

async function scratchRepo(): Promise<{ dir: string; head: string; git: GitRepo }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "w2b-")));
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await g(dir, "config", "user.email", "t@example.invalid");
  await g(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "x");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "init");
  const git = await GitRepo.open(dir);
  assert.ok(git);
  return { dir, head: await g(dir, "rev-parse", "HEAD"), git };
}

const wtPath = (dir: string, branch: string): string => join(dirname(dir), `pi-eng-${shortHash(dir)}-${branch}`);

test("createWorktree writes the ownership marker with the exact contract", async () => {
  const { dir, head, git } = await scratchRepo();
  const info = await git.createWorktree(head, "cand-1");
  const gitdir = await g(info.path, "rev-parse", "--absolute-git-dir");
  const file = join(gitdir, "pi-eng-owner.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(raw), ["version", "creator", "repoRootHash", "repoRootSha256", "branch", "createdAt"]);
  assert.equal(raw.version, 1);
  assert.equal(raw.creator, "pi-engineering");
  assert.equal(raw.repoRootHash, shortHash(dir));
  assert.equal(raw.repoRootSha256, createHash("sha256").update(realpathSync(dir)).digest("hex"));
  assert.equal(raw.branch, "cand-1");
  const read = readOwnerMarker(gitdir);
  assert.ok(read.ok);
  assert.equal(read.marker.branch, "cand-1");
  assert.deepEqual(
    readdirSync(gitdir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("readOwnerMarker rejects missing, malformed and foreign markers", () => {
  const d = mkdtempSync(join(tmpdir(), "w2b-marker-"));
  assert.deepEqual(readOwnerMarker(d), { ok: false, reason: "missing" });
  writeFileSync(join(d, "pi-eng-owner.json"), "{nope");
  assert.equal(readOwnerMarker(d).ok, false);
  writeFileSync(
    join(d, "pi-eng-owner.json"),
    JSON.stringify({
      version: 1,
      creator: "someone",
      repoRootHash: "a",
      repoRootSha256: "0".repeat(64),
      branch: null,
      createdAt: new Date().toISOString(),
    }),
  );
  assert.deepEqual(readOwnerMarker(d), { ok: false, reason: "foreign creator" });
});

test("createWorktree refuses to replace a dirty worktree and keeps its files and branch", async () => {
  const { head, git, dir } = await scratchRepo();
  const first = await git.createWorktree(head, "dirty-1");
  writeFileSync(join(first.path, "precious.txt"), "unsaved work");
  await assert.rejects(git.createWorktree(head, "dirty-1"), /refusing to replace/);
  assert.equal(readFileSync(join(first.path, "precious.txt"), "utf8"), "unsaved work");
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/dirty-1"));
});

test("createWorktree refuses an unregistered non-empty directory at the path", async () => {
  const { head, git, dir } = await scratchRepo();
  const path = wtPath(dir, "stray-1");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "keep.txt"), "k");
  await assert.rejects(git.createWorktree(head, "stray-1"), /not a registered worktree/);
  assert.equal(readFileSync(join(path, "keep.txt"), "utf8"), "k");
});

test("createWorktree preserves a leftover branch with unmerged commits under superseded/", async () => {
  const { head, git, dir } = await scratchRepo();
  const first = await git.createWorktree(head, "left-1");
  writeFileSync(join(first.path, "w.txt"), "work");
  await g(first.path, "add", "-A");
  await g(first.path, "commit", "-qm", "worker commit");
  const workerSha = await g(first.path, "rev-parse", "HEAD");
  // Clean worktree, branch with an unmerged commit.
  const second = await git.createWorktree(head, "left-1");
  assert.equal(await g(second.path, "rev-parse", "HEAD"), head);
  const refs = (
    await g(dir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/superseded/")
  ).split("\n");
  assert.equal(refs.length, 1);
  assert.match(refs[0] ?? "", /^superseded\/left-1-/);
  assert.ok((refs[0] ?? "").endsWith(workerSha));
});

test("createWorktree replaces a clean registered worktree whose branch is merged", async () => {
  const { head, git, dir } = await scratchRepo();
  await git.createWorktree(head, "merged-1");
  const again = await git.createWorktree(head, "merged-1");
  assert.ok(existsSync(join(again.path, "a.txt")));
  assert.equal(await g(dir, "for-each-ref", "refs/heads/superseded/"), "");
});

test("removeWorktree keeps a dirty worktree and its branch (no --force)", async () => {
  const { head, git, dir } = await scratchRepo();
  const info = await git.createWorktree(head, "rm-dirty");
  writeFileSync(join(info.path, "precious.txt"), "unsaved");
  await assert.rejects(git.removeWorktree(info));
  assert.equal(readFileSync(join(info.path, "precious.txt"), "utf8"), "unsaved");
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/rm-dirty"));
});

test("removeWorktree never deletes a branch with unmerged commits; it renames it", async () => {
  const { head, git, dir } = await scratchRepo();
  const info = await git.createWorktree(head, "rm-unmerged");
  writeFileSync(join(info.path, "w.txt"), "work");
  await g(info.path, "add", "-A");
  await g(info.path, "commit", "-qm", "worker commit");
  const sha = await g(info.path, "rev-parse", "HEAD");
  await git.removeWorktree(info);
  assert.ok(!existsSync(info.path));
  const refs = await g(dir, "for-each-ref", "--format=%(objectname)", "refs/heads/superseded/");
  assert.equal(refs, sha);
});

test("removeWorktree moves an orphaned directory aside instead of deleting it", async () => {
  const { head, git, dir } = await scratchRepo();
  const info = await git.createWorktree(head, "orphan-1");
  writeFileSync(join(info.path, "precious.txt"), "unsaved");
  await exec("rm", ["-rf", join(dir, ".git", "worktrees")]);
  await git.removeWorktree(info, { keepBranch: true });
  assert.ok(!existsSync(info.path));
  const trash = join(dirname(info.path), ".pi-eng-trash");
  const moved = readdirSync(trash).find((n) => n.endsWith(basename(info.path)));
  assert.ok(moved);
  assert.equal(readFileSync(join(trash, moved, "precious.txt"), "utf8"), "unsaved");
});

test("deleteBranch with an expected sha is a compare-and-swap", async () => {
  const { head, git, dir } = await scratchRepo();
  await g(dir, "branch", "cas-1", head);
  writeFileSync(join(dir, "b.txt"), "b");
  await g(dir, "checkout", "-q", "cas-1");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "landed after count");
  await g(dir, "checkout", "-q", "main");
  await assert.rejects(git.deleteBranch("cas-1", undefined, head), /not deleted/);
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/cas-1"));
  const tip = await g(dir, "rev-parse", "cas-1");
  await git.deleteBranch("cas-1", undefined, tip);
  assert.equal(existsSync(join(dir, ".git", "refs", "heads", "cas-1")), false);
});

test("deleteBranch without a sha refuses an unmerged branch", async () => {
  const { head, git, dir } = await scratchRepo();
  await g(dir, "checkout", "-q", "-b", "unmerged-1");
  writeFileSync(join(dir, "c.txt"), "c");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "unmerged");
  await g(dir, "checkout", "-q", "main");
  await git.deleteBranch("unmerged-1");
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/unmerged-1"));
  void head;
});

test("transcript rotation never overwrites an earlier generation", () => {
  const file = join(mkdtempSync(join(tmpdir(), "w2b-tr-")), "t.jsonl");
  process.env.PI_WORKER_TRANSCRIPT_MAX_BYTES = "300";
  try {
    const w = new TranscriptWriter(file);
    for (let i = 0; i < 30; i++) w.write({ kind: "n", i, pad: "p".repeat(40) });
    const rotated = readdirSync(dirname(file)).filter((n) => n.startsWith("t.jsonl."));
    const lines = rotated
      .flatMap((n) =>
        readFileSync(join(dirname(file), n), "utf8")
          .trim()
          .split("\n"),
      )
      .concat(readFileSync(file, "utf8").trim().split("\n"));
    assert.ok(rotated.length >= 3, `expected several generations, got ${rotated.length}`);
    assert.equal(lines.length, 30, "every record survives across generations");
  } finally {
    delete process.env.PI_WORKER_TRANSCRIPT_MAX_BYTES;
  }
});

test("runtime.jsonl rotation never overwrites an earlier generation", () => {
  const file = join(mkdtempSync(join(tmpdir(), "w2b-rt-")), "runtime.jsonl");
  process.env.PI_RUNTIME_LOG_MAX_BYTES = "500";
  setRuntimeEventLog(file);
  try {
    for (let i = 0; i < 40; i++) emitRuntimeEvent("runtime.started", { n: i, pad: "x".repeat(50) });
    const ns = new Set<number>();
    for (const n of readdirSync(dirname(file))) {
      for (const l of readFileSync(join(dirname(file), n), "utf8")
        .trim()
        .split("\n"))
        ns.add(JSON.parse(l).n);
    }
    assert.equal(ns.size, 40, "all 40 events are still on disk");
  } finally {
    setRuntimeEventLog(null);
    delete process.env.PI_RUNTIME_LOG_MAX_BYTES;
  }
});

test("event-store torn-tail repair quarantines the discarded bytes before truncating", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "w2b-torn-")), "events.jsonl");
  writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":"par');
  const prefix = await repairTornTail(file);
  assert.equal(prefix, '{"a":1}\n{"b":2}\n');
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"b":2}\n');
  const q = readdirSync(dirname(file)).find((n) => n.startsWith("events.jsonl.torn-"));
  assert.ok(q);
  assert.equal(readFileSync(join(dirname(file), q), "utf8"), '{"c":"par');
});

test("fork worktrees get an ownership marker keyed by the owning repo's shortHash", async () => {
  const { dir, head } = await scratchRepo();
  const wt = join(dirname(dir), `pi-fork-${shortHash(dir)}-t1`);
  await new CliForkGit(dir).addWorktree(wt, "pi-fork/fk-0123456789abcdef", head);
  const read = readOwnerMarker(await g(wt, "rev-parse", "--absolute-git-dir"));
  assert.ok(read.ok);
  assert.equal(read.marker.repoRootHash, shortHash(dir));
  assert.equal(read.marker.branch, "pi-fork/fk-0123456789abcdef");
});

test("a branch whose tip is reachable from another ref is dropped without a superseded copy", async () => {
  const { head, git, dir } = await scratchRepo();
  const info = await git.createWorktree(head, "reach-1");
  writeFileSync(join(info.path, "w.txt"), "work");
  await g(info.path, "add", "-A");
  await g(info.path, "commit", "-qm", "worker commit");
  await g(dir, "branch", "sibling", "reach-1");
  await git.removeWorktree(info);
  assert.equal(await g(dir, "for-each-ref", "refs/heads/superseded/"), "");
  assert.equal(await g(dir, "for-each-ref", "refs/heads/reach-1"), "");
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/sibling"));
});

test("post-merge revert conflict leaves no branch, no worktree and no temp dir", async () => {
  const { dir } = await scratchRepo();
  const commit = async (content: string): Promise<string> => {
    writeFileSync(join(dir, "a.txt"), content);
    await g(dir, "commit", "-qam", content);
    return g(dir, "rev-parse", "HEAD");
  };
  const first = await commit("one");
  await commit("two");
  const base = await g(dir, "rev-parse", "HEAD");
  const temps = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pi-postmerge-")).length;
  const before = temps();
  const out = await gitPostMerge(dir).createRevertBranch({ branch: "revert-x", mergedSha: first, base });
  assert.equal(out.ok, false);
  assert.equal(await g(dir, "for-each-ref", "refs/heads/revert-x"), "");
  assert.equal((await g(dir, "worktree", "list", "--porcelain")).split("\n\n").length, 1);
  assert.equal(temps(), before, "the temp directory is not leaked");
});

test("post-merge: an empty leftover revert branch at the base is not a finished revert", async () => {
  const { dir } = await scratchRepo();
  writeFileSync(join(dir, "b.txt"), "b");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "to revert");
  const merged = await g(dir, "rev-parse", "HEAD");
  const base = merged;
  await g(dir, "branch", "revert-y", base); // failed earlier attempt: empty branch at the base
  const out = await gitPostMerge(dir).createRevertBranch({ branch: "revert-y", mergedSha: merged, base });
  assert.ok(out.ok);
  assert.equal(out.created, true);
  assert.notEqual(out.sha, base);
});

test("restoreCheckpoint keeps the live state when the checkpoint copy fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "w2b-ck-"));
  const checkpoint = join(root, "cp");
  const state = join(root, "state");
  mkdirSync(checkpoint);
  mkdirSync(state);
  writeFileSync(join(state, "live.json"), "LIVE");
  // The manifest promises a checkpointed copy that is missing, so the copy fails.
  writeFileSync(
    join(checkpoint, "checkpoint-manifest.json"),
    JSON.stringify({ stateDir: state, createdAt: "x", entries: [{ path: "live.json", existed: true }] }),
  );
  await assert.rejects(restoreCheckpoint(checkpoint, state));
  assert.equal(readFileSync(join(state, "live.json"), "utf8"), "LIVE");
  assert.deepEqual(readdirSync(state), ["live.json"], "no half-written sibling left behind");
});

test("restoreCheckpoint swaps in the checkpoint copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "w2b-ck-"));
  const checkpoint = join(root, "cp");
  const state = join(root, "state");
  mkdirSync(join(checkpoint, "state"), { recursive: true });
  mkdirSync(state);
  writeFileSync(join(checkpoint, "state", "live.json"), "OLD");
  writeFileSync(join(state, "live.json"), "NEW");
  writeFileSync(
    join(checkpoint, "checkpoint-manifest.json"),
    JSON.stringify({ stateDir: state, createdAt: "x", entries: [{ path: "live.json", existed: true }] }),
  );
  await restoreCheckpoint(checkpoint, state);
  assert.equal(readFileSync(join(state, "live.json"), "utf8"), "OLD");
  assert.deepEqual(readdirSync(state), ["live.json"]);
});

const ev = (id: string) => ({ event_id: id, stream: "s", type: "t", at: new Date().toISOString(), data: {} }) as never;

test("torn tail + failed quarantine (ENOSPC for new files) never fuses the next event onto the fragment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-enospc-"));
  const file = join(dir, "events.jsonl");
  const store = await JsonlEventStore.open(file);
  await store.append(ev("e1"));
  appendFileSync(file, '{"event_id":"partial-wri'); // torn tail left by a failed append
  chmodSync(dir, 0o555); // no NEW files: the quarantine write fails; the existing file is still appendable
  try {
    await repairTornTail(file, { owner: (store as unknown as { writerLock: never }).writerLock });
    await store.append(ev("e2"));
  } finally {
    chmodSync(dir, 0o755);
  }
  store.close();
  const reloaded = await JsonlEventStore.openReadOnly(file);
  assert.deepEqual(
    reloaded.all().map((e) => e.event_id),
    ["e1", "e2"],
    "the committed event survives",
  );
  assert.ok(readFileSync(file, "utf8").includes('{"event_id":"partial-wri\n'), "the fragment is kept, terminated");
});

test("an unrepairable torn tail makes every append throw until repair succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-enospc2-"));
  const file = join(dir, "events.jsonl");
  const store = await JsonlEventStore.open(file);
  await store.append(ev("e1"));
  appendFileSync(file, '{"event_id":"partial-wri');
  chmodSync(file, 0o444);
  chmodSync(dir, 0o555);
  try {
    await assert.rejects(store.append(ev("e2")), "the failed write is surfaced");
    await assert.rejects(store.append(ev("e2b")), "still unrepairable: still throws, never fuses");
  } finally {
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);
  }
  await store.append(ev("e3"));
  store.close();
  const reloaded = await JsonlEventStore.openReadOnly(file);
  assert.deepEqual(
    reloaded.all().map((e) => e.event_id),
    ["e1", "e3"],
  );
});

test("a dirty leftover baseline worktree does not block later baselines", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "w2b-bl-")));
  const artifacts = mkdtempSync(join(tmpdir(), "w2b-bl-art-"));
  await exec("git", ["init", "-q", "-b", "main", root]);
  await g(root, "config", "user.email", "t@example.invalid");
  await g(root, "config", "user.name", "t");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(
    join(root, "test", "old.test.js"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { writeFileSync } from "node:fs";\nwriteFileSync("junit.xml", "<x/>");\ntest("old defect", () => assert.equal(1, 2));\n',
  );
  await g(root, "add", "-A");
  await g(root, "commit", "-qm", "base");
  const baseSha = await g(root, "rev-parse", "HEAD");
  const git = await GitRepo.open(root);
  assert.ok(git);
  const verifier = new CommandVerifier();
  const store = await ArtifactStore.create(artifacts);
  const profile = await verifier.detect(root);
  const run = async () => {
    const outcome = await verifier.run(root, profile, store);
    return subtractBaselineFailures({ git, verifier, artifacts: store, baseSha, cwd: root, profile, outcome });
  };
  const first = await run();
  assert.ok(
    first.inheritedFailures.some((id) => id.includes("old defect")),
    JSON.stringify(first.warnings),
  );
  const cache = join(await git.commonDir(), "pi-engineering-baselines");
  for (const n of readdirSync(cache)) if (n.endsWith(".json")) writeFileSync(join(cache, n), "{}"); // force recompute
  const second = await run();
  assert.ok(
    second.inheritedFailures.some((id) => id.includes("old defect")),
    `baseline retried despite the dirty leftover: ${JSON.stringify(second.warnings)}`,
  );
});

test("remote-tracking refs do not count as 'contained elsewhere'", async () => {
  const { head, git, dir } = await scratchRepo();
  const info = await git.createWorktree(head, "remote-1");
  writeFileSync(join(info.path, "w.txt"), "work");
  await g(info.path, "add", "-A");
  await g(info.path, "commit", "-qm", "worker commit");
  const sha = await g(info.path, "rev-parse", "HEAD");
  await g(dir, "update-ref", "refs/remotes/origin/remote-1", sha);
  await git.removeWorktree(info);
  assert.equal(await g(dir, "for-each-ref", "--format=%(objectname)", "refs/heads/superseded/"), sha);
});

test("a detached main checkout does not make 'merged into HEAD' trustworthy", async () => {
  const { head, git, dir } = await scratchRepo();
  const info = await git.createWorktree(head, "detached-1");
  writeFileSync(join(info.path, "w.txt"), "work");
  await g(info.path, "add", "-A");
  await g(info.path, "commit", "-qm", "worker commit");
  const sha = await g(info.path, "rev-parse", "HEAD");
  await g(dir, "checkout", "-q", "--detach", sha);
  await git.removeWorktree(info);
  assert.equal(await g(dir, "for-each-ref", "--format=%(objectname)", "refs/heads/superseded/"), sha);
});

async function ignoredRepo(): Promise<{ dir: string; head: string; git: GitRepo }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "w2b-ign-")));
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await g(dir, "config", "user.email", "t@example.invalid");
  await g(dir, "config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules/\ntarget/\n");
  writeFileSync(join(dir, "a.txt"), "x");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.txt"), "d");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "init");
  const git = await GitRepo.open(dir);
  assert.ok(git);
  return { dir, head: await g(dir, "rev-parse", "HEAD"), git };
}

test("removeWorktree keeps a worktree holding an ignored user file (.env) and its node_modules link", async () => {
  const { head, git } = await ignoredRepo();
  const info = await git.createWorktree(head, "ign-1");
  writeFileSync(join(info.path, ".env"), "SECRET=1");
  await assert.rejects(git.removeWorktree(info), /\.env/);
  assert.equal(readFileSync(join(info.path, ".env"), "utf8"), "SECRET=1");
  assert.ok(lstatSync(join(info.path, "node_modules")).isSymbolicLink(), "link untouched after a refusal");
});

test("createWorktree also refuses to replace a worktree holding an ignored user file", async () => {
  const { head, git } = await ignoredRepo();
  const info = await git.createWorktree(head, "ign-2");
  writeFileSync(join(info.path, ".env"), "SECRET=1");
  await assert.rejects(git.createWorktree(head, "ign-2"), /refusing to replace/);
  assert.equal(readFileSync(join(info.path, ".env"), "utf8"), "SECRET=1");
});

test("derived root dirs (target/, node_modules link) do not block removal of a clean worktree", async () => {
  const { head, git } = await ignoredRepo();
  const info = await git.createWorktree(head, "ign-3");
  mkdirSync(join(info.path, "target"));
  writeFileSync(join(info.path, "target", "out.o"), "o");
  await git.removeWorktree(info);
  assert.ok(!existsSync(info.path));
});

test("readOwnerMarker with repoRoot rejects another repository's marker", async () => {
  const a = await scratchRepo();
  const b = await scratchRepo();
  const info = await a.git.createWorktree(a.head, "mark-a");
  const gitdir = await g(info.path, "rev-parse", "--absolute-git-dir");
  assert.ok(readOwnerMarker(gitdir, { repoRoot: a.dir }).ok);
  assert.deepEqual(readOwnerMarker(gitdir, { repoRoot: b.dir }), { ok: false, reason: "repo mismatch (repoRootHash)" });
  const file = join(gitdir, "pi-eng-owner.json");
  const marker = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...marker, repoRootSha256: "0".repeat(64) }));
  assert.deepEqual(readOwnerMarker(gitdir, { repoRoot: a.dir }), {
    ok: false,
    reason: "repo mismatch (repoRootSha256)",
  });
  assert.ok(readOwnerMarker(gitdir).ok, "format-only callers keep working");
});

test("rotation under 8 concurrent processes loses no lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-rot-"));
  const file = join(dir, "runtime.jsonl");
  const child = join(import.meta.dirname, "..", "support", "rotateStressChild.ts");
  const codes = await Promise.all(
    Array.from(
      { length: 8 },
      (_, i) =>
        new Promise<number>((resolve) => {
          const p = spawn(process.execPath, [child, file, `p${i}`, "300"], { stdio: "inherit" });
          p.on("exit", (c) => resolve(c ?? 1));
        }),
    ),
  );
  assert.deepEqual(codes, Array(8).fill(0));
  const lines = readdirSync(dir)
    .filter((n) => n.startsWith("runtime.jsonl") && !n.endsWith(".lock"))
    .flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean));
  assert.equal(lines.length, 2400);
  assert.equal(new Set(lines).size, 2400);
});

// A tripwire, not a proof: it greps the data-bearing files for destructive git tokens in any argument position.
test("no destructive git tokens remain in the data-bearing cleanup paths", () => {
  const files = [
    "src/git/GitRepo.ts",
    "src/git/forkGit.ts",
    "src/merge/postMerge.ts",
    "src/plannerWorker/executor.ts",
    "src/runtime/EngineeringRuntime.ts",
    "src/orchestration/broker.ts",
    "src/verify/baselineSubtraction.ts",
  ];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, "..", "..", f), "utf8");
    for (const token of ['"-D"', '"-M"', '"--force"', '"-f"', '"--delete"']) {
      assert.ok(!src.includes(token), `${f}: ${token}`);
    }
  }
});
