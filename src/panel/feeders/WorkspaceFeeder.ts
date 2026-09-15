/**
 * Workspace feeder — the panel's view when no engineering run is active.
 *
 * Reads the git working tree and the session's own context usage so the panel
 * is never empty during ordinary interactive coding.
 *
 * Git runs on a TTL, never on the render path: the same discipline the status
 * footer uses (`src/status/git-context.ts`). A failed read marks the section
 * and keeps the last good data, because a momentarily broken git is not a
 * reason to blank what the operator was looking at.
 */

import type { GitRepo } from "../../git/GitRepo.ts";
import type { PanelFileEntry, PanelState } from "../PanelState.ts";

/** Matches the status bar's git cache TTL. */
export const DEFAULT_WORKSPACE_TTL_MS = 30_000;

export interface WorkspaceFeederOptions {
  state: PanelState;
  /** Null outside a git repository — not an error, just nothing to show. */
  repo: GitRepo | null;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
  ttlMs?: number;
  /** Session context usage, when the host exposes it. */
  contextUsage?: () => { tokens: number | null; percent: number | null } | undefined;
}

/**
 * Parse `git status --short` output into typed entries.
 *
 * Pure and total: anything unparsable is skipped rather than throwing.
 */
export function parseGitStatusShort(output: string): PanelFileEntry[] {
  const entries: PanelFileEntry[] = [];
  for (const rawLine of output.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    const code = rawLine.slice(0, 2);
    const rest = rawLine.slice(3).trim();
    if (rest.length === 0) continue;

    if (code === "??") {
      entries.push({ path: unquote(rest), change: "untracked" });
      continue;
    }
    // A rename reports "old -> new"; the new path is the one worth showing.
    if (code.includes("R")) {
      const arrow = rest.indexOf("->");
      const target = arrow >= 0 ? rest.slice(arrow + 2).trim() : rest;
      entries.push({ path: unquote(target), change: "renamed" });
      continue;
    }
    if (code.includes("D")) {
      entries.push({ path: unquote(rest), change: "deleted" });
      continue;
    }
    if (code.includes("A")) {
      entries.push({ path: unquote(rest), change: "added" });
      continue;
    }
    entries.push({ path: unquote(rest), change: "modified" });
  }
  return entries;
}

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

export class WorkspaceFeeder {
  private readonly state: PanelState;
  private readonly repo: GitRepo | null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly contextUsage: WorkspaceFeederOptions["contextUsage"];
  /** Timestamp of the last SUCCESSFUL read; 0 means "never read". */
  private lastReadAt = 0;
  private hasRead = false;

  constructor(opts: WorkspaceFeederOptions) {
    this.state = opts.state;
    this.repo = opts.repo;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? DEFAULT_WORKSPACE_TTL_MS;
    this.contextUsage = opts.contextUsage;
  }

  /** Force the next refresh to re-read git (e.g. on a branch change). */
  invalidate(): void {
    this.hasRead = false;
  }

  /**
   * Re-read the working tree if the cache has expired. Never rejects: a git
   * failure is reported through the panel, not thrown at the caller.
   */
  async refresh(): Promise<void> {
    if (this.hasRead && this.now() - this.lastReadAt < this.ttlMs) return;

    if (!this.repo) {
      // Outside a git repository there is simply nothing to show.
      this.publish([], undefined);
      this.hasRead = true;
      this.lastReadAt = this.now();
      return;
    }

    try {
      const [status, branch] = await Promise.all([this.repo.status(), this.repo.currentBranch()]);
      this.publish(parseGitStatusShort(status), branch ?? undefined);
      this.state.clearError("workspace");
      this.hasRead = true;
      this.lastReadAt = this.now();
    } catch (err) {
      // Keep whatever was on screen: a transient git failure should not blank
      // the panel the operator is reading.
      this.state.noteError("workspace", err instanceof Error ? err.message : String(err));
    }
  }

  private publish(files: PanelFileEntry[], branch: string | undefined): void {
    const usage = this.contextUsage?.();
    this.state.set({
      workspace: {
        ...(branch ? { branch } : {}),
        files,
        ...(usage?.tokens != null ? { contextTokens: usage.tokens } : {}),
        ...(usage?.percent != null ? { contextPercent: usage.percent } : {}),
      },
      updatedAt: this.now(),
    });
  }
}
