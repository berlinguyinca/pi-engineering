/**
 * Worktree ownership marker.
 *
 * Every `git worktree add` performed by pi-engineering writes
 * `<gitdir>/pi-eng-owner.json` (gitdir = `git rev-parse --absolute-git-dir` run
 * inside the new worktree, i.e. `<repo>/.git/worktrees/<name>`). The marker is
 * proof of who created a worktree, independent of its directory name, so
 * cleanup tooling can refuse to touch worktrees it cannot prove it owns.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { safeGitOrThrow } from "./safeGit.ts";
import { shortHash } from "./shortHash.ts";

export const OWNER_MARKER_FILE = "pi-eng-owner.json";

export interface OwnerMarker {
  version: 1;
  creator: "pi-engineering";
  /** The same hash the `pi-eng-<hash>-` worktree namespace uses (`shortHash(repoRoot)`). */
  repoRootHash: string;
  /** Full sha256 (hex) of the repo root realpath. */
  repoRootSha256: string;
  branch: string | null;
  createdAt: string;
}

export type OwnerMarkerRead = { ok: true; marker: OwnerMarker } | { ok: false; reason: string };

/**
 * Read and validate `<gitdir>/pi-eng-owner.json`. Never throws.
 *
 * With `{ repoRoot }` the marker must also belong to THAT repository:
 * `repoRootHash` must equal `shortHash(repoRoot)` (or of its realpath) and
 * `repoRootSha256` the sha256 of `realpath(repoRoot)`; with `branch` the recorded branch must equal it
 * (a marker copied from a sibling worktree names a different branch). Without `repoRoot` only the
 * format is checked (format-only callers); cleanup paths must pass `repoRoot`.
 */
export function readOwnerMarker(
  gitdir: string,
  opts: { repoRoot?: string; branch?: string | null } = {},
): OwnerMarkerRead {
  const read = readOwnerMarkerFormat(gitdir);
  if (!read.ok || opts.repoRoot === undefined) return read;
  let real = opts.repoRoot;
  try {
    real = realpathSync(opts.repoRoot);
  } catch {
    // unresolvable root: compare against the string as given
  }
  if (read.marker.repoRootHash !== shortHash(opts.repoRoot) && read.marker.repoRootHash !== shortHash(real)) {
    return { ok: false, reason: "repo mismatch (repoRootHash)" };
  }
  if (read.marker.repoRootSha256 !== createHash("sha256").update(real).digest("hex")) {
    return { ok: false, reason: "repo mismatch (repoRootSha256)" };
  }
  // A marker copied from a sibling worktree of the same repo names another branch.
  if (opts.branch !== undefined && read.marker.branch !== opts.branch) {
    return { ok: false, reason: "branch mismatch" };
  }
  return read;
}

function readOwnerMarkerFormat(gitdir: string): OwnerMarkerRead {
  let raw: string;
  try {
    // A symlink or other non-regular file is never trusted as a marker.
    if (!lstatSync(join(gitdir, OWNER_MARKER_FILE)).isFile()) return { ok: false, reason: "not a regular file" };
    raw = readFileSync(join(gitdir, OWNER_MARKER_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : `unreadable: ${code ?? "error"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not an object" };
  }
  const m = parsed as Record<string, unknown>;
  if (m.version !== 1) return { ok: false, reason: "unsupported version" };
  if (m.creator !== "pi-engineering") return { ok: false, reason: "foreign creator" };
  if (typeof m.repoRootHash !== "string" || !/^[0-9a-z]+$/.test(m.repoRootHash)) {
    return { ok: false, reason: "bad repoRootHash" };
  }
  if (typeof m.repoRootSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.repoRootSha256)) {
    return { ok: false, reason: "bad repoRootSha256" };
  }
  if (m.branch !== null && typeof m.branch !== "string") return { ok: false, reason: "bad branch" };
  if (typeof m.createdAt !== "string" || Number.isNaN(Date.parse(m.createdAt))) {
    return { ok: false, reason: "bad createdAt" };
  }
  return {
    ok: true,
    marker: {
      version: 1,
      creator: "pi-engineering",
      repoRootHash: m.repoRootHash,
      repoRootSha256: m.repoRootSha256,
      branch: m.branch,
      createdAt: m.createdAt,
    },
  };
}

/**
 * Stamp a freshly added worktree. `repoRootHash` is passed in (callers hold
 * `shortHash(repoRoot)`) so this module stays free of an import cycle.
 */
export async function writeOwnerMarker(
  worktreePath: string,
  opts: { repoRoot: string; repoRootHash: string; branch: string | null },
): Promise<string> {
  const { stdout } = await safeGitOrThrow(["rev-parse", "--absolute-git-dir"], {
    cwd: worktreePath,
    trust: "operator",
  });
  const gitdir = stdout.trim();
  const marker: OwnerMarker = {
    version: 1,
    creator: "pi-engineering",
    repoRootHash: opts.repoRootHash,
    repoRootSha256: createHash("sha256").update(realpathSync(opts.repoRoot)).digest("hex"),
    branch: opts.branch,
    createdAt: new Date().toISOString(),
  };
  const file = join(gitdir, OWNER_MARKER_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  // O_EXCL: never write through a pre-existing file or symlink; fsync before the rename.
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(marker)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return file;
}
