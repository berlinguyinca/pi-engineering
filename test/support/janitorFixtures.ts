import { execFile } from "node:child_process";
import { access, lutimes, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import { OWNER_MARKER_FILE, writeOwnerMarker as writeMarker } from "../../src/git/ownerMarker.ts";
import { shortHash } from "../../src/git/shortHash.ts";

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

/** `GitRepo.createWorktree` writes the ownership marker itself (src/git/ownerMarker.ts); no hand-written markers. */
export async function createOwned(
  repo: GitRepo,
  base: string,
  branch: string,
): Promise<Awaited<ReturnType<GitRepo["createWorktree"]>>> {
  return repo.createWorktree(base, branch);
}

/** Stamp a worktree made by plain `git worktree add` with the runtime's own marker writer. */
export async function writeOwnerMarker(repo: GitRepo, path: string, branch: string | null): Promise<string> {
  return writeMarker(path, { repoRoot: repo.root, repoRootHash: shortHash(repo.root), branch });
}

/** Absolute path of the marker file of a worktree. */
export async function markerFile(path: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", path, "rev-parse", "--absolute-git-dir"]);
  return join(stdout.trim(), OWNER_MARKER_FILE);
}

/** The ONE hand-written marker form: take the real marker and overwrite fields (`undefined` deletes a field). */
export async function tamperMarker(path: string, patch: Record<string, unknown>): Promise<void> {
  const file = await markerFile(path);
  const marker = { ...JSON.parse(await readFile(file, "utf8")), ...patch };
  await writeFile(file, JSON.stringify(marker));
}

/** A worktree whose HEAD is detached carries a marker that recorded no branch (marker branch must equal the live branch exactly). */
export async function markDetached(path: string): Promise<void> {
  await tamperMarker(path, { branch: null });
}
