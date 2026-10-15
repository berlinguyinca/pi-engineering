import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** Ignored paths (`!! path` lines of `git status --ignored`), and the non-ignored remainder. */
function splitStatus(porcelain: string): { dirty: string; ignored: Set<string> } {
  const dirty: string[] = [];
  const ignored = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("!! ")) ignored.add(line.slice(3));
    else dirty.push(line);
  }
  return { dirty: dirty.join("\n"), ignored };
}

/** Hash of the shared git dir's hooks and config: a planted hook would outlive the candidate worktree. */
async function commonDirHash(cwd: string): Promise<string> {
  const common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const hash = createHash("sha256");
  const read = async (path: string): Promise<void> => {
    hash.update(path);
    hash.update(await readFile(path).catch(() => ""));
  };
  await read(join(common, "config"));
  const hooks = await readdir(join(common, "hooks")).catch(() => [] as string[]);
  for (const name of hooks.sort()) await read(join(common, "hooks", name));
  return hash.digest("hex");
}

interface Snapshot {
  head: string;
  dirty: string;
  ignored: Set<string>;
  refs: string;
  common: string;
}

/**
 * Only refs the reviewer could meaningfully move for THIS candidate are watched:
 * the worktree's own HEAD symbolic ref and its target branch, and tags. The
 * common dir is shared with the user's real repository, where other sessions
 * commit, fetch and create worker/candidate branches all the time, so comparing
 * every ref (other branches, refs/remotes/*) would fail reviews at random.
 */
async function watchedRefs(cwd: string): Promise<string> {
  const symbolic = (await git(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
  const own = symbolic ? await git(cwd, ["for-each-ref", symbolic]) : "";
  const tags = await git(cwd, ["for-each-ref", "refs/tags/"]);
  return `${symbolic}\n${own}${tags}`;
}

async function snapshot(cwd: string): Promise<Snapshot> {
  const status = splitStatus(await git(cwd, ["status", "--porcelain", "--ignored"]));
  return {
    head: (await git(cwd, ["rev-parse", "HEAD"])).trim(),
    dirty: status.dirty,
    ignored: status.ignored,
    refs: await watchedRefs(cwd),
    common: await commonDirHash(cwd),
  };
}

/** Put the worktree back on the recorded candidate: reset tracked files, drop untracked files and new ignored paths. */
async function restore(cwd: string, candidateSha: string, knownIgnored: Set<string>): Promise<void> {
  await git(cwd, ["reset", "--hard", "-q", candidateSha]);
  await git(cwd, ["clean", "-fdq"]);
  const now = splitStatus(await git(cwd, ["status", "--porcelain", "--ignored"]));
  for (const path of now.ignored)
    if (!knownIgnored.has(path)) await rm(join(cwd, path), { recursive: true, force: true });
}

export interface ReviewGuard {
  /** Undefined when the candidate is intact; otherwise the reason. The worktree is restored first. */
  check(): Promise<string | undefined>;
  /** New ignored paths the last check removed quietly (they do not fail the review). */
  removedIgnored: string[];
}

/**
 * Guard a candidate worktree around a reviewer that has bash. The baseline is the
 * recorded candidate (HEAD == candidateSha, clean tree), never whatever the tree
 * looked like when this attempt started: a previous attempt's mutation must not
 * become the next attempt's baseline. Returns null when `cwd` is not a git checkout.
 */
export async function guardReviewWorktree(cwd: string | undefined, candidateSha?: string): Promise<ReviewGuard | null> {
  if (!cwd) return null;
  let start: Snapshot;
  try {
    start = await snapshot(cwd);
    if (candidateSha && (start.head !== candidateSha || start.dirty)) {
      await restore(cwd, candidateSha, start.ignored);
      start = await snapshot(cwd);
    }
  } catch {
    return null;
  }
  const expectedHead = candidateSha ?? start.head;
  const expectedDirty = candidateSha ? "" : start.dirty;
  const guard: ReviewGuard = {
    removedIgnored: [],
    async check() {
      let now: Snapshot;
      try {
        now = await snapshot(cwd);
      } catch (error) {
        return `reviewer mutated the candidate (state unreadable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
      }
      const reasons: string[] = [];
      if (now.head !== expectedHead) reasons.push("HEAD moved");
      if (now.dirty !== expectedDirty) reasons.push("the working tree changed");
      // Test runs legitimately write ignored output (coverage, caches): remove it, never fail for it.
      const strayIgnored = [...now.ignored].filter((path) => !start.ignored.has(path));
      guard.removedIgnored = strayIgnored;
      if (now.refs !== start.refs) reasons.push("git refs changed");
      if (now.common !== start.common) reasons.push("shared git hooks or config changed");
      if (reasons.length === 0) {
        for (const path of strayIgnored)
          await rm(join(cwd, path), { recursive: true, force: true }).catch(() => undefined);
        return undefined;
      }
      if (candidateSha) await restore(cwd, candidateSha, start.ignored).catch(() => undefined);
      return `reviewer mutated the candidate (${reasons.join("; ")})`;
    },
  };
  return guard;
}
