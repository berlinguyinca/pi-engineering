/**
 * Data-loss wave 2B: ownership markers, non-destructive worktree/branch cleanup,
 * non-overwriting rotation, torn-tail quarantine. Real git, real files.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import { GitRepo, shortHash } from "../../src/git/GitRepo.ts";
import { readOwnerMarker } from "../../src/git/ownerMarker.ts";
import { repairTornTail } from "../../src/platform/eventstore/jsonl.ts";
import { emitRuntimeEvent, setRuntimeEventLog } from "../../src/runtime/isolation/runtimeEvents.ts";
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
