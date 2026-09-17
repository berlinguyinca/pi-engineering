/**
 * Change observation (spec §7).
 *
 * The harness never trusts a model's claim that work is finished — it looks at
 * the repository. A snapshot covers committed-vs-base, staged, unstaged and
 * untracked work, plus the tool activity observed in-session, and produces a
 * stable fingerprint so a gate is not re-run for identical content.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ChangeFile, ChangeSnapshot } from "./types.ts";
import { EMPTY_CHANGE_SNAPSHOT } from "./types.ts";

const exec = promisify(execFile);

export interface ObserveOptions {
  cwd: string;
  /** Committed baseline; defaults to HEAD (or the empty repo root). */
  baseRef?: string;
  /** Observed tool activity for the session. */
  mutationsObserved?: number;
  commandsObserved?: string[];
  /** Max characters of diff retained for classification (full diff goes to artifacts). */
  diffExcerptChars?: number;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    return { stdout: stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: typeof e.stdout === "string" ? e.stdout : "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

function parseStatusLine(line: string): { index: string; worktree: string; path: string; orig?: string } | undefined {
  if (line.length < 4) return undefined;
  const index = line[0] ?? " ";
  const worktree = line[1] ?? " ";
  let rest = line.slice(3);
  let orig: string | undefined;
  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0) {
    orig = rest.slice(0, arrow);
    rest = rest.slice(arrow + 4);
  }
  // Quote-paths are quoted by git when they contain unusual characters.
  rest = rest.replace(/^"|"$/g, "");
  return { index, worktree, path: rest, orig };
}

function numstatFor(stdout: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const map = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").replace(/^"|"$/g, "");
    if (!path) continue;
    const binary = addedRaw === "-" || deletedRaw === "-";
    map.set(path, {
      added: binary ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0,
      deleted: binary ? 0 : Number.parseInt(deletedRaw ?? "0", 10) || 0,
      binary,
    });
  }
  return map;
}

/** Capture the complete change picture for a working tree. */
export async function captureChangeSnapshot(opts: ObserveOptions): Promise<ChangeSnapshot> {
  const cwd = opts.cwd;
  const excerptLimit = opts.diffExcerptChars ?? 24_000;

  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    // Not a repository: fall back to observed activity only, and say so.
    const fingerprint = createHash("sha256")
      .update(`${(opts.commandsObserved ?? []).join("\n")}|${opts.mutationsObserved ?? 0}`)
      .digest("hex")
      .slice(0, 16);
    return {
      ...EMPTY_CHANGE_SNAPSHOT,
      capturedAt: new Date().toISOString(),
      fingerprint: `nogit-${fingerprint}`,
      mutationsObserved: opts.mutationsObserved ?? 0,
      commandsObserved: opts.commandsObserved ?? [],
      isGit: false,
    };
  }

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const headCommit = head.code === 0 ? head.stdout.trim() : "";
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headRef = branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : "HEAD";
  let baseRef = opts.baseRef ?? headRef;
  if (!headCommit) baseRef = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // empty tree

  const statusRes = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const numstatStaged = numstatFor((await git(cwd, ["diff", "--cached", "--numstat", baseRef])).stdout);
  const numstatWork = numstatFor((await git(cwd, ["diff", "--numstat"])).stdout);

  const files: ChangeFile[] = [];
  const seen = new Set<string>();
  for (const line of statusRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseStatusLine(line);
    if (!parsed) continue;
    const { index, worktree, path, orig } = parsed;
    const staged = index !== " " && index !== "?";
    const unstaged = worktree !== " " && worktree !== "?";
    const untracked = index === "?" && worktree === "?";
    const stat = numstatStaged.get(path) ?? numstatWork.get(path) ?? { added: 0, deleted: 0, binary: false };
    const scope: ChangeFile["scope"] = untracked
      ? "untracked"
      : staged && !unstaged
        ? "staged"
        : staged
          ? "staged"
          : "unstaged";
    seen.add(path);
    files.push({
      path,
      added: index === "A" || untracked,
      deleted: index === "D" || worktree === "D",
      renamed: orig,
      linesAdded: stat.added || (untracked ? 1 : 0),
      linesDeleted: stat.deleted,
      binary: stat.binary,
      scope,
    });
  }

  // Committed work on top of the baseline is part of the change set too.
  if (headCommit && baseRef !== headCommit) {
    const committed = numstatFor((await git(cwd, ["diff", "--numstat", `${baseRef}..${headCommit}`])).stdout);
    for (const [path, stat] of committed) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({
        path,
        added: false,
        deleted: false,
        linesAdded: stat.added,
        linesDeleted: stat.deleted,
        binary: stat.binary,
        scope: "base",
      });
    }
  }

  const diffRes = await git(cwd, ["diff", "--no-color", baseRef]);
  const unstagedDiff = await git(cwd, ["diff", "--no-color"]);
  const rawDiff = diffRes.stdout.length >= unstagedDiff.stdout.length ? diffRes.stdout : unstagedDiff.stdout;
  const untrackedText = files
    .filter((f) => f.scope === "untracked")
    .map((f) => `--- /dev/null\n+++ b/${f.path}\n`)
    .join("");
  const fullDiff = `${rawDiff}${untrackedText}`;
  const truncated = fullDiff.length > excerptLimit;
  const diffExcerpt = truncated ? fullDiff.slice(0, excerptLimit) : fullDiff;

  const fingerprint = createHash("sha256")
    .update(
      [
        headCommit,
        ...files
          .map(
            (f) =>
              `${f.scope}:${f.path}:${f.linesAdded}:${f.linesDeleted}:${f.added ? "A" : ""}${f.deleted ? "D" : ""}`,
          )
          .sort(),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 20);

  return {
    capturedAt: new Date().toISOString(),
    baseRef,
    headRef,
    headCommit,
    fingerprint,
    files,
    diffExcerpt,
    diffChars: fullDiff.length,
    truncated,
    mutationsObserved: opts.mutationsObserved ?? 0,
    commandsObserved: opts.commandsObserved ?? [],
    isGit: true,
  };
}

/** True when a snapshot contains work a reviewer should look at. */
export function hasMeaningfulChange(snapshot: ChangeSnapshot): boolean {
  if (!snapshot.isGit) return (snapshot.mutationsObserved ?? 0) > 0;
  return snapshot.files.length > 0;
}

/** Paths grouped by top-level area, for plan-trigger and review scoping. */
export function changeAreas(snapshot: ChangeSnapshot): string[] {
  const areas = new Set<string>();
  for (const f of snapshot.files) {
    const parts = f.path.split("/");
    areas.add(parts.length > 1 ? parts.slice(0, 2).join("/") : (parts[0] ?? f.path));
  }
  return [...areas].sort();
}
