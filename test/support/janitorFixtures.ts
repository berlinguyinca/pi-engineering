import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lutimes, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitRepo, shortHash } from "../../src/git/GitRepo.ts";

const exec = promisify(execFile);

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Push every activity probe of a worktree into the past. */
export async function ageTree(dir: string, then: Date): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await ageTree(full, then);
    // A symlink's own times, never its target's (the provisioned node_modules link points at the real repo).
    await (entry.isSymbolicLink() ? lutimes(full, then, then) : utimes(full, then, then)).catch(() => {});
  }
}

export async function ageWorktree(path: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs);
  await ageTree(path, then);
  const link = (await readFile(join(path, ".git"), "utf8")).trim().replace(/^gitdir:\s*/, "");
  for (const p of [path, join(path, ".git"), join(link, "index"), join(link, "HEAD"), join(link, "logs", "HEAD")]) {
    await utimes(p, then, then).catch(() => {});
  }
}

/**
 * `createWorktree` plus the ownership marker the runtime writes (`pi-eng-owner.json` in the worktree's git dir,
 * contract shared with the worktree-creation side). Written here so these tests do not depend on that side.
 */
export async function createOwned(
  repo: GitRepo,
  base: string,
  branch: string,
): Promise<Awaited<ReturnType<GitRepo["createWorktree"]>>> {
  const wt = await repo.createWorktree(base, branch);
  await writeOwnerMarker(repo, wt.path, branch);
  return wt;
}

export async function writeOwnerMarker(
  repo: GitRepo,
  path: string,
  branch: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { stdout } = await exec("git", ["-C", path, "rev-parse", "--absolute-git-dir"]);
  const file = join(stdout.trim(), "pi-eng-owner.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      creator: "pi-engineering",
      repoRootHash: shortHash(repo.root),
      repoRootSha256: createHash("sha256").update(repo.root).digest("hex"),
      branch,
      createdAt: new Date().toISOString(),
      ...overrides,
    }),
  );
  return file;
}
