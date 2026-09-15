/**
 * Deciding whether the loaded extension is out of date, and whether it is safe
 * to do anything about it.
 *
 * This exists because of a real incident. An operator hit the exact failure this
 * package had just fixed — a saturated gateway killing the interactive turn —
 * and the giveaway was a notice in their session that had been DELETED in the
 * fix. Their pi was loading a checkout from before the merge. Nothing in the
 * session said so, and there is no worse failure mode than a fix that is
 * installed but not loaded: the operator reports the bug as unfixed, and the
 * evidence they quote is from code that no longer exists.
 *
 * ── Why most of this is refusals ────────────────────────────────────────────
 *
 * Auto-updating is pulling code into a directory the operator may be working
 * in. Getting it wrong costs uncommitted work, which no amount of being
 * up-to-date is worth. So an update runs only when every one of these holds:
 * a clean tree, a branch that tracks an upstream, and a strict fast-forward.
 * Anything else reports and stops.
 *
 * Pure: the caller supplies the observations and performs any git work.
 */

/** What `git` says about the checkout. */
export interface RepoObservation {
  /** Current branch, or null when detached. */
  branch: string | null;
  /** The branch this one tracks, e.g. `origin/main`. Null when untracked. */
  upstream: string | null;
  /** Uncommitted changes present. */
  dirty: boolean;
  /** Commits the local branch has that upstream does not. */
  ahead: number;
  /** Commits upstream has that the local branch does not. */
  behind: number;
  /** Local HEAD, for reporting. */
  head?: string;
  /** Upstream HEAD, for reporting. */
  upstreamHead?: string;
}

export type UpdateAction =
  /** Nothing to do. */
  | { action: "current"; reason: string }
  /** Safe to fast-forward. */
  | { action: "update"; reason: string; behind: number }
  /** Behind, but applying it automatically would risk something. */
  | { action: "report"; reason: string; behind: number }
  /** Not a situation this tool should touch at all. */
  | { action: "skip"; reason: string };

/**
 * Decide what to do about the checkout.
 *
 * `report` and `skip` differ in what they mean to the operator: `report` says
 * "you are behind and I will not apply it for you", which is actionable;
 * `skip` says "this checkout is not something I should be reasoning about",
 * which is not.
 */
export function decideUpdate(obs: RepoObservation): UpdateAction {
  if (!obs.branch) {
    return { action: "skip", reason: "detached HEAD — no branch to update" };
  }
  if (!obs.upstream) {
    return { action: "skip", reason: `${obs.branch} tracks no upstream` };
  }
  if (obs.behind === 0 && obs.ahead === 0) {
    return { action: "current", reason: `up to date with ${obs.upstream}` };
  }
  if (obs.behind === 0) {
    // Ahead only: local work not yet pushed. Nothing to pull, and nothing wrong.
    return { action: "current", reason: `${obs.ahead} commit(s) ahead of ${obs.upstream}, nothing to pull` };
  }
  if (obs.ahead > 0) {
    // Diverged. A fast-forward is impossible and anything else is a merge,
    // which is a decision about someone's work, not a maintenance task.
    return {
      action: "report",
      behind: obs.behind,
      reason: `diverged from ${obs.upstream} (${obs.ahead} ahead, ${obs.behind} behind) — merge or rebase yourself`,
    };
  }
  if (obs.dirty) {
    // The one that actually costs something. A pull onto a dirty tree can
    // refuse, stash, or conflict; none of those belong in a background task.
    return {
      action: "report",
      behind: obs.behind,
      reason: `${obs.behind} commit(s) behind ${obs.upstream}, but the working tree has uncommitted changes`,
    };
  }
  return { action: "update", behind: obs.behind, reason: `fast-forward ${obs.behind} commit(s) from ${obs.upstream}` };
}

/** Parse `git status --porcelain=v2 --branch` into an observation. */
export function parseStatus(porcelain: string): RepoObservation {
  const obs: RepoObservation = { branch: null, upstream: null, dirty: false, ahead: 0, behind: 0 };
  for (const line of porcelain.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("# branch.head ")) {
      const name = text.slice("# branch.head ".length).trim();
      // porcelain v2 reports a detached HEAD as the literal "(detached)".
      obs.branch = name === "(detached)" ? null : name;
    } else if (text.startsWith("# branch.upstream ")) {
      obs.upstream = text.slice("# branch.upstream ".length).trim();
    } else if (text.startsWith("# branch.oid ")) {
      const oid = text.slice("# branch.oid ".length).trim();
      if (oid !== "(initial)") obs.head = oid;
    } else if (text.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(text);
      if (m) {
        obs.ahead = Number.parseInt(m[1] as string, 10);
        obs.behind = Number.parseInt(m[2] as string, 10);
      }
    } else if (!text.startsWith("#")) {
      // Any non-header line is a change: tracked, untracked or unmerged.
      obs.dirty = true;
    }
  }
  return obs;
}

/** One line describing the outcome, for a notice. */
export function describeUpdate(decision: UpdateAction, opts: { applied?: boolean } = {}): string {
  switch (decision.action) {
    case "current":
      return `pi-engineering-runtime: ${decision.reason}`;
    case "update":
      return opts.applied
        ? `pi-engineering-runtime updated — ${decision.reason}. Restart Pi (or /reload) to load it.`
        : `pi-engineering-runtime is ${decision.behind} commit(s) behind. Run /update to apply.`;
    case "report":
      return `pi-engineering-runtime: ${decision.reason}. Run /update for detail.`;
    case "skip":
      return `pi-engineering-runtime: ${decision.reason}`;
  }
}
