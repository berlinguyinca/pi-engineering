/**
 * Data-loss wave 2B: ownership markers, non-destructive worktree/branch cleanup,
 * non-overwriting rotation, torn-tail quarantine. Real git, real files.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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
import { rotateWithoutOverwrite } from "../../src/runtime/rotateFile.ts";
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
  assert.ok(
    readFileSync(file, "utf8").includes('{"event_id":"partial-wri\u001e#torn\n'),
    "the fragment is kept, closed with a sentinel",
  );
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

test("a complete-but-unacknowledged event is not resurrected as a duplicate after a failed quarantine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-torn-complete-"));
  const file = join(dir, "events.jsonl");
  const store = await JsonlEventStore.open(file);
  await store.append(ev("e1"));
  appendFileSync(file, JSON.stringify(ev("e2"))); // every byte of e2 except its newline; the caller was told it failed
  chmodSync(dir, 0o555);
  try {
    await repairTornTail(file, { owner: (store as unknown as { writerLock: never }).writerLock });
    await store.append(ev("e2")); // the caller retries
  } finally {
    chmodSync(dir, 0o755);
  }
  store.close();
  for (let i = 0; i < 2; i++) {
    const reloaded = await JsonlEventStore.openReadOnly(file);
    assert.deepEqual(
      reloaded.all().map((e) => e.event_id),
      ["e1", "e2"],
      `reload ${i + 1}`,
    );
  }
});

test("the quarantined torn tail is byte-exact (no UTF-8 decoding)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-torn-bytes-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0xff, 0xfe, 0xc3])]));
  await repairTornTail(file);
  const q = readdirSync(dir).find((n) => n.startsWith("events.jsonl.torn-"));
  assert.ok(q);
  assert.deepEqual([...readFileSync(join(dir, q))], [0xff, 0xfe, 0xc3]);
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
});

async function remoteRepo(): Promise<{ dir: string; remote: string; git: GitRepo }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "w2b-up-")));
  const remote = join(root, "remote.git");
  await exec("git", ["init", "-q", "--bare", remote]);
  const dir = join(root, "repo");
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await g(dir, "config", "user.email", "t@example.invalid");
  await g(dir, "config", "user.name", "t");
  await g(dir, "commit", "-q", "--allow-empty", "-m", "i");
  await g(dir, "remote", "add", "origin", remote);
  await g(dir, "push", "-q", "origin", "main");
  const git = await GitRepo.open(dir);
  assert.ok(git);
  return { dir, remote, git };
}

test("a branch with an upstream is not deleted just because its remote-tracking ref has the tip", async () => {
  const { dir, remote, git } = await remoteRepo();
  await g(dir, "checkout", "-q", "-b", "cand-up");
  await g(dir, "commit", "-q", "--allow-empty", "-m", "unique-up");
  await g(dir, "push", "-q", "-u", "origin", "cand-up");
  const tip = await g(dir, "rev-parse", "HEAD");
  await g(dir, "checkout", "-q", "main");
  const r = await git.deleteOrPreserveBranch("cand-up");
  assert.ok(r?.renamedTo, "kept under superseded/");
  await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/cand-up"]);
  await g(dir, "fetch", "-q", "--prune", "origin");
  assert.equal(
    await g(dir, "for-each-ref", "--contains", tip, "--format=%(refname)", "refs/heads"),
    `refs/heads/${r.renamedTo}`,
  );
});

test("two branches at the same unique tip: the second is preserved", async () => {
  const { dir, git } = await remoteRepo();
  await g(dir, "checkout", "-q", "-b", "A");
  await g(dir, "commit", "-q", "--allow-empty", "-m", "unique-AB");
  await g(dir, "branch", "B");
  const tip = await g(dir, "rev-parse", "HEAD");
  await g(dir, "checkout", "-q", "main");
  await git.deleteOrPreserveBranch("A");
  await git.deleteOrPreserveBranch("B");
  assert.notEqual(await g(dir, "for-each-ref", "--contains", tip, "--format=%(refname)", "refs/heads"), "");
});

test("concurrent deleteOrPreserveBranch on two instances never loses a shared unique tip", async () => {
  const { dir, git } = await remoteRepo();
  const other = await GitRepo.open(dir);
  assert.ok(other);
  for (let round = 0; round < 5; round++) {
    await g(dir, "checkout", "-q", "-b", `C${round}`);
    await g(dir, "commit", "-q", "--allow-empty", "-m", `unique-${round}`);
    await g(dir, "branch", `D${round}`);
    const tip = await g(dir, "rev-parse", "HEAD");
    await g(dir, "checkout", "-q", "main");
    await Promise.all([git.deleteOrPreserveBranch(`C${round}`), other.deleteOrPreserveBranch(`D${round}`)]);
    assert.notEqual(
      await g(dir, "for-each-ref", "--contains", tip, "--format=%(refname)", "refs/heads"),
      "",
      `round ${round}`,
    );
  }
});

test("a scratch review branch holding only reproducible merges is deleted; one with unique work is preserved", async () => {
  const { head, git, dir } = await scratchRepo();
  await g(dir, "checkout", "-q", "-b", "cand");
  writeFileSync(join(dir, "c.txt"), "c");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "candidate work");
  await g(dir, "checkout", "-q", "main");
  const review = await git.createWorktree(head, "batch-review-1");
  await g(review.path, "merge", "-q", "--no-ff", "-m", "review merge", "cand");
  await git.removeWorktree(review, { keepBranch: true });
  const r = await git.deleteScratchBranch("batch-review-1");
  assert.equal(r?.renamedTo, undefined);
  assert.equal(await g(dir, "for-each-ref", "refs/heads/batch-review-1", "refs/heads/superseded/"), "");
  const own = await git.createWorktree(head, "batch-review-2");
  writeFileSync(join(own.path, "u.txt"), "unique");
  await g(own.path, "add", "-A");
  await g(own.path, "commit", "-qm", "unique work");
  await git.removeWorktree(own, { keepBranch: true });
  const r2 = await git.deleteScratchBranch("batch-review-2");
  assert.ok(r2?.renamedTo);
});

test("python caches and nested node_modules do not block removal; a re-create then succeeds", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "w2b-py-")));
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await g(dir, "config", "user.email", "t@example.invalid");
  await g(dir, "config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), "__pycache__/\n.pytest_cache/\n*.pyc\nnode_modules/\n*.tsbuildinfo\n");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "init");
  const git = await GitRepo.open(dir);
  assert.ok(git);
  const head = await g(dir, "rev-parse", "HEAD");
  const info = await git.createWorktree(head, "pi-eng-pw-m1");
  mkdirSync(join(info.path, "pkg", "__pycache__"), { recursive: true });
  writeFileSync(join(info.path, "pkg", "__pycache__", "m.cpython-312.pyc"), "x");
  mkdirSync(join(info.path, ".pytest_cache"));
  writeFileSync(join(info.path, ".pytest_cache", "README.md"), "x");
  mkdirSync(join(info.path, "pkg", "a", "node_modules", "x"), { recursive: true });
  writeFileSync(join(info.path, "pkg", "a", "node_modules", "x", "i.js"), "");
  writeFileSync(join(info.path, "tsconfig.tsbuildinfo"), "{}");
  await git.removeWorktree(info, { keepBranch: true });
  assert.ok(!existsSync(info.path));
  await git.createWorktree(head, "pi-eng-pw-m1");
});

test("a nested git repository under a derived dir keeps the worktree", async () => {
  const { head, git } = await ignoredRepo();
  const info = await git.createWorktree(head, "nested-1");
  mkdirSync(join(info.path, "target", "vendor"), { recursive: true });
  await exec("git", ["init", "-q", join(info.path, "target", "vendor")]);
  writeFileSync(join(info.path, "target", "vendor", "precious.txt"), "x");
  await assert.rejects(git.removeWorktree(info), /target/);
  assert.equal(readFileSync(join(info.path, "target", "vendor", "precious.txt"), "utf8"), "x");
});

test("a huge ignored target/ does not make the worktree 'uninspectable'", async () => {
  const { head, git } = await ignoredRepo();
  const info = await git.createWorktree(head, "huge-1");
  const long = "d".repeat(180);
  for (let d = 0; d < 80; d++) {
    const dd = join(info.path, "target", "debug", "deps", `${long}-${d}`);
    mkdirSync(dd, { recursive: true });
    for (let f = 0; f < 1000; f++) writeFileSync(join(dd, `artifact-with-a-long-file-name-${f}.rmeta`), "");
  }
  await git.removeWorktree(info, { keepBranch: true });
  assert.ok(!existsSync(info.path));
});

test("a refused removal is recorded in the durable kept-worktrees list with its marker", async () => {
  const { head, git, dir } = await ignoredRepo();
  const info = await git.createWorktree(head, "kept-1");
  writeFileSync(join(info.path, ".env"), "SECRET=1");
  await assert.rejects(git.removeWorktree(info));
  const list = join(
    await g(dir, "rev-parse", "--git-common-dir").then((c) => join(dir, c)),
    "pi-engineering-candidates",
    "kept-scratch-worktrees.jsonl",
  );
  const rec = JSON.parse(readFileSync(list, "utf8").trim().split("\n")[0] ?? "{}");
  assert.equal(rec.path, info.path);
  assert.match(rec.reason, /\.env/);
  assert.equal(rec.marker.branch, "kept-1");
});

test("readOwnerMarker with a branch rejects a marker copied from a sibling worktree", async () => {
  const { head, git, dir } = await scratchRepo();
  const a = await git.createWorktree(head, "sib-a");
  const gitdir = await g(a.path, "rev-parse", "--absolute-git-dir");
  assert.ok(readOwnerMarker(gitdir, { repoRoot: dir, branch: "sib-a" }).ok);
  assert.deepEqual(readOwnerMarker(gitdir, { repoRoot: dir, branch: "sib-b" }), {
    ok: false,
    reason: "branch mismatch",
  });
});

test("rotation steals a dead holder's lock at once and skips (does not stall) behind a live one", () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-lock-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, "line\n");
  writeFileSync(`${file}.rotate.lock`, "2147483646"); // no such process
  let t = Date.now();
  const rotated = rotateWithoutOverwrite(file);
  assert.ok(rotated);
  assert.ok(Date.now() - t < 1000, "dead holder's lock is stolen immediately");
  writeFileSync(file, "line\n");
  writeFileSync(`${file}.rotate.lock`, String(process.pid)); // a live holder
  t = Date.now();
  assert.equal(rotateWithoutOverwrite(file), null);
  assert.ok(Date.now() - t < 1500, "bounded wait");
  assert.equal(readFileSync(file, "utf8"), "line\n", "the live file is untouched");
});

test("restoreCheckpoint recovers the live state left behind by a crash between its two renames", async () => {
  const root = mkdtempSync(join(tmpdir(), "w2b-ck2-"));
  const checkpoint = join(root, "cp");
  const state = join(root, "state");
  mkdirSync(checkpoint);
  mkdirSync(state);
  writeFileSync(join(state, "live.json.replaced-123-abc"), "LIVE"); // crashed: target gone, previous kept aside
  writeFileSync(
    join(checkpoint, "checkpoint-manifest.json"),
    JSON.stringify({ stateDir: state, createdAt: "x", entries: [{ path: "live.json", existed: true }] }),
  );
  await assert.rejects(restoreCheckpoint(checkpoint, state)); // the checkpoint copy is missing
  assert.equal(readFileSync(join(state, "live.json"), "utf8"), "LIVE");
});

async function userDataRepo(): Promise<{ dir: string; head: string; git: GitRepo }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "w2b-ud-")));
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await g(dir, "config", "user.email", "t@example.invalid");
  await g(dir, "config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), "build/\n.venv/\n*.pyc\ngen/\nnode_modules/\ntarget/\n.tox/\nout/\n");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "init");
  const git = await GitRepo.open(dir);
  assert.ok(git);
  return { dir, head: await g(dir, "rev-parse", "HEAD"), git };
}

const KEEP_CASES: Array<[string, (p: string) => void, string]> = [
  [
    "build/release-notes-final.md",
    (p) => {
      mkdirSync(join(p, "build"));
      writeFileSync(join(p, "build", "release-notes-final.md"), "hand");
    },
    "build/release-notes-final.md",
  ],
  [
    "pkg/build/.env",
    (p) => {
      mkdirSync(join(p, "pkg", "build"), { recursive: true });
      writeFileSync(join(p, "pkg", "build", ".env"), "SECRET=1");
    },
    "pkg/build/.env",
  ],
  [
    ".venv/.env",
    (p) => {
      mkdirSync(join(p, ".venv", "bin"), { recursive: true });
      writeFileSync(join(p, ".venv", ".env"), "TOKEN=x");
    },
    ".venv/.env",
  ],
  [
    "notes.pyc (a user file, not in __pycache__)",
    (p) => writeFileSync(join(p, "notes.pyc"), "user notes"),
    "notes.pyc",
  ],
  [
    "bare repo in target/",
    (p) => {
      mkdirSync(join(p, "target"), { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", join(p, "target", "mirror.git")]);
    },
    "target/mirror.git/HEAD",
  ],
  [
    "bare repo in build/",
    (p) => {
      mkdirSync(join(p, "build"), { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", join(p, "build", "backup.git")]);
    },
    "build/backup.git/HEAD",
  ],
  [
    "secret key under target/",
    (p) => {
      mkdirSync(join(p, "target", "debug"), { recursive: true });
      writeFileSync(join(p, "target", "debug", "deploy.pem"), "KEY");
    },
    "target/debug/deploy.pem",
  ],
];
for (const [name, setup, kept] of KEEP_CASES) {
  test(`removal keeps the worktree: ${name}`, async () => {
    const { head, git } = await userDataRepo();
    const info = await git.createWorktree(head, `keep-${basename(kept).replace(/\W/g, "")}`);
    setup(info.path);
    await assert.rejects(git.removeWorktree(info, { keepBranch: true }));
    assert.ok(existsSync(join(info.path, kept)), `${kept} still there`);
  });
}

test("a __pycache__ directory under an ignored gen/ is still disposable", async () => {
  const { head, git } = await userDataRepo();
  const info = await git.createWorktree(head, "py-ok");
  mkdirSync(join(info.path, "gen", "__pycache__"), { recursive: true });
  writeFileSync(join(info.path, "gen", "__pycache__", "a.pyc"), "");
  await git.removeWorktree(info, { keepBranch: true });
  assert.ok(!existsSync(info.path));
});

test("symbolic aliases under refs/heads do not count as an independent copy of the tip", async () => {
  const { dir, git } = await remoteRepo();
  await g(dir, "checkout", "-q", "-b", "S");
  await g(dir, "commit", "-q", "--allow-empty", "-m", "unique-S");
  const tip = await g(dir, "rev-parse", "HEAD");
  await g(dir, "checkout", "-q", "main");
  await g(dir, "symbolic-ref", "refs/heads/S-alias", "refs/heads/S");
  const r = await git.deleteOrPreserveBranch("S");
  assert.ok(r?.renamedTo, "preserved");
  assert.ok((await g(dir, "for-each-ref", "--contains", tip, "--format=%(refname)")).includes("superseded/"));
});

test("a scratch merge with an amended resolution is not reproducible: the branch is preserved", async () => {
  const { dir, git } = await remoteRepo();
  await g(dir, "checkout", "-q", "-b", "worker1");
  writeFileSync(join(dir, "w.txt"), "w");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-q", "-m", "w");
  await g(dir, "checkout", "-q", "main");
  await g(dir, "checkout", "-q", "-b", "review-x");
  await g(dir, "merge", "--no-ff", "-q", "-m", "review", "worker1");
  writeFileSync(join(dir, "resolution.txt"), "hand-written conflict resolution");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-q", "--amend", "--no-edit");
  const merge = await g(dir, "rev-parse", "HEAD");
  await g(dir, "checkout", "-q", "main");
  const r = await git.deleteScratchBranch("review-x");
  assert.ok(r?.renamedTo, "preserved, not deleted");
  assert.notEqual(await g(dir, "for-each-ref", "--contains", merge, "--format=%(refname)"), "");
});

test("a branch checked out in another worktree is neither deleted nor renamed", async () => {
  const { dir, git } = await remoteRepo();
  await g(dir, "branch", "co", "main");
  const wt = join(dirname(dir), "wt-co");
  await g(dir, "worktree", "add", "-q", wt, "co");
  const r = await git.deleteOrPreserveBranch("co");
  assert.equal(r?.renamedTo, undefined);
  assert.equal(await g(wt, "rev-parse", "--abbrev-ref", "HEAD"), "co");
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/co"));
  await assert.rejects(git.deleteBranch("co", undefined, await g(dir, "rev-parse", "co")), /checked out/);
  assert.equal(await g(wt, "rev-parse", "--abbrev-ref", "HEAD"), "co");
});

test("restoreCheckpoint (existed=false) sets a recovered live copy aside instead of deleting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "w2b-ck3-"));
  const checkpoint = join(root, "cp");
  const state = join(root, "state");
  mkdirSync(checkpoint);
  mkdirSync(join(state, "db.replaced-9-x"), { recursive: true });
  writeFileSync(join(state, "db.replaced-9-x", "a"), "LIVE state from interrupted restore");
  writeFileSync(
    join(checkpoint, "checkpoint-manifest.json"),
    JSON.stringify({ stateDir: state, createdAt: "x", entries: [{ path: "db", existed: false }] }),
  );
  await restoreCheckpoint(checkpoint, state);
  const kept = readdirSync(state).find((n) => n.startsWith("db.replaced-recovered-"));
  assert.ok(kept, readdirSync(state).join(","));
  assert.equal(readFileSync(join(state, kept, "a"), "utf8"), "LIVE state from interrupted restore");
  assert.ok(!existsSync(join(state, "db")));
});

test("openReadOnly skips a repeated event_id like load()", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "w2b-ro-")), "events.jsonl");
  writeFileSync(file, `${[ev("e1"), ev("e2"), ev("e2")].map((e) => JSON.stringify(e)).join("\n")}\n`);
  const ro = await JsonlEventStore.openReadOnly(file);
  assert.deepEqual(
    ro.all().map((e) => e.event_id),
    ["e1", "e2"],
  );
});

test("torn tails quarantined in the same second never concatenate into one file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w2b-torn-same-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, '{"a":1}\n');
  for (const frag of ["AAA", "BBB", "CCC"]) {
    appendFileSync(file, frag);
    await repairTornTail(file);
  }
  const parts = readdirSync(dir)
    .filter((n) => n.startsWith("events.jsonl.torn-"))
    .map((n) => readFileSync(join(dir, n), "utf8"))
    .sort();
  assert.deepEqual(parts, ["AAA", "BBB", "CCC"]);
});

test("a symlinked marker is not trusted", async () => {
  const { head, git } = await scratchRepo();
  const info = await git.createWorktree(head, "sym-mark");
  const gitdir = await g(info.path, "rev-parse", "--absolute-git-dir");
  const real = join(gitdir, "pi-eng-owner.json");
  const copy = join(gitdir, "elsewhere.json");
  writeFileSync(copy, readFileSync(real));
  rmSync(real);
  symlinkSync(copy, real);
  assert.deepEqual(readOwnerMarker(gitdir), { ok: false, reason: "not a regular file" });
});

test("the kept-worktrees list holds one line per path", async () => {
  const { head, git, dir } = await ignoredRepo();
  const info = await git.createWorktree(head, "kept-2");
  writeFileSync(join(info.path, ".env"), "SECRET=1");
  for (let i = 0; i < 3; i++) await assert.rejects(git.removeWorktree(info));
  const common = join(dir, await g(dir, "rev-parse", "--git-common-dir"));
  const lines = readFileSync(join(common, "pi-engineering-candidates", "kept-scratch-worktrees.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 1);
});

const reachable = async (dir: string, sha: string): Promise<string> =>
  g(dir, "for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads", "refs/tags");

test("re-creating over a worktree with a DETACHED HEAD keeps its unreferenced commit", async () => {
  const { head, git, dir } = await scratchRepo();
  const wt = await git.createWorktree(head, "det-1");
  await g(wt.path, "checkout", "-q", "--detach");
  writeFileSync(join(wt.path, "work.txt"), "w");
  await g(wt.path, "add", "-A");
  await g(wt.path, "commit", "-qm", "detached work");
  const lost = await g(wt.path, "rev-parse", "HEAD");
  await git.createWorktree(head, "det-1");
  assert.match(await reachable(dir, lost), /superseded\/detached-/);
});

test("a registered worktree whose directory is gone and whose HEAD is detached keeps its commit", async () => {
  const { head, git, dir } = await scratchRepo();
  const wt = await git.createWorktree(head, "det-2");
  await g(wt.path, "checkout", "-q", "--detach");
  writeFileSync(join(wt.path, "work.txt"), "w");
  await g(wt.path, "add", "-A");
  await g(wt.path, "commit", "-qm", "detached work");
  const lost = await g(wt.path, "rev-parse", "HEAD");
  rmSync(wt.path, { recursive: true, force: true });
  await git.createWorktree(head, "det-2");
  assert.match(await reachable(dir, lost), /superseded\/detached-/);
});

test("admin cleanup never touches another worktree whose admin dir got a suffixed name", async () => {
  const { head, git, dir } = await scratchRepo();
  const probe = await git.createWorktree(head, "leaf-x");
  const leaf = basename(probe.path);
  await git.removeWorktree(probe, { keepBranch: true });
  const other = join(dir, "..", "elsewhere", leaf);
  mkdirSync(dirname(other), { recursive: true });
  await g(dir, "worktree", "add", "-q", "--detach", other, head); // takes the plain admin name
  writeFileSync(join(other, "w"), "w");
  await g(other, "add", "-A");
  await g(other, "commit", "-qm", "operator detached work");
  const work = await g(other, "rev-parse", "HEAD");
  const wt = await git.createWorktree(head, "leaf-x"); // its admin dir is <leaf>1
  await git.removeWorktree(wt, { keepBranch: true });
  assert.equal(await g(other, "rev-parse", "HEAD"), work, "the operator's worktree still works");
  assert.ok(existsSync(join(dir, ".git", "worktrees", leaf)));
});

for (const secret of [".envrc", "id_rsa", ".ENV", "service-account-prod.json", ".npmrc"]) {
  test(`removal keeps a worktree with ${secret} under target/`, async () => {
    const { head, git } = await userDataRepo();
    const info = await git.createWorktree(head, `sec-${secret.replace(/\W/g, "")}`);
    mkdirSync(join(info.path, "target", "x"), { recursive: true });
    writeFileSync(join(info.path, "target", "x", secret), "s");
    await assert.rejects(git.removeWorktree(info, { keepBranch: true }));
    assert.ok(existsSync(join(info.path, "target", "x", secret)));
  });
}

test("a branch being rebased in another worktree (detached HEAD) is kept and reported", async () => {
  const { dir, git } = await remoteRepo();
  await g(dir, "branch", "rb", "main");
  const wt = join(dir, "..", "wt-rb");
  await g(dir, "worktree", "add", "-q", wt, "rb");
  writeFileSync(join(wt, "c"), "1");
  await g(wt, "add", "-A");
  await g(wt, "commit", "-qm", "rb1");
  const rb1 = await g(wt, "rev-parse", "HEAD");
  await g(dir, "branch", "keepcopy", rb1);
  writeFileSync(join(wt, "c"), "2");
  await g(wt, "commit", "-qam", "rb2");
  try {
    await g(wt, "rebase", "-q", "--exec", "false", "main");
  } catch {
    // stops mid-rebase on purpose
  }
  assert.ok(existsSync(join(dir, ".git", "worktrees")), "linked worktree present");
  const r = await git.deleteOrPreserveBranch("rb");
  assert.match(r?.kept ?? "", /rebase/);
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/rb"));
});

async function detachedWork(git: GitRepo, head: string, name: string): Promise<{ path: string; work: string }> {
  const wt = await git.createWorktree(head, name);
  await g(wt.path, "checkout", "-q", "--detach");
  writeFileSync(join(wt.path, "work.txt"), "w");
  await g(wt.path, "add", "-A");
  await g(wt.path, "commit", "-qm", "detached work");
  return { path: wt.path, work: await g(wt.path, "rev-parse", "HEAD") };
}

const adminOf = (dir: string, path: string): string => {
  const root = join(dir, ".git", "worktrees");
  const name = readdirSync(root).find(
    (n) => readFileSync(join(root, n, "gitdir"), "utf8").trim() === join(path, ".git"),
  );
  assert.ok(name);
  return join(root, name);
};

test("duplicate admin dirs for one path: the live worktree's detached commit is still kept", async () => {
  const { head, git, dir } = await scratchRepo();
  const { path, work } = await detachedWork(git, head, "dup-1");
  const admin = adminOf(dir, path);
  cpSync(admin, `${admin}-stale`, { recursive: true });
  cpSync(admin, `${admin}-copy`, { recursive: true });
  rmSync(admin, { recursive: true });
  cpSync(`${admin}-copy`, admin, { recursive: true });
  rmSync(`${admin}-copy`, { recursive: true });
  try {
    await git.createWorktree(head, "dup-1");
  } catch {
    // refusing is also safe
  }
  const alive = existsSync(path) && (await g(path, "rev-parse", "HEAD")) === work;
  assert.ok(alive || (await reachable(dir, work)) !== "", "the detached commit survived");
});

test("a relative gitdir pointer (git >= 2.48) still identifies the admin dir", async () => {
  const { head, git, dir } = await scratchRepo();
  const { path } = await detachedWork(git, head, "rel-1");
  const admin = adminOf(dir, path);
  writeFileSync(join(admin, "gitdir"), `${relative(admin, join(path, ".git"))}\n`);
  const priv = git as unknown as { findAdminDir(p: string): Promise<string | null> };
  assert.equal(await priv.findAdminDir(path), admin);
  rmSync(path, { recursive: true, force: true });
  assert.equal(await priv.findAdminDir(path), admin);
});

test("a worktree mid-rebase with an autostash is never replaced, present or gone", async () => {
  for (const gone of [false, true]) {
    const { head, git, dir } = await scratchRepo();
    const wt = await git.createWorktree(head, "rb-auto");
    writeFileSync(join(wt.path, "c1"), "c1");
    await g(wt.path, "add", "-A");
    await g(wt.path, "commit", "-qm", "c1");
    writeFileSync(join(dir, "m2"), "m2");
    await g(dir, "add", "-A");
    await g(dir, "commit", "-qm", "m2");
    writeFileSync(join(wt.path, "a.txt"), "UNCOMMITTED PRECIOUS");
    await g(wt.path, "rebase", "--autostash", "--exec", "false", "main").catch(() => "");
    const admin = adminOf(dir, wt.path);
    assert.ok(existsSync(join(admin, "rebase-merge", "autostash")), "setup: rebase stopped with an autostash");
    if (gone) rmSync(wt.path, { recursive: true, force: true });
    await assert.rejects(git.createWorktree(head, "rb-auto"));
    assert.ok(existsSync(join(admin, "rebase-merge", "autostash")), `autostash kept (dir gone: ${gone})`);
  }
});

for (const entry of ["MERGE_HEAD", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer"]) {
  test(`a registered worktree with ${entry} in its admin dir is not forgotten`, async () => {
    const { head, git, dir } = await scratchRepo();
    const wt = await git.createWorktree(head, "ip-1");
    const admin = adminOf(dir, wt.path);
    if (entry === "sequencer") mkdirSync(join(admin, entry));
    else writeFileSync(join(admin, entry), `${head}\n`);
    rmSync(wt.path, { recursive: true, force: true });
    await assert.rejects(git.createWorktree(head, "ip-1"));
    assert.ok(existsSync(join(admin, entry)));
  });
}

test("a locked admin dir is left alone when its directory is gone", async () => {
  const { head, git, dir } = await scratchRepo();
  const wt = await git.createWorktree(head, "lk-1");
  const admin = adminOf(dir, wt.path);
  writeFileSync(join(admin, "locked"), "on a removable drive");
  rmSync(wt.path, { recursive: true, force: true });
  await assert.rejects(git.createWorktree(head, "lk-1"));
  assert.ok(existsSync(join(admin, "locked")));
});

test("rebase --update-refs counts the branches it will move as checked out", async () => {
  const { dir, git } = await remoteRepo();
  await g(dir, "checkout", "-q", "-b", "stackA");
  writeFileSync(join(dir, "a"), "a");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "a1");
  await g(dir, "checkout", "-q", "-b", "stackB");
  writeFileSync(join(dir, "b"), "b");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "b1");
  await g(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "m"), "m");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "m2");
  const wt = join(dir, "..", "wt-upd");
  await g(dir, "worktree", "add", "-q", wt, "stackB");
  await g(wt, "rebase", "-q", "--update-refs", "--exec", "false", "main").catch(() => "");
  assert.ok(existsSync(join(adminOf(dir, wt), "rebase-merge", "update-refs")), "setup: update-refs recorded");
  const r = await git.deleteOrPreserveBranch("stackA");
  assert.match(r?.kept ?? "", /rebase/);
  assert.ok(await g(dir, "rev-parse", "--verify", "refs/heads/stackA"));
});

test("detached-HEAD ref names are sanitised and never throw for naming reasons", async () => {
  const { head, git, dir } = await scratchRepo();
  const { path, work } = await detachedWork(git, head, "nm-1");
  const admin = adminOf(dir, path);
  for (const leaf of ["a b..c", `${"x".repeat(300)}`, "..", "-lead.lock", "tab\tq~^:"]) {
    await (git as unknown as { preserveDetachedHead(a: string, l: string): Promise<void> }).preserveDetachedHead(
      admin,
      leaf,
    );
  }
  const refs = (await reachable(dir, work)).split("\n").filter((r) => r.includes("detached-"));
  assert.ok(refs.length >= 1);
  for (const r of refs) assert.ok(r.length < 140 && /^[A-Za-z0-9._/-]+$/.test(r), r);
});

for (const [name, blocks] of [
  ["credentials.json", true],
  ["id_rsa", true],
  ["CredentialsService.class", false],
  ["credentials_helper.rs", false],
  ["credentials-0123abcd", false],
] as const) {
  test(`${name} under target/ ${blocks ? "keeps" : "does not keep"} the worktree`, async () => {
    const { head, git } = await userDataRepo();
    const info = await git.createWorktree(head, `cr-${name.replace(/\W/g, "")}`);
    mkdirSync(join(info.path, "target", "deps"), { recursive: true });
    writeFileSync(join(info.path, "target", "deps", name), "s");
    if (blocks) await assert.rejects(git.removeWorktree(info, { keepBranch: true }));
    else await git.removeWorktree(info, { keepBranch: true });
    assert.equal(existsSync(info.path), blocks);
  });
}

for (const mode of ["copied-checkout", "symlink-spelling"] as const) {
  test(`cleanup of a ${mode} of a live worktree never touches the live worktree's admin dir`, async () => {
    const { head, git, dir } = await scratchRepo();
    const branchName = `alias-${mode}-${process.pid}-${Date.now().toString(36)}`;
    const wt = await git.createWorktree(head, branchName);
    writeFileSync(join(wt.path, "staged.txt"), "STAGED ONLY");
    await g(wt.path, "add", "staged.txt");
    const alias = join(dirname(wt.path), basename(wt.path).replace(/^pi-eng-[0-9a-z]+-/, "pi-eng-zzzzzz-"));
    if (mode === "copied-checkout") cpSync(wt.path, alias, { recursive: true });
    else symlinkSync(wt.path, alias);
    await git
      .removeWorktree({ path: alias, branch: branchName }, { cleanupIdentity: { missionId: "m1", repoId: "r1" } })
      .catch(() => {});
    assert.match(await g(wt.path, "status", "--short"), /^A\s+staged\.txt/m);
    assert.ok((await g(dir, "worktree", "list")).includes(wt.path));
    assert.ok(existsSync(adminOf(dir, wt.path)));
    assert.ok(existsSync(join(adminOf(dir, wt.path), "index")));
  });
}

test("in-progress refusals name the path and the exact command", async () => {
  const { head, git, dir } = await scratchRepo();
  const wt = await git.createWorktree(head, "msg-1");
  const admin = adminOf(dir, wt.path);
  mkdirSync(join(admin, "rebase-merge"));
  rmSync(wt.path, { recursive: true, force: true });
  await assert.rejects(git.createWorktree(head, "msg-1"), (e: Error) => {
    assert.ok(e.message.includes(`git -C ${wt.path} rebase --abort`), e.message);
    return true;
  });
  rmSync(join(admin, "rebase-merge"), { recursive: true });
  writeFileSync(join(admin, "locked"), "usb drive");
  await assert.rejects(git.createWorktree(head, "msg-1"), (e: Error) => {
    assert.ok(e.message.includes("usb drive") && e.message.includes(`git worktree unlock ${wt.path}`), e.message);
    return true;
  });
});

test("ambiguous admin dirs for a vanished worktree are named in the operator error", async () => {
  const { head, git, dir } = await scratchRepo();
  const wt = await git.createWorktree(head, "amb-1");
  const admin = adminOf(dir, wt.path);
  cpSync(admin, `${admin}-stale`, { recursive: true });
  rmSync(wt.path, { recursive: true, force: true });
  await assert.rejects(git.createWorktree(head, "amb-1"), (e: Error) => {
    assert.ok(e.message.includes(`${admin}-stale`) && /several administrative directories/.test(e.message), e.message);
    return true;
  });
});

for (const secret of [".git-credentials", "id_rsa_backup", "id_ed25519-old", "id_rsa.bak"]) {
  test(`removal keeps a worktree with ${secret} under target/`, async () => {
    const { head, git } = await userDataRepo();
    const info = await git.createWorktree(head, `sec6-${secret.replace(/\W/g, "")}`);
    mkdirSync(join(info.path, "target", "x"), { recursive: true });
    writeFileSync(join(info.path, "target", "x", secret), "s");
    await assert.rejects(git.removeWorktree(info, { keepBranch: true }));
    assert.ok(existsSync(join(info.path, "target", "x", secret)));
  });
}

test("rebaseWorktreeOnto works when git has no identity (the -c options precede the subcommand)", async () => {
  const { head, git, dir } = await scratchRepo();
  const wt = await git.createWorktree(head, "rb-id");
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
  writeFileSync(join(wt.path, "c.txt"), "c");
  await exec("git", ["-C", wt.path, ...id, "add", "-A"]);
  await exec("git", ["-C", wt.path, ...id, "commit", "-qm", "c"]);
  writeFileSync(join(dir, "m.txt"), "m");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-qm", "m");
  const onto = await g(dir, "rev-parse", "HEAD");
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosys: process.env.GIT_CONFIG_NOSYSTEM };
  await exec("git", ["-C", dir, "config", "--unset", "user.name"]);
  await exec("git", ["-C", dir, "config", "--unset", "user.email"]);
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const fresh = await GitRepo.open(dir);
    assert.ok(fresh);
    const r = await fresh.rebaseWorktreeOnto(wt, onto);
    assert.equal(r.ok, true, String(r.reason));
  } finally {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosys;
  }
});

test(
  "an unreadable parent (EACCES) is not 'directory gone': the live worktree's admin dir survives",
  {
    skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false,
  },
  async () => {
    const { head, git, dir } = await scratchRepo();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "w2b-eacces-")));
    const path = join(parent, "pi-eng-live");
    await g(dir, "worktree", "add", "-q", "-b", "live-eacces", path, head);
    writeFileSync(join(path, "staged.txt"), "STAGED");
    await g(path, "add", "staged.txt");
    const admin = adminOf(dir, path);
    const priv = git as unknown as {
      forgetWorktreeAdmin(p: string): Promise<string | null>;
      clearStaleWorktreeTarget(p: string, b: string): Promise<void>;
    };
    chmodSync(parent, 0o000);
    try {
      await assert.rejects(priv.forgetWorktreeAdmin(path), /cannot tell whether .* exists \(EACCES\)/);
      await assert.rejects(priv.clearStaleWorktreeTarget(path, "live-eacces"), /EACCES/);
    } finally {
      chmodSync(parent, 0o755);
    }
    assert.ok(existsSync(join(admin, "index")));
    assert.match(await g(path, "status", "--short"), /^A\s+staged\.txt/m);
  },
);

test("fallbackIdentityArgs fills in only the missing key", async () => {
  const { head, git, dir } = await scratchRepo();
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosys: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const ask = async (cwd?: string): Promise<string[]> => {
    const fresh = await GitRepo.open(dir);
    assert.ok(fresh);
    return (fresh as unknown as { fallbackIdentityArgs(c?: string): Promise<string[]> }).fallbackIdentityArgs(cwd);
  };
  try {
    assert.deepEqual(await ask(), []); // scratchRepo configures both
    await g(dir, "config", "--unset", "user.email");
    assert.deepEqual(await ask(), ["-c", "user.email=lanes@pi-engineering.local"]);
    await g(dir, "config", "--unset", "user.name");
    assert.deepEqual(await ask(), ["-c", "user.name=pi-engineering", "-c", "user.email=lanes@pi-engineering.local"]);
  } finally {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosys;
  }
});

test("restoreCheckpoint recovers the NEWEST leftover (by timestamp, not pid) and keeps a recovered copy when swapping", async () => {
  const root = mkdtempSync(join(tmpdir(), "w2b-ck4-"));
  const checkpoint = join(root, "cp");
  const state = join(root, "state");
  mkdirSync(join(checkpoint, "state"), { recursive: true });
  mkdirSync(state);
  writeFileSync(join(checkpoint, "state", "live.json"), "CHECKPOINT");
  writeFileSync(join(state, "live.json.replaced-9-1"), "OLDER");
  writeFileSync(join(state, "live.json.replaced-1-zzzz"), "NEWEST");
  writeFileSync(
    join(checkpoint, "checkpoint-manifest.json"),
    JSON.stringify({ stateDir: state, createdAt: "x", entries: [{ path: "live.json", existed: true }] }),
  );
  await restoreCheckpoint(checkpoint, state);
  assert.equal(readFileSync(join(state, "live.json"), "utf8"), "CHECKPOINT");
  const kept = readdirSync(state).filter((n) => n.startsWith("live.json.replaced-recovered-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(state, kept[0] as string), "utf8"), "NEWEST");
});

test("the kept-worktrees list drops entries whose worktree no longer exists", async () => {
  const { head, git, dir } = await ignoredRepo();
  const a = await git.createWorktree(head, "kept-a");
  writeFileSync(join(a.path, ".env"), "S");
  await assert.rejects(git.removeWorktree(a));
  rmSync(a.path, { recursive: true, force: true });
  const b = await git.createWorktree(head, "kept-b");
  writeFileSync(join(b.path, ".env"), "S");
  await assert.rejects(git.removeWorktree(b));
  const common = join(dir, await g(dir, "rev-parse", "--git-common-dir"));
  const lines = readFileSync(join(common, "pi-engineering-candidates", "kept-scratch-worktrees.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).path);
  assert.deepEqual(lines, [b.path]);
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
