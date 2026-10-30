/**
 * Worktree ownership marker.
 *
 * Every `git worktree add` performed by pi-engineering writes
 * `<gitdir>/pi-eng-owner.json` (gitdir = `git rev-parse --absolute-git-dir` run
 * inside the new worktree, i.e. `<repo>/.git/worktrees/<name>`). The marker is
 * proof of who created a worktree, independent of its directory name, so
 * cleanup tooling can refuse to touch worktrees it cannot prove it owns.
 */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGitOrThrow } from "./safeGit.ts";

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

/** Read and validate `<gitdir>/pi-eng-owner.json`. Never throws. */
export function readOwnerMarker(gitdir: string): OwnerMarkerRead {
  let raw: string;
  try {
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
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}
